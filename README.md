# Relay · YouTube live, through your own server

A small, single-instance live-restreaming service with an English/Persian interface, a fully mirrored RTL player, and a protected operator console. Paste a YouTube live video URL, channel URL, or `@handle`. The **server** resolves the source, re-muxes it, and serves local HLS. Viewers never load a YouTube iframe, image, script, manifest, or media segment.

**Use only broadcasts you own or have explicit permission to restream.** Restreaming permissions, YouTube's terms, and applicable laws remain the operator's responsibility. This is not a DRM bypass, general-purpose proxy, recording service, or promise that cloud-origin YouTube extraction will always work.

## Architecture and choices

```text
Browser: EN / فارسی (RTL), HLS.js + <video>, familiar mirrored controls
    │ same-origin JSON + heartbeat + local HLS only
    ▼
Node.js / Express (one process, one Railway replica)
    ├── strict YouTube input parser + per-IP submission limiter
    ├── bounded channel resolver/cache ── yt-dlp discovery
    ├── video-ID mutex + atomic capacity reservation
    ├── StreamRegistry interface → MemoryRegistry
    │      canonical video ID → one lifecycle + many viewer leases
    └── Pipeline
           yt-dlp metadata / signed source URLs (short-lived process)
                      ▼
           one FFmpeg process per video ID, -c copy
                      ▼
           data/streams/{video_id}/stream.m3u8 (local master)
                                 /360p.m3u8, /720p.m3u8, …
                                 /{generation}-{quality}-{sequence}.ts
                      ▼
           authenticated same-origin HLS routes → all viewers

/admin → Basic-auth operator page, stop buttons, memory/disk/uptime, logs
/health → dependency readiness + disk floor + shutdown state
```

- **Node.js 22 + Express 5:** small dependency footprint, asynchronous I/O, and direct OS child-process supervision. No database, Redis, web sockets, frontend compilation, or background queue is needed for one instance.
- **Vanilla ES modules + HLS.js:** a lightweight UI with conventional play/pause, volume, live-edge, quality, and fullscreen controls. HLS.js handles ABR; native HLS is used where MediaSource is unavailable. Controls use logical CSS to mirror consistently in RTL, rather than relying on platform-native controls that may not mirror. iOS native fullscreen controls are ultimately OS-controlled.
- **Local Inter and Vazirmatn fonts:** copied along with HLS.js during `npm ci`. No CDNs, Google Fonts, analytics, thumbnails, or third-party browser requests.
- **MPEG-TS HLS + copy mode:** no production video/audio transcoding, minimizing CPU. A sliding segment window bounds disk use. FFmpeg's temporary-file publication prevents half-written playlists/segments.
- **Polling:** starting streams are checked about once a second; live heartbeat/status defaults to every 12 seconds. This avoids maintaining a separate SSE/WebSocket connection. End notifications arrive on the next successful poll, not instantaneously.

## Repository

```text
server/                 HTTP API, process supervisor, extractor, registry, manager
  admin.html            Basic-auth-protected operator document
client/                 bilingual public UI, HLS controls, admin scripts/styles
  vendor/               generated at install; not committed
scripts/vendor.js       copies runtime HLS.js and local font assets
test/                  unit, process, HTTP integration, and browser tests
Dockerfile              Node + pinned yt-dlp/EJS + FFmpeg + tini, non-root runtime
railway.json            Docker build, single replica, health check, drain settings
.env.example            documented runtime configuration
package-lock.json       reproducible Node dependency versions
```

## Quick start

### Local Node installation

Dependencies: **Node 22 recommended (20.19+ supported), Python 3.10+, yt-dlp with its default dependencies/EJS, and FFmpeg**. Linux is the deployment target. macOS works with installed binaries; Windows process-tree semantics are not part of the tested target.

