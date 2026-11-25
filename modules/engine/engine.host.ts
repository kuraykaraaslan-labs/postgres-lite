import type { Worker } from 'node:worker_threads';

import Logger from '../../libs/logger/index.js';
import { WorkerResponseSchema, type EngineExtension, type WorkerResponse } from './engine.dto.js';
import { EngineMessages } from './engine.messages.js';
import type { EngineHandle, EngineStorage } from './engine.types.js';
import EngineWorkerPath from './engine.worker-path.js';

export interface EngineHostOptions {
  durable?: boolean;
  extensions?: EngineExtension[];
  settings?: Record<string, string>;
  /** Terminates the worker if the engine has not started by then (a damaged directory can hang PostgreSQL). */
  startTimeoutMs?: number;
}

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Main-thread side of an engine running in a worker_thread (storage rule 3). Bytes cross the thread boundary as
 * transferred ArrayBuffers; the caller's buffer is copied first, so it stays usable after the call.
 */
export class WorkerEngine implements EngineHandle {
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #dead: Error | undefined;
  readonly #exited: Promise<number>;

  constructor(private readonly worker: Worker) {
    this.#exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.on('message', (raw: unknown) => this.onMessage(raw));
    worker.on('error', (error: Error) => this.fail(error));
    worker.on('exit', (code: number) => this.fail(new Error(`${EngineMessages.WORKER_EXITED} (code ${code})`)));
  }

  get alive(): boolean {
    return this.#dead === undefined;
  }

  get threadId(): number {
    return this.worker.threadId;
  }

  async execProtocolRaw(messages: Uint8Array): Promise<Uint8Array> {
    const bytes = messages.slice();
    const response = await this.request((id) => this.worker.postMessage({ type: 'exec', id, bytes }, [bytes.buffer]));
    if (response.type === 'result') return response.bytes;
    throw new Error(response.type === 'error' ? response.message : EngineMessages.WORKER_BAD_MESSAGE);
  }

  async close(): Promise<void> {
    if (this.#dead !== undefined) return;
    const response = await this.request((id) => this.worker.postMessage({ type: 'close', id }));
    if (response.type === 'error') throw new Error(response.message);
    await this.#exited;
    Logger.debug(`[WorkerEngine.close] ${EngineMessages.ENGINE_CLOSED}`, { threadId: this.worker.threadId });
  }

  /**
   * Ends the engine at once, whatever it is doing. Pending requests fail. Nothing is checkpointed: the next open of the
   * directory runs crash recovery, which with storage rule 1 keeps every acknowledged commit.
   */
  async terminate(): Promise<void> {
    this.fail(new Error(EngineMessages.WORKER_TERMINATED));
    await this.worker.terminate();
  }

  /** Waits for the worker's start reply; used once by EngineHost.start. */
  waitStarted(): Promise<WorkerResponse> {
    return this.request(() => undefined, -1);
  }

  private request(send: (id: number) => void, fixedId?: number): Promise<WorkerResponse> {
    if (this.#dead !== undefined) return Promise.reject(this.#dead);
    const id = fixedId ?? this.#nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        send(id);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(raw: unknown): void {
    const parsed = WorkerResponseSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`[WorkerEngine.onMessage] ${EngineMessages.WORKER_BAD_MESSAGE}`, { threadId: this.worker.threadId });
      return;
    }
    const response = parsed.data;
    const id = response.type === 'started' || response.type === 'start-failed' ? -1 : response.id;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.resolve(response);
  }

  private fail(error: Error): void {
    if (this.#dead === undefined) this.#dead = error;
    for (const pending of this.#pending.values()) pending.reject(this.#dead);
    this.#pending.clear();
  }
}

/** Starts PGlite engines in worker threads. */
export default class EngineHost {
  static async start(storage: EngineStorage, options: EngineHostOptions = {}): Promise<WorkerEngine> {
    const worker = EngineWorkerPath.spawn();
    const engine = new WorkerEngine(worker);
    const started = engine.waitStarted();
    worker.postMessage({
      type: 'start',
      storage,
      durable: options.durable ?? true,
      extensions: options.extensions ?? [],
      settings: options.settings ?? {},
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (options.startTimeoutMs === undefined) return;
      timer = setTimeout(() => reject(new Error(EngineMessages.WORKER_START_TIMEOUT)), options.startTimeoutMs);
    });
    let response: WorkerResponse;
    try {
      response = await Promise.race([started, timeout]);
    } catch (error) {
      await engine.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.type !== 'started') {
      await worker.terminate();
      throw new Error(`${EngineMessages.WORKER_START_FAILED}: ${response.type === 'start-failed' ? response.message : response.type}`);
    }
    return engine;
  }
}
