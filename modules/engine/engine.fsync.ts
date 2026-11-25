import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { NodeFS } from '@electric-sql/pglite/nodefs';

import Logger from '../../libs/logger/index.js';
import { EngineMessages } from './engine.messages.js';
import { asNodefsModule, type EmscriptenStream, type NodefsModule } from './engine.nodefs.js';

/** A hook that runs on the Emscripten module before PostgreSQL starts (and before initdb writes anything). */
export type NodefsHook = (mod: NodefsModule) => void;

export interface DurableFsOptions {
  /** Defaults to process.platform; tests pass 'win32' to exercise the Windows directory rule on Linux. */
  platform?: NodeJS.Platform;
  /** Extra hooks after fsync is installed; the durability test uses one to record every write and fsync. */
  hooks?: readonly NodefsHook[];
  /** false leaves NODEFS as PGlite ships it (no fsync), for the before/after measurements. Default true. */
  installFsync?: boolean;
}

export interface SyncTreeResult {
  files: number;
  directories: number;
}

type EmscriptenOpts = Parameters<NodeFS['init']>[1];
type InitResult = Awaited<ReturnType<NodeFS['init']>>;

function errnoError(code: string): Error {
  // NODEFS.tryFSOperation maps `code` to the Emscripten errno, which PostgreSQL then sees as errno.
  return Object.assign(new Error(code), { code });
}

/**
 * NodeFS with a working fsync. PGlite's NodeFS mounts NODEFS in a preRun hook; ours runs right after it, still
 * before initdb and PostgreSQL start, which is the only point where every later file operation goes through the patch.
 */
class DurableNodeFS extends NodeFS {
  readonly #platform: NodeJS.Platform;
  readonly #hooks: readonly NodefsHook[];
  readonly #installFsync: boolean;

  constructor(dataDir: string, options: DurableFsOptions) {
    super(dataDir);
    this.#platform = options.platform ?? process.platform;
    this.#hooks = options.hooks ?? [];
    this.#installFsync = options.installFsync ?? true;
  }

  override async init(pg: PGlite, opts: EmscriptenOpts): Promise<InitResult> {
    const result = await super.init(pg, opts);
    const platform = this.#platform;
    const hooks = this.#hooks;
    const installFsync = this.#installFsync;
    const preRun = result.emscriptenOpts.preRun ?? [];
    result.emscriptenOpts.preRun = [
      ...preRun,
      (mod): void => {
        const nodefs = asNodefsModule(mod);
        if (installFsync) EngineFsync.install(nodefs, platform);
        for (const hook of hooks) hook(nodefs);
      },
    ];
    return result;
  }
}

/** Storage rule 1 (docs/PHASES.md): PostgreSQL's fsyncs reach the disk, and files written outside PostgreSQL are fsynced. */
export default class EngineFsync {
  /**
   * PGlite's defaults without `-F` (fsync = off), plus `wal_sync_method = fsync`. Not open_sync (aborts PGlite) and not
   * open_datasync (no such flag on Windows, no drive-cache flush on macOS); fdatasync is a no-op in PGlite's Emscripten.
   */
  static startParams(defaults: readonly string[] = PGlite.defaultStartParams): string[] {
    const out: string[] = [];
    for (let i = 0; i < defaults.length; i++) {
      const arg = defaults[i];
      if (arg === undefined || arg === '-F') continue;
      const value = defaults[i + 1];
      if (arg === '-c' && value !== undefined && /^(fsync|wal_sync_method)=/.test(value)) {
        i++;
        continue;
      }
      out.push(arg);
    }
    return [...out, '-c', 'fsync=on', '-c', 'wal_sync_method=fsync'];
  }

  /** A PGlite filesystem for `dataDir` whose NODEFS fsync calls fs.fsyncSync. */
  static createFilesystem(dataDir: string, options: DurableFsOptions = {}): NodeFS {
    return new DurableNodeFS(dataDir, options);
  }

  /**
   * Adds stream_ops.fsync to NODEFS. Node maps fs.fsyncSync to F_FULLFSYNC on macOS and FlushFileBuffers on Windows.
   * Windows cannot flush a directory handle (EPERM, which PostgreSQL turns into a PANIC), so a directory fsync there
   * reports EINVAL: PostgreSQL's fsync_fname ignores EINVAL and EBADF for directories, as on any OS that cannot do it.
   *
   * That leaves a rename on Windows (a new WAL segment, a checkpoint file) with nothing to make the new name durable,
   * so there the renamed file is flushed right after the rename: NTFS commits a file's metadata, its name included,
   * with FlushFileBuffers. Native PostgreSQL on Windows does not do this; renames are rare, so it costs little.
   */
  static install(mod: NodefsModule, platform: NodeJS.Platform = process.platform): void {
    const { NODEFS, FS } = mod;
    NODEFS.stream_ops.fsync = (stream: EmscriptenStream): number =>
      NODEFS.tryFSOperation(() => {
        const isDir = FS.isDir(stream.node.mode);
        if (isDir && platform === 'win32') throw errnoError('EINVAL');
        if (stream.nfd === undefined) throw errnoError('EBADF');
        fs.fsyncSync(stream.nfd);
        return 0;
      });
    if (platform === 'win32') EngineFsync.flushRenames(mod);
    Logger.debug(`[EngineFsync.install] ${EngineMessages.FSYNC_INSTALLED}`, { platform });
  }

  private static flushRenames({ NODEFS, FS }: NodefsModule): void {
    const rename = NODEFS.node_ops.rename;
    NODEFS.node_ops.rename = (node, newDir, newName): void => {
      rename(node, newDir, newName);
      if (FS.isDir(node.mode)) return;
      // NODEFS sets node.name but moves node.parent only after this returns, so build the new path from newDir.
      const target = path.join(NODEFS.realPath(newDir), newName);
      NODEFS.tryFSOperation(() => {
        const nfd = fs.openSync(target, 'r+');
        try {
          // Through stream_ops, so hooks installed after this one (the crash recorder) see the flush.
          NODEFS.stream_ops.fsync?.({ node, nfd });
        } finally {
          fs.closeSync(nfd);
        }
      });
    };
  }

  /**
   * fsyncs every file under `root`, then every directory bottom-up, then the parent of `root` (so the root's own entry
   * is durable). Used after initdb, which writes about 970 files without one fsync, and for any directory written
   * outside PostgreSQL. Directories are skipped on Windows, which cannot flush them.
   */
  static syncTree(root: string, platform: NodeJS.Platform = process.platform): SyncTreeResult {
    const result: SyncTreeResult = { files: 0, directories: 0 };
    const directories: string[] = [];
    const walk = (dir: string): void => {
      directories.push(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          EngineFsync.syncPath(full, 'r+');
          result.files++;
        }
      }
    };
    walk(root);
    if (platform !== 'win32') {
      directories.push(path.dirname(root));
      for (const dir of directories.reverse()) {
        EngineFsync.syncPath(dir, 'r');
        result.directories++;
      }
    }
    return result;
  }

  private static syncPath(target: string, flags: string): void {
    const fd = fs.openSync(target, flags);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
