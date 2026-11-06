import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { openApiDocument } from './openapi.js';

const reservedCodes = new Set(['health', 'docs', 'links']);
const codeSchema = z.string()
  .regex(/^[A-Za-z0-9_-]{3,16}$/)
  .refine((code) => !reservedCodes.has(code.toLowerCase()), 'This code is reserved.');
const createLinkSchema = z.object({
  target_url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'target_url must use http or https'),
  code: codeSchema.optional(),
  expires_at: z.string().datetime({ offset: true })
    .refine((value) => Date.parse(value) > Date.now()).optional(),
}).strict();
const clicksQuerySchema = z.object({
  after: z.preprocess((value) => value === '' ? undefined : value, z.string().optional()),
  limit: z.preprocess(
    (value) => value === undefined ? 50 : Number(value),
    z.number().int().min(1).max(100),
  ),
});
const cursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  id: z.number().int().positive(),
});
const csvPageSize = 500;

function validationMessage(issue, field) {
  if (issue.code === 'unrecognized_keys') {
    const fields = issue.keys.join(', ');
    return `Remove unsupported field${issue.keys.length === 1 ? '' : 's'}: ${fields}.`;
  }

  const fieldMessages = {
    target_url: 'Enter a valid URL that starts with http:// or https://.',
    code: 'Choose a code with 3 to 16 letters, numbers, underscores, or hyphens; health, docs, and links are reserved.',
    expires_at: 'Enter a future expiry date and time in ISO 8601 format.',
    limit: 'Choose a page size between 1 and 100.',
    after: 'The page cursor is invalid.',
  };
  return fieldMessages[field] ?? issue.message;
}

function sendValidationError(res, error) {
  const details = error.issues.map((issue) => {
    const field = issue.path.join('.') || 'request';
    return { field, message: validationMessage(issue, field) };
  });
  return res.status(400).json({ error: 'Please check your request.', details });
}

