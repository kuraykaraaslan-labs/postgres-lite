import { z } from 'zod';

/*
 * Messages between the main thread (engine.host.ts) and an engine worker (engine.worker.ts). Both sides parse what
 * they receive: a worker that went wrong must not be able to feed the host anything but a well-formed message.
 */

export const EngineExtensionEnum = z.enum(['amcheck']);

export const EngineStorageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('memory') }),
  z.object({ kind: z.literal('disk'), dataDir: z.string().min(1) }),
]);

const Bytes = z.instanceof(Uint8Array);
const RequestId = z.number().int().nonnegative();

export const WorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    storage: EngineStorageSchema,
    durable: z.boolean().default(true),
    extensions: z.array(EngineExtensionEnum).default([]),
    settings: z.record(z.string().regex(/^[a-z_][a-z0-9_.]*$/), z.string()).default({}),
  }),
  z.object({ type: z.literal('exec'), id: RequestId, bytes: Bytes }),
  z.object({ type: z.literal('close'), id: RequestId }),
]);

export const WorkerResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), created: z.boolean() }),
  z.object({ type: z.literal('start-failed'), message: z.string() }),
  z.object({ type: z.literal('result'), id: RequestId, bytes: Bytes }),
  z.object({ type: z.literal('error'), id: RequestId, message: z.string() }),
  z.object({ type: z.literal('closed'), id: RequestId }),
]);

export type EngineExtension = z.infer<typeof EngineExtensionEnum>;
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
