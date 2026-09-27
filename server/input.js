import { AppError } from './errors.js';
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export function normalizeInput(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x20\x7f]/.test(raw.trim()))
    throw new AppError('INVALID_URL');
  let s = raw.trim();
  if (/^@[\p{L}\p{N}_.-]{3,100}$/u.test(s)) s = `https://www.youtube.com/${s}`;
  if (/^(www\.|m\.)?youtube\.com\//i.test(s) || /^youtu\.be\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new AppError('INVALID_URL');
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port)
    throw new AppError('INVALID_URL');
  let id;
  if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(u.hostname)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (/^\/(live|embed|shorts)\//.test(u.pathname)) id = u.pathname.split('/')[2];
    else {
      const p = u.pathname.replace(/\/+$/, '').replace(/\/(live|streams|videos|featured)$/, '');
      if (
        /^\/(?:@[\p{L}\p{N}_.%\-]{3,300}|channel\/UC[A-Za-z0-9_-]{22}|(?:c|user)\/[\p{L}\p{N}_.%\-]{1,100})$/u.test(
          p,
        )
      ) {
        return { kind: 'channel', url: `https://www.youtube.com${p}/live` };
      }
    }
  }
  if (!id || !VIDEO_ID.test(id)) throw new AppError('INVALID_URL');
  return { kind: 'video', id, url: `https://www.youtube.com/watch?v=${id}` };
}
export function validateMediaUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('UNSUPPORTED_FORMAT', 422);
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !['googlevideo.com', 'youtube.com'].some(
      (d) => u.hostname === d || u.hostname.endsWith(`.${d}`),
    )
  )
    throw new AppError('UNSUPPORTED_FORMAT', 422);
  return raw;
}
