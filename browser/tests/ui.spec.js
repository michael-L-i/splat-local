import { test, expect } from '@playwright/test';

test('presets, advanced controls and narrow layouts remain usable', async ({ page }) => {
  await page.goto('./');
  await page.locator('#quality').selectOption('detailed');
  await expect(page.locator('#quality-info')).toContainText('48 frames · 1024 px · 10,000 steps');
  await page.locator('#advanced summary').click();
  await page.locator('#frames').selectOption('24');
  await expect(page.locator('#quality-info')).toContainText('24 frames');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#start')).toBeVisible();
    await expect(page.locator('#quality')).toBeVisible();
  }
  await page.locator('#advanced summary').click();
  await page.screenshot({ path: 'test-results/empty.png', fullPage: true });
});

test('cancelling frame extraction leaves no output and allows retry', async ({ page }) => {
  test.skip(!process.env.SPLAT_TEST_VIDEO, 'Set SPLAT_TEST_VIDEO to a local clip.');
  await page.goto('./');
  await page.locator('#video').setInputFiles(process.env.SPLAT_TEST_VIDEO);
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText(/Surveying video|Selected frame/, { timeout: 20000 });
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toContainText('Cancelled.');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#download')).toBeHidden();
  await expect(page.locator('#video')).toBeEnabled();
});
