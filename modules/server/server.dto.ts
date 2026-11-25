import { z } from 'zod';

// ============================================================================
// Value primitives
// ============================================================================

export const LogLevelEnum = z.enum(['silent', 'warn', 'info', 'debug']);
export const TimescaleLicenseEnum = z.enum(['timescale', 'apache']);
export const TimescaleJobsEnum = z.enum(['auto', 'manual']);

/** PostgreSQL limits identifiers to NAMEDATALEN - 1 = 63 bytes and forbids NUL; any other character is legal. */
export const DatabaseNameSchema = z
  .string({ error: 'Database name must be a string' })
  .min(1, 'Database name must not be empty')
  .refine((name) => Buffer.byteLength(name, 'utf8') <= 63, 'Database name must be at most 63 bytes')
  .refine((name) => !name.includes('\0'), 'Database name must not contain NUL');

/** Instance names become folder names, so they are restricted to a portable, case-insensitive-safe set. */
export const InstanceNameSchema = z
  .string({ error: 'Instance name must be a string' })
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'Instance name: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, at most 64 characters');

export const PortSchema = z.coerce
  .number({ error: 'Port must be a number' })
  .int('Port must be an integer')
  .min(0, 'Port must be between 0 and 65535')
  .max(65535, 'Port must be between 0 and 65535');

export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must look like 2.31.0');

// ============================================================================
// Server options (CLI flags and PostgresLite.start())
// ============================================================================

export const PostgresLiteOptionsDTO = z
  .object({
    port: PortSchema.default(5432),
    host: z.string().min(1, 'Host must not be empty').default('127.0.0.1'),
    password: z.string().min(1, 'Password must not be empty').optional(),
    database: DatabaseNameSchema.optional(),
    dataDir: z.string().min(1, 'Data directory must not be empty').optional(),
    instance: InstanceNameSchema.optional(),
    memory: z.boolean().default(false),
    timescale: z.boolean().default(false),
    timescaleLicense: TimescaleLicenseEnum.default('timescale'),
    timescaleVersion: SemverSchema.default('2.31.0'),
    timescaleJobs: TimescaleJobsEnum.default('auto'),
    lockTimeoutMs: z.coerce.number().int().min(0, 'Lock timeout must not be negative').default(10_000),
    forceUnlock: z.boolean().default(false),
    logLevel: LogLevelEnum.default('warn'),
  })
  .refine((o) => !(o.memory && (o.dataDir !== undefined || o.instance !== undefined)), {
    message: 'memory cannot be combined with dataDir or instance: memory keeps nothing on disk',
    path: ['memory'],
  });

// ============================================================================
// Type exports
// ============================================================================

export type LogLevel = z.infer<typeof LogLevelEnum>;
export type TimescaleLicense = z.infer<typeof TimescaleLicenseEnum>;
export type TimescaleJobs = z.infer<typeof TimescaleJobsEnum>;
export type PostgresLiteOptionsInput = z.input<typeof PostgresLiteOptionsDTO>;
export type PostgresLiteOptions = z.output<typeof PostgresLiteOptionsDTO>;
