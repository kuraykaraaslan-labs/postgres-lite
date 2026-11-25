/** Text sent to clients in ErrorResponse messages and written to the log by the wire module. */
export enum WireMessages {
  // Client-facing errors (the M field of an ErrorResponse)
  STARTUP_PACKET_INVALID = 'invalid startup packet layout',
  STARTUP_PACKET_TOO_LARGE = 'invalid length of startup packet',
  STARTUP_UNSUPPORTED_PROTOCOL = 'unsupported frontend protocol',
  STARTUP_NO_USER = 'no PostgreSQL user name specified in startup packet',
  STARTUP_PARAMETER_REJECTED = 'startup parameter rejected by the engine',
  MESSAGE_TOO_LARGE = 'invalid message length',
  MESSAGE_TYPE_INVALID = 'invalid frontend message type',
  COPY_FROM_STDIN_UNSUPPORTED = 'COPY FROM STDIN is not supported by postgres-lite yet',
  ENGINE_FAILED = 'the database engine failed while running this request',

  // Log lines (static text; variable data goes in the context object)
  LOG_LISTENING = '[WireServer.start] listening',
  LOG_CLOSED = '[WireServer.close] closed',
  LOG_CONNECTION_OPENED = '[WireConnection.open] connection opened',
  LOG_CONNECTION_CLOSED = '[WireConnection.close] connection closed',
  LOG_SOCKET_ERROR = '[WireConnection.open] socket error',
  LOG_PROTOCOL_VIOLATION = '[WireConnection.handleData] protocol violation, closing',
  LOG_ENGINE_ERROR = '[WireConnection.forward] engine call failed',
  LOG_CLEANUP_FAILED = '[WireConnection.cleanup] engine cleanup failed',
  LOG_COPY_REFUSED = '[WireConnection.forward] refused COPY FROM STDIN',
}
