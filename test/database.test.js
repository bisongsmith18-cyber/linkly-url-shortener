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
  const previousMode = process.env.DATABASE_SSL_MODE;
  delete process.env.DATABASE_SSL_MODE;

  try {
    const options = getDatabasePoolOptions('postgres://user:pass@db.example/linkly');
    assert.equal(options.ssl, true);
  } finally {
    if (previousMode === undefined) {
      delete process.env.DATABASE_SSL_MODE;
    } else {
      process.env.DATABASE_SSL_MODE = previousMode;
    }
  }
});

test('remote database connections can require TLS with a self-signed certificate', () => {
  const previousMode = process.env.DATABASE_SSL_MODE;
  process.env.DATABASE_SSL_MODE = 'require';

  try {
    const options = getDatabasePoolOptions('postgres://user:pass@db.example/linkly?sslmode=disable');
    assert.deepEqual(options.ssl, { rejectUnauthorized: false });
    assert.deepEqual(new Client(options).connectionParameters.ssl, { rejectUnauthorized: false });
  } finally {
    if (previousMode === undefined) {
      delete process.env.DATABASE_SSL_MODE;
    } else {
      process.env.DATABASE_SSL_MODE = previousMode;
    }
  }
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
