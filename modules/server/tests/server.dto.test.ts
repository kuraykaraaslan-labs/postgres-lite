import { describe, expect, it } from 'vitest';

import { DatabaseNameSchema, InstanceNameSchema, PostgresLiteOptionsDTO } from '../server.dto.js';

describe('PostgresLiteOptionsDTO', () => {
  it('fills the documented defaults', () => {
    const parsed = PostgresLiteOptionsDTO.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      port: 5432,
      host: '127.0.0.1',
      memory: false,
      timescale: false,
      timescaleLicense: 'timescale',
      timescaleVersion: '2.31.0',
      timescaleJobs: 'auto',
      lockTimeoutMs: 10_000,
      logLevel: 'warn',
    });
  });

  it('refuses memory together with an on-disk location', () => {
    expect(PostgresLiteOptionsDTO.safeParse({ memory: true, dataDir: '/tmp/x' }).success).toBe(false);
    expect(PostgresLiteOptionsDTO.safeParse({ memory: true, instance: 'app' }).success).toBe(false);
    expect(PostgresLiteOptionsDTO.safeParse({ memory: true }).success).toBe(true);
  });

  it('rejects an out-of-range port', () => {
    expect(PostgresLiteOptionsDTO.safeParse({ port: 70000 }).success).toBe(false);
  });
});

describe('DatabaseNameSchema', () => {
  it('accepts any name PostgreSQL accepts, case and Unicode included', () => {
    for (const name of ['app', 'App', 'team/app', '..', 'café', 'x'.repeat(63)]) {
      expect(DatabaseNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('rejects names PostgreSQL rejects', () => {
    expect(DatabaseNameSchema.safeParse('').success).toBe(false);
    expect(DatabaseNameSchema.safeParse('x'.repeat(64)).success).toBe(false);
    expect(DatabaseNameSchema.safeParse('ç'.repeat(32)).success).toBe(false); // 64 bytes
    expect(DatabaseNameSchema.safeParse('a\0b').success).toBe(false);
  });
});

describe('InstanceNameSchema', () => {
  it('only allows folder-safe lowercase names', () => {
    expect(InstanceNameSchema.safeParse('my-app-3f2a91c0').success).toBe(true);
    expect(InstanceNameSchema.safeParse('My-App').success).toBe(false);
    expect(InstanceNameSchema.safeParse('../x').success).toBe(false);
  });
});
