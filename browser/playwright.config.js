import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '*.spec.js', workers: 1,
  webServer: process.env.SPLAT_TEST_URL ? undefined : {
    command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4173', port: 4173, timeout: 120000,
  },
  use: {
    baseURL: process.env.SPLAT_TEST_URL || 'http://127.0.0.1:4173/',
    channel: 'chrome', headless: false, viewport: { width: 1440, height: 960 },
  },
});
