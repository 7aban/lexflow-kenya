# LexFlow Kenya

LexFlow Kenya is a local-first legal practice management app for Kenyan law firms. It includes JWT authentication, role-based access, clients, matters, tasks, documents, case notes, invoices, virtual court links, firm branding, and a lightweight client portal.

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
- Password: `admin123`

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

Use `.env.example` as a checklist for production environment variables. The current server reads environment variables from the process environment, so set them in your shell, hosting platform, or service manager.

Important variables:

- `JWT_SECRET`: required for production; use a long random value.
- `PORT`: backend port, default `5000`.

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

## Version Control Notes

- Source code is committed on `main`.
- Local database files, backups, build output, and `node_modules` are ignored.
- The current client-ready state has been backed up with a Git tag and should not be modified unless intentionally creating a new release tag.
