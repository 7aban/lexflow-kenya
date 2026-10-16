import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

if (process.version !== 'v22.22.2' || !process.env.LEXFLOW_DS1A_EVIDENCE) throw new Error('Node 22.22.2 and synthetic evidence directory required');
const run = process.env.LEXFLOW_DS2A2_RUN || 'ds2a2';
export default defineConfig({
  testDir: '.', testMatch: 'document-studio-2a-2.spec.js', workers: 1, retries: 0, maxFailures: 1,
  timeout: 45000, globalTimeout: 240000, expect: { timeout: 10000 },
  outputDir: `${process.env.LEXFLOW_DS1A_EVIDENCE}/${run}-artifacts`,
  reporter: [['list'], ['json', { outputFile: `${process.env.LEXFLOW_DS1A_EVIDENCE}/${run}-results.json` }]],
  webServer: { command: 'node tests/fixtures/document-studio-vite.mjs', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:5187', reuseExistingServer: false, timeout: 30000 },
  use: { baseURL: 'http://127.0.0.1:5187', browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block', actionTimeout: 10000 },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
});
