/** Error and log messages of the engine module. Log messages carry their `[Class.method]` prefix where they are used. */
export enum EngineMessages {
  NODEFS_SHAPE = 'PGlite NODEFS does not have the shape postgres-lite patches (stream_ops, node_ops, tryFSOperation, realPath); the PGlite version is not supported',
  FSYNC_INSTALLED = 'fsync installed on NODEFS',
  INITDB_SYNCED = 'new data directory fsynced after initdb',
  DURABILITY_SETTING_REFUSED = 'This setting would turn durability off and cannot be passed to a durable engine',
  ENGINE_OPENED = 'engine opened',
  ENGINE_CLOSED = 'engine closed',
  WORKER_NOT_STARTED = 'Engine worker is not running',
  WORKER_EXITED = 'Engine worker exited',
  WORKER_TERMINATED = 'Engine worker was terminated',
  WORKER_BAD_MESSAGE = 'Engine worker sent a malformed message',
  WORKER_BAD_REQUEST = 'Engine worker received a malformed request',
  WORKER_START_FAILED = 'Engine worker failed to start the engine',
  WORKER_START_TIMEOUT = 'Engine worker did not start the engine in time',
  WORKER_ALREADY_STARTED = 'Engine worker already has an engine',
  WORKER_NO_PARENT = 'engine.worker must run inside a worker_thread',
  WORKER_SOURCE_LOADER = 'Running the engine worker from TypeScript source needs rolldown (installed with vitest/vite); build with tsc to run it from dist/',
}
