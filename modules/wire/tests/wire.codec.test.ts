import { describe, expect, it } from 'vitest';

import WireCodec, { MAX_STARTUP_PACKET_LENGTH } from '../wire.codec.js';
import RawClient from './support/raw.client.js';

describe('WireCodec.splitStartupPacket', () => {
  it('waits for a complete packet, then parses protocol and parameters', () => {
    const packet = RawClient.startup({ user: 'postgres', database: 'db', application_name: 'x' });
    expect(WireCodec.splitStartupPacket(packet.subarray(0, 3)).kind).toBe('incomplete');
    expect(WireCodec.splitStartupPacket(packet.subarray(0, packet.length - 1)).kind).toBe('incomplete');
    const split = WireCodec.splitStartupPacket(WireCodec.concat([packet, new Uint8Array([1, 2])]));
    expect(split.kind).toBe('packet');
    if (split.kind !== 'packet') return;
    expect(split.packet).toEqual({
      kind: 'startup',
      major: 3,
      minor: 0,
      parameters: [
        ['user', 'postgres'],
        ['database', 'db'],
        ['application_name', 'x'],
      ],
    });
    expect([...split.rest]).toEqual([1, 2]);
  });

  it('recognises SSLRequest, GSSENCRequest and CancelRequest', () => {
    expect(WireCodec.splitStartupPacket(RawClient.sslRequest())).toMatchObject({ kind: 'packet', packet: { kind: 'ssl' } });
    const gss = WireCodec.concat([WireCodec.int32(8), WireCodec.int32(80877104)]);
    expect(WireCodec.splitStartupPacket(gss)).toMatchObject({ kind: 'packet', packet: { kind: 'gssenc' } });
    const cancel = WireCodec.concat([WireCodec.int32(16), WireCodec.int32(80877102), WireCodec.int32(1234), WireCodec.int32(99)]);
    expect(WireCodec.splitStartupPacket(cancel)).toMatchObject({ kind: 'packet', packet: { kind: 'cancel', processId: 1234 } });
  });

  it('rejects lengths outside what PostgreSQL accepts and malformed parameter lists', () => {
    expect(WireCodec.splitStartupPacket(WireCodec.int32(7))).toEqual({ kind: 'error', reason: 'too-small' });
    expect(WireCodec.splitStartupPacket(WireCodec.int32(MAX_STARTUP_PACKET_LENGTH + 1))).toEqual({ kind: 'error', reason: 'too-large' });
    // Parameter name without its terminating NUL and without the list terminator.
    const body = WireCodec.concat([WireCodec.int32(3 << 16), new TextEncoder().encode('user')]);
    const bad = WireCodec.concat([WireCodec.int32(body.length + 4), body]);
    expect(WireCodec.splitStartupPacket(bad)).toMatchObject({ kind: 'packet', packet: { kind: 'invalid' } });
  });
});

describe('WireCodec.splitFrontendMessages', () => {
  it('splits several messages in one buffer and keeps a partial tail', () => {
    const q1 = WireCodec.query('SELECT 1');
    const q2 = WireCodec.query('SELECT 2');
    const joined = WireCodec.concat([q1, q2, q1.subarray(0, 7)]);
    const split = WireCodec.splitFrontendMessages(joined);
    expect(split.kind).toBe('frames');
    if (split.kind !== 'frames') return;
    expect(split.frames.map((f) => f.type)).toEqual(['Q', 'Q']);
    expect(WireCodec.readSqlText(split.frames[1]!)).toBe('SELECT 2');
    expect(split.rest.length).toBe(7);
    expect(WireCodec.bytesNeeded(split.rest)).toBe(q1.length);
    expect(WireCodec.bytesNeeded(split.rest.subarray(0, 3))).toBe(5);
  });

  it('refuses a length below 4 or above the 1 GiB protocol limit', () => {
    const tooSmall = new Uint8Array([0x51, 0, 0, 0, 3]);
    expect(WireCodec.splitFrontendMessages(tooSmall)).toMatchObject({ kind: 'error', reason: 'too-small' });
    const tooLarge = WireCodec.concat([new Uint8Array([0x51]), WireCodec.int32(0x4000_0000)]);
    expect(WireCodec.splitFrontendMessages(tooLarge)).toMatchObject({ kind: 'error', reason: 'too-large' });
  });
});

describe('WireCodec backend readers', () => {
  it('reads the last ReadyForQuery status, errors and text DataRows', () => {
    const row = WireCodec.message('D', WireCodec.concat([WireCodec.int16(2), WireCodec.int32(1), new TextEncoder().encode('7'), WireCodec.int32(-1)]));
    const output = WireCodec.concat([
      row,
      WireCodec.errorResponse({ S: 'ERROR', C: '22012', M: 'division by zero' }),
      WireCodec.readyForQuery('T'),
      WireCodec.readyForQuery('E'),
    ]);
    expect(WireCodec.dataRows(output)).toEqual([['7', null]]);
    expect(WireCodec.firstError(output)).toEqual({ S: 'ERROR', C: '22012', M: 'division by zero' });
    expect(WireCodec.lastReadyForQueryStatus(output)).toBe('E');
    expect(WireCodec.lastReadyForQueryStatus(output.subarray(0, output.length - 1))).toBe('T');
  });

  it('stops at a DataRow whose column length points past the message', () => {
    const lying = WireCodec.message('D', WireCodec.concat([WireCodec.int16(1), WireCodec.int32(50), new Uint8Array(3)]));
    expect(WireCodec.dataRows(lying)).toEqual([]);
  });
});
