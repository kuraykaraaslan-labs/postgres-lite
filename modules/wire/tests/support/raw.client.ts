import { connect, type Socket } from 'node:net';

import WireCodec from '../../wire.codec.js';

export type BackendMessage = { type: string; body: Uint8Array };

/** A bare TCP client for protocol tests that the 'pg' driver cannot express (byte-by-byte writes, raw startup). */
export default class RawClient {
  static async connect(port: number): Promise<{ socket: Socket; received: () => Uint8Array; closed: Promise<void> }> {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setNoDelay(true);
    const chunks: Uint8Array[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    return { socket, received: () => WireCodec.concat(chunks), closed };
  }

  /** A StartupMessage for protocol `major.minor` with the given parameters. */
  static startup(parameters: Record<string, string>, major = 3, minor = 0): Uint8Array {
    const parts: Uint8Array[] = [WireCodec.int32((major << 16) | minor)];
    for (const [name, value] of Object.entries(parameters)) parts.push(WireCodec.cstring(name), WireCodec.cstring(value));
    parts.push(new Uint8Array([0]));
    const body = WireCodec.concat(parts);
    return WireCodec.concat([WireCodec.int32(body.length + 4), body]);
  }

  static sslRequest(): Uint8Array {
    return WireCodec.concat([WireCodec.int32(8), WireCodec.int32(80877103)]);
  }

  static terminate(): Uint8Array {
    return WireCodec.message('X', new Uint8Array(0));
  }

  static messages(bytes: Uint8Array): BackendMessage[] {
    const out: BackendMessage[] = [];
    WireCodec.forEachBackendMessage(bytes, (type, body) => out.push({ type, body: body.slice() }));
    return out;
  }

  /** Waits until `received()` satisfies `done`, or fails after `timeoutMs`. */
  static async until(received: () => Uint8Array, done: (bytes: Uint8Array) => boolean, timeoutMs = 10_000): Promise<Uint8Array> {
    const started = Date.now();
    for (;;) {
      const bytes = received();
      if (done(bytes)) return bytes;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out; received ${bytes.length} bytes`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  static countType(bytes: Uint8Array, type: string): number {
    return RawClient.messages(bytes).filter((m) => m.type === type).length;
  }
}
