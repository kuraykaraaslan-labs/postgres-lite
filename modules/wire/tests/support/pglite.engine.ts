import { PGlite } from '@electric-sql/pglite';

import type { EngineHandle } from '../../../engine/engine.types.js';
import WireCodec from '../../wire.codec.js';

/**
 * An in-process, in-memory PGlite wrapped as an EngineHandle, for the wire tests only (the real engine module is
 * built separately). It mirrors what the spike found the engine module needs to do:
 * - Run PGlite's own startup once, so the backend reports GUC changes (ParameterStatus after SET); without it a
 *   SET application_name produces no ParameterStatus at all.
 * - Use execProtocolRawStream, not execProtocolRaw: the latter also parses every result into a list PGlite never
 *   clears in raw mode (24 MB of heap per 50 000 calls in the spike); the stream variant keeps nothing.
 */
export default class PgliteTestEngine {
  static async create(): Promise<EngineHandle & { pglite: PGlite }> {
    const pglite = await PGlite.create();
    const startup = PgliteTestEngine.startupPacket();
    await PgliteTestEngine.call(pglite, startup);
    // The startup leaves pending ParameterStatus reports that would otherwise be attached to the first client reply.
    await PgliteTestEngine.call(pglite, WireCodec.sync());
    return {
      pglite,
      execProtocolRaw: (messages: Uint8Array) => PgliteTestEngine.call(pglite, messages),
      close: () => pglite.close(),
    };
  }

  static async call(pglite: PGlite, messages: Uint8Array): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    // onRawData hands out a view of PGlite's reused buffer, so each piece is copied before the next one overwrites it.
    await pglite.execProtocolRawStream(messages, { syncToFs: false, onRawData: (data) => parts.push(data.slice()) });
    return parts.length === 1 ? (parts[0] as Uint8Array) : WireCodec.concat(parts);
  }

  static startupPacket(): Uint8Array {
    const body = WireCodec.concat([WireCodec.int32(3 << 16), WireCodec.cstring('user'), WireCodec.cstring('postgres'), WireCodec.cstring('database'), WireCodec.cstring('postgres'), new Uint8Array([0])]);
    return WireCodec.concat([WireCodec.int32(body.length + 4), body]);
  }
}
