import { isIP } from 'node:net';
import pg from 'pg';

const { Pool } = pg;

export function getDatabasePoolOptions(connectionString) {
  const databaseHost = new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
  const isLoopbackDatabase =
    databaseHost === 'localhost' ||
    databaseHost === '::1' ||
    (isIP(databaseHost) === 4 && databaseHost.startsWith('127.'));

  if (isLoopbackDatabase) {
    return { connectionString };
  }

  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim();
  if (ca) {
    const url = new URL(connectionString);
    for (const parameter of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      url.searchParams.delete(parameter);
    }
    connectionString = url.toString();
  }

  return {
    connectionString,
    ssl: ca ? { ca, rejectUnauthorized: true } : true,
  };
}

export function createDatabasePool(connectionString) {
  return new Pool(getDatabasePoolOptions(connectionString));
}
