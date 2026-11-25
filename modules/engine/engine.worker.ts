import { parentPort, type MessagePort } from 'node:worker_threads';

import type { Extensions, PGlite } from '@electric-sql/pglite';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';

import Logger from '../../libs/logger/index.js';
import { WorkerRequestSchema, type EngineExtension, type WorkerRequest, type WorkerResponse } from './engine.dto.js';
import { EngineMessages } from './engine.messages.js';
import EngineOpen from './engine.open.js';

/*
 * Worker-thread entry: one PGlite engine per worker (storage rule 3). PGlite's execProtocolRaw runs PostgreSQL
 * synchronously, so a long statement blocks only this thread, and the host can end it with Worker.terminate().
 */

const EXTENSIONS: Record<EngineExtension, Extensions[string]> = { amcheck };

/** Transfers a buffer only when the view owns all of it; anything else is copied first. */
function ownedBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return new Uint8Array(buffer);
  }
  return bytes.slice();
}

export default class EngineWorker {
  private static pg: PGlite | undefined;
  private static queue: Promise<void> = Promise.resolve();

  static run(port: MessagePort): void {
    port.on('message', (raw: unknown) => {
      // One request at a time, in arrival order: PGlite has a single backend.
      EngineWorker.queue = EngineWorker.queue.then(() => EngineWorker.handle(port, raw));
    });
  }

  private static send(port: MessagePort, message: WorkerResponse): void {
    if (message.type === 'result') port.postMessage(message, [message.bytes.buffer]);
    else port.postMessage(message);
  }

  private static async handle(port: MessagePort, raw: unknown): Promise<void> {
    const parsed = WorkerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`[EngineWorker.handle] ${EngineMessages.WORKER_BAD_REQUEST}`, { issues: parsed.error.issues.length });
      return;
    }
    const request: WorkerRequest = parsed.data;
    switch (request.type) {
      case 'start':
        return EngineWorker.start(port, request);
      case 'exec':
        return EngineWorker.exec(port, request.id, request.bytes);
      case 'close':
        return EngineWorker.close(port, request.id);
    }
  }

  private static async start(port: MessagePort, request: Extract<WorkerRequest, { type: 'start' }>): Promise<void> {
    if (EngineWorker.pg !== undefined) {
      EngineWorker.send(port, { type: 'start-failed', message: EngineMessages.WORKER_ALREADY_STARTED });
      return;
    }
    try {
      const extensions: Extensions = {};
      for (const name of request.extensions) extensions[name] = EXTENSIONS[name];
      const { pg, created } = await EngineOpen.open(request.storage, {
        durable: request.durable,
        extensions,
        settings: request.settings,
      });
      EngineWorker.pg = pg;
      EngineWorker.send(port, { type: 'started', created });
    } catch (error) {
      EngineWorker.send(port, { type: 'start-failed', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private static async exec(port: MessagePort, id: number, bytes: Uint8Array): Promise<void> {
    const pg = EngineWorker.pg;
    if (pg === undefined) {
      EngineWorker.send(port, { type: 'error', id, message: EngineMessages.WORKER_NOT_STARTED });
      return;
    }
    try {
      const result = await pg.execProtocolRaw(bytes);
      EngineWorker.send(port, { type: 'result', id, bytes: ownedBuffer(result) });
    } catch (error) {
      EngineWorker.send(port, { type: 'error', id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private static async close(port: MessagePort, id: number): Promise<void> {
    const pg = EngineWorker.pg;
    EngineWorker.pg = undefined;
    try {
      if (pg !== undefined) await pg.close();
      EngineWorker.send(port, { type: 'closed', id });
    } catch (error) {
      EngineWorker.send(port, { type: 'error', id, message: error instanceof Error ? error.message : String(error) });
    }
    // Nothing else keeps the worker alive once the port is closed, so it exits on its own.
    port.close();
  }
}

if (parentPort === null) throw new Error(EngineMessages.WORKER_NO_PARENT);
EngineWorker.run(parentPort);
