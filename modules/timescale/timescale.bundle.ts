import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import Logger from '../../libs/logger/index.js';
import { DEFAULT_TIMESCALE_VERSION } from './timescale.dto.js';
import { TimescaleMessages } from './timescale.messages.js';
import { buildTar, type TarEntry } from './timescale.ustar.js';

const SQL_DIR = join(__dirname, 'sql');
const SOURCE_SCRIPT = `timescaledb--${DEFAULT_TIMESCALE_VERSION}.sql`;
/** PGlite unpacks bundles under its install prefix, so this lands in $sharedir/extension. */
const EXTENSION_PATH = 'share/postgresql/extension';

/**
 * Builds the PGlite extension bundle (.tar.gz) from the SQL files at runtime, so the package needs no build step
 * for it and the reported version can be chosen per server.
 */
export default class TimescaleBundle {
  /** The files PGlite must see in $sharedir/extension for the given reported version. */
  static entries(version: string = DEFAULT_TIMESCALE_VERSION): TarEntry[] {
    const control = TimescaleBundle.readSql('timescaledb.control').replace(
      /^default_version\s*=.*$/m,
      `default_version = '${version}'`,
    );
    // The same install script is published under the requested version, which is all a version check reads.
    const script = TimescaleBundle.readSql(SOURCE_SCRIPT);
    return [
      { name: `${EXTENSION_PATH}/timescaledb.control`, data: Buffer.from(control, 'utf8') },
      { name: `${EXTENSION_PATH}/timescaledb--${version}.sql`, data: Buffer.from(script, 'utf8') },
    ];
  }

  static build(version: string = DEFAULT_TIMESCALE_VERSION): Buffer {
    return gzipSync(buildTar(TimescaleBundle.entries(version)));
  }

  /**
   * PGlite in Node reads a bundle from a file path, so the archive is written once to a file named by its content hash.
   * Write to a unique temp name then rename: concurrent servers never see a half-written bundle.
   */
  static ensureFile(version: string = DEFAULT_TIMESCALE_VERSION, dir: string = join(tmpdir(), 'postgres-lite')): string {
    const tar = buildTar(TimescaleBundle.entries(version));
    const hash = createHash('sha256').update(tar).digest('hex').slice(0, 16);
    const file = join(dir, `timescaledb-${version}-${hash}.tar.gz`);
    if (existsSync(file)) {
      Logger.debug(TimescaleMessages.BUNDLE_REUSED, { file });
      return file;
    }
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, gzipSync(tar));
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    Logger.debug(TimescaleMessages.BUNDLE_WRITTEN, { file });
    return file;
  }

  private static readSql(name: string): string {
    const path = join(SQL_DIR, name);
    if (!existsSync(path)) throw new Error(`${TimescaleMessages.SQL_FILE_MISSING}: ${path}`);
    return readFileSync(path, 'utf8');
  }
}
