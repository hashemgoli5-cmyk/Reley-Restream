import { config } from './config.js';
import { Extractor } from './extractor.js';
import { Pipeline } from './pipeline.js';
import { StreamManager } from './manager.js';
import { createApp } from './app.js';
import { capture, shutdownChildren } from './process.js';
import { log } from './log.js';
const dependencies = { ffmpeg: false, ytDlp: false };
await Promise.all(
  [
    ['ffmpeg', config.ffmpeg, ['-version']],
    ['ytDlp', config.ytDlp, ['--version']],
  ].map(async ([key, cmd, args]) => {
    try {
      await capture(cmd, args, { timeoutMs: 5000 });
      dependencies[key] = true;
    } catch {
      log('error', 'dependency_missing', { dependency: key });
    }
  }),
);
const extractor = new Extractor(config),
  manager = new StreamManager(config, new Pipeline(config, extractor));
await manager.init();
const app = createApp(config, manager, extractor, { dependencies });
const server = app.listen(config.port, '0.0.0.0', () =>
  log('info', 'listening', { port: config.port, mode: config.demo ? 'demo' : 'live' }),
);
server.requestTimeout = 60000;
server.headersTimeout = 15000;
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log('info', 'shutdown', { signal });
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  app.locals.channelAbort.abort();
  server.close();
  await manager.shutdown();
  await shutdownChildren();
  server.closeAllConnections();
  clearTimeout(deadline);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { code: err.code || 'INTERNAL' });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', () => {
  log('error', 'unhandled_rejection');
  void shutdown('unhandledRejection');
});
