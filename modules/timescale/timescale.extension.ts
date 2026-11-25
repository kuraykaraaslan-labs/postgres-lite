import { pathToFileURL } from 'node:url';

import type { Extension, PGliteInterface } from '@electric-sql/pglite';

import Logger from '../../libs/logger/index.js';
import TimescaleBundle from './timescale.bundle.js';
import { type TimescaleExtensionOptions, TimescaleExtensionOptionsSchema, type TimescaleLicense } from './timescale.dto.js';
import { TimescaleMessages } from './timescale.messages.js';

export const PREINSTALL_SQL = 'CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public';

/** The PGlite side of the TimescaleDB-compatible layer: the extension object and the engine start parameters. */
export default class TimescaleExtension {
  /**
   * A PGlite extension whose bundle holds only the control file and install script. PGlite unpacks it into its
   * share directory on every start (it is not stored in the data directory), so every open must pass it again.
   */
  static create(options: TimescaleExtensionOptions = {}): Extension {
    const parsed = TimescaleExtensionOptionsSchema.parse(options);
    return {
      name: 'timescaledb',
      setup: async (pg: PGliteInterface) => {
        const file = TimescaleBundle.ensureFile(parsed.version, parsed.bundleDir);
        if (!parsed.preinstall) return { bundlePath: pathToFileURL(file) };
        return {
          bundlePath: pathToFileURL(file),
          // init runs after PostgreSQL is up, once per engine open; IF NOT EXISTS makes reopening a no-op.
          init: async (): Promise<void> => {
            await pg.exec(PREINSTALL_SQL);
            Logger.debug(TimescaleMessages.PREINSTALL_DONE, { version: parsed.version });
          },
        };
      },
    };
  }

  /**
   * Startup parameters for PGlite. A -c option is the only route that applies on every open in both memory and disk
   * mode: PGlite's single-user backend ignores ALTER DATABASE / ALTER ROLE settings, and ALTER SYSTEM only reaches
   * an on-disk instance. PGlite replaces its defaults when startParams is given, so they are repeated here.
   */
  static startParams(license: TimescaleLicense, base: readonly string[]): string[] {
    return [...base, '-c', `timescaledb.license=${license}`];
  }
}
