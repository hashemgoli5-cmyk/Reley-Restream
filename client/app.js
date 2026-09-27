import { strings } from './i18n.js';
const $ = (id) => document.getElementById(id),
  video = $('video');
let lang = 'en';
try {
  lang = localStorage.getItem('relay-language') === 'fa' ? 'fa' : 'en';
} catch {}
let session = null,
  hls = null,
  timer = null,
  config = { heartbeatMs: 12000 },
  state = 'ready',
  lastError = '',
  health = 'checking',
  busy = false,
  failures = 0,
  polling = false,
  playbackRecoveries = 0,
  requestGeneration = 0;
const t = (k) => strings[lang][k] || strings[lang].INTERNAL;
const show = (id, visible) => {
  $(id).hidden = !visible;
};
function localize() {
  document.title = t('pageTitle');
  document.querySelector('.brand').setAttribute('aria-label', t('home'));
  document.querySelector('.stream-workspace').setAttribute('aria-label', t('playerAria'));
  video.setAttribute('aria-label', t('playerAria'));
  document.querySelectorAll('.step-number').forEach((el, i) => {
    el.textContent = new Intl.NumberFormat(lang, { minimumIntegerDigits: 2 }).format(i + 1);
  });
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelector('.intro-description').style.whiteSpace = 'pre-line';
  $('stream-url').placeholder = t('placeholder');
  $('language-label').textContent = lang === 'en' ? 'فارسی' : 'English';
  $('language').setAttribute(
    'aria-label',
    lang === 'en' ? 'Switch to Persian' : 'تغییر زبان به انگلیسی',
  );
  for (const [id, key] of [
    ['volume', 'volume'],
    ['fullscreen', document.fullscreenElement ? 'exitFullscreen' : 'fullscreen'],
    ['live-edge', 'goLive'],
    ['quality', 'quality'],
  ])
    $(id).setAttribute('aria-label', t(key));
  $('submit').querySelector('span').textContent = t(busy ? 'connecting' : 'watch');
  $('health-label').textContent = t(health);
  renderState();
  updateControls();
  updateQuality();
  if (lastError) $('form-error').textContent = t(lastError);
}
$('language').onclick = () => {
  lang = lang === 'en' ? 'fa' : 'en';
  try {
    localStorage.setItem('relay-language', lang);
  } catch {}
  localize();
};
function renderState() {
  $('status-label').textContent = t(state);
  $('status-dot').classList.toggle('live', state === 'live');
  if (state === 'ended') {
    $('stage-title').textContent = t('endedTitle');
    $('stage-description').textContent = t('endedDescription');
  } else if (state === 'error') {
    $('stage-title').textContent = t('errorTitle');
    $('stage-description').textContent = t(lastError || 'UPSTREAM_ERROR');
  } else if (state === 'starting') {
    $('stage-title').textContent = t('connecting');
    $('stage-description').textContent = t('buffering');
  } else {
    $('stage-title').textContent = t('emptyTitle');
    $('stage-description').textContent = t('emptyDescription');
  }
  if (session) {
    $('viewer-count').textContent =
      `${new Intl.NumberFormat(lang).format(session.viewers || 1)} ${t('viewers')}`;
    show('viewer-count', state === 'live');
  }
}
function error(code) {
  lastError = strings.en[code] ? code : 'INTERNAL';
  $('form-error').textContent = t(lastError);
  show('form-error', true);
}
async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(25000),
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error('network');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({ error: 'INTERNAL' }));
  if (!response.ok) throw new Error(data.error || 'INTERNAL');
  return data;
}
function clearPlayer() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
  show('video', false);
  show('controls', false);
  show('buffering', false);
  show('play-overlay', false);
  show('quality-wrap', false);
  show('placeholder', true);
}
function release() {
  clearTimeout(timer);
  clearPlayer();
  if (session) {
    const old = session;
    session = null;
    fetch(`/api/streams/${old.id}/viewer`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${old.token}` },
      keepalive: true,
    }).catch(() => {});
  }
  show('viewer-count', false);
  show('stream-details', false);
}
function terminal(s, code) {
  state = s;
  lastError = code || '';
  clearTimeout(timer);
  clearPlayer();
  show('stream-details', false);
  show('viewer-count', false);
  renderState();
  if (code) error(code);
  busy = false;
  $('submit').disabled = false;
  $('submit').querySelector('span').textContent = t('watch');
}
$('stream-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const generation = ++requestGeneration;
  release();
  lastError = '';
  show('form-error', false);
  busy = true;
  $('submit').disabled = true;
  $('submit').querySelector('span').textContent = t('connecting');
  state = 'starting';
  renderState();
  try {
    const result = await api('/api/streams', {
      method: 'POST',
      body: JSON.stringify({ url: $('stream-url').value }),
    });
    if (generation !== requestGeneration) return;
    session = result;
    failures = 0;
    playbackRecoveries = 0;
    applyStatus(result);
    schedule(700);
  } catch (e) {
    terminal('error', e.message);
  }
});
function schedule(ms = config.heartbeatMs) {
  clearTimeout(timer);
  if (session && ['live', 'starting'].includes(state)) timer = setTimeout(poll, ms);
}
async function poll() {
  if (!session || polling) return;
  polling = true;
  const active = session;
  try {
    const data = await api(`/api/streams/${active.id}/heartbeat`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (session !== active) return;
    failures = 0;
    applyStatus(data);
  } catch (e) {
    if (session !== active) return;
    if (e.message === 'VIEWER_EXPIRED' || ++failures >= 3) terminal('error', e.message);
    else if (state === 'starting') {
      $('stage-title').textContent = t('reconnectTitle');
    }
  } finally {
    polling = false;
    schedule(state === 'starting' ? 1000 : config.heartbeatMs);
  }
}
function applyStatus(data) {
  if (!session) return;
  Object.assign(session, data);
  if (data.status === 'ended' || data.status === 'error') {
    terminal(data.status, data.error);
    return;
  }
  if (data.status === 'live' && state !== 'live') {
    state = 'live';
    busy = false;
    $('submit').disabled = false;
    $('submit').querySelector('span').textContent = t('watch');
    startPlayer(data.manifest);
    $('stream-title').textContent = data.title || data.id;
    show('stream-details', true);
  }
  renderState();
}
async function tryPlay() {
  try {
    await video.play();
    show('play-overlay', false);
  } catch {
    show('buffering', false);
    show('play-overlay', true);
  }
}
function startPlayer(manifest) {
  clearPlayer();
  show('placeholder', false);
  show('video', true);
  show('controls', true);
  show('buffering', true);
  const source = `${manifest}?token=${encodeURIComponent(session.token)}`;
  if (window.Hls?.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      liveSyncDurationCount: 3,
      maxBufferLength: 24,
      maxMaxBufferLength: 40,
      backBufferLength: 15,
      manifestLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 3,
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      updateQuality();
      void tryPlay();
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && playbackRecoveries++ < 2) {
        hls.recoverMediaError();
        return;
      }
      // Ask the server for terminal status before displaying a generic player failure.
      void api(`/api/streams/${session?.id}`)
        .then((s) => {
          if (!session) return;
          if (['ended', 'error'].includes(s.status)) applyStatus(s);
          else if (s.checkingEnd) {
            show('buffering', true);
            schedule(1000);
          } else terminal('error', 'playbackError');
        })
        .catch((e) => terminal('error', e.message));
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source;
    void tryPlay();
  } else terminal('error', 'UNSUPPORTED_FORMAT');
}
function updateQuality() {
  const select = $('quality'),
    selected = select.value;
  select.replaceChildren(new Option(t('auto'), '-1'));
  if (hls) hls.levels.forEach((l, i) => select.add(new Option(`${l.height}p`, String(i))));
  if ([...select.options].some((o) => o.value === selected)) select.value = selected;
  show('quality-wrap', !!hls && hls.levels.length > 1);
}
$('quality').onchange = () => {
  if (hls) hls.currentLevel = Number($('quality').value);
};
function updateControls() {
  $('play').setAttribute('aria-label', t(video.paused ? 'play' : 'pause'));
  $('play').innerHTML = video.paused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7Z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
  $('mute').setAttribute('aria-label', t(video.muted ? 'unmute' : 'mute'));
  $('mute').setAttribute('aria-pressed', String(video.muted));
  $('mute').style.opacity = video.muted ? '.45' : '1';
  $('volume').value = video.muted ? 0 : video.volume;
}
$('play').onclick = () => {
  if (video.paused) void tryPlay();
  else video.pause();
};
$('play-overlay').onclick = () => void tryPlay();
$('mute').onclick = () => {
  video.muted = !video.muted;
  updateControls();
};
$('volume').oninput = () => {
  video.volume = Number($('volume').value);
  video.muted = video.volume === 0;
  updateControls();
};
$('live-edge').onclick = () => {
  if (hls?.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
  else if (video.seekable.length)
    video.currentTime = video.seekable.end(video.seekable.length - 1) - 1;
  void tryPlay();
};
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('player-stage').requestFullscreen) await $('player-stage').requestFullscreen();
    else video.webkitEnterFullscreen?.();
  } catch {}
};
$('disconnect').onclick = () => {
  ++requestGeneration;
  release();
  state = 'ready';
  lastError = '';
  show('form-error', false);
  renderState();
};
video.addEventListener('waiting', () => {
  if (state === 'live') show('buffering', true);
});
video.addEventListener('playing', () => {
  show('buffering', false);
  show('play-overlay', false);
  updateControls();
});
video.addEventListener('pause', updateControls);
video.addEventListener('volumechange', updateControls);
video.addEventListener('error', () => {
  if (state === 'live' && !hls)
    void poll().then(() => {
      if (state === 'live') terminal('error', 'playbackError');
    });
});
video.addEventListener('ended', () => {
  if (state === 'live') void poll();
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').setAttribute(
    'aria-label',
    t(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen'),
  );
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session && ['live', 'starting'].includes(state)) {
    clearTimeout(timer);
    void poll();
  }
});
window.addEventListener('pagehide', release);
localize();
fetch('/api/config')
  .then((r) => r.json())
  .then((c) => {
    config = c;
    show('demo-banner', c.demo);
  })
  .catch(() => {});
async function checkHealth() {
  try {
    const r = await fetch('/health', { signal: AbortSignal.timeout(6000) });
    health = r.ok ? 'online' : 'offline';
  } catch {
    health = 'offline';
  }
  $('health-dot').classList.toggle('ok', health === 'online');
  $('health-label').textContent = t(health);
}
void checkHealth();
setInterval(checkHealth, 60000);
