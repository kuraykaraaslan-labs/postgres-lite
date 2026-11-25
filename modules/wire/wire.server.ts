import { createServer, type Server, type Socket } from 'node:net';

import Logger from '../../libs/logger/index.js';
import WireConnection, { type EngineGate, type WireConnectionState } from './wire.connection.js';
import { WireMessages } from './wire.messages.js';
import type { WireServerHandle, WireServerOptions } from './wire.types.js';

/** First process id handed to clients in BackendKeyData; real backends use OS pids, which are never this low. */
const FIRST_PROCESS_ID = 1000;

/** A TCP server speaking the PostgreSQL protocol in front of one engine. */
export default class WireServer {
  static async start(options: WireServerOptions): Promise<WireServerHandle> {
    const gate: EngineGate = { engine: options.engine, tail: Promise.resolve() };
    const connections = new Set<WireConnectionState>();
    let nextId = FIRST_PROCESS_ID;

    const server: Server = createServer((socket: Socket) => {
      const state = WireConnection.open(socket, gate, nextId++);
      connections.add(state);
      void state.done.then(() => connections.delete(state));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port;
    Logger.info(WireMessages.LOG_LISTENING, { host: options.host, port });

    return {
      port,
      host: options.host,
      close: () => WireServer.close(server, connections),
    };
  }

  /** Stops accepting, closes every client and waits until each one's engine cleanup has finished. */
  static async close(server: Server, connections: Set<WireConnectionState>): Promise<void> {
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    const pending = [...connections].map((state) => {
      state.socket.destroy();
      return state.done;
    });
    await Promise.all(pending);
    await stopped;
    Logger.info(WireMessages.LOG_CLOSED);
  }
}