```sh
# Debian/Ubuntu example; install Node.js 22 using your preferred supported method.
sudo apt-get update
sudo apt-get install -y ffmpeg python3-venv
python3 -m venv .venv
.venv/bin/pip install 'yt-dlp[default]==2026.8.19'
export PATH="$PWD/.venv/bin:$PATH"

npm ci
cp .env.example .env
# Edit .env: set a strong ADMIN_PASSWORD (>=16 chars).
npm start
# Open http://localhost:3000 and http://localhost:3000/admin
```

`npm run dev` uses Node's file watcher. It is for development only, not multi-worker production. A restart ends active broadcasts and invalidates viewer leases. Do not use PM2 cluster mode or multiple Node workers.

`YT_DLP_PATH` / `FFMPEG_PATH` can be absolute executable paths. Startup checks both binaries; `/health` returns 503 if a required binary is missing. The frontend still loads and explains that the service is not configured.

### Local Docker

```sh
docker build -t relay-live .
docker run --rm -p 3000:3000 \
  -e ADMIN_PASSWORD='replace-with-a-long-random-secret' \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  relay-live
```

Do not use the example password. Local HTTP is for development only; production Basic auth requires HTTPS. The Docker image supplies all runtime dependencies and vendors client assets automatically. Its default `NODE_ENV=production` refuses to start without a password of at least 16 characters. `tini` and application signal handlers reap child processes. FFmpeg is from Debian security-maintained packages; yt-dlp is pinned to the version tested at build time. Rebuild with a reviewed newer `--build-arg YT_DLP_VERSION=...` as YouTube changes. EJS is installed with yt-dlp's default extras; extraction does not dynamically download remote JS components.

## GitHub → Railway, without post-deploy shell commands

1. Create an empty GitHub repository. From this project directory:
   ```sh
   git init
   git add .
   git commit -m "Build Relay live restreaming service"
   git branch -M main
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPO.git
   git push -u origin main
   ```
   `.gitignore` excludes `.env`, dependency/cache/build outputs, HLS files, cookies, screenshots, and test artifacts. Never commit authentication cookies or secrets.
2. In Railway choose **New Project → Deploy from GitHub repo**, authorize access, and select that repository. Keep the repository root as the service root. The checked-in `railway.json` selects the Dockerfile automatically; no custom build or start shell steps are required.
3. Set service **Variables** before the first successful deployment:
   - `ADMIN_PASSWORD`: a random secret, at least 16 characters.
   - `ADMIN_USER=admin` (or your own username).
   - `NODE_ENV=production` (also the image default).
   - `TRUST_PROXY=1` for Railway's single trusted ingress. Verify the proxy topology if adding Cloudflare or another proxy; do not blindly trust arbitrary forwarding headers.
   - `DEMO_MODE=false`, `MAX_STREAMS=2`, `ABR_ENABLED=false` initially.
   - `PUBLIC_ORIGIN`: set after generating the domain below.
     All other defaults are listed in `.env.example`. Railway supplies `PORT`; the server binds to `0.0.0.0`.
4. Generate a Railway public HTTPS domain under service networking. Set `PUBLIC_ORIGIN=https://YOUR-SERVICE.up.railway.app` with **no trailing slash** (or use your custom HTTPS domain).
5. Deploy the current commit, or redeploy after variables are saved. A first auto-build before setting `ADMIN_PASSWORD` intentionally fails closed; saving the variables and redeploying fixes it. Watch `/health` become healthy and inspect deploy logs.
6. Keep **one replica**. Use the included zero-overlap/20-second drain configuration, do not enable simultaneous application instances, and avoid deployment while an important broadcast is active. Active streams are not preserved over redeploys. The runtime uses disposable local disk; no volume/database/Redis add-on is required. If attaching a volume, give the runtime user permission to write it and use a dedicated empty `STREAM_DIR`.
7. Open the public URL and test your authorized live stream. Open `/admin` with your operator credentials. Future `git push` commits to the connected branch automatically build and redeploy.

