import { setTimeout as delay } from 'node:timers/promises';
import { capture } from './process.js';
import { AppError } from './errors.js';
import { VIDEO_ID } from './input.js';
import { log, safeDiagnostic } from './log.js';
export class Extractor {
  constructor(config) {
    this.config = config;
    this.inflight = new Map();
    this.cache = new Map();
  }
  async extract(url, { signal, onChild } = {}) {
    const c = this.config,
      deadline = Date.now() + c.extractTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await capture(
          c.ytDlp,
          [
            '--ignore-config',
            '--no-playlist',
            '--no-warnings',
            '--skip-download',
            '--dump-single-json',
            '--no-check-formats',
            '--socket-timeout',
            '6',
            '--retries',
            '0',
            '--extractor-retries',
            '0',
            '--js-runtimes',
            'node',
            ...(c.cookies ? ['--cookies', c.cookies] : []),
            '--',
            url,
          ],
          { timeoutMs: Math.max(1, deadline - Date.now()), signal, onChild },
        );
        const info = JSON.parse(raw);
        if (!VIDEO_ID.test(info.id || '')) throw new AppError('NOT_LIVE', 422);
        if (info.live_status !== 'is_live') throw new AppError('NOT_LIVE', 422);
        return info;
      } catch (e) {
        if (e.diagnostic) {
          log('warn', 'extraction_failed', { attempt, detail: safeDiagnostic(e.diagnostic) });
          if (
            /not currently live|not live|live event will begin|Premieres in|offline/i.test(
              e.diagnostic,
            )
          )
            throw new AppError('NOT_LIVE', 422);
          if (
            /private video|video unavailable|removed|sign in|not available|copyright/i.test(
              e.diagnostic,
            )
          )
            throw new AppError('SOURCE_UNAVAILABLE', 422);
        }
        if (e instanceof SyntaxError) throw new AppError('UPSTREAM_ERROR', 502);
        const wait = c.retryBaseMs * 2 ** attempt;
        if (
          e.code !== 'UPSTREAM_ERROR' ||
          attempt >= c.extractRetries ||
          Date.now() + wait >= deadline
        )
          throw e;
        await delay(wait, undefined, { signal }).catch(() => {
          throw new AppError('STOPPED', 409);
        });
      }
    }
  }
  async channel(url, signal) {
    const now = Date.now();
    for (const [k, v] of this.cache) if (v.until < now) this.cache.delete(k);
    if (this.cache.has(url)) return this.cache.get(url).info;
    if (this.inflight.has(url)) return this.inflight.get(url);
    if (this.inflight.size >= this.config.maxResolvers) throw new AppError('CAPACITY', 503);
    const promise = this.extract(url, { signal })
      .then((info) => {
        if (this.cache.size >= this.config.maxCache)
          this.cache.delete(this.cache.keys().next().value);
        this.cache.set(url, {
          info: { id: info.id, title: info.title, live_status: info.live_status },
          until: Date.now() + this.config.resolveCacheMs,
        });
        return info;
      })
      .catch((e) => {
        if (e.code === 'NOT_LIVE') throw new AppError('CHANNEL_NOT_LIVE', 422);
        throw e;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }
}
