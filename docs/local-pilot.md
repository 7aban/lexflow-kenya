# Local Pilot

One-command scripts to start and stop a local pilot instance of LexFlow with safe defaults for development and evaluation.

## Quick Start

From the repository root:

```powershell
.\start-pilot.ps1
```

This starts:

- **Backend** at `http://localhost:5000` with:
  - `NODE_ENV=development`
  - `OAUTH_STAFF_ENABLED=false`
  - `DATABASE_PATH=pilot.db` (stored at `server/pilot.db`)
  - `LEXFLOW_DISABLE_RATE_LIMIT=true`
- **Frontend** at `http://localhost:5173`

## Login

| Field    | Value                |
| -------- | -------------------- |
| Email    | admin@lexflow.co.ke |
| Password | password123          |

**Change the default password immediately after first login.**

## Stop

```powershell
.\stop-pilot.ps1
```

Stops backend and frontend, checkpoints the SQLite WAL, and frees ports 5000 and 5173. The pilot database at `server/pilot.db` is never deleted.

## Pilot Database

The pilot database is stored at `server/pilot.db`. It is gitignored (`server/*.db`).

**Do not run `npm run seed:demo` against `pilot.db`.** The seed:demo script is destructive — it rebuilds a demo database from scratch and will overwrite your pilot data.

## Backup

To back up the pilot database manually:

```powershell
Copy-Item server\pilot.db server\pilot-$(Get-Date -Format 'yyyyMMdd-HHmmss').db
```

Or use the encrypted backup workflow from `server/` with `DATABASE_PATH` set to `pilot.db`.
