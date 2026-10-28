import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';

const codeSchema = z.string().regex(/^[A-Za-z0-9_-]{3,16}$/);
const createLinkSchema = z.object({
  target_url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'target_url must use http or https'),
  expires_at: z.string().datetime({ offset: true }).optional(),
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

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Linkly URL shortener',
    version: '1.0.0',
    description: 'Create short links, redirect visitors, and inspect click analytics.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/health': {
      get: {
        summary: 'Check API and database health',
        responses: {
          200: { description: 'Healthy' },
          503: { description: 'Database unavailable' },
        },
      },
    },
    '/links': {
      post: {
        summary: 'Create a short link',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['target_url'],
                additionalProperties: false,
                properties: {
                  target_url: { type: 'string', format: 'uri', description: 'An http(s) URL' },
                  expires_at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created' },
          400: { description: 'Invalid input with field-specific guidance' },
        },
      },
    },
    '/links/{code}': {
      parameters: [{ $ref: '#/components/parameters/Code' }],
      get: {
        summary: 'Get link metadata',
        responses: {
          200: { description: 'Link metadata' },
          404: { description: 'Link not found' },
        },
      },
      delete: {
        summary: 'Delete a link and its clicks',
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Link not found' },
        },
      },
    },
    '/links/{code}/clicks': {
      get: {
        summary: 'Get a keyset-paginated click log',
        parameters: [
          { $ref: '#/components/parameters/Code' },
          { name: 'after', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          200: { description: 'Click page and next_cursor' },
          400: { description: 'Invalid query or cursor' },
          404: { description: 'Link not found' },
        },
      },
    },
    '/links/{code}/clicks.csv': {
      get: {
        summary: 'Stream the click log as CSV',
        parameters: [{ $ref: '#/components/parameters/Code' }],
        responses: {
          200: { description: 'CSV click log' },
          404: { description: 'Link not found' },
        },
      },
    },
    '/{code}': {
      get: {
        summary: 'Redirect and record a click',
        parameters: [{ $ref: '#/components/parameters/Code' }],
        responses: {
          302: { description: 'Redirected' },
          404: { description: 'Link not found' },
          410: { description: 'Link expired' },
        },
      },
    },
  },
  components: {
    parameters: {
      Code: {
        name: 'code',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,16}$' },
      },
    },
  },
};

function validationMessage(issue, field) {
  if (issue.code === 'unrecognized_keys') {
    const fields = issue.keys.join(', ');
    return `Remove unsupported field${issue.keys.length === 1 ? '' : 's'}: ${fields}.`;
  }

  const fieldMessages = {
    target_url: 'Enter a valid URL that starts with http:// or https://.',
    expires_at: 'Enter an expiry date and time in ISO 8601 format.',
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
      const result = cursor
        ? await pool.query(
          `SELECT id, clicked_at, referrer, user_agent,
                  to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM clicks
           WHERE link_id = $1 AND (clicked_at, id) > ($2::timestamptz, $3::integer)
           ORDER BY clicked_at, id
           LIMIT 500`,
          [linkId, cursor.at, cursor.id],
        )
        : await pool.query(
          `SELECT id, clicked_at, referrer, user_agent,
                  to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM clicks
           WHERE link_id = $1
           ORDER BY clicked_at, id
           LIMIT 500`,
          [linkId],
        );
      for (const click of result.rows) {
        yield csvRow(click);
        cursor = { at: click.cursor_at, id: click.id };
      }
      if (result.rowCount < 500) return;
    }
  }
  return Readable.from(rows());
}

export function createApp(pool, { publicBaseUrl = '' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

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
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = randomBytes(6).toString('base64url');
        const result = await pool.query(
          `INSERT INTO links (code, target_url, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (code) DO NOTHING
           RETURNING code, target_url, created_at, expires_at, click_count`,
          [code, data.target_url, data.expires_at ?? null],
        );
        if (result.rowCount === 0) continue;

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
      const result = cursor
        ? await pool.query(
          `SELECT id, clicked_at, referrer, user_agent,
                  to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM clicks
           WHERE link_id = $1 AND (clicked_at, id) > ($2::timestamptz, $3::integer)
           ORDER BY clicked_at, id
           LIMIT $4`,
          [link.rows[0].id, cursor.at, cursor.id, limit + 1],
        )
        : await pool.query(
          `SELECT id, clicked_at, referrer, user_agent,
                  to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM clicks
           WHERE link_id = $1
           ORDER BY clicked_at, id
           LIMIT $2`,
          [link.rows[0].id, limit + 1],
        );
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
    console.error('Request failed', error);
    if (res.headersSent) return res.destroy(error);
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
