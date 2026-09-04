import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

test('video to downloadable splat without a backend', async ({ page }) => {
  test.skip(!process.env.SPLAT_TEST_VIDEO, 'Set SPLAT_TEST_VIDEO to a local test clip.');
  test.setTimeout(20 * 60 * 1000);
  const external = [], errors = [], requests = [];
  const origin = new URL(test.info().project.use.baseURL).origin;
  page.on('request', request => {
    requests.push({ method: request.method(), url: request.url() });
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
    if (request.method() !== 'GET') external.push(`${request.method()} ${request.url()}`);
  });
  page.on('pageerror', error => { errors.push(error.message); console.log('PAGE ERROR:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE:', message.text()); });
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('Ready.', { timeout: 30000 });
  await page.locator('#video').setInputFiles(process.env.SPLAT_TEST_VIDEO);
  if (process.env.SPLAT_TEST_QUALITY) await page.locator('#quality').selectOption(process.env.SPLAT_TEST_QUALITY);
  await page.locator('#advanced summary').click();
  if (process.env.SPLAT_TEST_EVALUATE) await page.locator('#evaluate').check();
  if (process.env.SPLAT_TEST_FRAMES) await page.locator('#frames').selectOption(process.env.SPLAT_TEST_FRAMES);
  await page.locator('#steps').selectOption(process.env.SPLAT_TEST_STEPS || '200');
  if (process.env.SPLAT_TEST_FOV) await page.locator('#fov').selectOption(process.env.SPLAT_TEST_FOV);
  await page.locator('#advanced summary').click();
  await page.locator('#start').click();
  let previous = '';
  while (await page.locator('#start').isDisabled()) {
    const status = await page.locator('#status').textContent();
    if (status !== previous) { console.log(status); previous = status; }
    await page.waitForTimeout(2000);
  }
  await test.info().attach('run-log', { body: await page.locator('#log').textContent(), contentType: 'text/plain' });
  // These textured fixtures compress far above a blank canvas. Wait for Spark's
  // asynchronous first draw; a status message alone does not prove a preview.
  await expect.poll(async () => (await page.locator('#viewer').screenshot()).length, { timeout: 20000 }).toBeGreaterThan(20000);
  await page.locator('aside').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'test-results/result.png', fullPage: true });
  await expect(page.locator('#download')).toBeVisible();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Complete ·');
  const saved = page.waitForEvent('download');
  await page.locator('#download').click();
  await (await saved).saveAs('test-results/scene.ply');
  const report = page.waitForEvent('download');
  await page.locator('#report').click();
  await (await report).saveAs('test-results/report.json');
  const bytes = await readFile('test-results/scene.ply');
  const end = bytes.indexOf('end_header\n') + 'end_header\n'.length;
  const header = bytes.subarray(0, end).toString();
  const count = Number(header.match(/element vertex (\d+)/)[1]);
  const properties = [...header.matchAll(/property float /g)].length;
  expect(bytes.length - end).toBe(count * properties * 4);
  let nonFinite = 0;
  for (let i = end; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i))) nonFinite++;
  expect(nonFinite).toBe(0);
  const stats = JSON.parse(await readFile('test-results/report.json', 'utf8'));
  expect(count).toBe(stats.splats);
  expect(stats.registered / stats.total).toBeGreaterThanOrEqual(0.75);
  expect(stats.refinement.finalCost).toBeLessThanOrEqual(stats.refinement.initialCost);
  expect(stats.samples).toHaveLength(stats.settings.frames);
  if (process.env.SPLAT_TEST_EVALUATE) {
    expect(Number.isFinite(stats.validation.psnr)).toBe(true);
    expect(stats.validation.ssim).toBeGreaterThan(0);
    expect(stats.validation.ssim).toBeLessThanOrEqual(1);
  }
  expect(stats.samples.every((sample, i, samples) => i === 0 || sample.time > samples[i-1].time)).toBe(true);
  expect(await page.evaluate(async () => {
    const entries = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) entries.push(name);
    return entries.filter(name => name.startsWith('splat-local-'));
  })).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile('test-results/network-audit.json', JSON.stringify({ page: page.url(), requests, external, errors }, null, 2));
  const box = await page.locator('#viewer').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'test-results/orbit.png', fullPage: true });
  await page.locator('#reset-view').click();
  await expect(page.locator('#reset-view')).toBeEnabled();
  await page.locator('#next-view').click();
  await expect(page.locator('#camera-view')).toHaveText(`View 2 / ${stats.registered}`);
  await page.locator('#previous-view').click();
  await expect(page.locator('#camera-view')).toHaveText(`View 1 / ${stats.registered}`);
  const previousDownload = await page.locator('#download').getAttribute('href');
  await page.locator('#video').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video') });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Cannot decode this video');
  await expect(page.locator('#download')).toHaveAttribute('href', previousDownload);
  await expect(page.locator('#download')).toBeVisible();
});

test('unsupported GPUs are explained before starting', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('requires desktop Chrome/Edge');
  await expect(page.locator('#start')).toBeDisabled();
  await page.locator('#quality').selectOption('fast');
  await expect(page.locator('#start')).toBeDisabled();
});

test('invalid video fails clearly and leaves the form usable', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#video').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video') });
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Cannot decode this video');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#download')).toBeHidden();
});

test('training cancellation cleans temporary data and permits another run', async ({ page }) => {
  test.skip(!process.env.SPLAT_TEST_VIDEO, 'Set SPLAT_TEST_VIDEO to a local test clip.');
  test.setTimeout(180000);
  await page.goto('./');
  await page.locator('#video').setInputFiles(process.env.SPLAT_TEST_VIDEO);
  await page.locator('#quality').selectOption('fast');
  await page.locator('#advanced summary').click();
  await page.locator('#steps').selectOption('5000');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Training ', { timeout: 120000 });
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toContainText('Cancelled.', { timeout: 30000 });
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#download')).toBeHidden();
  await page.locator('#steps').selectOption('200');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Complete ·', { timeout: 120000 });
  await expect(page.locator('#download')).toBeVisible();
});
