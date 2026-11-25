import { z } from 'zod';

import { SemverSchema, type TimescaleLicense } from '../server/server.dto.js';

export type { TimescaleLicense };

/** Matches the server option default (`--timescale-version`). */
export const DEFAULT_TIMESCALE_VERSION = '2.31.0';

export const TimescaleExtensionOptionsSchema = z.object({
  version: SemverSchema.default(DEFAULT_TIMESCALE_VERSION),
  /** Run CREATE EXTENSION when the engine opens, so apps take their "already installed" branch. */
  preinstall: z.boolean().default(false),
  /** Folder for the generated .tar.gz; PGlite reads bundles from a file path in Node. Defaults to os.tmpdir(). */
  bundleDir: z.string().min(1).optional(),
});
export type TimescaleExtensionOptions = z.input<typeof TimescaleExtensionOptionsSchema>;
