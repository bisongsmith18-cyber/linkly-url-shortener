import 'dotenv/config';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
}

const pool = new Pool({ connectionString: databaseUrl });
let server;
let baseUrl;

before(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code VARCHAR(16) UNIQUE NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{3,16}$'),
      target_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0)
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      referrer TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS clicks_link_clicked_id_idx
      ON clicks (link_id, clicked_at, id);
    TRUNCATE clicks, links RESTART IDENTITY CASCADE;
  `);
  server = createServer(createApp(pool));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await pool.end();
});

test('create validates URLs, rejects unsupported fields, and generates a short code', async () => {
  const invalidUrl = await fetch(`${baseUrl}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_url: 'javascript:alert(1)' }),
  });
  assert.equal(invalidUrl.status, 400);
  assert.equal((await invalidUrl.json()).details[0].field, 'target_url');

  const unsupportedField = await fetch(`${baseUrl}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_url: 'https://example.com', code: 'custom' }),
  });
  assert.equal(unsupportedField.status, 400);
  assert.match((await unsupportedField.json()).details[0].message, /unsupported field: code/);

  const created = await fetch(`${baseUrl}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_url: 'https://example.com/path' }),
  });
  assert.equal(created.status, 201);
  const createdLink = await created.json();
  assert.match(createdLink.code, /^[A-Za-z0-9_-]{3,16}$/);
  assert.equal(createdLink.short_url, `/${createdLink.code}`);

  const metadata = await fetch(`${baseUrl}/links/${createdLink.code}`);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).click_count, 0);
});

test('redirects live links, records clicks, paginates logs, exports CSV, and deletes', async () => {
  const created = await fetch(`${baseUrl}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_url: 'https://example.com/path' }),
  });
  const { code } = await created.json();
  const redirect = await fetch(`${baseUrl}/${code}`, {
    redirect: 'manual',
    headers: { referer: 'https://ref.example/' },
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/path');

  const page = await fetch(`${baseUrl}/links/${code}/clicks?limit=1`);
  assert.equal(page.status, 200);
  const first = await page.json();
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].referrer, 'https://ref.example/');
  assert.equal(first.next_cursor, null);

  const csv = await fetch(`${baseUrl}/links/${code}/clicks.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /id,clicked_at,referrer,user_agent/);

  const removed = await fetch(`${baseUrl}/links/${code}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM clicks')).rows[0].count, 0);
  assert.equal((await fetch(`${baseUrl}/links/${code}`)).status, 404);
});

test('expired links return 410 without recording a click', async () => {
  await pool.query(
    `INSERT INTO links (code, target_url, expires_at)
     VALUES ($1, $2, now() - interval '1 second')`,
    ['expired', 'https://example.com'],
  );
  const response = await fetch(`${baseUrl}/expired`, { redirect: 'manual' });
  assert.equal(response.status, 410);
  const link = await pool.query('SELECT click_count FROM links WHERE code = $1', ['expired']);
  assert.equal(link.rows[0].click_count, 0);
});

test('concurrent redirects increment the counter and insert every click exactly once', async () => {
  await pool.query(
    'INSERT INTO links (code, target_url) VALUES ($1, $2)',
    ['atomic', 'https://example.com'],
  );
  const requests = Array.from({ length: 80 }, () =>
    fetch(`${baseUrl}/atomic`, { redirect: 'manual' }));
  const responses = await Promise.all(requests);
  assert.ok(responses.every((response) => response.status === 302));

  const result = await pool.query(
    `SELECT l.click_count, count(c.id)::int AS click_rows
     FROM links l LEFT JOIN clicks c ON c.link_id = l.id
     WHERE l.code = $1
     GROUP BY l.id`,
    ['atomic'],
  );
  assert.equal(result.rows[0].click_count, 80);
  assert.equal(result.rows[0].click_rows, 80);
});

test('SQL injection-shaped codes cannot read or mutate stored links', async () => {
  const beforeCount = (await pool.query(
    'SELECT click_count FROM links WHERE code = $1', ['atomic'],
  )).rows[0].click_count;
  const injection = encodeURIComponent("' OR '1'='1");
  assert.equal((await fetch(`${baseUrl}/${injection}`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${baseUrl}/links/${injection}`)).status, 404);
  const afterCount = (await pool.query(
    'SELECT click_count FROM links WHERE code = $1', ['atomic'],
  )).rows[0].click_count;
  assert.equal(afterCount, beforeCount);
});

test('click pagination returns a keyset cursor and the following page', async () => {
  await pool.query(
    'INSERT INTO links (code, target_url) VALUES ($1, $2)',
    ['pages', 'https://example.com'],
  );
  await pool.query(
    `INSERT INTO clicks (link_id, clicked_at)
     SELECT id, '2026-01-01 00:00:00.123456+00'::timestamptz
     FROM links WHERE code = $1`,
    ['pages'],
  );
  await pool.query(
    `INSERT INTO clicks (link_id, clicked_at)
     SELECT id, '2026-01-01 00:00:00.123456+00'::timestamptz
     FROM links WHERE code = $1`,
    ['pages'],
  );
  const firstResponse = await fetch(`${baseUrl}/links/pages/clicks?limit=1`);
  const firstPage = await firstResponse.json();
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.next_cursor);

  const nextResponse = await fetch(
    `${baseUrl}/links/pages/clicks?limit=1&after=${encodeURIComponent(firstPage.next_cursor)}`,
  );
  const nextPage = await nextResponse.json();
  assert.equal(nextPage.items.length, 1);
  assert.notEqual(nextPage.items[0].id, firstPage.items[0].id);
  assert.equal(nextPage.next_cursor, null);

  const csvResponse = await fetch(`${baseUrl}/links/pages/clicks.csv`, {
    signal: AbortSignal.timeout(2000),
  });
  const csvLines = (await csvResponse.text()).trim().split('\r\n');
  assert.equal(csvLines.length, 3);
});
