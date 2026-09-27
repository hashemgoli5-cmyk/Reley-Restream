import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
const children = new Set();
export function startChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    ...options,
  });
  children.add(child);
  child.once('error', () => {});
  child.done = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  return child;
}
export async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal) => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {}
  };
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), 2500);
  timer.unref();
  await child.done;
  clearTimeout(timer);
}
export async function shutdownChildren() {
  await Promise.all([...children].map(terminate));
}
export function capture(
  command,
  args,
  { timeoutMs = 18000, signal, onChild, maxBytes = 12 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('STOPPED', 409));
    const child = startChild(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure;
    const abort = () => {
      failure = new AppError('STOPPED', 409);
      void terminate(child);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      failure = new AppError('RESOLVE_TIMEOUT', 504);
      void terminate(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        failure = new AppError('UPSTREAM_ERROR', 502);
        void terminate(child);
      } else stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    child.on('error', () => {
      failure = new AppError('DEPENDENCY_MISSING', 503);
    });
    child.done.then(({ code }) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) {
        const e = new AppError('UPSTREAM_ERROR', 502);
        e.diagnostic = stderr;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}
