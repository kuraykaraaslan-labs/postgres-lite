import {
  StartupRequestCode,
  type ErrorFields,
  type FrameSplit,
  type FrontendFrame,
  type StartupPacket,
  type StartupSplit,
  type TransactionStatus,
} from './wire.types.js';

/** PostgreSQL refuses startup packets above this size (MAX_STARTUP_PACKET_LENGTH). */
export const MAX_STARTUP_PACKET_LENGTH = 10_000;

/** PostgreSQL's PQ_LARGE_MESSAGE_LIMIT: the largest frontend message it accepts. */
export const MAX_MESSAGE_LENGTH = 0x3fff_ffff;

/** The protocol version this server speaks; clients asking for a newer 3.x minor are negotiated down to it. */
export const PROTOCOL_MAJOR = 3;
export const PROTOCOL_MINOR = 0;

const utf8 = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

/**
 * Framing, parsing and building of PostgreSQL protocol 3 messages. Every read is bounds-checked: input comes
 * straight from a socket or from the engine and is never trusted to be well formed.
 */
export default class WireCodec {
  // ==========================================================================
  // Startup phase
  // ==========================================================================

  /** Reads one startup-phase packet (no type byte) from the front of `buffer`, if it is complete. */
  static splitStartupPacket(buffer: Uint8Array): StartupSplit {
    if (buffer.length < 4) return { kind: 'incomplete' };
    const length = WireCodec.readInt32(buffer, 0);
    if (length < 8) return { kind: 'error', reason: 'too-small' };
    if (length > MAX_STARTUP_PACKET_LENGTH) return { kind: 'error', reason: 'too-large' };
    if (buffer.length < length) return { kind: 'incomplete' };
    const packet = WireCodec.parseStartupPacket(buffer.subarray(4, length));
    return { kind: 'packet', packet, rest: buffer.subarray(length) };
  }

  /** Parses the body of a startup packet (after its length word). */
  static parseStartupPacket(body: Uint8Array): StartupPacket {
    if (body.length < 4) return { kind: 'invalid', reason: 'short' };
    const code = WireCodec.readInt32(body, 0) >>> 0;
    if (code === StartupRequestCode.SSL) return body.length === 4 ? { kind: 'ssl' } : { kind: 'invalid', reason: 'ssl length' };
    if (code === StartupRequestCode.GSSENC) return body.length === 4 ? { kind: 'gssenc' } : { kind: 'invalid', reason: 'gssenc length' };
    if (code === StartupRequestCode.CANCEL) {
      // Protocol 3.2 allows a longer secret key (up to 256 bytes); 3.0 always sends 4.
      if (body.length < 12 || body.length > 8 + 256) return { kind: 'invalid', reason: 'cancel length' };
      return { kind: 'cancel', processId: WireCodec.readInt32(body, 4), secretKey: body.slice(8) };
    }
    const major = code >>> 16;
    const minor = code & 0xffff;
    const parameters: Array<[string, string]> = [];
    let offset = 4;
    for (;;) {
      if (offset >= body.length) return { kind: 'invalid', reason: 'missing terminator' };
      if (body[offset] === 0) {
        if (offset !== body.length - 1) return { kind: 'invalid', reason: 'data after terminator' };
        break;
      }
      const name = WireCodec.readCString(body, offset);
      if (name === null) return { kind: 'invalid', reason: 'unterminated name' };
      const value = WireCodec.readCString(body, name.next);
      if (value === null) return { kind: 'invalid', reason: 'unterminated value' };
      parameters.push([name.value, value.value]);
      offset = value.next;
    }
    return { kind: 'startup', major, minor, parameters };
  }

  // ==========================================================================
  // Frontend messages after startup
  // ==========================================================================

