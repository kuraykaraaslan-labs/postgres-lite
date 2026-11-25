import type { LogLevel } from '../../modules/server/server.dto.js';

export type LogContext = {
  database?: string;
  connectionId?: number;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
};

const RANK: Record<LogLevel, number> = { silent: 0, warn: 1, info: 2, debug: 3 };

/** Keys whose values are never written, whatever the caller passes. */
const REDACTED = new Set(['password', 'secret', 'token', 'authorization']);

/**
 * Structured logger for a CLI dev tool: one line per event on stderr, a static message
 * prefixed with `[Service.method]` and the variable data in the context object.
 */
export default class Logger {
  private static level: LogLevel = 'warn';
  private static sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`);

  static setLevel(level: LogLevel): void {
    Logger.level = level;
  }

  /** Redirects output, for tests. */
  static setSink(sink: (line: string) => void): void {
    Logger.sink = sink;
  }

  static warn(message: string, context: LogContext = {}): void {
    Logger.write('warn', message, context);
  }

  static info(message: string, context: LogContext = {}): void {
    Logger.write('info', message, context);
  }

  static debug(message: string, context: LogContext = {}): void {
    Logger.write('debug', message, context);
  }

  private static write(level: Exclude<LogLevel, 'silent'>, message: string, context: LogContext): void {
    if (RANK[Logger.level] < RANK[level]) return;
    const fields = Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${REDACTED.has(key.toLowerCase()) ? '[redacted]' : JSON.stringify(value)}`);
    Logger.sink(`postgres-lite ${level.toUpperCase()} ${message}${fields.length ? ` ${fields.join(' ')}` : ''}`);
  }
}
