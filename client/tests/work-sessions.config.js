import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
if (!process.env.LEXFLOW_104B_EVIDENCE) throw new Error('Evidence directory required');
export default defineConfig({
  testDir: '.', testMatch: 'work-sessions.spec.js', workers: 1, retries: 0, maxFailures: 1,
  timeout: 90000, expect: { timeout: 12000 },
  outputDir: `${process.env.LEXFLOW_104B_EVIDENCE}/${process.env.LEXFLOW_104B_RUN || 'browser'}-artifacts`,
  webServer: { command: 'node tests/fixtures/work-session-vite.mjs', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:5184', reuseExistingServer: false, timeout: 30000 },
  use: { baseURL: 'http://127.0.0.1:5184', browserName: 'chromium', viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block', actionTimeout: 12000 },
});
