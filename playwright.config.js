import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    headless: true,
    viewport: { width: 1440, height: 1100 },
  },
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:3101/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: '3101',
      NODE_ENV: 'development',
      DEMO_MODE: 'true',
      STREAM_DIR: './data/browser-tests',
      ADMIN_PASSWORD: 'browser-test-only-password',
      SUBMISSIONS_PER_WINDOW: '100',
      HEARTBEAT_SECONDS: '2',
      VIEWER_TTL_SECONDS: '15',
      MAINTENANCE_SECONDS: '1',
      IDLE_GRACE_SECONDS: '2',
    },
  },
  reporter: 'list',
});
