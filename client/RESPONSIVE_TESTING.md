# Responsive Overflow Verification

Playwright-based automated check for page-level horizontal overflow across staff and client views at 360, 390, 768 and 1280 px widths.

## Prerequisites

- Node v22.22.2 / npm 10.9.7 (pinned toolchain)
- Chromium browser installed via Playwright (`npx playwright install chromium`)

## How to run

`npm run test:responsive` starts or reuses the Vite frontend automatically through Playwright. The backend must still be running and seeded unless a later phase adds backend webServer automation.

### 1. Start backend

```powershell
$nodeDir = "C:\Users\user 1\Documents\Codex\tools\node-v22.22.2-win-x64"
cd "C:\Users\user 1\Documents\Codex\2026-05-03\we-have-lexflow-a-kenyan-law\server"
$env:Path = "$nodeDir;$nodeDir\node_modules\npm\bin;$env:Path"
npm run seed:demo
npm start
```

### 2. Run responsive overflow checks

```powershell
$nodeDir = "C:\Users\user 1\Documents\Codex\tools\node-v22.22.2-win-x64"
cd "C:\Users\user 1\Documents\Codex\2026-05-03\we-have-lexflow-a-kenyan-law\client"
$env:Path = "$nodeDir;$nodeDir\node_modules\npm\bin;$env:Path"
npm run test:responsive
```

If a frontend dev server is already running at port 5173, Playwright reuses it.

### 3. Run with visible browser (headed mode)

```powershell
$nodeDir = "C:\Users\user 1\Documents\Codex\tools\node-v22.22.2-win-x64"
cd "C:\Users\user 1\Documents\Codex\2026-05-03\we-have-lexflow-a-kenyan-law\client"
$env:Path = "$nodeDir;$nodeDir\node_modules\npm\bin;$env:Path"
npm run test:responsive:headed
```

## What the test checks

The test checks page-level horizontal overflow at 360, 390, 768, and 1280 px widths.

## Expected pass criteria

- No page-level horizontal overflow at any tested viewport (360, 390, 768, 1280).
- `document.documentElement.scrollWidth` must not exceed viewport width.
- Tables may scroll inside their own `overflow-x: auto` wrappers, but the wrapper must not increase `documentElement.scrollWidth`.

## Covered pages

| Role   | Views                                      |
|--------|--------------------------------------------|
| Staff  | Dashboard, Communications, Performance, Matters, Invoices, Users |
| Client | My Matters                                 |

## Test output

On success, the matrix shows `✅ OK` for every page/viewport combination.
On failure, `❌ OVERFLOW` entries include the measured `scrollWidth > clientWidth` and the first 5 overflowing elements with tag, computed width, and parent overflow-x value.
