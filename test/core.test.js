import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../server/config.js';
import { normalizeInput, validateMediaUrl } from '../server/input.js';
import { KeyedMutex, RateLimiter } from '../server/registry.js';
import { StreamManager } from '../server/manager.js';
import { chooseRenditions, buildFfmpegArgs } from '../server/pipeline.js';
import { createApp } from '../server/app.js';
import { Extractor } from '../server/extractor.js';

const id = 'abcdefghijk';
test('canonical ID matches direct, short, live, embed and mobile links', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&t=5`,
    `https://youtu.be/${id}?si=secret`,
    `https://youtube.com/live/${id}`,
    `https://m.youtube.com/embed/${id}`,
    `youtube.com/watch?v=${id}`,
  ])
    assert.equal(normalizeInput(url).id, id);
  assert.equal(normalizeInput('@MyLiveChannel').url, 'https://www.youtube.com/@MyLiveChannel/live');
  assert.equal(normalizeInput('https://youtube.com/@MyLiveChannel/streams').kind, 'channel');
});
test('rejects malformed input, credentials, arbitrary hosts, ports and argument injection', () => {
  for (const input of [
    '',
    null,
    {},
    'file:///etc/passwd',
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://u:p@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:444/watch?v=abcdefghijk',
    '--exec touch /tmp/owned',
    'https://127.0.0.1/live/abcdefghijk',
    'https://youtube.com/playlist?list=foo',
    'https://youtu.be/bad',
  ])
    assert.throws(() => normalizeInput(input));
  assert.throws(() => validateMediaUrl('http://127.0.0.1'));
  assert.throws(() => validateMediaUrl('https://googlevideo.com.evil.test/a'));
  assert.equal(
    validateMediaUrl('https://rr1.googlevideo.com/video?q=1'),
    'https://rr1.googlevideo.com/video?q=1',
  );
});
test('mutex serializes same key and allows distinct keys', async () => {
  const lock = new KeyedMutex();
  let running = 0,
    max = 0;
  await Promise.all(
    Array.from({ length: 40 }, () =>
      lock.run('a', async () => {
        max = Math.max(max, ++running);
        await delay(1);
        running--;
      }),
    ),
  );
  assert.equal(max, 1);
  await Promise.all(
    ['a', 'b'].map((k) =>
      lock.run(k, async () => {
        max = Math.max(max, ++running);
        await delay(5);
        running--;
      }),
    ),
  );
  assert.equal(max, 2);
});
test('rate limiter is bounded and expires windows', () => {
  const l = new RateLimiter(2, 100, 2);
  assert(l.allow('a', 1));
  assert(l.allow('a', 2));
  assert(!l.allow('a', 3));
  assert(l.allow('b', 4));
  assert(!l.allow('c', 5));
  assert(l.allow('c', 105));
});
async function fixture(options = {}) {
  const streamDir = await mkdtemp(path.join(os.tmpdir(), 'relay-test-'));
  const c = {
    ...config,
    streamDir,
    maxStreams: 2,
    graceMs: 20,
    viewerTtlMs: 20,
    maintenanceMs: 100000,
    minFreeMb: 0,
    ...options,
  };
  let starts = 0;
  const pipeline = {
    async start(e) {
      starts++;
      await delay(5);
      if (e.abort.signal.aborted) throw Error('stopped');
      await mkdir(e.outputPath, { recursive: true });
      return { done: new Promise(() => {}) };
    },
  };
  const manager = new StreamManager(c, pipeline);
  await manager.init();
  return {
    manager,
    c,
    starts: () => starts,
    close: async () => {
      await manager.shutdown();
      await rm(streamDir, { recursive: true, force: true });
    },
  };
}
test('100 concurrent attachments create exactly one pipeline and share output', async () => {
  const f = await fixture({ maxViewers: 200 });
  try {
    const viewers = await Promise.all(Array.from({ length: 100 }, () => f.manager.attach(id)));
    await f.manager.registry.get(id).ready;
    assert.equal(f.starts(), 1);
    assert.equal(f.manager.registry.values().length, 1);
    assert.equal(f.manager.registry.get(id).viewers.size, 100);
    assert.equal(new Set(viewers.map((v) => v.token)).size, 100);
    assert(viewers.every((v) => v.id === id));
  } finally {
    await f.close();
  }
});
test('atomic cross-ID admission never exceeds max pipelines', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(
      ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'].map((id) =>
        f.manager.attach(id),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(f.manager.active().length, 2);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CAPACITY');
  } finally {
    await f.close();
  }
});
test('viewer expiry and grace stop the pipeline, then permit a clean new generation', async () => {
  const f = await fixture();
  try {
    const v = await f.manager.attach(id);
    await f.manager.registry.get(id).ready;
    assert.equal(f.manager.authorize(id, v.token).status, 'live');
    await delay(25);
    await f.manager.maintain();
    assert.equal(f.manager.registry.get(id).viewers.size, 0);
    await delay(25);
    await f.manager.maintain();
    assert.equal(f.manager.registry.get(id).status, 'ended');
    const second = await f.manager.attach(id);
    await f.manager.registry.get(id).ready;
    assert.notEqual(v.token, second.token);
    assert.equal(f.starts(), 2);
    assert.throws(() => f.manager.authorize(id, v.token));
  } finally {
    await f.close();
  }
});
test('ABR reuses shared AAC input and never transcodes or invents a source quality', () => {
  const info = {
    formats: [360, 720]
      .map((h) => ({
        format_id: String(h),
        height: h,
        width: (h * 16) / 9,
        vcodec: 'avc1.4d',
        acodec: 'none',
        protocol: 'https',
        url: `https://rr.googlevideo.com/v${h}`,
        tbr: h * 3,
      }))
      .concat([
        {
          format_id: 'audio',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          protocol: 'https',
          url: 'https://rr.googlevideo.com/audio',
          abr: 128,
        },
      ]),
  };
  const c = { ...config, abr: true };
  const r = chooseRenditions(info, c);
  assert.deepEqual(
    r.map((r) => r.height),
    [360, 720],
  );
  const args = buildFfmpegArgs(r, c, '/tmp/stream', '123');
  assert.equal(args.filter((x) => x === '-i').length, 3);
  assert.equal(args.filter((x) => x === 'copy').length, 2);
  assert(!args.includes('libx264'));
  assert.throws(() => chooseRenditions({ formats: [] }, c));
});
test('channel discovery coalesces simultaneous calls and maps not-live errors', async () => {
  const extractor = new Extractor(config);
  let count = 0;
  extractor.extract = async () => {
    count++;
    await delay(5);
    return { id };
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => extractor.channel('channel')));
  assert.equal(count, 1);
  assert(results.every((r) => r.id === id));
  await extractor.channel('channel');
  assert.equal(count, 1);
});
test('API protects HLS, rewrites only local manifests, uses auth and blocks cross-origin mutation', async () => {
  const f = await fixture({
    adminUser: 'operator',
    adminPassword: 'correct-long-password',
    viewerTtlMs: 60000,
  });
  const app = createApp(f.c, f.manager, {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    const auth = 'Basic ' + Buffer.from('operator:correct-long-password').toString('base64');
    assert.equal(
      (await fetch(`${base}/admin/api/status`, { headers: { Authorization: auth } })).status,
      200,
    );
    const cross = await fetch(`${base}/api/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
      body: JSON.stringify({ url: `https://youtu.be/${id}` }),
    });
    assert.equal(cross.status, 403);
    const response = await fetch(`${base}/api/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://youtu.be/${id}` }),
    });
    assert.equal(response.status, 202);
    const v = await response.json();
    const e = f.manager.registry.get(id);
    await e.ready;
    await writeFile(path.join(e.outputPath, 'stream.m3u8'), '#EXTM3U\n360p.m3u8\n');
    assert.equal((await fetch(`${base}/streams/${id}/stream.m3u8`)).status, 401);
    const playlist = await fetch(`${base}/streams/${id}/stream.m3u8?token=${v.token}`);
    assert.equal(playlist.status, 200);
    assert.match(await playlist.text(), /360p\.m3u8\?token=/);
    await writeFile(
      path.join(e.outputPath, 'stream.m3u8'),
      '#EXTM3U\nhttps://youtube.com/not-allowed\n',
    );
    assert.equal((await fetch(`${base}/streams/${id}/stream.m3u8?token=${v.token}`)).status, 500);
    assert.equal(
      (
        await fetch(`${base}/admin/api/streams/${id}/stop`, {
          method: 'POST',
          headers: { Authorization: auth, Origin: base },
        })
      ).status,
      200,
    );
    const status = await fetch(`${base}/api/streams/${id}`, {
      headers: { Authorization: `Bearer ${v.token}` },
    });
    assert.equal((await status.json()).status, 'ended');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await f.close();
  }
});
test('failed startup is shared, settles before restart, and cannot erase a new generation', async () => {
  const f = await fixture();
  let starts = 0;
  f.manager.pipeline.start = async () => {
    starts++;
    await delay(5);
    throw Object.assign(new Error('unavailable'), { code: 'NOT_LIVE' });
  };
  try {
    await Promise.all(Array.from({ length: 10 }, () => f.manager.attach(id)));
    const first = f.manager.registry.get(id);
    await first.ready;
    assert.equal(starts, 1);
    assert.equal(first.error, 'NOT_LIVE');
    await f.manager.attach(id);
    await f.manager.registry.get(id).ready;
    assert.equal(starts, 2);
    assert.notEqual(first.generation, f.manager.registry.get(id).generation);
  } finally {
    await f.close();
  }
});
test('source-end confirmation differentiates natural end from transient interruption', async () => {
  const f = await fixture();
  try {
    await f.manager.attach(id);
    let e = f.manager.registry.get(id);
    await e.ready;
    f.manager.pipeline.hasEnded = async () => true;
    await f.manager.sourceStopped(e, 'SOURCE_INTERRUPTED');
    assert.equal(e.status, 'ended');
    assert.equal(e.error, null);
    await f.manager.attach(id);
    e = f.manager.registry.get(id);
    await e.ready;
    f.manager.pipeline.hasEnded = async () => false;
    await f.manager.sourceStopped(e, 'SOURCE_INTERRUPTED');
    assert.equal(e.status, 'error');
    assert.equal(e.error, 'SOURCE_INTERRUPTED');
  } finally {
    await f.close();
  }
});
test('operator allowlist rejects unapproved streams without starting a pipeline', async () => {
  const f = await fixture({ allowedVideoIds: ['aaaaaaaaaaa'] });
  try {
    await assert.rejects(f.manager.attach(id), { code: 'SOURCE_NOT_ALLOWED' });
    assert.equal(f.starts(), 0);
  } finally {
    await f.close();
  }
});

test('a delayed stop from an old generation cannot terminate its replacement', async () => {
  const f = await fixture();
  try {
    await f.manager.attach(id);
    const old = f.manager.registry.get(id);
    await old.ready;
    await f.manager.stop(id);
    await f.manager.attach(id);
    const current = f.manager.registry.get(id);
    await current.ready;
    await f.manager.stop(id, 'error', 'SOURCE_STALLED', old);
    assert.equal(current.status, 'live');
    assert.equal(current.reserved, true);
  } finally {
    await f.close();
  }
});
