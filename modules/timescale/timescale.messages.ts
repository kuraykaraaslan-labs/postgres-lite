export enum TimescaleMessages {
  TAR_NAME_TOO_LONG = 'Tar entry name is longer than 100 bytes',
  TAR_NAME_NOT_ASCII = 'Tar entry name must be printable ASCII',
  TAR_NAME_UNSAFE = 'Tar entry name must be relative and must not contain ".."',
  TAR_ENTRY_TOO_LARGE = 'Tar entry is larger than the ustar size field allows',
  SQL_FILE_MISSING = 'Timescale extension SQL file is missing',
  BUNDLE_WRITTEN = '[TimescaleBundle.ensureFile] extension bundle written',
  BUNDLE_REUSED = '[TimescaleBundle.ensureFile] extension bundle reused',
  PREINSTALL_DONE = '[TimescaleExtension.init] timescaledb created in this database',
}
