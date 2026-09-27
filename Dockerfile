FROM node:22-bookworm-slim
ARG YT_DLP_VERSION=2026.8.19
# FFmpeg, Python/yt-dlp, and Node's JS runtime are present in the final runtime.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YT_DLP_VERSION}"
ENV PATH="/opt/ytdlp/bin:$PATH" NODE_ENV=production PORT=3000
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY client ./client
RUN mkdir -p /app/data/streams && chown -R node:node /app/data
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
