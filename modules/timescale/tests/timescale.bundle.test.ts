import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import TimescaleBundle from '../timescale.bundle.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgl-ts-bundle-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TimescaleBundle', () => {
  it('publishes the control file and the install script under the requested version', () => {
    const names = TimescaleBundle.entries('2.17.0').map((e) => e.name);
    expect(names).toEqual([
      'share/postgresql/extension/timescaledb.control',
      'share/postgresql/extension/timescaledb--2.17.0.sql',
    ]);
    const control = TimescaleBundle.entries('2.17.0')[0]?.data.toString();
    expect(control).toContain("default_version = '2.17.0'");
  });

  it('builds a gzip whose tar starts with the control file', () => {
    const tar = gunzipSync(TimescaleBundle.build());
    expect(tar.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '')).toBe('share/postgresql/extension/timescaledb.control');
    expect(tar.toString('latin1')).toContain("default_version = '2.31.0'");
  });

  it('writes the bundle once and reuses it, with no temp files left behind', () => {
    const dir = tempDir();
    const first = TimescaleBundle.ensureFile('2.31.0', dir);
    const second = TimescaleBundle.ensureFile('2.31.0', dir);
    expect(second).toBe(first);
    expect(readdirSync(dir)).toEqual([first.slice(dir.length + 1)]);
    expect(gunzipSync(readFileSync(first)).length % 512).toBe(0);
  });
});
