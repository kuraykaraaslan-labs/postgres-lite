import { describe, expect, it } from 'vitest';

import { buildTar } from '../timescale.ustar.js';

function field(block: Buffer, offset: number, width: number): string {
  return block.subarray(offset, offset + width).toString('ascii').replace(/\0.*$/s, '').trim();
}

describe('buildTar', () => {
  it('writes ustar headers with a valid checksum, size and padding', () => {
    const data = Buffer.from('hello world\n');
    const tar = buildTar([{ name: 'share/a.txt', data }]);
    expect(tar.length).toBe(512 + 512 + 1024);
    const header = tar.subarray(0, 512);
    expect(field(header, 0, 100)).toBe('share/a.txt');
    expect(Number.parseInt(field(header, 124, 12), 8)).toBe(data.length);
    expect(field(header, 257, 6)).toBe('ustar');
    const stored = Number.parseInt(field(header, 148, 8), 8);
    const copy = Buffer.from(header);
    copy.write('        ', 148, 8, 'ascii');
    expect(stored).toBe(copy.reduce((sum, byte) => sum + byte, 0));
    expect(tar.subarray(512, 512 + data.length).equals(data)).toBe(true);
    expect(tar.subarray(512 + data.length).every((byte) => byte === 0)).toBe(true);
  });

  it('is byte-identical for identical input', () => {
    const entries = [{ name: 'x', data: Buffer.from('1') }];
    expect(buildTar(entries).equals(buildTar(entries))).toBe(true);
  });

  it('refuses names a reader could resolve outside the target', () => {
    const data = Buffer.alloc(0);
    expect(() => buildTar([{ name: '/etc/passwd', data }])).toThrow();
    expect(() => buildTar([{ name: 'a/../../b', data }])).toThrow();
    expect(() => buildTar([{ name: 'é', data }])).toThrow();
    expect(() => buildTar([{ name: 'a'.repeat(101), data }])).toThrow();
  });

});
