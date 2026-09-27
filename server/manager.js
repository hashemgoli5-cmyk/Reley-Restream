import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, rm, readdir, stat, statfs } from 'node:fs/promises';
import { MemoryRegistry, KeyedMutex } from './registry.js';
import { AppError } from './errors.js';
import { terminate } from './process.js';
import { log } from './log.js';
export class StreamManager {
  constructor(c, pipeline, registry = new MemoryRegistry()) {
    Object.assign(this, { c, pipeline, registry });
    this.lock = new KeyedMutex();
    this.closing = false;
    this.disk = { freeMb: null, usedMb: 0 };
  }
  async init() {
    await mkdir(this.c.streamDir, { recursive: true });
    // Dedicated transient directory only. Never point STREAM_DIR at a shared/user directory.
    for (const name of await readdir(this.c.streamDir))
      await rm(path.join(this.c.streamDir, name), { recursive: true, force: true });
    await this.checkDisk();
    this.timer = setInterval(() => {
      if (!this.maintaining) {
        this.maintaining = this.maintain()
          .catch((e) => log('error', 'maintenance_failed', { code: e.code || 'INTERNAL' }))
          .finally(() => {
            this.maintaining = null;
          });
      }
    }, this.c.maintenanceMs);
    this.timer.unref();
  }
  active() {
    return this.registry.values().filter((e) => ['starting', 'live'].includes(e.status));
  }
  attach(id, info) {
    return this.lock.run(id, async () => {
      if (this.closing) throw new AppError('SHUTTING_DOWN', 503);
      if (this.c.allowedVideoIds.length && !this.c.allowedVideoIds.includes(id))
        throw new AppError('SOURCE_NOT_ALLOWED', 403);
      let e = this.registry.get(id);
      if (e?.stopping) await e.stopping;
      if (e && ['ended', 'error'].includes(e.status)) await e.ready;
      if (this.closing) throw new AppError('SHUTTING_DOWN', 503);
      if (e && ['starting', 'live'].includes(e.status)) return this.addViewer(e);
      if (this.registry.values().filter((e) => e.reserved).length >= this.c.maxStreams)
        throw new AppError('CAPACITY', 503);
      if (
        this.disk.freeMb !== null &&
        (this.disk.freeMb < this.c.minFreeMb || this.disk.usedMb >= this.c.maxDiskMb)
      )
        throw new AppError('DISK_LOW', 503);
      // Synchronous global admission before any asynchronous I/O prevents cross-ID oversubscription.
      e = {
        id,
        reserved: true,
        title: info?.title || '',
        status: 'starting',
        outputPath: path.join(this.c.streamDir, id),
        generation: randomBytes(6).toString('hex'),
        process: null,
        pid: null,
        viewers: new Map(),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        zeroSince: null,
        abort: new AbortController(),
        qualities: [],
        error: null,
      };
      this.registry.set(id, e);
      const viewer = this.addViewer(e);
      e.ready = this.launch(e, info); // Every later attachment shares this creation; never starts another one.
      return viewer;
    });
  }
  addViewer(e) {
    if (e.viewers.size >= this.c.maxViewers) throw new AppError('VIEWER_CAPACITY', 503);
    const token = randomUUID();
    e.viewers.set(token, Date.now());
    e.zeroSince = null;
    e.lastActivityAt = Date.now();
    return { token, ...this.public(e) };
  }
  async launch(e, info) {
    try {
      // Old generations cannot be removed by an asynchronously completing earlier pipeline.
      await rm(e.outputPath, { recursive: true, force: true });
      const child = await this.pipeline.start(e, info);
      if (e.abort.signal.aborted) return;
      e.status = 'live';
      log('info', 'stream_live', { videoId: e.id, pid: e.pid });
      child.done.then(({ code }) => {
        if (!e.abort.signal.aborted)
          void this.sourceStopped(e, code === 0 ? null : 'SOURCE_INTERRUPTED');
      });
    } catch (err) {
      if (!e.abort.signal.aborted) {
        e.error = err.code || 'UPSTREAM_ERROR';
        e.status = 'error';
        e.terminalAt = Date.now();
        e.abort.abort();
        await Promise.all([terminate(e.process), terminate(e.extractorProcess)]);
        await rm(e.outputPath, { recursive: true, force: true });
        e.reserved = false;
        log('error', 'stream_failed', { videoId: e.id, code: e.error });
      }
    }
  }
  async sourceStopped(e, reason) {
    if (e.finishing || e.abort.signal.aborted) return;
    e.finishing = true;
    let ended = !reason;
    // Nonzero FFmpeg exits also occur when YouTube removes a finished manifest.
    // Confirm the live state rather than mislabeling network failures as natural ends.
    if (reason && this.pipeline.hasEnded) {
      try {
        ended = await this.pipeline.hasEnded(e);
      } catch {}
    }
    if (!e.abort.signal.aborted && this.registry.get(e.id) === e)
      await this.stop(e.id, ended ? 'ended' : 'error', ended ? null : reason, e);
  }
  public(e) {
    return {
      id: e.id,
      title: e.title,
      status: e.status,
      checkingEnd: !!e.finishing,
      viewers: e.viewers.size,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
      qualities: e.qualities,
      error: e.error,
      manifest: e.status === 'live' ? `/streams/${e.id}/stream.m3u8` : null,
    };
  }
  authorize(id, token, touch = false) {
    const e = this.registry.get(id),
      t = e?.viewers.get(token);
    if (!e || !t || Date.now() - t > this.c.viewerTtlMs) {
      if (e && t) this.release(id, token);
      throw new AppError('VIEWER_EXPIRED', 401);
    }
    if (touch) {
      e.viewers.set(token, Date.now());
      e.lastActivityAt = Date.now();
      e.zeroSince = null;
    }
    return e;
  }
  release(id, token) {
    const e = this.registry.get(id);
    if (e) {
      e.viewers.delete(token);
      if (!e.viewers.size && e.zeroSince === null) e.zeroSince = Date.now();
    }
  }
  stop(id, status = 'ended', error = null, expectedEntry = null) {
    return this.lock.run(id, async () => {
      const e = this.registry.get(id);
      if (!e || (expectedEntry && e !== expectedEntry)) return;
      if (e.stopping) return e.stopping;
      e.status = status;
      e.error = error;
      e.terminalAt = Date.now();
      e.abort.abort();
      e.stopping = (async () => {
        await Promise.all([terminate(e.process), terminate(e.extractorProcess)]);
        await e.ready;
        await rm(e.outputPath, { recursive: true, force: true });
        e.reserved = false;
        log('info', 'stream_stopped', { videoId: id, status, error });
      })();
      await e.stopping;
    });
  }
  async checkDisk() {
    const fs = await statfs(this.c.streamDir);
    let bytes = 0;
    for (const name of await readdir(this.c.streamDir)) {
      const dir = path.join(this.c.streamDir, name),
        e = this.registry.get(name);
      if (!e || !['starting', 'live'].includes(e.status)) {
        // Known entries own their teardown; only unregistered folders are orphans.
        if (!e) await rm(dir, { recursive: true, force: true });
        continue;
      }
      for (const file of await readdir(dir).catch(() => []))
        bytes += (await stat(path.join(dir, file)).catch(() => ({ size: 0 }))).size;
    }
    this.disk = { freeMb: (fs.bavail * fs.bsize) / 1048576, usedMb: bytes / 1048576 };
  }
  async maintain() {
    const now = Date.now();
    for (const e of this.registry.values()) {
      for (const [token, t] of e.viewers)
        if (now - t > this.c.viewerTtlMs) this.release(e.id, token);
      if (
        ['starting', 'live'].includes(e.status) &&
        e.zeroSince !== null &&
        now - e.zeroSince >= this.c.graceMs
      )
        await this.stop(e.id, 'ended', null, e);
      if (e.status === 'live') {
        const times = await Promise.all(
          e.qualities.map((h) =>
            stat(path.join(e.outputPath, `${h}p.m3u8`))
              .then((s) => s.mtimeMs)
              .catch(() => e.lastManifestAt),
          ),
        );
        if (now - Math.min(...times) > this.c.stallMs) void this.sourceStopped(e, 'SOURCE_STALLED');
      }
      if (
        ['ended', 'error'].includes(e.status) &&
        !e.viewers.size &&
        now - e.terminalAt > this.c.terminalRetentionMs
      ) {
        await e.ready;
        await e.stopping;
        if (this.registry.get(e.id) === e) this.registry.delete(e.id);
      }
    }
    const terminal = this.registry
      .values()
      .filter((e) => ['ended', 'error'].includes(e.status))
      .sort((a, b) => b.terminalAt - a.terminalAt);
    for (const e of terminal.slice(this.c.maxTerminalStreams)) {
      await e.ready;
      await e.stopping;
      if (this.registry.get(e.id) === e) this.registry.delete(e.id);
    }
    await this.checkDisk();
    if (this.disk.freeMb < this.c.minFreeMb || this.disk.usedMb > this.c.maxDiskMb) {
      const candidate = this.active().sort(
        (a, b) => a.viewers.size - b.viewers.size || a.createdAt - b.createdAt,
      )[0];
      if (candidate) await this.stop(candidate.id, 'error', 'DISK_LOW', candidate);
    }
  }
  async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    await this.maintaining;
    await Promise.all(this.registry.values().map((e) => this.stop(e.id, 'ended', null, e)));
  }
}
