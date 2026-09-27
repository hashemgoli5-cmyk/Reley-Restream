import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startChild, terminate } from './process.js';
import { validateMediaUrl } from './input.js';
import { AppError } from './errors.js';
import { log, safeDiagnostic } from './log.js';

export function chooseRenditions(info, c) {
  const formats = (info.formats || []).filter(
    (f) => f.url && !f.has_drm && ['https', 'm3u8_native', 'm3u8'].includes(f.protocol),
  );
  const videos = formats.filter(
    (f) =>
      /^avc1|^h264/.test(f.vcodec || '') &&
      f.height &&
      (!f.acodec || f.acodec === 'none' || /^mp4a|^aac/.test(f.acodec)),
  );
  const audios = formats
    .filter((f) => f.vcodec === 'none' && /^mp4a|^aac/.test(f.acodec || ''))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const result = [];
  for (const height of c.abr ? c.abrHeights : [c.singleHeight]) {
    const video = videos
      .filter((f) => f.height <= height)
      .sort((a, b) => b.height - a.height || (b.tbr || 0) - (a.tbr || 0))[0];
    if (!video || result.some((r) => r.video.format_id === video.format_id)) continue;
    const audio = video.acodec && video.acodec !== 'none' ? null : audios[0];
    if (!audio && (!video.acodec || video.acodec === 'none')) continue;
    validateMediaUrl(video.url);
    if (audio) validateMediaUrl(audio.url);
    result.push({
      video,
      audio,
      height: video.height,
      width: video.width || Math.round((video.height * 16) / 9),
    });
  }
  if (!result.length) throw new AppError('UNSUPPORTED_FORMAT', 422);
  return result;
}
function hlsArgs(c, dir, label, prefix) {
  return [
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    String(c.segmentSeconds),
    '-hls_list_size',
    String(c.listSize),
    '-hls_delete_threshold',
    '2',
    '-hls_flags',
    'delete_segments+temp_file+omit_endlist',
    '-hls_segment_filename',
    path.join(dir, `${prefix}-${label}-%09d.ts`),
    path.join(dir, `${label}.m3u8`),
  ];
}
export function buildFfmpegArgs(renditions, c, dir, prefix) {
  const inputs = [],
    index = new Map();
  for (const r of renditions)
    for (const f of [r.video, r.audio].filter(Boolean))
      if (!index.has(f.url)) {
        index.set(f.url, inputs.length);
        inputs.push(f);
      }
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
  for (const f of inputs)
    args.push(
      '-protocol_whitelist',
      'https,http,tls,tcp,crypto',
      '-rw_timeout',
      '15000000',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      f.url,
    );
  for (const r of renditions)
    args.push(
      '-map',
      `${index.get(r.video.url)}:v:0`,
      '-map',
      `${index.get((r.audio || r.video).url)}:a:0`,
      ...hlsArgs(c, dir, `${r.height}p`, prefix),
    );
  return args;
}
export class Pipeline {
  constructor(c, extractor) {
    this.c = c;
    this.extractor = extractor;
  }
  async hasEnded(entry) {
    if (this.c.demo) return false;
    // No media is downloaded: a bounded metadata probe on a failed/stalled pipeline.
    try {
      await this.extractor.extract(`https://www.youtube.com/watch?v=${entry.id}`, {
        signal: entry.abort.signal,
        onChild: (p) => {
          entry.extractorProcess = p;
        },
      });
      return false;
    } catch (e) {
      return e.code === 'NOT_LIVE';
    } finally {
      entry.extractorProcess = null;
    }
  }
  async start(entry, discovered) {
    const c = this.c;
    await mkdir(entry.outputPath, { recursive: true });
    let renditions, args;
    if (c.demo) {
      entry.title = 'Relay test signal · locally generated';
      renditions = [{ height: 360, width: 640, video: { tbr: 800 } }];
      args = [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-nostdin',
        '-y',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-threads',
        '1',
        '-g',
        '100',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-f',
        'hls',
        '-hls_time',
        String(c.segmentSeconds),
        '-hls_list_size',
        String(c.listSize),
        '-hls_flags',
        'delete_segments+temp_file+omit_endlist',
        '-hls_delete_threshold',
        '2',
        '-hls_segment_filename',
        path.join(entry.outputPath, `${entry.generation}-360p-%09d.ts`),
        path.join(entry.outputPath, '360p.m3u8'),
      ];
    } else {
      const info = discovered?.formats?.length
        ? discovered
        : await this.extractor.extract(`https://www.youtube.com/watch?v=${entry.id}`, {
            signal: entry.abort.signal,
            onChild: (p) => {
              entry.extractorProcess = p;
            },
          });
      entry.extractorProcess = null;
      if (info.id !== entry.id) throw new AppError('UPSTREAM_ERROR', 502);
      entry.title = String(info.title || entry.id).slice(0, 300);
      renditions = chooseRenditions(info, c);
      args = buildFfmpegArgs(renditions, c, entry.outputPath, entry.generation);
    }
    if (entry.abort.signal.aborted) throw new AppError('STOPPED', 409);
    const child = startChild(c.ffmpeg, args);
    entry.process = child;
    entry.pid = child.pid;
    let dependencyError = false,
      diagnostic = '';
    child.on('error', () => {
      dependencyError = true;
    });
    child.stderr.on('data', (d) => {
      diagnostic = (diagnostic + d).slice(-3000);
    });
    const abort = () => {
      void terminate(child);
    };
    entry.abort.signal.addEventListener('abort', abort, { once: true });
    child.done.then(({ code, signal }) => {
      entry.abort.signal.removeEventListener('abort', abort);
      if (!entry.abort.signal.aborted)
        log(code === 0 ? 'info' : 'warn', 'ffmpeg_exit', {
          videoId: entry.id,
          code,
          signal,
          detail: safeDiagnostic(diagnostic),
        });
    });
    const deadline = Date.now() + c.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (entry.abort.signal.aborted) throw new AppError('STOPPED', 409);
      if (dependencyError) throw new AppError('DEPENDENCY_MISSING', 503);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new AppError('UPSTREAM_ERROR', 502);
      const ready = await Promise.all(
        renditions.map(async (r) => {
          try {
            const text = await readFile(path.join(entry.outputPath, `${r.height}p.m3u8`), 'utf8');
            const segments = text.split('\n').filter((s) => s && !s.startsWith('#'));
            if (!segments.length) return false;
            const s = await stat(path.join(entry.outputPath, segments.at(-1)));
            return s.size > 0;
          } catch {
            return false;
          }
        }),
      );
      if (ready.every(Boolean)) {
        const master =
          [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            ...renditions.flatMap((r) => [
              `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(((r.video.tbr || r.height * 4) + 192) * 1200)},RESOLUTION=${r.width}x${r.height}`,
              `${r.height}p.m3u8`,
            ]),
          ].join('\n') + '\n';
        await writeFile(path.join(entry.outputPath, 'stream.m3u8'), master);
        entry.qualities = renditions.map((r) => r.height);
        entry.lastManifestAt = Date.now();
        return child;
      }
      await delay(250);
    }
    throw new AppError('STARTUP_TIMEOUT', 504);
  }
}
