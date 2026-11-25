import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import EngineHost from '../engine.host.js';
import EngineOpen from '../engine.open.js';
import { buildCrashImage } from './support/crash-image.js';
import { CrashRecorder } from './support/crash-recorder.js';
import { readReply, simpleQuery } from './support/protocol.js';
import { checkImage, MARKS, runWorkload, type Acked, type MarkLabel } from './support/workload.js';

/*
 * Storage rule 1, proven: after a power cut the disk holds what was fsynced plus any subset of the rest. Every image
 * built that way from a recording of real commits must reopen with every acknowledged commit and a clean amcheck.
 * The control records the same workload with PGlite's own settings and must lose data in the same harness, which
 * shows the harness can see a loss.
 */

const SEEDS = [1, 2, 3, 4];
// Windows rules (no directory fsync, renamed files flushed) also run on Linux and macOS, so every CI job checks them.
const PLATFORMS: readonly NodeJS.Platform[] = process.platform === 'win32' ? ['win32'] : [process.platform, 'win32'];
// 16 buffers: dirty pages get evicted between checkpoints, so unsynced data-file writes are part of every image.
const SETTINGS = { shared_buffers: '128kB' };

interface Recording {
  recorder: CrashRecorder;
  ackedAt: Map<MarkLabel, Acked>;
  platform: NodeJS.Platform;
}

let root: string;

async function record(name: string, durable: boolean, platform: NodeJS.Platform = process.platform): Promise<Recording> {
  const dataDir = path.join(root, `${name}-live`);
  const recorder = new CrashRecorder(dataDir);
  // The live engine is never closed: the process "loses power" after the last mark, and its directory is not reused.
  const { pg } = await EngineOpen.open({ kind: 'disk', dataDir }, { durable, platform, hooks: [recorder.hook], settings: SETTINGS });
  recorder.start(path.join(root, `${name}-base`));
  const ackedAt = await runWorkload(pg, recorder);
  return { recorder, ackedAt, platform };
}

function image(recording: Recording, label: MarkLabel, seed: number, name: string): { dir: string; acked: Acked; volatileOps: number } {
  const { recorder, ackedAt, platform } = recording;
  const mark = recorder.marks.find((m) => m.label === label);
  const acked = ackedAt.get(label);
  if (mark === undefined || acked === undefined || recorder.base === undefined) throw new Error('workload did not run');
  const dir = path.join(root, `img-${name}-${label}-${seed}`);
  const stats = buildCrashImage(recorder.base, recorder.ops, mark.opIndex, seed, dir, platform);
  return { dir, acked, volatileOps: stats.volatileOps };
}

const fixed = new Map<NodeJS.Platform, Recording>();
let control: Recording;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-spike6-crash-'));
  for (const platform of PLATFORMS) fixed.set(platform, await record(`fixed-${platform}`, true, platform));
  control = await record('control', false);
}, 300_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function recording(platform: NodeJS.Platform): Recording {
  const found = fixed.get(platform);
  if (found === undefined) throw new Error(`no recording for ${platform}`);
  return found;
}

describe.each(PLATFORMS)('lost unsynced writes, with storage rule 1 (%s rules)', (platform) => {
  it('records every file the engine touched, and real fsyncs', () => {
    expect(recording(platform).recorder.unknownNodes).toBe(0);
    expect(recording(platform).recorder.ops.some((op) => op.kind === 'fsync')).toBe(true);
  });

  for (const label of MARKS) {
    for (const seed of SEEDS) {
      it(`crash at ${label}, seed ${seed}: every acknowledged commit present and amcheck clean`, async () => {
        const img = image(recording(platform), label, seed, `fixed-${platform}`);
        expect(img.volatileOps).toBeGreaterThan(0);
        const { pg } = await EngineOpen.open({ kind: 'disk', dataDir: img.dir }, { extensions: { amcheck } });
        try {
          const result = await checkImage(pg, img.acked);
          expect(result.missing).toEqual([]);
          expect(result.wrongValue).toEqual([]);
          expect(result.amcheckErrors).toEqual([]);
        } finally {
          await pg.close();
          fs.rmSync(img.dir, { recursive: true, force: true });
        }
      });
    }
  }
});

describe('lost unsynced writes, control without the fix', () => {
  it('records no fsync at all', () => {
    expect(control.recorder.ops.some((op) => op.kind === 'fsync')).toBe(false);
  });

  it('loses acknowledged commits in the same harness (run in a worker, since a damaged directory can hang PGlite)', async () => {
    const outcomes: string[] = [];
    for (const label of MARKS) {
      for (const seed of SEEDS.slice(0, 2)) {
        const img = image(control, label, seed, 'control');
        let outcome: string;
        try {
          const engine = await EngineHost.start({ kind: 'disk', dataDir: img.dir }, { startTimeoutMs: 30_000 });
          const reply = readReply(await engine.execProtocolRaw(simpleQuery('SELECT id, v FROM t ORDER BY id')));
          await engine.terminate();
          const found = new Map(reply.rows.map((r) => [Number(r[0]), r[1]]));
          const missing = [...img.acked].filter(([id, v]) => found.get(id) !== v).length;
          outcome = reply.errors[0] ?? `${missing} of ${img.acked.size} acknowledged rows missing or wrong`;
        } catch (error) {
          outcome = `open failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        outcomes.push(`${label}/${seed}: ${outcome}`);
        fs.rmSync(img.dir, { recursive: true, force: true });
      }
    }
    console.info(`[spike6] control (no fix):\n  ${outcomes.join('\n  ')}`);
    const lost = outcomes.filter((o) => !/: 0 of \d+ acknowledged/.test(o));
    expect(lost.length).toBeGreaterThanOrEqual(outcomes.length / 2);
  }, 300_000);
});
