import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { normalizeInput, VIDEO_ID } from './input.js';
import { RateLimiter } from './registry.js';
import { AppError } from './errors.js';
import { log, logs } from './log.js';
const root = path.resolve(import.meta.dirname, '..');
const equal = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
export function createApp(
  c,
  manager,
  extractor,
  { dependencies = { ffmpeg: true, ytDlp: true } } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', c.trustProxy);
  const submissions = new RateLimiter(c.submissions, c.submissionWindowMs, c.maxRateKeys);
  const adminAttempts = new RateLimiter(20, 60000, c.maxRateKeys);
  const channelAbort = new AbortController();
  app.locals.channelAbort = channelAbort;
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-ID', req.requestId);
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'" +
        (c.production ? "; frame-ancestors 'none'" : ''),
    });
    if (c.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path === '/health')
      res.set('Cache-Control', 'no-store');
    const start = Date.now();
    res.on('finish', () => {
      if (req.method !== 'GET' || res.statusCode >= 400)
        log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
          requestId: req.requestId,
          method: req.method,
          path: req.path.replace(/[^\x20-\x7e]/g, '?').slice(0, 160),
          status: res.statusCode,
          durationMs: Date.now() - start,
        });
    });
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.use((req, res, next) => {
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method)) {
      const expected = c.publicOrigin || `${req.protocol}://${req.get('host')}`;
      if (
        req.get('sec-fetch-site') === 'cross-site' ||
        (req.get('origin') && req.get('origin') !== expected)
      )
        return next(new AppError('ORIGIN_REJECTED', 403));
    }
    next();
  });
  app.get('/health', (_req, res) => {
    const ok =
      !manager.closing &&
      dependencies.ffmpeg &&
      (c.demo || dependencies.ytDlp) &&
      manager.disk.freeMb >= c.minFreeMb;
    res
      .status(ok ? 200 : 503)
      .json({ ok, service: 'relay', mode: c.demo ? 'demo' : 'live', dependencies });
  });
  app.get('/api/config', (_req, res) =>
    res.json({ heartbeatMs: c.heartbeatMs, abr: c.abr, demo: c.demo, maxHeight: c.singleHeight }),
  );
  app.post('/api/streams', async (req, res) => {
    if (!submissions.allow(req.ip)) {
      res.set('Retry-After', String(Math.ceil(c.submissionWindowMs / 1000)));
      throw new AppError('RATE_LIMIT', 429);
    }
    if (!dependencies.ffmpeg || (!c.demo && !dependencies.ytDlp))
      throw new AppError('DEPENDENCY_MISSING', 503);
    const input = normalizeInput(req.body?.url);
    let info;
    if (input.kind === 'channel') {
      if (c.demo) throw new AppError('DEMO_DIRECT_ONLY', 422);
      info = await extractor.channel(input.url, channelAbort.signal);
    }
    const viewer = await manager.attach(info?.id || input.id, info);
    res.status(202).json(viewer);
  });
  const bearer = (req) => req.get('authorization')?.replace(/^Bearer /, '') || '';
  app.get('/api/streams/:id', (req, res) =>
    res.json(manager.public(manager.authorize(req.params.id, bearer(req)))),
  );
  app.post('/api/streams/:id/heartbeat', (req, res) =>
    res.json(manager.public(manager.authorize(req.params.id, bearer(req), true))),
  );
  app.delete('/api/streams/:id/viewer', (req, res) => {
    manager.release(req.params.id, bearer(req));
    res.sendStatus(204);
  });
  app.get('/streams/:id/:file', async (req, res) => {
    const { id, file } = req.params;
    if (!VIDEO_ID.test(id) || !/^([a-f0-9]{12}-\d+p-\d{9}\.ts|\d+p\.m3u8|stream\.m3u8)$/.test(file))
      throw new AppError('NOT_FOUND', 404);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const e = manager.authorize(id, token, true);
    if (e.status !== 'live') throw new AppError(e.error || 'STREAM_ENDED', 410);
    const location = path.join(e.outputPath, file);
    if (file.endsWith('.m3u8')) {
      const text = await readFile(location, 'utf8');
      // All playlists are FFmpeg-generated. Fail closed on unexpected URI directives or external links.
      const lines = text.split('\n').map((line) => {
        if (line.includes('URI=')) throw new AppError('INTERNAL', 500);
        if (!line || line.startsWith('#')) return line;
        if (!/^(\d+p\.m3u8|[a-f0-9]{12}-\d+p-\d{9}\.ts)$/.test(line))
          throw new AppError('INTERNAL', 500);
        return `${line}?token=${encodeURIComponent(token)}`;
      });
      res.set('Cache-Control', 'no-store');
      res.type('application/vnd.apple.mpegurl').send(lines.join('\n'));
    } else {
      if (!file.startsWith(e.generation + '-')) throw new AppError('NOT_FOUND', 404);
      res.set('Cache-Control', 'private, max-age=60, immutable');
      res.type('video/mp2t').sendFile(location);
    }
  });
  function admin(req, res, next) {
    if (!c.adminPassword) return next(new AppError('ADMIN_DISABLED', 503));
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    let credentials = '';
    try {
      credentials = Buffer.from(encoded || '', 'base64').toString('utf8');
    } catch {}
    if (scheme === 'Basic' && equal(credentials, `${c.adminUser}:${c.adminPassword}`))
      return next();
    if (!adminAttempts.allow(req.ip)) return next(new AppError('RATE_LIMIT', 429));
    res.set('WWW-Authenticate', 'Basic realm="Relay operator", charset="UTF-8"');
    res.status(401).send('Operator sign-in required.');
  }
  app.use('/admin', admin);
  app.get('/admin', (_req, res) => res.sendFile(path.join(root, 'server/admin.html')));
  app.get('/admin/api/status', async (_req, res) => {
    const streams = await Promise.all(
      manager.registry.values().map(async (e) => {
        let rssMb = null;
        if (e.pid)
          try {
            const status = await readFile(`/proc/${e.pid}/status`, 'utf8');
            rssMb = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024;
          } catch {}
        return {
          ...manager.public(e),
          pid: e.pid,
          extractorPid: e.extractorProcess?.pid || null,
          rssMb,
          outputPath: e.outputPath,
        };
      }),
    );
    res.json({
      streams,
      logs,
      disk: manager.disk,
      memoryMb: process.memoryUsage().rss / 1048576,
      uptime: process.uptime(),
      maxStreams: c.maxStreams,
    });
  });
  app.post('/admin/api/streams/:id/stop', async (req, res) => {
    if (!req.get('origin')) throw new AppError('ORIGIN_REJECTED', 403);
    if (!VIDEO_ID.test(req.params.id)) throw new AppError('INVALID_URL');
    await manager.stop(req.params.id);
    res.json({ ok: true });
  });
  app.use(
    express.static(path.join(root, 'client'), {
      index: 'index.html',
      maxAge: c.production ? '1h' : 0,
      dotfiles: 'deny',
      setHeaders(res, file) {
        if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 404)));
  app.use((err, req, res, _next) => {
    const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
    const code =
      err instanceof AppError
        ? err.code
        : status === 413
          ? 'REQUEST_TOO_LARGE'
          : status === 400
            ? 'INVALID_REQUEST'
            : status === 404
              ? 'NOT_FOUND'
              : 'INTERNAL';
    if (status >= 500) log('error', 'request_error', { requestId: req.requestId, code });
    if (!res.headersSent) res.status(status).json({ error: code, requestId: req.requestId });
  });
  return app;
}