function readCursor(value) {
  if (value === undefined) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = cursorSchema.safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeCursor(click) {
  return Buffer.from(JSON.stringify({
    at: click.cursor_at,
    id: click.id,
  })).toString('base64url');
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvRow(click) {
  return [
    click.id,
    click.clicked_at.toISOString(),
    click.referrer,
    click.user_agent,
  ].map(csvCell).join(',') + '\r\n';
}

// Preserve PostgreSQL's microseconds so a page cursor never repeats a click.
function getClickBatch(pool, linkId, cursor, limit) {
  if (cursor) {
    return pool.query(
      `SELECT id, clicked_at, referrer, user_agent,
              to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM clicks
       WHERE link_id = $1 AND (clicked_at, id) > ($2::timestamptz, $3::integer)
       ORDER BY clicked_at, id
       LIMIT $4`,
      [linkId, cursor.at, cursor.id, limit],
    );
  }

  return pool.query(
    `SELECT id, clicked_at, referrer, user_agent,
            to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
     FROM clicks
     WHERE link_id = $1
     ORDER BY clicked_at, id
     LIMIT $2`,
    [linkId, limit],
  );
}

async function recordClick(pool, link, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE links
       SET click_count = click_count + 1
       WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())
       RETURNING id`,
      [link.id],
    );
    if (updated.rowCount === 0) {
      const current = await client.query(
        'SELECT expires_at <= now() AS expired FROM links WHERE code = $1',
        [link.code],
      );
      await client.query('ROLLBACK');
      return current.rowCount === 0 ? 'missing' : 'expired';
    }

    await client.query(
      `INSERT INTO clicks (link_id, referrer, user_agent)
       VALUES ($1, $2, $3)`,
      [link.id, req.get('referer') ?? null, req.get('user-agent') ?? null],
    );
    await client.query('COMMIT');
    return 'recorded';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function streamClicks(pool, linkId) {
  async function* rows() {
    yield 'id,clicked_at,referrer,user_agent\r\n';
    let cursor;
    while (true) {
      const result = await getClickBatch(pool, linkId, cursor, csvPageSize);
      for (const click of result.rows) {
        yield csvRow(click);
        cursor = { at: click.cursor_at, id: click.id };
      }
      if (result.rowCount < csvPageSize) return;
    }
  }
  return Readable.from(rows());
}

export function createApp(pool, { publicBaseUrl = '' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/', (_req, res) => res.redirect('/docs/'));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('Health check failed', error);
      res.status(503).json({ error: 'Database unavailable' });
    }
  });

  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.post('/links', async (req, res, next) => {
    const parsed = createLinkSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const data = parsed.data;

    try {
      const attempts = data.code ? 1 : 3;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const code = data.code ?? randomBytes(6).toString('base64url');
        const result = await pool.query(
          `INSERT INTO links (code, target_url, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (code) DO NOTHING
           RETURNING code, target_url, created_at, expires_at, click_count`,
          [code, data.target_url, data.expires_at ?? null],
        );
        if (result.rowCount === 0) {
          if (data.code) return res.status(409).json({ error: 'This short code is already in use.' });
          continue;
        }

        const link = result.rows[0];
        const shortUrl = publicBaseUrl
          ? `${publicBaseUrl.replace(/\/$/, '')}/${link.code}`
          : `/${link.code}`;
        return res.status(201).json({ ...link, short_url: shortUrl });
      }
      return res.status(503).json({ error: 'Could not allocate a unique code; try again' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/links/:code/clicks.csv', async (req, res, next) => {
    const parsedCode = codeSchema.safeParse(req.params.code);
    if (!parsedCode.success) return res.status(404).json({ error: 'Link not found' });
    try {
      const result = await pool.query('SELECT id FROM links WHERE code = $1', [parsedCode.data]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
      const stream = streamClicks(pool, result.rows[0].id);
      res.type('text/csv');
      res.set('Content-Disposition', `attachment; filename="${parsedCode.data}-clicks.csv"`);
      stream.on('error', (error) => {
        console.error('CSV stream failed', error);
        res.destroy(error);
      });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  app.get('/links/:code/clicks', async (req, res, next) => {
    const parsedCode = codeSchema.safeParse(req.params.code);
    if (!parsedCode.success) return res.status(404).json({ error: 'Link not found' });
    const parsedQuery = clicksQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return sendValidationError(res, parsedQuery.error);
    const cursor = readCursor(parsedQuery.data.after);
    if (cursor === null) return res.status(400).json({ error: 'Invalid cursor' });

    try {
      const link = await pool.query('SELECT id FROM links WHERE code = $1', [parsedCode.data]);
      if (link.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
      const limit = parsedQuery.data.limit;
      const result = await getClickBatch(pool, link.rows[0].id, cursor, limit + 1);
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit);
      res.json({
        items: items.map((click) => ({
          id: click.id,
          clicked_at: click.clicked_at,
          referrer: click.referrer,
          user_agent: click.user_agent,
        })),
        next_cursor: hasMore && items.length > 0 ? encodeCursor(items.at(-1)) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/links/:code', async (req, res, next) => {
    const parsedCode = codeSchema.safeParse(req.params.code);
    if (!parsedCode.success) return res.status(404).json({ error: 'Link not found' });
    try {
      const result = await pool.query(
        `SELECT code, target_url, created_at, expires_at, click_count
         FROM links WHERE code = $1`,
        [parsedCode.data],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/links/:code', async (req, res, next) => {
    const parsedCode = codeSchema.safeParse(req.params.code);
    if (!parsedCode.success) return res.status(404).json({ error: 'Link not found' });
    try {
      const result = await pool.query('DELETE FROM links WHERE code = $1 RETURNING id', [parsedCode.data]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/:code', async (req, res, next) => {
    const parsedCode = codeSchema.safeParse(req.params.code);
    if (!parsedCode.success) return res.status(404).json({ error: 'Link not found' });
    try {
      const result = await pool.query(
        `SELECT id, code, target_url, expires_at <= now() AS expired
         FROM links WHERE code = $1`,
        [parsedCode.data],
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
      const link = result.rows[0];
      if (link.expired) return res.status(410).json({ error: 'Link expired' });

      const clickResult = await recordClick(pool, link, req);
      if (clickResult === 'missing') return res.status(404).json({ error: 'Link not found' });
      if (clickResult === 'expired') return res.status(410).json({ error: 'Link expired' });
      return res.redirect(302, link.target_url);
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'Please send valid JSON.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body must be 16 KB or smaller.' });
    }
    console.error('Request failed', error);
    if (res.headersSent) return res.destroy(error);
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
