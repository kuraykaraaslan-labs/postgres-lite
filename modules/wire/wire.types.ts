import type { EngineHandle } from '../engine/engine.types.js';

/** One complete frontend message after the startup phase: type byte plus the whole frame, header included. */
export type FrontendFrame = {
  type: string;
  /** The full frame (type byte, Int32 length, body), ready to forward unchanged. */
  bytes: Uint8Array;
  /** The body only, a view into `bytes`. */
  body: Uint8Array;
};

/** Result of reading as many frames as a buffer holds. */
export type FrameSplit<T> =
  | { kind: 'frames'; frames: T[]; rest: Uint8Array }
  | { kind: 'error'; reason: 'too-large' | 'too-small'; declaredLength: number };

/** Codes of the special packets a client may send instead of a StartupMessage. */
export enum StartupRequestCode {
  CANCEL = 80877102,
  SSL = 80877103,
  GSSENC = 80877104,
}

export type StartupPacket =
  | { kind: 'ssl' }
  | { kind: 'gssenc' }
  | { kind: 'cancel'; processId: number; secretKey: Uint8Array }
  | { kind: 'startup'; major: number; minor: number; parameters: Array<[string, string]> }
  | { kind: 'invalid'; reason: string };

export type StartupSplit =
  | { kind: 'incomplete' }
  | { kind: 'packet'; packet: StartupPacket; rest: Uint8Array }
  | { kind: 'error'; reason: 'too-large' | 'too-small' };

/** Fields of an ErrorResponse or NoticeResponse, keyed by their one-letter code. */
export type ErrorFields = Record<string, string>;

/** Transaction status from ReadyForQuery: idle, in a transaction block, or in a failed one. */
export type TransactionStatus = 'I' | 'T' | 'E';

export type WireServerOptions = {
  engine: EngineHandle;
  host: string;
  port: number;
};

export type WireServerHandle = {
  port: number;
  host: string;
  close(): Promise<void>;
};
