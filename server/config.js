import 'dotenv/config';
import path from 'node:path';
function number(name, fallback, min = 1, max = 1e9) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
const bool = (name, fallback = false) => (process.env[name] ?? String(fallback)) === 'true';
export const config = {
  port: number('PORT', 3000, 1, 65535),
  production: process.env.NODE_ENV === 'production',
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  trustProxy: number('TRUST_PROXY', 0, 0, 10),
  streamDir: path.resolve(process.env.STREAM_DIR || './data/streams'),
  maxStreams: number('MAX_STREAMS', 2, 1, 100),
  maxViewers: number('MAX_VIEWERS_PER_STREAM', 250, 1, 100000),
  graceMs: number('IDLE_GRACE_SECONDS', 120) * 1000,
  viewerTtlMs: number('VIEWER_TTL_SECONDS', 45) * 1000,
  heartbeatMs: number('HEARTBEAT_SECONDS', 12) * 1000,
  extractTimeoutMs: number('EXTRACT_TIMEOUT_SECONDS', 18) * 1000,
  startupTimeoutMs: number('STARTUP_TIMEOUT_SECONDS', 35) * 1000,
  extractRetries: number('EXTRACT_RETRIES', 2, 0, 5),
  retryBaseMs: number('RETRY_BASE_MS', 500),
  maintenanceMs: number('MAINTENANCE_SECONDS', 5) * 1000,
  stallMs: number('STALL_TIMEOUT_SECONDS', 45) * 1000,
  terminalRetentionMs: number('TERMINAL_RETENTION_SECONDS', 300) * 1000,
  maxTerminalStreams: number('MAX_TERMINAL_STREAMS', 100, 1, 10000),
  allowedVideoIds: (process.env.ALLOWED_VIDEO_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  submissionWindowMs: number('SUBMISSION_WINDOW_SECONDS', 60) * 1000,
  submissions: number('SUBMISSIONS_PER_WINDOW', 10),
  maxRateKeys: number('MAX_RATE_KEYS', 10000),
  maxResolvers: number('MAX_RESOLVERS', 2, 1, 20),
  resolveCacheMs: number('RESOLVE_CACHE_SECONDS', 30) * 1000,
  maxCache: number('MAX_RESOLVE_CACHE', 250),
  segmentSeconds: number('HLS_SEGMENT_SECONDS', 4, 1, 20),
  listSize: number('HLS_LIST_SIZE', 8, 3, 100),
  singleHeight: number('SINGLE_HEIGHT', 720, 144, 2160),
  abr: bool('ABR_ENABLED'),
  abrHeights: (process.env.ABR_HEIGHTS || '360,480,720').split(',').map(Number),
  minFreeMb: number('MIN_FREE_DISK_MB', 128, 0),
  maxDiskMb: number('MAX_HLS_DISK_MB', 400),
  ytDlp: process.env.YT_DLP_PATH || 'yt-dlp',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  cookies: process.env.YT_DLP_COOKIES_FILE || '',
  demo: bool('DEMO_MODE'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  logLimit: number('LOG_BUFFER_SIZE', 200, 10, 10000),
};
if (
  config.abrHeights.length > 4 ||
  config.abrHeights.some((n) => !Number.isInteger(n) || n < 144 || n > 2160)
)
  throw new Error('Invalid ABR_HEIGHTS (maximum 4 heights)');
if (config.heartbeatMs >= config.viewerTtlMs)
  throw new Error('Heartbeat must be shorter than viewer TTL');
if (config.production && config.adminPassword.length < 16)
  throw new Error('Production requires ADMIN_PASSWORD of at least 16 characters');
if (config.publicOrigin && new URL(config.publicOrigin).origin !== config.publicOrigin)
  throw new Error('PUBLIC_ORIGIN must be a bare origin');

if (config.allowedVideoIds.some((id) => !/^[A-Za-z0-9_-]{11}$/.test(id)))
  throw new Error('Invalid ALLOWED_VIDEO_IDS');

if (
  [
    path.parse(config.streamDir).root,
    process.cwd(),
    path.resolve(process.cwd(), 'server'),
    path.resolve(process.cwd(), 'client'),
  ].includes(config.streamDir)
)
  throw new Error('STREAM_DIR must be a dedicated disposable subdirectory');
