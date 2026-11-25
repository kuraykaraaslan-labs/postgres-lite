import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

import Logger from '../../libs/logger/index.js';
import type { EngineHandle } from '../engine/engine.types.js';
import WireCodec from './wire.codec.js';
import WireGuard from './wire.guard.js';
import { WireMessages } from './wire.messages.js';
import WireStartup from './wire.startup.js';
import type { ErrorFields, FrontendFrame, TransactionStatus } from './wire.types.js';

/** What every connection of one server shares: the engine and the queue that keeps its calls one at a time. */
export type EngineGate = {
  engine: EngineHandle;
  /** Tail of the chain of engine calls; each call starts only after the previous one settled. */
  tail: Promise<unknown>;
};

export type WireConnectionState = {
  id: number;
  socket: Socket;
  gate: EngineGate;
  phase: 'startup' | 'ready' | 'closed';
  /** Received bytes not yet consumed, kept as chunks so a large message is not re-copied on every TCP read. */
  chunks: Uint8Array[];
  buffered: number;
  /** Bytes that must be buffered before the next packet can be complete. */
  needed: number;
  processing: boolean;
  /** True once this connection sent anything to the engine, so the engine needs cleaning when it leaves. */
  touchedEngine: boolean;
  status: TransactionStatus;
  /** Resolves when the connection has been closed and the engine cleaned. */
  done: Promise<void>;
  resolveDone: () => void;
};

/** RESET-like cleanup after a client leaves, so the next connection starts from a fresh session. */
const CLEANUP = WireCodec.concat([WireCodec.sync(), WireCodec.query('ROLLBACK'), WireCodec.query('DISCARD ALL')]);

