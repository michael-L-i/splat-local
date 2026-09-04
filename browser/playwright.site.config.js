import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '*.site.js', workers: 1, timeout: 90000,
  webServer: {
    command: [
      `${process.env.CI ? 'SPLAT_JS_ONLY=1 ' : ''}npm run build`,
      '../site/build.sh', 'mkdir -p ../_site/create', 'cp -R dist/. ../_site/create/',
      'python3 -m http.server 4180 --bind 127.0.0.1 --directory ../_site',
    ].join(' && '),
    port: 4180, timeout: 120000, reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4180/', channel: process.env.CI ? undefined : 'chrome',
    headless: !!process.env.CI, reducedMotion: 'reduce',
    viewport: process.env.CI ? { width: 960, height: 720 } : { width: 1440, height: 960 },
    launchOptions: { args: process.env.CI ? ['--enable-unsafe-swiftshader'] : [] },
  },
});
