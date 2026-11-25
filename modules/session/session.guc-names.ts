import { z } from 'zod';

/** A custom GUC name: two or more dotted identifier parts, as PostgreSQL accepts for placeholders. */
export const CustomGucNameSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)+$/);

/** Bounds the registry so a client that invents names cannot grow every later swap without limit. */
export const MAX_CUSTOM_GUC_NAMES = 1024;

// Each pattern is anchored on a keyword and uses only bounded, non-nested quantifiers, so it stays linear on any input.
const NAME = `"?[A-Za-z_][A-Za-z0-9_$]{0,99}"?(?:\\."?[A-Za-z_][A-Za-z0-9_$]{0,99}"?){1,4}`;
const PATTERNS: readonly RegExp[] = [
  /\b(?:set_config|current_setting)\s*\(\s*'([^']{1,200})'/gi,
  new RegExp(`\\bSET\\s+(?:SESSION\\s+|LOCAL\\s+)?(${NAME})\\s*(?:=|\\bTO\\b)`, 'gi'),
  new RegExp(`\\bRESET\\s+(${NAME})`, 'gi'),
  new RegExp(`\\bSHOW\\s+(${NAME})`, 'gi'),
];

/**
 * Finds custom GUC names a statement (or a function body) refers to. Reading counts too: code that reads a setting
 * is the code whose result a leaked value would change. Names built at run time (format('app.%s', x)) are not found.
 */
export function extractCustomGucNames(sql: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of sql.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      // Quoted identifiers keep their case; unquoted ones fold to lower case, as PostgreSQL's GUC lookup does.
      const name = raw
        .split('.')
        .map((part) => (part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase()))
        .join('.');
      if (CustomGucNameSchema.safeParse(name).success) found.add(name);
    }
  }
  return [...found];
}

/** Adds names to a registry up to MAX_CUSTOM_GUC_NAMES; returns how many were new. */
export function rememberCustomGucNames(registry: Set<string>, names: readonly string[]): number {
  let added = 0;
  for (const name of names) {
    if (registry.size >= MAX_CUSTOM_GUC_NAMES) break;
    if (!registry.has(name)) {
      registry.add(name);
      added += 1;
    }
  }
  return added;
}
