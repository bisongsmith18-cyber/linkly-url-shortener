import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from './app.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('Application startup failed: DATABASE_URL is required. Configure it with a reachable PostgreSQL connection URL.');
  process.exit(1);
}

const databaseHost = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '');
const isLoopbackDatabase =
  databaseHost === 'localhost' ||
  databaseHost === '::1' ||
  (isIP(databaseHost) === 4 && databaseHost.startsWith('127.'));

const portValue = (process.env.PORT ?? '3000').trim();
const port = Number(portValue);
if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Application startup failed: PORT must be an integer between 0 and 65535.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ...(isLoopbackDatabase ? {} : { ssl: true }),
});
const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const seedPath = fileURLToPath(new URL('../db/seed.sql', import.meta.url));

try {
  await pool.query(await readFile(schemaPath, 'utf8'));
  await pool.query(await readFile(seedPath, 'utf8'));
  const app = createApp(pool, { publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '' });
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Linkly listening on port ${port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async (error) => {
      await pool.end();
      if (error) {
        console.error('Server shutdown failed', error);
        process.exitCode = 1;
      }
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error('Application startup failed', error);
  await pool.end();
  process.exitCode = 1;
}
