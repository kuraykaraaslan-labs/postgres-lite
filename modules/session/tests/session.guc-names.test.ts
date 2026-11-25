import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { extractCustomGucNames, MAX_CUSTOM_GUC_NAMES, rememberCustomGucNames } from '../session.guc-names.js';

describe('extractCustomGucNames', () => {
  it('finds names in SET, RESET, SHOW, set_config and current_setting', () => {
    const sql = `SET app.current_tenant = 'a'; SET SESSION App.Mode TO 'x'; set local "My"."Flag" = 1;
      RESET app.gone; SHOW app.shown; SELECT set_config('app.bypass_rls', 'on', true), current_setting('app.read', true)`;
    expect(extractCustomGucNames(sql).sort()).toEqual(['My.Flag', 'app.bypass_rls', 'app.current_tenant', 'app.gone', 'app.mode', 'app.read', 'app.shown']);
  });

  it('ignores built-in (undotted) settings and malformed names', () => {
    expect(extractCustomGucNames(`SET work_mem = '8MB'; SET search_path TO public; SELECT set_config('bad name.x', '1', false)`)).toEqual([]);
  });

  it('stays linear on hostile input', () => {
    const hostile = `SET ${'a.'.repeat(50_000)}`;
    const started = performance.now();
    extractCustomGucNames(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('caps the registry', () => {
    const registry = new Set<string>();
    const names = Array.from({ length: MAX_CUSTOM_GUC_NAMES + 10 }, (_, i) => `app.n${i}`);
    expect(rememberCustomGucNames(registry, names)).toBe(MAX_CUSTOM_GUC_NAMES);
    expect(registry.size).toBe(MAX_CUSTOM_GUC_NAMES);
  });

  it('every extracted name is one PostgreSQL accepts as a placeholder', async () => {
    const engine = await PGlite.create();
    try {
      for (const name of extractCustomGucNames(`SET SESSION App.Mode TO 'x'; SELECT set_config('app.bypass_rls', 'on', false)`)) {
        const result = await engine.query<{ v: string }>(`SELECT set_config($1, 'ok', false) AS v`, [name]);
        expect(result.rows[0]?.v).toBe('ok');
      }
    } finally {
      await engine.close();
    }
  });
});
