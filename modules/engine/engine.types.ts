/**
 * The contract between the wire server (modules/wire, modules/session) and the PostgreSQL engines (modules/engine).
 * One EngineHandle is one PGlite instance, i.e. one database, wherever it runs (in-process or in a worker thread).
 */
export interface EngineHandle {
  /**
   * Sends complete frontend protocol messages (never the startup packet, which the wire server handles itself)
   * and resolves with every backend message the engine produced for them, as raw bytes.
   */
  execProtocolRaw(messages: Uint8Array): Promise<Uint8Array>;

  /** Clean close: the engine checkpoints and releases its files. */
  close(): Promise<void>;
}

/** Where an engine keeps its data. */
export type EngineStorage = { kind: 'memory' } | { kind: 'disk'; dataDir: string };
