import fs from 'node:fs';
import path from 'node:path';

import { PGlite, type Extensions } from '@electric-sql/pglite';

import Logger from '../../libs/logger/index.js';
import EngineFsync, { type NodefsHook } from './engine.fsync.js';
import { EngineMessages } from './engine.messages.js';
import type { EngineStorage } from './engine.types.js';

export interface EngineOpenOptions {
  /** Storage rule 1 on (default). false opens the directory the way plain PGlite does: for measurements only. */
  durable?: boolean;
  extensions?: Extensions;
  platform?: NodeJS.Platform;
  hooks?: readonly NodefsHook[];
  /** Extra server settings passed as `-c name=value` start parameters (tests use a tiny shared_buffers). */
  settings?: Readonly<Record<string, string>>;
}

export interface OpenedEngine {
  pg: PGlite;
  /** True when this open ran initdb. */
  created: boolean;
}

/**
 * Written, and fsynced, only after syncTree finished. Its absence (not the absence of PG_VERSION) decides whether
 * the tree must be synced: a first open killed between initdb and the end of syncTree leaves PG_VERSION behind,
 * and the next open must still flush initdb's output before anything is acknowledged.
 */
export const SYNCED_MARKER = '.postgres-lite-synced';

/** Settings that would silently undo storage rule 1 if a caller passed them after the durable start params. */
const DURABILITY_SETTINGS = new Set(['fsync', 'wal_sync_method', 'synchronous_commit', 'full_page_writes', 'data_sync_retry']);

/** Opens one PGlite engine on memory or on a data directory. Runs wherever the engine lives (main thread or worker). */
export default class EngineOpen {
  static async open(storage: EngineStorage, options: EngineOpenOptions = {}): Promise<OpenedEngine> {
    const extensions = options.extensions ?? {};
    if (storage.kind === 'memory') {
      const pg = await PGlite.create({ extensions });
      return { pg, created: true };
    }
    const dataDir = path.resolve(storage.dataDir);
    const created = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
    const durable = options.durable ?? true;
    const platform = options.platform ?? process.platform;
    const refused = Object.keys(options.settings ?? {}).filter((name) => DURABILITY_SETTINGS.has(name.toLowerCase()));
    if (durable && refused.length > 0) throw new Error(`${EngineMessages.DURABILITY_SETTING_REFUSED}: ${refused.join(', ')}`);
    const settings = Object.entries(options.settings ?? {}).flatMap(([name, value]) => ['-c', `${name}=${value}`]);
    const pg = await PGlite.create({
      fs: EngineFsync.createFilesystem(dataDir, { platform, hooks: options.hooks ?? [], installFsync: durable }),
      startParams: [...(durable ? EngineFsync.startParams() : PGlite.defaultStartParams), ...settings],
      extensions,
    });
    const marker = path.join(dataDir, SYNCED_MARKER);
    if (durable && !fs.existsSync(marker)) {
      // Nothing has been acknowledged on this engine yet, so syncing here is still "before use".
      const synced = EngineFsync.syncTree(dataDir, platform);
      EngineOpen.writeMarker(marker, platform);
      Logger.debug(`[EngineOpen.open] ${EngineMessages.INITDB_SYNCED}`, { ...synced, created });
    }
    Logger.debug(`[EngineOpen.open] ${EngineMessages.ENGINE_OPENED}`, { dataDir, durable, created });
    return { pg, created };
  }

  private static writeMarker(marker: string, platform: NodeJS.Platform): void {
    const fd = fs.openSync(marker, 'w');
    try {
      fs.writeSync(fd, `${new Date().toISOString()}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Windows cannot fsync a directory (storage rule 1); elsewhere the new entry itself must reach the disk.
    if (platform === 'win32') return;
    const dir = fs.openSync(path.dirname(marker), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }
}
