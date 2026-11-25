import { TimescaleMessages } from './timescale.messages.js';

export type TarEntry = { name: string; data: Uint8Array; mode?: number };

const BLOCK = 512;
const NAME_LEN = 100;
/** 11 octal digits: the largest size a ustar header can carry without the GNU base-256 extension. */
const MAX_SIZE = 0o77777777777;

function assertSafeName(name: string): void {
  if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(name)) throw new Error(TimescaleMessages.TAR_NAME_NOT_ASCII);
  if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(TimescaleMessages.TAR_NAME_UNSAFE);
  if (Buffer.byteLength(name, 'ascii') > NAME_LEN) throw new Error(TimescaleMessages.TAR_NAME_TOO_LONG);
}

function writeOctal(header: Buffer, offset: number, width: number, value: number): void {
  // width - 1 digits then NUL, the form every tar reader accepts.
  header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
}

function headerFor(entry: TarEntry): Buffer {
  assertSafeName(entry.name);
  if (entry.data.length > MAX_SIZE) throw new Error(TimescaleMessages.TAR_ENTRY_TOO_LARGE);
  const header = Buffer.alloc(BLOCK, 0);
  header.write(entry.name, 0, NAME_LEN, 'ascii');
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  // A fixed mtime keeps the archive byte-identical for identical input, so its hash can name the cached file.
  writeOctal(header, 136, 12, 0);
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/** Plain ustar archive: regular files only, which is all a PGlite extension bundle needs. */
export function buildTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(headerFor(entry), Buffer.from(entry.data));
    const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
