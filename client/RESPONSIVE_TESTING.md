# Responsive Overflow Verification

Playwright-based automated check for page-level horizontal overflow across staff and client views at 360, 390, 768 and 1280 px widths.

## Prerequisites

- Node v22.22.2 / npm 10.9.7 (pinned toolchain)
- Chromium browser installed via Playwright (`npx playwright install chromium`)

## How to run

### 1. Start backend

```powershell
cd server
npm run seed:demo
npm start
```

### 2. Start frontend

```powershell
cd client
npm run dev
```

### 3. Run responsive overflow checks

```powershell
cd client
npm run test:responsive
```

### 4. Run with visible browser (headed mode)

```powershell
cd client
npm run test:responsive:headed
```

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
