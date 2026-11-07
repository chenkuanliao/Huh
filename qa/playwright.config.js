import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  use: { baseURL: process.env.HUH_TEST_URL || 'http://127.0.0.1:18787', headless: true, trace: 'retain-on-failure' },
  outputDir: '../.artifacts/playwright',
  reporter: 'list',
});