/** One client connection: startup handshake, then forwarding of complete frontend messages to the engine. */
export default class WireConnection {
  static open(socket: Socket, gate: EngineGate, id: number): WireConnectionState {
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const state: WireConnectionState = {
      id,
      socket,
      gate,
      phase: 'startup',
      chunks: [],
      buffered: 0,
      needed: 4,
      processing: false,
      touchedEngine: false,
      status: 'I',
      done,
      resolveDone,
    };
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => WireConnection.handleData(state, chunk));
    socket.on('error', (error) => Logger.debug(WireMessages.LOG_SOCKET_ERROR, { connectionId: id, error: error.message }));
    socket.on('close', () => void WireConnection.close(state));
    Logger.debug(WireMessages.LOG_CONNECTION_OPENED, { connectionId: id });
    return state;
  }

  /** Runs `call` once every earlier engine call of this server has settled. */
  static exclusive<T>(gate: EngineGate, call: (engine: EngineHandle) => Promise<T>): Promise<T> {
    const result = gate.tail.then(() => call(gate.engine));
    gate.tail = result.catch(() => undefined);
    return result;
  }

  static handleData(state: WireConnectionState, chunk: Uint8Array): void {
    if (state.phase === 'closed') return;
    state.chunks.push(chunk);
    state.buffered += chunk.length;
    if (!state.processing) void WireConnection.drain(state);
  }

  /** Consumes buffered packets in order; only one drain runs per connection, so responses never interleave. */
  static async drain(state: WireConnectionState): Promise<void> {
    state.processing = true;
    try {
      while (state.phase !== 'closed' && state.buffered >= state.needed) {
        const taken = state.chunks.length;
        const buffer = taken === 1 ? (state.chunks[0] as Uint8Array) : WireCodec.concat(state.chunks);
        const rest = state.phase === 'startup' ? await WireConnection.handleStartup(state, buffer) : await WireConnection.handleMessages(state, buffer);
        if (rest === null) return;
        // Chunks that arrived while the engine was busy stay queued behind the unconsumed tail.
        const arrived = state.chunks.slice(taken);
        state.chunks = rest.length > 0 ? [rest, ...arrived] : arrived;
        state.buffered = state.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      }
    } catch (error) {
      Logger.warn(WireMessages.LOG_ENGINE_ERROR, { connectionId: state.id, error: error instanceof Error ? error.message : String(error) });
      await WireConnection.fail(state, WireStartup.fatal('XX000', WireMessages.ENGINE_FAILED));
    } finally {
      state.processing = false;
    }
  }

  /** Handles one startup-phase packet; returns the unconsumed bytes, or null once the connection is closing. */
  static async handleStartup(state: WireConnectionState, buffer: Uint8Array): Promise<Uint8Array | null> {
    const split = WireCodec.splitStartupPacket(buffer);
    if (split.kind === 'incomplete') {
      state.needed = buffer.length >= 4 ? WireCodec.readInt32(buffer, 0) : 4;
      return buffer;
    }
    if (split.kind === 'error') {
      Logger.debug(WireMessages.LOG_PROTOCOL_VIOLATION, { connectionId: state.id, reason: split.reason });
      await WireConnection.fail(state, WireStartup.fatal('08P01', split.reason === 'too-large' ? WireMessages.STARTUP_PACKET_TOO_LARGE : WireMessages.STARTUP_PACKET_INVALID));
      return null;
    }
    state.needed = 4;
    const packet = split.packet;
    switch (packet.kind) {
      case 'ssl':
      case 'gssenc':
        // No TLS or GSS encryption: 'N' tells the client to continue in plain text on the same socket.
        await WireConnection.write(state, new Uint8Array([0x4e]));
        return split.rest;
      case 'cancel':
        // CancelRequest arrives on its own connection, which PostgreSQL closes without a reply (Phase A acts on it).
        WireConnection.end(state);
        return null;
      case 'invalid':
        await WireConnection.fail(state, WireStartup.fatal('08P01', WireMessages.STARTUP_PACKET_INVALID));
        return null;
      case 'startup':
        break;
    }
    const decision = WireStartup.decide(packet);
    if (decision.kind === 'reject') {
      await WireConnection.fail(state, decision.error);
      return null;
    }
    state.touchedEngine = true;
    const setup = await WireConnection.exclusive(state.gate, (engine) => WireStartup.setupSession(engine, decision.parameters));
    if (setup.kind === 'error') {
      if (decision.negotiation !== null) await WireConnection.write(state, decision.negotiation);
      await WireConnection.fail(state, setup.error);
      return null;
    }
    const greeting = WireStartup.greeting(setup.reported, state.id, randomBytes(4));
    await WireConnection.write(state, decision.negotiation === null ? greeting : WireCodec.concat([decision.negotiation, greeting]));
    state.phase = 'ready';
    state.needed = 5;
    return split.rest;
  }

  /** Forwards every complete message in `buffer`; returns the incomplete tail, or null once closing. */
  static async handleMessages(state: WireConnectionState, buffer: Uint8Array): Promise<Uint8Array | null> {
    const split = WireCodec.splitFrontendMessages(buffer);
    if (split.kind === 'error') {
      Logger.debug(WireMessages.LOG_PROTOCOL_VIOLATION, { connectionId: state.id, reason: split.reason });
      await WireConnection.fail(state, WireStartup.fatal('08P01', WireMessages.MESSAGE_TOO_LARGE));
      return null;
    }
    const batch: Uint8Array[] = [];
    for (const frame of split.frames) {
      if (frame.type === 'X') {
        await WireConnection.forward(state, batch);
        WireConnection.end(state);
        return null;
      }
      if (!WireGuard.isForwardable(frame.type)) {
        await WireConnection.forward(state, batch);
        Logger.debug(WireMessages.LOG_PROTOCOL_VIOLATION, { connectionId: state.id, messageType: frame.type.charCodeAt(0) });
        await WireConnection.fail(state, WireStartup.fatal('08P01', `${WireMessages.MESSAGE_TYPE_INVALID} ${frame.type.charCodeAt(0)}`));
        return null;
      }
      batch.push(WireConnection.guarded(state, frame));
    }
    // Everything that arrived together goes to the engine in one call, which keeps client pipelines intact.
    await WireConnection.forward(state, batch);
    state.needed = WireCodec.bytesNeeded(split.rest);
    return split.rest;
  }

  static guarded(state: WireConnectionState, frame: FrontendFrame): Uint8Array {
    const { bytes, refused } = WireGuard.rewrite(frame);
    if (refused) Logger.debug(WireMessages.LOG_COPY_REFUSED, { connectionId: state.id });
    return bytes;
  }

  /** Sends a batch of frames to the engine and writes its whole output back to the client unchanged. */
  static async forward(state: WireConnectionState, frames: Uint8Array[]): Promise<void> {
    if (frames.length === 0) return;
    const input = frames.length === 1 ? (frames[0] as Uint8Array) : WireCodec.concat(frames);
    state.touchedEngine = true;
    const output = await WireConnection.exclusive(state.gate, (engine) => engine.execProtocolRaw(input));
    const status = WireCodec.lastReadyForQueryStatus(output);
    if (status !== null) state.status = status;
    if (output.length > 0) await WireConnection.write(state, output);
  }

  /** Sends a FATAL ErrorResponse and closes, as PostgreSQL does on a protocol violation. */
  static async fail(state: WireConnectionState, error: ErrorFields): Promise<void> {
    await WireConnection.write(state, WireCodec.errorResponse(error));
    WireConnection.end(state);
  }

  static end(state: WireConnectionState): void {
    if (!state.socket.destroyed) state.socket.end();
  }

  /** Writes with backpressure: waits for 'drain' when the socket's buffer is full. */
  static write(state: WireConnectionState, bytes: Uint8Array): Promise<void> {
    const socket = state.socket;
    if (socket.destroyed || !socket.writable) return Promise.resolve();
    if (socket.write(bytes)) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = (): void => {
        socket.off('drain', settle);
        socket.off('close', settle);
        resolve();
      };
      socket.on('drain', settle);
      socket.on('close', settle);
    });
  }

  /**
   * Runs once when the socket closes, by Terminate, by the client or by the server. A client may leave in the middle
   * of a transaction or of an unsynced extended-protocol batch; the engine is single-session, so it is reset before
   * the next connection uses it.
   */
  static async close(state: WireConnectionState): Promise<void> {
    if (state.phase === 'closed') return;
    state.phase = 'closed';
    state.chunks = [];
    state.buffered = 0;
    try {
      if (state.touchedEngine) {
        const output = await WireConnection.exclusive(state.gate, (engine) => engine.execProtocolRaw(CLEANUP));
        const status = WireCodec.lastReadyForQueryStatus(output);
        if (status !== 'I') Logger.warn(WireMessages.LOG_CLEANUP_FAILED, { connectionId: state.id, status: status ?? 'none' });
      }
    } catch (error) {
      Logger.warn(WireMessages.LOG_CLEANUP_FAILED, { connectionId: state.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      Logger.debug(WireMessages.LOG_CONNECTION_CLOSED, { connectionId: state.id });
      state.resolveDone();
    }
  }
}
