# LexFlow Kenya

LexFlow Kenya is a local-first legal practice management app for Kenyan law firms. It includes JWT authentication, role-based access, clients, matters, tasks, documents, case notes, invoices, virtual court links, firm branding, and a lightweight client portal.

## Runtime Requirements

- **Node.js 22 LTS** (22.22.2 recommended; Node 24 is unstable on Windows with Jest)
- npm 10.9.x

To activate the correct Node version (if you use `nvm-windows` or `nvm`):

```powershell
nvm use 22
```

A `.nvmrc` file is provided at the repository root for automatic version switching.

## Tech Stack

- Frontend: React 18 + Vite, in `client/`
- Backend: Express + SQLite, in `server/`
- Database: `server/lawfirm.db`
- Authentication: JWT + bcrypt password hashes
- PDF invoices: `pdfkit`

## Quick Start

From the repository root, run:

```powershell
.\start-lexflow.ps1
```

This script:

- Installs missing dependencies in `client/` and `server/`
- Clears stale processes on ports `5000` and `5173`
- Starts the backend at `http://localhost:5000`
- Starts the frontend at `http://localhost:5173`

Default admin login:

- Email: `admin@lexflow.co.ke`
- Password: `password123`

To stop both local servers:

```powershell
.\stop-lexflow.ps1
```

## Manual Start

Backend:

```powershell
cd server
npm install
npm start
```

Frontend:

```powershell
cd client
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

## Database Backup

Create a timestamped SQLite backup:

```powershell
.\backup-db.ps1
```

Backups are written to `backups/` and ignored by Git.

## Environment

Use `.env.example` for local development and `server/.env.production.example` as the production checklist. The current server reads environment variables from the process environment in production, so set them through the shell, hosting platform, PM2 config, or systemd `EnvironmentFile`.

Important variables:

- `JWT_SECRET`: required for production; use a long random value.
- `PORT`: backend port, default `5000`.
- `DATABASE_PATH`: SQLite database path. The database stores document BLOBs.
- `BASE_URL` and `CORS_ORIGINS`: public app/API origins used by browser clients and OAuth callbacks.
- `LEXFLOW_BACKUP_KEY`: 64-hex-character key required for encrypted backups.
- `BACKUP_DIR`, `BACKUP_LOG`, and `LEXFLOW_BACKUP_RETENTION_COUNT`: backup output, logging, and retention settings.
- `SEED_ADMIN_PASSWORD`: used only when the database has no users for first-admin bootstrap.

## Pilot Deployment

The backend starts from `server/` with:

```powershell
npm start
```

The frontend production bundle is built from `client/` with:

```powershell
npm run build
```

The Express backend does not currently serve `client/dist` by itself. For a pilot deployment, run the backend as a Node service on `PORT` and host the frontend build with a static host or reverse proxy that forwards API traffic to the backend. Use `/health` as the backend healthcheck.

See `docs/pilot-deployment-runbook.md` for the production env matrix, startup sequence, smoke tests, backup notes, and rollback guidance.

Do not run `npm run seed:demo` against production or pilot data. It rebuilds the demo database and is for local development and test fixtures only.

## Troubleshooting

### Port 5173 is already in use

Run:

```powershell
.\stop-lexflow.ps1
.\start-lexflow.ps1
```

### Backend login fails

Confirm the backend is running:

```text
http://localhost:5000
```

Then restart with:

```powershell
.\stop-lexflow.ps1
.\start-lexflow.ps1
```

### Blank page

Run a frontend build check:

```powershell
cd client
npm run build
```

If the build passes, restart both services with `start-lexflow.ps1`.

## Testing

Backend tests require the demo seed database to be present. On a fresh clone, clean checkout, or after deleting/replacing `server/lawfirm.db`, run:

```powershell
cd server
npm run seed:demo
npm test
```

Or use the convenience script:

```powershell
cd server
npm run test:seeded
```

### When auth/access-control tests fail

If you see these symptoms:
- login returns `401`
- `advRes.body.user` is `undefined`
- expected `403` but received `401`
- many token/access-control tests fail together

**First confirm the demo seed data exists** by running `npm run seed:demo` before investigating JWT/session code. These are test-fixture/setup issues, not auth regressions.

Do not "fix" these failures by weakening JWT validation, bypassing auth middleware, or changing expected `403`s to `401`s.

## Version Control Notes

- Source code is committed on `main`.
- Local database files, backups, build output, and `node_modules` are ignored.
- The current client-ready state has been backed up with a Git tag and should not be modified unless intentionally creating a new release tag.
