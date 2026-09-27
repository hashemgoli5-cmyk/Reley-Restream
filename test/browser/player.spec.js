import { test, expect } from '@playwright/test';
const auth = 'Basic ' + Buffer.from('admin:browser-test-only-password').toString('base64');
test('English and Persian render without overflow on desktop and mobile', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#health-label')).toHaveText('Service available');
  await page.screenshot({ path: 'artifacts/desktop-en.png', fullPage: true });
  await page.locator('#language').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#stream-url')).toHaveAttribute('placeholder', /لینک/);
  await page.screenshot({ path: 'artifacts/desktop-fa.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `artifacts/mobile-fa-${width}.png`, fullPage: true });
  }
  await page.locator('#language').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/mobile-en.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('invalid input is localized', async ({ page }) => {
  await page.goto('/');
  await page.locator('#stream-url').fill('https://evil.example/video');
  await page.locator('#submit').click();
  await expect(page.locator('#form-error')).toContainText('valid YouTube');
  await page.locator('#language').click();
  await expect(page.locator('#form-error')).toContainText('معتبر');
});
test('real local FFmpeg HLS playback, shared PID, admin stop and same-origin network', async ({
  page,
  context,
  request,
}) => {
  const external = [];
  context.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:3101/') && !r.url().startsWith('blob:'))
      external.push(r.url());
  });
  await page.goto('/');
  await page.locator('#stream-url').fill('https://youtube.com/live/abcdefghijk');
  await page.locator('#submit').click();
  await expect(page.locator('#status-label')).toHaveText('LIVE', { timeout: 30000 });
  if (await page.locator('#play-overlay').isVisible()) await page.locator('#play-overlay').click();
  await expect
    .poll(() => page.locator('video').evaluate((v) => v.currentTime), { timeout: 15000 })
    .toBeGreaterThan(0);
  const second = await context.newPage();
  await second.goto('/');
  await second.locator('#stream-url').fill('https://youtu.be/abcdefghijk');
  await second.locator('#submit').click();
  await expect(second.locator('#status-label')).toHaveText('LIVE');
  const status = await (
    await request.get('/admin/api/status', { headers: { Authorization: auth } })
  ).json();
  const active = status.streams.filter((s) => s.status === 'live');
  expect(active).toHaveLength(1);
  expect(active[0].viewers).toBe(2);
  expect(active[0].pid).toBeGreaterThan(0);
  await page.locator('#language').click();
  await page.screenshot({ path: 'artifacts/playback-fa.png', fullPage: true });
  const stopped = await request.post('/admin/api/streams/abcdefghijk/stop', {
    headers: { Authorization: auth, Origin: 'http://127.0.0.1:3101' },
  });
  expect(stopped.ok()).toBe(true);
  await expect(page.locator('#stage-title')).toHaveText('این پخش زنده به پایان رسید.', {
    timeout: 10000,
  });
  await expect(second.locator('#stage-title')).toHaveText('This live stream has ended.', {
    timeout: 10000,
  });
  expect(external).toEqual([]);
  await second.close();
});
