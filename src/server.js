import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from './app.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const seedPath = fileURLToPath(new URL('../db/seed.sql', import.meta.url));

try {
  await pool.query(await readFile(schemaPath, 'utf8'));
  await pool.query(await readFile(seedPath, 'utf8'));
  const port = Number(process.env.PORT ?? 3000);
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
