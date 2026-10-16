import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
if (!process.env.LEXFLOW_DS1A_EVIDENCE) throw new Error('Synthetic DS1A evidence directory required');
export default defineConfig({
  testDir: '.', testMatch: 'document-studio-1a.spec.js', workers: 1, retries: 0, maxFailures: 1,
  timeout: 60000, globalTimeout: 180000, expect: { timeout: 10000 },
  outputDir: `${process.env.LEXFLOW_DS1A_EVIDENCE}/${process.env.LEXFLOW_DS1A_RUN || 'browser'}-artifacts`,
  webServer: { command: 'node tests/fixtures/document-studio-vite.mjs', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:5187', reuseExistingServer: false, timeout: 30000 },
  use: { baseURL: 'http://127.0.0.1:5187', browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block', actionTimeout: 10000 },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
});