  /**
   * Splits every complete message off the front of `buffer`. `needed` in the caller is the size the buffer must
   * reach before calling again; see `bytesNeeded`.
   */
  static splitFrontendMessages(buffer: Uint8Array): FrameSplit<FrontendFrame> {
    const frames: FrontendFrame[] = [];
    let offset = 0;
    while (buffer.length - offset >= 5) {
      const declaredLength = WireCodec.readInt32(buffer, offset + 1);
      if (declaredLength < 4) return { kind: 'error', reason: 'too-small', declaredLength };
      if (declaredLength > MAX_MESSAGE_LENGTH) return { kind: 'error', reason: 'too-large', declaredLength };
      const end = offset + 1 + declaredLength;
      if (end > buffer.length) break;
      const bytes = buffer.subarray(offset, end);
      frames.push({ type: String.fromCharCode(bytes[0] ?? 0), bytes, body: bytes.subarray(5) });
      offset = end;
    }
    return { kind: 'frames', frames, rest: buffer.subarray(offset) };
  }

  /** How many bytes the buffer must hold before the next frame can be complete. */
  static bytesNeeded(rest: Uint8Array): number {
    if (rest.length < 5) return 5;
    return 1 + WireCodec.readInt32(rest, 1);
  }

  /** The SQL text of a Query ('Q') or Parse ('P') message, or null if the body is malformed. */
  static readSqlText(frame: FrontendFrame): string | null {
    if (frame.type === 'Q') return WireCodec.readCString(frame.body, 0)?.value ?? null;
    if (frame.type === 'P') {
      const name = WireCodec.readCString(frame.body, 0);
      if (name === null) return null;
      return WireCodec.readCString(frame.body, name.next)?.value ?? null;
    }
    return null;
  }

  /** The statement name of a Parse message, or null if the body is malformed. */
  static readParseStatementName(frame: FrontendFrame): string | null {
    return frame.type === 'P' ? (WireCodec.readCString(frame.body, 0)?.value ?? null) : null;
  }

  static query(sql: string): Uint8Array {
    return WireCodec.message('Q', WireCodec.cstring(sql));
  }

  /** Parse with no declared parameter types. */
  static parse(statementName: string, sql: string): Uint8Array {
    return WireCodec.message('P', WireCodec.concat([WireCodec.cstring(statementName), WireCodec.cstring(sql), new Uint8Array(2)]));
  }

  /** Bind of the unnamed portal with text-format parameters and text-format results. */
  static bind(statementName: string, parameters: string[]): Uint8Array {
    const parts: Uint8Array[] = [WireCodec.cstring(''), WireCodec.cstring(statementName), WireCodec.int16(0), WireCodec.int16(parameters.length)];
    for (const value of parameters) {
      const bytes = encoder.encode(value);
      parts.push(WireCodec.int32(bytes.length), bytes);
    }
    parts.push(WireCodec.int16(0));
    return WireCodec.message('B', WireCodec.concat(parts));
  }

  static execute(): Uint8Array {
    return WireCodec.message('E', WireCodec.concat([WireCodec.cstring(''), WireCodec.int32(0)]));
  }

  static sync(): Uint8Array {
    return WireCodec.message('S', new Uint8Array(0));
  }

  // ==========================================================================
  // Backend messages built by the server
  // ==========================================================================

  static authenticationOk(): Uint8Array {
    return WireCodec.message('R', WireCodec.int32(0));
  }

  static parameterStatus(name: string, value: string): Uint8Array {
    return WireCodec.message('S', WireCodec.concat([WireCodec.cstring(name), WireCodec.cstring(value)]));
  }

  static backendKeyData(processId: number, secretKey: Uint8Array): Uint8Array {
    return WireCodec.message('K', WireCodec.concat([WireCodec.int32(processId), secretKey]));
  }

  static readyForQuery(status: TransactionStatus): Uint8Array {
    return WireCodec.message('Z', new Uint8Array([status.charCodeAt(0)]));
  }

  static negotiateProtocolVersion(newestMinor: number, unrecognisedOptions: string[]): Uint8Array {
    return WireCodec.message(
      'v',
      WireCodec.concat([WireCodec.int32(newestMinor), WireCodec.int32(unrecognisedOptions.length), ...unrecognisedOptions.map((o) => WireCodec.cstring(o))]),
    );
  }