There is no requirement to install anything manually inside a Railway container. Do not override the Docker entrypoint or introduce extra workers. Railway edge logs may include HLS bearer query strings: restrict log access and avoid configuring external URL analytics.

### Honest free-plan limits (checked September 27, 2026)

Railway currently lists **$1 of monthly Free-plan usage credit**, **one replica, 0.5 GB RAM, 1 vCPU, and 1 GB ephemeral storage**. The separate Trial lists a one-time $5 credit. These are small budgets, not unlimited streaming entitlements. [1](https://docs.railway.com/pricing/plans)

Railway's published resource rates include **$20/vCPU-month, $10/GB RAM-month, and $0.05/GB network egress**. Check the actual dashboard and current terms before deployment; account eligibility, limits, and prices can change. [5](https://blog.railway.com/p/usage-based-vs-fixed-pricing-2026)

At a hypothetical **2 Mb/s**, one viewer consumes about **0.9 GB/hour** before overhead; ten viewers are about 9 GB/hour. Deduplication saves upstream fetching and processing, **not per-viewer downstream bandwidth**. $1 would cover only about 22 viewer-hours at that bitrate if egress were the only expense; CPU/RAM consume the same credit too. This is an arithmetic illustration using the cited rate, not a guarantee of included hours.

Practical guidance:

- Treat Free as a short, small-scale proof of operation, not a 24/7 public video platform. There is no fixed unlimited-hours assumption; metered usage and available credit determine usable runtime.
- Leave ABR off; begin at `MAX_STREAMS=1` or `2`, and reduce `SINGLE_HEIGHT=480` for modest tests. Concurrent yt-dlp metadata extraction and FFmpeg buffers consume memory even in copy mode. The default cap is conservative rather than the suggested VPS-sized 5–10.
- Shared cloud IPs may be throttled, blocked, or asked for bot verification by YouTube. A correct deploy does not guarantee extraction. The application returns a clear unavailable/timeout error rather than sending the viewer to YouTube.
- `MIN_FREE_DISK_MB=128` and `MAX_HLS_DISK_MB=400` are application safeguards, not OS quotas. Segment/keyframe sizes vary; files are checked every maintenance interval, so a short overshoot is possible. Large individual writes or the platform's own disk usage may still exhaust a tiny filesystem.
- Source expiry, Railway resource limits, and upstream restrictions can interrupt long sessions. Keep usage alerts enabled and verify plan spend/credit behavior in your account.
- **If you outgrow Free:** Railway Hobby/paid capacity or a dedicated VPS with predictable egress is the natural next step. Neither is required to build or run this repository. Benchmark before raising stream/viewer limits.

## Implemented behavior

### Input, discovery, deduplication, and locking

Supported forms include `youtube.com/watch?v=VIDEO_ID`, `youtu.be/VIDEO_ID`, `/live/VIDEO_ID`, `/embed/VIDEO_ID`, mobile YouTube links, `@handle`, `/@handle`, `/channel/UC…`, `/c/name`, and `/user/name`. Tracking parameters do not affect identity. Unsupported hosts, embedded credentials, ports, arbitrary schemes, overlong inputs, playlists, and shell-like input are rejected.

Direct video links yield a canonical 11-character ID without starting an extractor. Channel URLs are resolved through their `/live` endpoint; a channel without a current broadcast returns `CHANNEL_NOT_LIVE`. Scheduled/upcoming, recorded, and post-live videos are not accepted as live.

**Only the canonical video ID keys the registry and media pipeline.** A per-ID mutex serializes attachments and teardown/recreation. A synchronous `starting` reservation counts against global capacity **before asynchronous disk or process work**. The first request launches the creation promise; subsequent requests receive their own viewer leases and observe the **same in-flight creation** rather than launching their own. HTTP 202 and player status polling avoid holding a long-running HTTP connection while FFmpeg starts. An existing stream can be joined even when all distinct-stream slots are occupied.

Registry entries store status (`starting/live/ended/error`), title, output path, generation, child handle/PID, viewer map/count, created/last-activity times, abort controller, and the shared startup promise. `StreamRegistry` is an explicit interface with a `MemoryRegistry` adapter.

Channel discovery is distinct from a media pipeline: different channel aliases cannot be known to reference one video until resolved. Identical concurrent channel lookups are coalesced; different aliases may require separate short metadata lookups, but **never separate FFmpeg pipelines** for the resulting ID. First discovery metadata is reused for startup where possible. The bounded 30-second channel cache retains only identity/title, not large format lists or signed URLs. A recently changed channel live ID can be stale until this short TTL expires.

### Extraction, format selection, HLS, and ABR

- yt-dlp runs without a shell, ignores machine config, disables playlists/downloads, and returns live metadata and source URLs. The extracted ID must match the reserved ID.
- Accepted sources use HTTPS and YouTube/Googlevideo domains. FFmpeg's input protocol list excludes local files/concat and unsupported protocols. Nested redirects/manifests still rely on trusted YouTube media infrastructure; this is not a full network firewall. Keep binaries updated and use egress firewall rules if your environment requires stronger SSRF isolation.
- Default: choose the best available H.264/AAC source at or below `SINGLE_HEIGHT=720`. Sources requiring other codecs fail clearly rather than silently burning CPU on transcoding. Separate AAC audio is mapped when necessary.
- FFmpeg writes local media playlists and `.ts` segments under the ID folder; a local `stream.m3u8` master is published only after every selected rendition has at least one nonempty segment.
- `ABR_ENABLED=true`, `ABR_HEIGHTS=360,480,720` selects existing source qualities (up to four configured heights). Missing/duplicate qualities collapse to available renditions. **One FFmpeg process handles all inputs and outputs**, reusing common audio input, with `-c copy` for each output. HLS.js switches automatically or the viewer can choose a quality.
- No upscaling or invented renditions. ABR costs additional upstream bandwidth, disk writes, buffers, and sockets even without encoding. Seamless switching depends on aligned upstream timestamps/keyframes; validate it against your own broadcast. Default copy mode cannot force keyframes. Native-HLS-only browsers get native adaptive selection, not manual rendition selection.
- Playlist routes reject external/unknown URIs, then add a viewer lease token to **local** child URLs. There is no endpoint that forwards arbitrary URLs. Playlists are never cached; generation-specific segments have short private caching.

### Viewer lifecycle, ends, and errors

Each attachment gets an unpredictable viewer token. Heartbeats default to 12 seconds, leases expire after 45 seconds, and authenticated HLS requests also refresh activity (helpful for background tabs). Leaving sends a best-effort release; a crashed browser is removed after expiry. Paused/backgrounded browsers may lose their lease if neither heartbeats nor HLS requests arrive.

When the final viewer leaves/expires, the configurable **120-second zero-viewer grace** begins. Rejoining cancels the grace. Maintenance stops child process groups and removes output files after expiry. Abandoned tabs therefore cost at most lease expiry + grace + one maintenance interval, not zero time.

A clean FFmpeg exit marks the live ended. A nonzero exit or stalled playlist triggers a bounded metadata recheck: a no-longer-live source becomes `ended`; a still-live/unverifiable source becomes a clear interruption/stall error. The player replaces the video with a localized ended/error message; it does not spin forever. End confirmation may require extraction timeout + the next status poll. Operator stop also produces the explicit ended state.

Invalid syntax fails immediately. Valid-looking but not-live/unavailable inputs resolve under `EXTRACT_TIMEOUT_SECONDS=18`; retries share this overall deadline. Valid live extraction can then need up to `STARTUP_TIMEOUT_SECONDS=35` for first playable media. Process termination has a 2.5-second SIGKILL fallback. A failed stream can be explicitly reopened for a fresh generation; there is no unbounded automatic restart loop.

### Limits, admin, and resilience

- Per-IP fixed-window submission limit: 10/minute by default, including joins/discovery (so metadata probes cannot bypass it); bounded rate-key storage. Global stream admission and channel resolver concurrency limit distinct work. Viewer counts also have a ceiling. All public errors are localized.
- `/admin` and `/admin/api/*` require Basic auth; missing dev password disables the console, missing/short production password refuses startup. Admin shows IDs/titles, state, viewers, uptime, FFmpeg PID/RSS (Linux), app RSS, HLS storage, recent logs/errors, and manual stop controls. CPU attribution is not implemented; use Railway/container metrics for CPU.
- SIGTERM/SIGINT: stop accepting requests, abort discovery, signal complete process groups, escalate if necessary, await pipeline teardown, clean output, and close sockets. Twenty-second shutdown safety deadline; `tini` is a second line of defense in Docker. SIGKILL/crashes cannot run cleanup, so the next startup removes orphan output.
- Transient yt-dlp failures retry twice with exponential 500/1000 ms backoff inside the extraction budget; unavailable/private/not-live inputs do not get pointless retries. FFmpeg has bounded input network timeouts/reconnection and a playlist-stall watchdog. Signed URLs are not refreshed midstream; reopen a failed stream to re-extract.
- Structured JSON stdout logs have request IDs/video IDs and a bounded operator log ring. Query strings, bearer/admin headers, cookies, and signed source URLs are not emitted by application logging. Raw diagnostic URLs are redacted.
- Startup orphan cleanup and periodic free-space/output-size checks protect disk. Under pressure, new pipelines are refused and the least-viewed/oldest active pipeline is stopped per maintenance pass until space recovers. **`STREAM_DIR` is exclusively disposable app storage; all contents are removed at startup. Never point it at user files or shared storage.**

## Configuration reference

Copy `.env.example`; it documents every runtime setting. Environment values win over `.env`. Defaults are centralized and validated in `server/config.js`.

| Group                  | Variables                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| HTTP / deployment      | `PORT`, `NODE_ENV`, `PUBLIC_ORIGIN`, `TRUST_PROXY`                                                                    |
| Operator / policy      | `ADMIN_USER`, `ADMIN_PASSWORD`, `ALLOWED_VIDEO_IDS`                                                                   |
| Storage / binary paths | `STREAM_DIR`, `YT_DLP_PATH`, `FFMPEG_PATH`, `YT_DLP_COOKIES_FILE`                                                     |
| Capacity               | `MAX_STREAMS`, `MAX_VIEWERS_PER_STREAM`, `MAX_RESOLVERS`                                                              |
| Viewer / cleanup       | `HEARTBEAT_SECONDS`, `VIEWER_TTL_SECONDS`, `IDLE_GRACE_SECONDS`, `MAINTENANCE_SECONDS`                                |
| Deadlines / retry      | `EXTRACT_TIMEOUT_SECONDS`, `STARTUP_TIMEOUT_SECONDS`, `EXTRACT_RETRIES`, `RETRY_BASE_MS`, `STALL_TIMEOUT_SECONDS`     |
| Submission limits      | `SUBMISSIONS_PER_WINDOW`, `SUBMISSION_WINDOW_SECONDS`, `MAX_RATE_KEYS`                                                |
| Cache / retention      | `RESOLVE_CACHE_SECONDS`, `MAX_RESOLVE_CACHE`, `TERMINAL_RETENTION_SECONDS`, `MAX_TERMINAL_STREAMS`, `LOG_BUFFER_SIZE` |
| Media                  | `SINGLE_HEIGHT`, `ABR_ENABLED`, `ABR_HEIGHTS`, `HLS_SEGMENT_SECONDS`, `HLS_LIST_SIZE`                                 |
| Disk                   | `MIN_FREE_DISK_MB`, `MAX_HLS_DISK_MB`                                                                                 |
| Testing only           | `DEMO_MODE`                                                                                                           |

Use literal `true`/`false` for booleans. `HEARTBEAT_SECONDS` must be smaller than `VIEWER_TTL_SECONDS`. `ALLOWED_VIDEO_IDS` is blank for open submission or a comma-separated list of approved IDs. Disallowed IDs never start pipelines; channel metadata discovery is still needed before the policy can be evaluated.

Optional operator-provided cookies must be in Netscape cookie-file format, readable/writable by the runtime user, and kept outside the public/static tree. They may permit access to the operator's private videos: **never enable account cookies on an unrestricted public service without an allowlist/access policy.** They do not guarantee YouTube will accept a cloud IP. No cookies are included or requested by the frontend.

## Additional features added by the builder

Every item below is **Added by builder — not explicitly requested.** The requested production-hardening features above are separately documented rather than misrepresented as extras.

1. **Bearer-leased HLS endpoints:** segment access requires an unexpired viewer lease. This prevents untracked static hotlinking; tokens are not user accounts or DRM. Do not share them. Production HTTPS and restricted edge logs matter.
2. **Generation-specific segment names:** a stopped/restarted video never collides with cached segment filenames from a previous generation.
3. **Same-origin browser policy and local assets:** CSP, no-referrer, MIME protections, production anti-framing/HSTS, mutation-origin checks, and no CORS avoid accidental external viewer connections. Development permits framing so local app previews work; production forbids it.
4. **Optional operator video allowlist:** `ALLOWED_VIDEO_IDS` restricts the broadcast catalog without adding database/auth overhead.
5. **Bounded memory housekeeping:** limits for viewer leases, resolver concurrency, identity-only caches, rate-limit keys, recent logs, and terminal entries reduce idle accumulation. Old terminal entries can be evicted under pressure, resulting in a session-expired response to an old client.
6. **Deterministic, prominently labeled test signal:** `DEMO_MODE=true` creates local FFmpeg color bars/tone, not a hidden fallback or a claimed YouTube broadcast. Real mode never substitutes demo content. The demo is the only path that encodes video and must stay off in deployment.
7. **Privacy-conscious logging:** no input query strings or signed source URLs; request IDs allow support without disclosing secrets. Admin log content is rendered as text, not HTML.
8. **Autoplay recovery and visibility recovery:** a clear tap-to-play button handles browser autoplay policy; returning to a visible tab triggers a heartbeat instead of silently staying stale. Language preference is remembered locally. Focus-visible controls, localized accessible labels, and reduced-motion styling are included.
9. **Regression suite and CI:** concurrency/security/process tests plus actual local FFmpeg-to-browser HLS tests, EN/FA narrow-layout checks, and browser request-origin assertions. No third-party copyrighted fixtures are needed.
10. **Non-root, signal-aware container and pinned extractor version:** less privilege and reproducible extraction behavior, with an explicit upgrade path instead of silently changing the extractor at each build.

## Tests and operator-owned live verification

```sh
npm test                        # 18 unit/process/HTTP integration tests
npm run check
npx playwright install --with-deps chromium
npm run test:e2e                 # requires FFmpeg; runs its own temporary test server
```

The browser suite uses `DEMO_MODE=true` **only in its separate test process**. It exercises actual HLS segments, decoded/advancing video, two tabs on one PID, admin stop/end messaging, same-origin requests, localized validation, and desktop/mobile LTR/RTL. Screenshots go to ignored `artifacts/`. Tests do not rely on YouTube availability. CI uses Ubuntu + Node 22 + FFmpeg and never needs operator cookies.

Manual real-source checklist:

1. Use **your own** YouTube channel and begin a live broadcast you are authorized to redistribute. Keep it public/unlisted and actually broadcasting, not merely scheduled.
2. Run with `DEMO_MODE=false`; paste its watch/live URL. Confirm the spinner resolves to a title, LIVE indicator, and advancing video. If cloud verification blocks it, inspect the redacted operator error, update yt-dlp, or test from your own permitted host; do not assume it is a frontend issue.
3. Open a second tab with the same ID via `youtu.be`, then the channel URL. `/admin` should show one active entry/FFmpeg PID and multiple viewers. There may be short channel-discovery yt-dlp processes, not multiple media pipelines.
4. Inspect browser Network: only your own origin; all `.m3u8` entries refer to your local variants/segments. Do not paste signed URLs or tokens into public tickets.
5. Switch فارسی; verify the whole page/control row mirrors, Persian fonts load locally, long titles and input behave correctly, and play/pause, mute, volume, live edge, and fullscreen work. Test your target Safari/iOS devices as well as desktop Chromium.
6. If enabling ABR, repeat with your own multi-quality source and throttled browser bandwidth. Verify only available qualities are listed and input renditions align.
7. End your broadcast in YouTube Studio. Verify all tabs show “This live stream has ended” / «این پخش زنده به پایان رسید». Also test operator Stop and a temporary source-network failure.
8. Leave all tabs; after release or lease expiry plus the grace period, check that the FFmpeg PID and ID directory disappear. Ctrl-C the server while starting/playing and confirm children exit.
9. Set `MAX_STREAMS=1`, start one owned broadcast, and submit another owned live ID to see capacity handling. Join the first again to confirm capacity does not block deduplicated viewers. Exercise invalid, recorded, and offline-channel links.

**Verification boundary:** included tests passed against local FFmpeg output, not an actual operator-owned YouTube broadcast. No such live source or Railway/GitHub account was provided. A Railway Docker deployment and Safari/iOS playback have not been executed in this build environment. Do the real-source checklist before relying on it for an event.

## Known limits and scaling

- **One application instance only.** An in-memory registry cannot enforce a global pipeline guarantee across independent replicas, deploy overlap, or multiple machines. Local files also belong to their owner. The provided config disables deliberate overlap, but verify platform rollout behavior; coordinated global ownership requires the next architecture below.
- A distributed `StreamRegistry` needs **atomic admission, distributed leases/locks, ownership fencing, crash recovery, and generation-aware routing**. Simply replacing a Map with Redis GET/SET is insufficient. Add sticky/routed HLS to the owner or shared object storage/CDN, and account for CDN token/cache-key semantics. A media worker pool and Redis control plane are natural next steps.
- HLS is buffered live delivery, not WebRTC/ultra-low-latency. Actual delay depends on upstream latency, keyframe intervals, fragment duration, and player buffers. No DVR, seeking through an archive, subtitles extraction, chat, DRM, or persisted sessions are implied.
- Global max pipelines protects processing; it does not stop distributed request floods or bandwidth exhaustion by allowed viewers. For an internet-facing paid deployment, add an identity/access layer, ingress/WAF quotas and egress budgets. IP limits can aggregate users behind NAT and can be evaded with many addresses.
- Lease tokens are possession-based, not strong user authentication. Same-origin protections are browser defenses, not authorization for server-to-server clients. A private deployment should be behind an authenticated gateway in addition to the optional ID allowlist.
- Auto-selected H.264/AAC formats and upstream live manifests can change. Update/retest yt-dlp/FFmpeg/HLS.js regularly. Private/restricted/age-gated/geoblocked broadcasts may be unavailable. The service fails explicitly rather than embedding YouTube or transcoding unexpectedly.
- No full Docker build was possible here because the environment has no Docker daemon. Docker syntax/config and installed runtime components were checked separately. Platform free-tier limits are not a production SLA.

## Third-party notices

HLS.js (Apache-2.0) and the Inter/Vazirmatn fonts (SIL Open Font License) are installed from their packages. Their license files are copied into `client/vendor/` and shipped with the assets. FFmpeg/yt-dlp/Node retain their respective upstream licenses; review their terms when redistributing container images.
