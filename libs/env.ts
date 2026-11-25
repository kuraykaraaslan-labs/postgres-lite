import { z } from 'zod';

import { DatabaseNameSchema, LogLevelEnum, PortSchema } from '../modules/server/server.dto.js';

/**
 * Environment read by postgres-lite. The only file that reads process.env.
 * CLI flags and start() options win over these values.
 */
export const EnvSchema = z.object({
  POSTGRES_LITE_PORT: PortSchema.optional(),
  POSTGRES_LITE_HOST: z.string().min(1).optional(),
  POSTGRES_LITE_PASSWORD: z.string().min(1).optional(),
  POSTGRES_LITE_DATABASE: DatabaseNameSchema.optional(),
  POSTGRES_LITE_DATA_DIR: z.string().min(1).optional(),
  POSTGRES_LITE_LOG_LEVEL: LogLevelEnum.optional(),
  /** Windows only: the default data root is %LOCALAPPDATA%\postgres-lite (see docs/PHASES.md, Storage). */
  LOCALAPPDATA: z.string().optional(),
  /** Test-runner markers: start() without a storage option uses a separate -test instance under a test runner. */
  VITEST: z.string().optional(),
  VITEST_POOL_ID: z.string().optional(),
  JEST_WORKER_ID: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** Treats empty strings as unset, so `FOO=` in a .env file does not fail validation. */
function withoutEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && value !== '') out[key] = value;
  return out;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid postgres-lite environment: ${issues}`);
  }
  return parsed.data;
}

/** The test worker id when running under Vitest or Jest, otherwise undefined. */
export function testWorkerId(env: Env): string | undefined {
  if (env.VITEST !== undefined) return env.VITEST_POOL_ID ?? '0';
  if (env.JEST_WORKER_ID !== undefined) return env.JEST_WORKER_ID;
  if (env.NODE_ENV === 'test') return '0';
  return undefined;
}