  /** ErrorResponse; `fields` uses the protocol's one-letter codes (S, V, C, M, ...). */
  static errorResponse(fields: ErrorFields): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [code, value] of Object.entries(fields)) parts.push(encoder.encode(code.slice(0, 1)), WireCodec.cstring(value));
    parts.push(new Uint8Array([0]));
    return WireCodec.message('E', WireCodec.concat(parts));
  }

  // ==========================================================================
  // Reading backend output from the engine
  // ==========================================================================

  /** The status of the last ReadyForQuery in `output`, or null if it holds none (or is malformed). */
  static lastReadyForQueryStatus(output: Uint8Array): TransactionStatus | null {
    let status: TransactionStatus | null = null;
    WireCodec.forEachBackendMessage(output, (type, body) => {
      if (type !== 'Z' || body.length !== 1) return;
      const value = String.fromCharCode(body[0] ?? 0);
      if (value === 'I' || value === 'T' || value === 'E') status = value;
    });
    return status;
  }

  /** The fields of the first ErrorResponse in `output`, or null. */
  static firstError(output: Uint8Array): ErrorFields | null {
    let found: ErrorFields | null = null;
    WireCodec.forEachBackendMessage(output, (type, body) => {
      if (type === 'E' && found === null) found = WireCodec.parseErrorFields(body);
    });
    return found;
  }

  /** Text values of every DataRow in `output`, in order. */
  static dataRows(output: Uint8Array): Array<Array<string | null>> {
    const rows: Array<Array<string | null>> = [];
    WireCodec.forEachBackendMessage(output, (type, body) => {
      if (type !== 'D' || body.length < 2) return;
      const count = WireCodec.readInt16(body, 0);
      const row: Array<string | null> = [];
      let offset = 2;
      for (let i = 0; i < count; i++) {
        if (offset + 4 > body.length) return;
        const length = WireCodec.readInt32(body, offset);
        offset += 4;
        if (length === -1) {
          row.push(null);
          continue;
        }
        if (length < 0 || offset + length > body.length) return;
        row.push(utf8.decode(body.subarray(offset, offset + length)));
        offset += length;
      }
      rows.push(row);
    });
    return rows;
  }

  static parseErrorFields(body: Uint8Array): ErrorFields {
    const fields: ErrorFields = {};
    let offset = 0;
    while (offset < body.length && body[offset] !== 0) {
      const code = String.fromCharCode(body[offset] ?? 0);
      const value = WireCodec.readCString(body, offset + 1);
      if (value === null) break;
      fields[code] = value.value;
      offset = value.next;
    }
    return fields;
  }

  /** Calls `visit` for each complete backend message; stops quietly at a truncated or malformed frame. */
  static forEachBackendMessage(output: Uint8Array, visit: (type: string, body: Uint8Array) => void): void {
    let offset = 0;
    while (output.length - offset >= 5) {
      const length = WireCodec.readInt32(output, offset + 1);
      if (length < 4 || offset + 1 + length > output.length) return;
      visit(String.fromCharCode(output[offset] ?? 0), output.subarray(offset + 5, offset + 1 + length));
      offset += 1 + length;
    }
  }

  // ==========================================================================
  // Primitives
  // ==========================================================================

  static message(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(5 + body.length);
    out[0] = type.charCodeAt(0);
    new DataView(out.buffer).setInt32(1, 4 + body.length);
    out.set(body, 5);
    return out;
  }

  static readInt32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset);
  }

  static readInt16(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(offset);
  }

  /** A NUL-terminated UTF-8 string starting at `offset`, or null if no NUL follows inside the buffer. */
  static readCString(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
    if (offset < 0 || offset >= bytes.length) return null;
    const end = bytes.indexOf(0, offset);
    if (end === -1) return null;
    return { value: utf8.decode(bytes.subarray(offset, end)), next: end + 1 };
  }

  static cstring(value: string): Uint8Array {
    const bytes = encoder.encode(value);
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes, 0);
    return out;
  }

  static int32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setInt32(0, value);
    return out;
  }

  static int16(value: number): Uint8Array {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setInt16(0, value);
    return out;
  }

  static concat(parts: Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
