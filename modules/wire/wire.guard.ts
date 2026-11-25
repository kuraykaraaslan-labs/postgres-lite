import WireCodec from './wire.codec.js';
import { WireMessages } from './wire.messages.js';
import type { FrontendFrame } from './wire.types.js';

/**
 * Frontend message types PGlite handles without harm after startup. Anything else is refused by the server:
 * PGlite 0.5.16 hangs forever (a synchronous spin, the event loop blocked) on an unknown type or a stray
 * PasswordMessage ('p'), instead of ending the session as PostgreSQL does.
 */
const FORWARDABLE_TYPES = new Set(['Q', 'P', 'B', 'D', 'E', 'S', 'H', 'C', 'F', 'd', 'c', 'f']);

/**
 * The words COPY, FROM and STDIN in that order anywhere in the text, comments and string literals included. Keywords
 * cannot be escaped in SQL, so this cannot miss a real `COPY ... FROM STDIN`, whatever comments, quoted names or
 * statements come before or between them; one missed COPY kills the engine, while a false refusal only fails one
 * statement, so the check errs that way.
 */
const COPY_FROM_STDIN = /\bcopy\b[\s\S]*?\bfrom\b[\s\S]*?\bstdin\b/i;

/**
 * Raises 0A000 inside the engine, so the engine itself produces the ErrorResponse, marks an open transaction
 * failed and (in the extended protocol) skips to Sync exactly as it does for any other error.
 */
const COPY_REFUSAL_SQL = `DO $postgres_lite$BEGIN RAISE EXCEPTION USING ERRCODE = 'feature_not_supported', MESSAGE = '${WireMessages.COPY_FROM_STDIN_UNSUPPORTED}'; END$postgres_lite$`;

/** Decides which client messages may reach the engine, and in what form. */
export default class WireGuard {
  static isForwardable(type: string): boolean {
    return FORWARDABLE_TYPES.has(type);
  }

  /**
   * PGlite runs COPY FROM STDIN only when CopyData and CopyDone arrive in the same execProtocolRaw call as the
   * COPY itself; a COPY sent alone ends the WASM PostgreSQL with exit(1) and the next call spins forever. Until
   * the server buffers COPY (Phase A), such statements are rewritten to fail cleanly.
   * This is a text check, not a parser: any text with these three words in order, even in a
   * string literal or comment, is refused too.
   */
  static isCopyFromStdin(sql: string): boolean {
    return COPY_FROM_STDIN.test(sql);
  }

  /** The frame to forward in place of `frame`: unchanged, or a statement that fails with 0A000. */
  static rewrite(frame: FrontendFrame): { bytes: Uint8Array; refused: boolean } {
    if (frame.type !== 'Q' && frame.type !== 'P') return { bytes: frame.bytes, refused: false };
    const sql = WireCodec.readSqlText(frame);
    if (sql === null || !WireGuard.isCopyFromStdin(sql)) return { bytes: frame.bytes, refused: false };
    if (frame.type === 'Q') return { bytes: WireCodec.query(COPY_REFUSAL_SQL), refused: true };
    // COPY takes no parameters, so the client's Bind for it supplies none and matches the DO statement.
    const name = WireCodec.readParseStatementName(frame) ?? '';
    return { bytes: WireCodec.parse(name, COPY_REFUSAL_SQL), refused: true };
  }
}
