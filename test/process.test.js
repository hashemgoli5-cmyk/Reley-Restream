import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { capture } from '../server/process.js';
import { Extractor } from '../server/extractor.js';
import { config } from '../server/config.js';
test('process timeout terminates the complete child process group', async () => {
  let child;
  const start = Date.now();
  await assert.rejects(
    capture(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
      timeoutMs: 60,
      onChild: (p) => (child = p),
    }),
    { code: 'RESOLVE_TIMEOUT' },
  );
  assert(Date.now() - start < 3000);
  assert(child.signalCode || child.exitCode !== null);
});
test('aborted extraction is terminated rather than orphaned', async () => {
  const controller = new AbortController();
  let child;
  const task = capture(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
    signal: controller.signal,
    onChild: (p) => (child = p),
  });
  controller.abort();
  await assert.rejects(task, { code: 'STOPPED' });
  assert(child.signalCode || child.exitCode !== null);
});
test('bounded extraction retries transient errors with backoff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-extractor-')),
    script = path.join(dir, 'fake-yt-dlp'),
    count = path.join(dir, 'attempts');
  try {
    await writeFile(
      script,
      `#!/usr/bin/env node\nconst fs=require('fs');const file=${JSON.stringify(count)};const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));if(n<2){console.error('temporary upstream timeout');process.exit(1);}console.log(JSON.stringify({id:'abcdefghijk',live_status:'is_live',title:'Test'}));\n`,
      { mode: 0o755 },
    );
    const extractor = new Extractor({
      ...config,
      ytDlp: script,
      extractTimeoutMs: 3000,
      retryBaseMs: 20,
      extractRetries: 2,
    });
    assert.equal(
      (await extractor.extract('https://youtube.com/watch?v=abcdefghijk')).id,
      'abcdefghijk',
    );
    assert.equal(await readFile(count, 'utf8'), '3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('channel without current broadcast returns CHANNEL_NOT_LIVE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-channel-')),
    script = path.join(dir, 'fake-yt-dlp');
  try {
    await writeFile(
      script,
      "#!/usr/bin/env node\nconsole.error('User is not currently live');process.exit(1);\n",
      { mode: 0o755 },
    );
    const extractor = new Extractor({ ...config, ytDlp: script });
    await assert.rejects(extractor.channel('https://youtube.com/@owner/live'), {
      code: 'CHANNEL_NOT_LIVE',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
