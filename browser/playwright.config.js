import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '*.spec.js', workers: 1,
  webServer: { command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4173', port: 4173, timeout: 120000 },
  use: { channel: 'chrome', headless: false, viewport: { width: 1440, height: 960 } },
});
