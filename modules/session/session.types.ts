import type { PGliteInterface } from '@electric-sql/pglite';

/** The part of an in-process PGlite the session module needs. */
export type SessionEngine = Pick<PGliteInterface, 'query' | 'exec'>;

/** Per-engine facts the swap needs; one per PGlite instance. */
export type SessionEngineContext = {
  /** The bootstrap superuser PGlite runs as; the only identity allowed to switch session authorization. */
  superuser: string;
  /**
   * Custom (placeholder) GUC names seen on this engine. PostgreSQL hides placeholders from pg_settings and SHOW ALL,
   * so a swap can only capture the ones it has been told about.
   */
  customGucNames: Set<string>;
};

/** Everything a client connection has changed in the backend's session state, as captured between transactions. */
export type SessionState = {
  /** session_user: the startup user, or whatever a superuser login switched to with SET SESSION AUTHORIZATION. */
  sessionUser: string;
  /** current_setting('role'): 'none' or the role set with SET ROLE. */
  role: string;
  /** Built-in GUCs whose source is 'session' (SET, set_config(..., false)), as current_setting() shows them. */
  gucs: Record<string, string>;
  /** Custom GUCs with a non-empty session value. */
  customGucs: Record<string, string>;
  /** Names of SQL-level PREPAREd statements found in the backend (not restored; see docs/spikes/02-role-switching.md). */
  sqlPreparedNames: string[];
};

/** One client connection as the swap sees it. */
export type SessionConnection = {
  id: number;
  loginRole: string;
  loginIsSuperuser: boolean;
  state: SessionState;
};

export type SwapResult = {
  /** True when nothing ran because the incoming connection already owned the backend session. */
  skipped: boolean;
  /**
   * True when the outgoing connection's session user no longer matched a non-superuser login role. PGlite's
   * authenticated user is a superuser, so dynamic SQL can do what PostgreSQL would refuse; the caller must end
   * that connection.
   */
  outgoingEscalated: boolean;
};
