import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { getDatabasePoolOptions } from '../src/database.js';

const { Client } = pg;

test('local database connections retain default SSL settings', () => {
  const options = getDatabasePoolOptions('postgres://user:pass@localhost/linkly');
  assert.equal(options.ssl, undefined);
});

test('remote database connections use TLS with certificate verification', () => {
  const options = getDatabasePoolOptions('postgres://user:pass@db.example/linkly');
  assert.equal(options.ssl, true);
});

test('remote database connections trust the configured CA and verify certificates', () => {
  const previousCa = process.env.DATABASE_SSL_CA;
  process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----\\ntrusted-ca\\n-----END CERTIFICATE-----';

  try {
    const options = getDatabasePoolOptions('postgres://user:pass@db.example/linkly?sslmode=require');
    assert.equal(options.ssl.ca, '-----BEGIN CERTIFICATE-----\ntrusted-ca\n-----END CERTIFICATE-----');
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.equal(new Client(options).connectionParameters.ssl.ca, options.ssl.ca);
  } finally {
    if (previousCa === undefined) {
      delete process.env.DATABASE_SSL_CA;
    } else {
      process.env.DATABASE_SSL_CA = previousCa;
    }
  }
});
