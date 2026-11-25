import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import EngineFsync from '../engine.fsync.js';
import { EngineMessages } from '../engine.messages.js';
import EngineOpen, { SYNCED_MARKER } from '../engine.open.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-open-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('EngineOpen.open', () => {
  it('marks a new directory as synced only after the whole tree was flushed', async () => {
    const dataDir = path.join(tempDir(), 'db');
    const { pg, created } = await EngineOpen.open({ kind: 'disk', dataDir });
    await pg.close();
    expect(created).toBe(true);
    expect(fs.existsSync(path.join(dataDir, SYNCED_MARKER))).toBe(true);
  });

  it('syncs again when an earlier open died between initdb and the end of syncTree', async () => {
    const dataDir = path.join(tempDir(), 'db');
    const first = await EngineOpen.open({ kind: 'disk', dataDir });
    await first.pg.close();
    // Simulate the crash window: PG_VERSION exists, the marker does not.
    fs.rmSync(path.join(dataDir, SYNCED_MARKER));

    const calls: string[] = [];
    const original = EngineFsync.syncTree;
    EngineFsync.syncTree = (root, platform) => {
      calls.push(root);
      return original(root, platform);
    };
    try {
      const second = await EngineOpen.open({ kind: 'disk', dataDir });
      await second.pg.close();
      expect(second.created).toBe(false);
    } finally {
      EngineFsync.syncTree = original;
    }
    expect(calls).toEqual([path.resolve(dataDir)]);
    expect(fs.existsSync(path.join(dataDir, SYNCED_MARKER))).toBe(true);
  });

  it('refuses settings that would turn durability off', async () => {
    const dataDir = path.join(tempDir(), 'db');
    for (const name of ['fsync', 'wal_sync_method', 'synchronous_commit', 'FULL_PAGE_WRITES']) {
      await expect(EngineOpen.open({ kind: 'disk', dataDir }, { settings: { [name]: 'off' } })).rejects.toThrow(
        EngineMessages.DURABILITY_SETTING_REFUSED,
      );
    }
    expect(fs.existsSync(dataDir)).toBe(false);
  });
});
