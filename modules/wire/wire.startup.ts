import type { EngineHandle } from '../engine/engine.types.js';
import WireCodec, { PROTOCOL_MAJOR, PROTOCOL_MINOR } from './wire.codec.js';
import { NON_GUC_STARTUP_PARAMETERS, PROTOCOL_OPTION_PREFIX, StartupParametersDTO, type StartupParameters } from './wire.dto.js';
import { WireMessages } from './wire.messages.js';
import type { ErrorFields, StartupPacket } from './wire.types.js';

/**
 * The ParameterStatus values PostgreSQL 18 sends after authentication, in the order it sends them (recorded from
 * PGlite's own startup reply, which runs the real backend code). session_authorization is read from session_user
 * because PGlite leaves that GUC empty when the server, not the engine, handled authentication.
 */
export const REPORTED_PARAMETERS = [
  'in_hot_standby',
  'integer_datetimes',
  'TimeZone',
  'IntervalStyle',
  'search_path',
  'is_superuser',
  'application_name',
  'default_transaction_read_only',
  'scram_iterations',
  'DateStyle',
  'standard_conforming_strings',
  'session_authorization',
  'client_encoding',
  'server_version',
  'server_encoding',
] as const;

const READ_REPORTED_SQL = `SELECT ${REPORTED_PARAMETERS.map((name) =>
  name === 'session_authorization' ? 'session_user::text' : `pg_catalog.current_setting('${name}')`,
).join(', ')}`;

const SET_CONFIG_SQL = 'SELECT pg_catalog.set_config($1, $2, false)';

export type StartupDecision =
  | { kind: 'reject'; error: ErrorFields }
  | { kind: 'accept'; parameters: StartupParameters; negotiation: Uint8Array | null };

export type SessionSetup = { kind: 'ok'; reported: Array<[string, string]> } | { kind: 'error'; error: ErrorFields };

/** The startup phase: protocol negotiation, startup parameters and the greeting a real server sends. */
export default class WireStartup {
  static fatal(code: string, message: string): ErrorFields {
    return { S: 'FATAL', V: 'FATAL', C: code, M: message };
  }

  /** Checks a StartupMessage's protocol version and parameters. */
  static decide(packet: Extract<StartupPacket, { kind: 'startup' }>): StartupDecision {
    if (packet.major !== PROTOCOL_MAJOR) {
      return {
        kind: 'reject',
        error: WireStartup.fatal('0A000', `${WireMessages.STARTUP_UNSUPPORTED_PROTOCOL} ${packet.major}.${packet.minor}: server supports 3.0 to 3.${PROTOCOL_MINOR}`),
      };
    }
    // Later duplicates win, as in PostgreSQL's ProcessStartupPacket.
    const parsed = StartupParametersDTO.safeParse(Object.fromEntries(packet.parameters));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const isUser = issue?.path[0] === 'user';
      return { kind: 'reject', error: WireStartup.fatal(isUser ? '28000' : '42704', isUser ? WireMessages.STARTUP_NO_USER : (issue?.message ?? WireMessages.STARTUP_PACKET_INVALID)) };
    }
    const protocolOptions = Object.keys(parsed.data).filter((name) => name.startsWith(PROTOCOL_OPTION_PREFIX));
    const negotiation =
      packet.minor > PROTOCOL_MINOR || protocolOptions.length > 0 ? WireCodec.negotiateProtocolVersion(PROTOCOL_MINOR, protocolOptions) : null;
    return { kind: 'accept', parameters: parsed.data, negotiation };
  }

  /**
   * Applies the client's startup GUCs (application_name, client_encoding, ...) inside the engine and reads back the
   * values to report. One engine call; output the engine produces along the way (its own ParameterStatus for each
   * set_config) is discarded, because the greeting reports the final values itself.
   */
  static async setupSession(engine: EngineHandle, parameters: StartupParameters): Promise<SessionSetup> {
    const parts: Uint8Array[] = [];
    for (const [name, value] of Object.entries(parameters)) {
      if (NON_GUC_STARTUP_PARAMETERS.has(name) || name.startsWith(PROTOCOL_OPTION_PREFIX)) continue;
      parts.push(WireCodec.parse('', SET_CONFIG_SQL), WireCodec.bind('', [name, value]), WireCodec.execute());
    }
    parts.push(WireCodec.sync(), WireCodec.query(READ_REPORTED_SQL));
    const output = await engine.execProtocolRaw(WireCodec.concat(parts));
    const error = WireCodec.firstError(output);
    if (error !== null) {
      return { kind: 'error', error: WireStartup.fatal(error.C ?? 'XX000', error.M ?? WireMessages.STARTUP_PARAMETER_REJECTED) };
    }
    // set_config returns a row of its own for every parameter; the settings row is the last one.
    const row = WireCodec.dataRows(output).at(-1);
    if (row === undefined || row.length !== REPORTED_PARAMETERS.length) {
      return { kind: 'error', error: WireStartup.fatal('XX000', WireMessages.ENGINE_FAILED) };
    }
    return { kind: 'ok', reported: REPORTED_PARAMETERS.map((name, i) => [name, row[i] ?? '']) };
  }

  /** AuthenticationOk, every ParameterStatus, BackendKeyData and ReadyForQuery, as one write. */
  static greeting(reported: Array<[string, string]>, processId: number, secretKey: Uint8Array): Uint8Array {
    return WireCodec.concat([
      WireCodec.authenticationOk(),
      ...reported.map(([name, value]) => WireCodec.parameterStatus(name, value)),
      WireCodec.backendKeyData(processId, secretKey),
      WireCodec.readyForQuery('I'),
    ]);
  }
}
