/** Static texts of the session module: log messages and error messages. */
export enum SessionMessages {
  ESCALATED = '[SessionSwapService.swap] connection changed its session user although its login role is not a superuser',
  SWAP_FAILED = '[SessionSwapService.swap] restoring the incoming session failed',
  OPENED = '[SessionSwapService.open] engine session context ready',
  CAPTURE_EMPTY = 'Session capture returned no row',
  CAPTURE_INVALID = 'Session capture returned an unexpected shape',
  SUPERUSER_UNKNOWN = 'Could not read the engine superuser',
  ROLE_NOT_FOUND = 'Login role does not exist',
  ROLE_CANNOT_LOGIN = 'Role is not permitted to log in',
}
