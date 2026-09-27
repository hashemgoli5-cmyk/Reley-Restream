import { config } from './config.js';
export const logs = [];
export function log(level, event, fields = {}) {
  const row = { time: new Date().toISOString(), level, event, ...fields };
  logs.push(row);
  if (logs.length > config.logLimit) logs.shift();
  console.log(JSON.stringify(row));
}
// Never persist signed media URLs, cookies, or authorization headers in operator logs.
export function safeDiagnostic(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"']+/g, '[upstream URL]')
    .replace(/[\r\n]+/g, ' ')
    .slice(-800);
}
