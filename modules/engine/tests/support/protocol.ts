/** Minimal frontend/backend protocol helpers for engine tests: a simple Query and a reader for what comes back. */

export function simpleQuery(sql: string): Uint8Array {
  const body = Buffer.from(`${sql}\0`, 'utf8');
  const out = Buffer.alloc(5 + body.length);
  out.write('Q', 0, 'ascii');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export interface QueryReply {
  rows: (string | null)[][];
  commands: string[];
  errors: string[];
  /** Transaction status from the last ReadyForQuery: I, T or E. */
  status: string | undefined;
}

export function readReply(bytes: Uint8Array): QueryReply {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reply: QueryReply = { rows: [], commands: [], errors: [], status: undefined };
  let at = 0;
  while (at + 5 <= buf.length) {
    const type = String.fromCharCode(buf.readUInt8(at));
    const length = buf.readInt32BE(at + 1);
    if (length < 4 || at + 1 + length > buf.length) throw new Error(`truncated backend message ${type} at ${at}`);
    const body = buf.subarray(at + 5, at + 1 + length);
    if (type === 'D') {
      const row: (string | null)[] = [];
      let p = 2;
      for (let i = 0; i < body.readInt16BE(0); i++) {
        const len = body.readInt32BE(p);
        p += 4;
        if (len < 0) row.push(null);
        else {
          row.push(body.subarray(p, p + len).toString('utf8'));
          p += len;
        }
      }
      reply.rows.push(row);
    } else if (type === 'C') reply.commands.push(body.subarray(0, body.length - 1).toString('utf8'));
    else if (type === 'E') {
      const fields = body.toString('utf8').split('\0');
      reply.errors.push(fields.find((f) => f.startsWith('M'))?.slice(1) ?? 'unknown error');
    } else if (type === 'Z') reply.status = String.fromCharCode(body.readUInt8(0));
    at += 1 + length;
  }
  return reply;
}
