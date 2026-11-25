import { z } from 'zod';

/** Startup parameters that are not GUCs: the server reads them itself instead of applying them with set_config. */
export const NON_GUC_STARTUP_PARAMETERS = new Set(['user', 'database', 'options', 'replication']);

/** Protocol options (`_pq_.name`) are reserved for protocol extensions and must be reported back as unrecognised. */
export const PROTOCOL_OPTION_PREFIX = '_pq_.';

/** A GUC name as PostgreSQL accepts it, including custom `prefix.name` settings. */
const GucNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/, 'invalid configuration parameter name');

/** The key/value pairs of a StartupMessage, once the binary layout has been parsed. */
export const StartupParametersDTO = z
  .record(z.string(), z.string())
  .superRefine((params, ctx) => {
    if (!params.user) ctx.addIssue({ code: 'custom', message: 'no PostgreSQL user name specified in startup packet', path: ['user'] });
    for (const name of Object.keys(params)) {
      if (NON_GUC_STARTUP_PARAMETERS.has(name) || name.startsWith(PROTOCOL_OPTION_PREFIX)) continue;
      if (!GucNameSchema.safeParse(name).success) ctx.addIssue({ code: 'custom', message: 'invalid configuration parameter name', path: [name] });
    }
  });

export type StartupParameters = z.infer<typeof StartupParametersDTO>;
