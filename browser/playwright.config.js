import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '*.spec.js', workers: 1,
  webServer: process.env.SPLAT_TEST_URL ? undefined : {
    command: `${process.env.CI ? 'SPLAT_JS_ONLY=1 ' : ''}npm run build && npx vite preview --host 127.0.0.1 --port 4173`, port: 4173, timeout: 120000,
  },
  use: {
    baseURL: process.env.SPLAT_TEST_URL || 'http://127.0.0.1:4173/',
    channel: process.env.CI ? undefined : 'chrome', headless: !!process.env.CI, viewport: { width: 1440, height: 960 },
  },
});
