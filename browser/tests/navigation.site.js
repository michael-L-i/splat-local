import { test, expect } from '@playwright/test';

test('homepage, creator and viewer form one connected, green site', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('link', { name: 'Create from video', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/$/);
  await expect(page.getByRole('heading', { name: 'Video to 3D.' })).toBeVisible();
  await page.getByRole('link', { name: 'Viewer', exact: true }).click();
  await expect(page).toHaveURL(/\/viewer.html$/);
  await page.getByRole('link', { name: 'Create from video' }).click();
  await expect(page).toHaveURL(/\/create\/$/);
  await page.getByRole('link', { name: 'Splat Local home' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your video.');
  for (const path of ['./', './viewer.html', './create/']) {
    await page.goto(path);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#c3e8a1');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Create', exact: true })).toBeVisible();
    }
    const zoom = await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await zoom.evaluate(element => element.remove());
  }
  await page.screenshot({ path: 'test-results/site-create.png', fullPage: true });
});

test('interactive demo and local file viewer still work', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log(message.text()); });
  await page.goto('./');
  await expect(page.locator('#veil')).toHaveClass(/hidden/, { timeout: 60000 });
  await expect.poll(async () => (await page.locator('#canvas').screenshot()).length, { timeout: 30000 }).toBeGreaterThan(20000);
  await page.screenshot({ path: 'test-results/site-home.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/site-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('link', { name: 'Viewer', exact: true }).click();
  await page.getByRole('button', { name: 'Try the demo scene' }).click();
  await expect(page.locator('#statusText')).toHaveText('READY', { timeout: 60000 });
  await expect(page.locator('#fileRow')).toBeVisible();
  await expect.poll(async () => (await page.locator('#canvas').screenshot()).length).toBeGreaterThan(20000);
  await page.screenshot({ path: 'test-results/site-viewer.png', fullPage: true });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('#fileRow')).toBeHidden();
  await page.locator('#fileInput').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
  await expect(page.locator('#errorMsg')).toContainText('Unsupported file type');
  expect(errors).toEqual([]);
});

test('creation stays discoverable when the demo cannot render', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return /webgl/.test(type) ? null : original.call(this, type, ...args);
    };
  });
  await page.goto('./');
  await expect(page.locator('#veilLabel')).toContainText('webgl unavailable');
  await page.getByRole('link', { name: 'Create from video', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/$/);
});
