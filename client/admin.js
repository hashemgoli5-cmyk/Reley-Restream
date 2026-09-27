const $ = (id) => document.getElementById(id);
let lang = 'en';
try {
  lang = localStorage.getItem('relay-language') || 'en';
} catch {}
const copy = {
  en: {
    operator: 'Operator console',
    system: 'SYSTEM OVERVIEW',
    streams: 'Live streams',
    refresh: 'Refresh',
    logs: 'Recent activity',
    active: 'Active pipelines',
    memory: 'App memory',
    disk: 'HLS storage',
    uptime: 'Server uptime',
    head: ['Stream / video ID', 'Status', 'Viewers', 'Uptime', 'PID / RAM', 'Action'],
    empty: 'No streams yet. Your server is ready.',
    stop: 'Stop',
    confirm: 'Stop this stream for all viewers?',
    failed: 'Could not load the operator console. Check your sign-in and connection.',
    live: 'Live',
    starting: 'Starting',
    ended: 'Ended',
    error: 'Error',
  },
  fa: {
    operator: 'پنل مدیریت',
    system: 'نمای کلی سیستم',
    streams: 'پخش‌های زنده',
    refresh: 'تازه‌سازی',
    logs: 'رویدادهای اخیر',
    active: 'پخش‌های فعال',
    memory: 'حافظه برنامه',
    disk: 'فضای پخش HLS',
    uptime: 'زمان فعالیت سرور',
    head: [
      'عنوان / شناسه ویدیو',
      'وضعیت',
      'تماشاگران',
      'زمان فعالیت',
      'شناسه فرایند / حافظه',
      'عملیات',
    ],
    empty: 'هنوز پخشی وجود ندارد. سرور آماده است.',
    stop: 'توقف',
    confirm: 'این پخش برای تمام تماشاگران متوقف شود؟',
    failed: 'دریافت اطلاعات ممکن نشد. ورود و اتصال خود را بررسی کنید.',
    live: 'زنده',
    starting: 'در حال شروع',
    ended: 'پایان‌یافته',
    error: 'خطا',
  },
};
let data = null,
  busy = false;
const num = (n) => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
function render() {
  const t = copy[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  for (const [id, key] of [
    ['operator-label', 'operator'],
    ['system-label', 'system'],
    ['streams-label', 'streams'],
    ['refresh', 'refresh'],
    ['logs-label', 'logs'],
  ])
    $(id).textContent = t[key];
  $('admin-language').textContent = lang === 'en' ? 'فارسی' : 'English';
  $('table-head').replaceChildren(
    ...t.head.map((x) => {
      const el = document.createElement('th');
      el.textContent = x;
      return el;
    }),
  );
  if (!data) return;
  $('metrics').replaceChildren(
    ...[
      [
        t.active,
        `${num(data.streams.filter((s) => ['live', 'starting'].includes(s.status)).length)} / ${num(data.maxStreams)}`,
      ],
      [t.memory, `${num(data.memoryMb)} MB`],
      [t.disk, `${num(data.disk.usedMb)} MB`],
      [t.uptime, `${num(data.uptime / 3600)} h`],
    ].map(([label, value]) => {
      const el = document.createElement('div');
      el.className = 'metric';
      const a = document.createElement('span'),
        b = document.createElement('strong');
      a.textContent = label;
      b.textContent = value;
      el.append(a, b);
      return el;
    }),
  );
  $('streams').replaceChildren();
  for (const stream of data.streams) {
    const row = document.createElement('tr');
    for (const value of [
      stream.title || stream.id,
      t[stream.status] || stream.status,
      num(stream.viewers),
      `${num((Date.now() - stream.createdAt) / 60000)} min`,
      `${stream.pid || '—'} / ${stream.rssMb === null ? '—' : num(stream.rssMb) + ' MB'}`,
    ]) {
      const td = document.createElement('td');
      td.textContent = value;
      row.append(td);
    }
    const id = document.createElement('small');
    id.textContent = stream.id;
    id.dir = 'ltr';
    row.firstChild.append(id);
    const td = document.createElement('td');
    if (['starting', 'live'].includes(stream.status)) {
      const b = document.createElement('button');
      b.textContent = t.stop;
      b.className = 'stop-button';
      b.onclick = async () => {
        if (!confirm(t.confirm)) return;
        b.disabled = true;
        try {
          const r = await fetch(`/admin/api/streams/${stream.id}/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (!r.ok) throw new Error();
          await refresh();
        } catch {
          $('admin-error').textContent = t.failed;
          $('admin-error').hidden = false;
        } finally {
          b.disabled = false;
        }
      };
      td.append(b);
    }
    row.append(td);
    $('streams').append(row);
  }
  if (!data.streams.length) {
    const tr = document.createElement('tr'),
      td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = t.empty;
    tr.append(td);
    $('streams').append(tr);
  }
  $('logs').textContent =
    data.logs
      .slice()
      .reverse()
      .map((l) => JSON.stringify(l))
      .join('\n') || '—';
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch('/admin/api/status', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error();
    data = await r.json();
    $('admin-error').hidden = true;
    render();
  } catch {
    $('admin-error').textContent = copy[lang].failed;
    $('admin-error').hidden = false;
  } finally {
    busy = false;
  }
}
$('admin-language').onclick = () => {
  lang = lang === 'en' ? 'fa' : 'en';
  try {
    localStorage.setItem('relay-language', lang);
  } catch {}
  render();
};
$('refresh').onclick = refresh;
render();
void refresh();
setInterval(refresh, 5000);
