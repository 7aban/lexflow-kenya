# LexFlow Pilot Deployment Runbook

This runbook is for the R18 pilot-ready application line. It covers production-style startup, configuration, smoke testing, backup, and high-level rollback. It does not introduce PDF, docx, court formatting, line numbering, pagination, or AI drafting.

## 1. Runtime Requirements

- Node.js 22 LTS. Use Node `v22.22.2` for parity with the validated pilot baseline.
- npm `10.9.x`.
- SQLite database file access for the backend service user.
- Durable storage for the SQLite database, backup directory, and backup log.
- The SQLite database stores uploaded and generated documents as BLOBs, so database backups are data backups for document content as well.
- The frontend must be built separately with `npm run build` from `client/`.

## 2. Production Topology

Run the backend as a Node service from `server/`:

```sh
npm start
```

The backend listens on `PORT`, with `5000` as the default. The public healthcheck is:

```text
GET /health
```

The backend does not currently serve `client/dist` unless a deployment layer is separately wired to do that. For the pilot, use one of these topologies:

- Static frontend hosting serves `client/dist`, and a reverse proxy forwards `/api/*` and `/health` to the backend Node service.
- A single reverse proxy host serves `client/dist` as static files and proxies API traffic to `http://127.0.0.1:5000`.

Set `BASE_URL`, `CORS_ORIGINS`, and OAuth redirect URLs to match the public pilot URL.

## 3. First Deployment Sequence

1. Clone or fetch the repository on the server.
2. Check out the pilot-ready tag or current approved `main`:

   ```sh
   git checkout v3.99-r18-final-document-automation-pilot-ready-2026-05-18
   ```

3. Install dependencies if they are not already present:

   ```sh
   cd server && npm install
   cd ../client && npm install
   ```

4. Create the production environment from `server/.env.production.example`.
5. Fill in only real production values on the server. Do not commit real secrets.
6. Build the frontend:

   ```sh
   cd client
   npm run build
   ```

7. Start the backend service with the production environment loaded.
8. Host `client/dist` through the chosen static host or reverse proxy.
9. Verify the backend:

   ```sh
   curl https://lexflow.example.com/health
   ```

10. Sign in with the initial admin account if the database was empty, then rotate or remove the bootstrap password from operational use.

## 4. First Admin Bootstrap

When the database has no users, startup creates the first admin from:

- `SEED_ADMIN_EMAIL`
- `SEED_ADMIN_NAME`
- `SEED_ADMIN_PASSWORD`

In production, `SEED_ADMIN_PASSWORD` is required for this bootstrap path and must be at least 12 characters and not a common weak password. Use it only for first setup, then change the admin password and remove or rotate the bootstrap value according to the hosting model.

Do not run this command against production or pilot data:

```sh
npm run seed:demo
```

`npm run seed:demo` rebuilds a demo database and is destructive/non-production only. It is for local development and automated test fixtures.

## 5. Environment Matrix

Use `.env.example` for local development and `server/.env.production.example` for production. In production, the Node process must receive variables from the service manager, host, shell, or deployment wrapper.

Required production values:

- `NODE_ENV=production`
- `PORT`
- `DATABASE_PATH`
- `BASE_URL`
- `CORS_ORIGINS`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `LEXFLOW_BACKUP_KEY`
- `LEXFLOW_BACKUP_RETENTION_COUNT`
- `BACKUP_DIR`
- `BACKUP_LOG`
- `SEED_ADMIN_PASSWORD`, only while bootstrapping the first admin on an empty database

OAuth values:

- `OAUTH_STAFF_ENABLED`
- `OAUTH_CLIENT_ENABLED`
- `OAUTH_STATE_SECRET`
- `OAUTH_ALLOWED_DOMAINS`
- `OAUTH_REQUIRE_VERIFIED_EMAIL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `MICROSOFT_REDIRECT_URI`

Limits and rate limiting:

- `JSON_BODY_LIMIT`
- `UPLOAD_BODY_LIMIT`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX`
- `AUTH_RATE_LIMIT_WINDOW_MS`
- `AUTH_RATE_LIMIT_MAX`

Secret handling:

- `JWT_SECRET` must be high entropy and unique to the environment.
- `OAUTH_STATE_SECRET` must be high entropy and unique to the environment.
- `LEXFLOW_BACKUP_KEY` must be a 64-hex-character key. Store it separately from backups.

## 6. Backup

Run encrypted backup from `server/` with the production environment loaded:

```sh
npm run backup
```

The backup script uses:

- `DATABASE_PATH` as the SQLite source database. The backup helper checkpoints WAL against this same path before reading it, and the resolved source path is logged at the start of the run. Restore and the backup audit-event sink also follow `DATABASE_PATH`, so runtime, backup, and restore agree on a single source of truth.
- `BACKUP_DIR` for encrypted backup output.
- `BACKUP_LOG` for backup logs.
- `LEXFLOW_BACKUP_KEY` for encryption.
- `LEXFLOW_BACKUP_RETENTION_COUNT` for rotation.

A successful run logs the source database path, backup creation, verification, retention rotation, and a non-fatal audit event attempt. Verify backup success by checking the process exit code, backup log, and presence of a recent `.db.enc` file in `BACKUP_DIR`.

Keep `BACKUP_DIR` and `BACKUP_LOG` outside the repository or in ignored operational paths.

`npm run seed:demo` is unaffected by this change: it remains a destructive demo/local fixture that rebuilds the default `server/lawfirm.db`. Do not run it against production or pilot data.

## 7. Restore and Rollback

Code rollback and data rollback are separate.

For code rollback, check out the approved tag or restore from the release bundle:

```sh
git checkout v3.99-r18-final-document-automation-pilot-ready-2026-05-18
```

For database rollback, restore a matching encrypted SQLite backup using the same `LEXFLOW_BACKUP_KEY` used to create it:

```sh
npm run restore:backup -- /path/to/lexflow-backup.db.enc --force
```

The Git bundle or tag alone is not enough to restore pilot data. A complete recovery requires both the approved code version and a valid encrypted database backup. See Section 8 for a controlled restore drill procedure that operators should run periodically to validate recovery without touching production data.

## 8. Backup Restore Drill

Run this drill periodically to prove the encrypted backup/restore path works end-to-end. The drill uses a throwaway database path outside the repository so it never touches the live `server/lawfirm.db` as a write target. Treat the drill as a documented, evidence-producing operation: record the backup file path, SHA256, operator, and date in your operational log when running it in real pilot operations.

### 8.1 Safety Rules

- Never restore over the production database without a verified, recent encrypted backup and a planned downtime window.
- The Git bundle/tag restores code only. Database recovery requires a valid `.db.enc` backup decrypted with the matching `LEXFLOW_BACKUP_KEY`.
- The restore script refuses to overwrite an existing target database unless `--force` is supplied. Do not pass `--force` until you are certain the target path is correct and the backup file is the intended one.
- Restore with `--force` replaces the target database file and clears stale SQLite WAL/SHM sidecar files (`-wal`, `-shm`, `-wal.db`, `-shm.db`).
- `LEXFLOW_BACKUP_KEY` is required for any encrypted backup restore. Do not commit it to the repository, log it, or share it with the backup itself; the audit log emitted by the script does not print the key.
- The drill key documented in any example is a non-production placeholder. Generate a real 64-hex-character key with `openssl rand -hex 32` (or equivalent) for production.

### 8.2 What the Drill Validates

- Encrypted backup creation succeeds and verifies (`PRAGMA integrity_check` passes on the decrypted copy).
- Restore refuses to overwrite an existing target database without `--force`.
- Restore with `--force` replaces the target with the decrypted backup and clears stale WAL/SHM files.
- Retention rotation honours `LEXFLOW_BACKUP_RETENTION_COUNT`.
- The restored database has the expected business tables and row counts.

### 8.3 Prerequisites

- A clean working tree on the approved pilot tag or `main`.
- The pinned Node runtime (`v22.22.2` / npm `10.9.x`).
- A throwaway directory outside the repository for drill artifacts (database, encrypted backups, log).
- A 64-hex-character drill backup key (separate from any real production key).

### 8.4 Procedure

1. Choose a throwaway drill root outside the repository. Example on Windows:

   ```powershell
   $drillRoot = "C:\path\outside\repo\lexflow-restore-drill"
   $drillDb = "$drillRoot\restore-drill.db"
   $drillBackupDir = "$drillRoot\backups"
   $drillLog = "$drillRoot\restore-drill-backup.log"
   New-Item -ItemType Directory -Force -Path $drillRoot, $drillBackupDir | Out-Null
   ```

2. Seed the throwaway drill database by copying a representative source DB (for example, the live development DB) to `$drillDb`. After PILOT-HARDENING-4 the backup helper reads from `DATABASE_PATH`, so `$drillDb` must exist before `npm run backup` runs:

   ```powershell
   Copy-Item ".\server\lawfirm.db" $drillDb
   ```

   The drill never writes back to the original — restore points at `$drillDb`, which is overwritten.

3. Export drill environment variables in the same shell session, including a non-production backup key. Required env for the scripts to load:

   ```powershell
   $env:NODE_ENV = "test"
   $env:DATABASE_PATH = $drillDb
   $env:BACKUP_DIR = $drillBackupDir
   $env:BACKUP_LOG = $drillLog
   $env:LEXFLOW_BACKUP_KEY = "<64-hex-character drill key>"
   $env:LEXFLOW_BACKUP_RETENTION_COUNT = "3"
   # Plus JWT_SECRET, OAUTH_STATE_SECRET, OAUTH_* and provider test creds as required by config.js
   ```

   Note: the drill `DATABASE_PATH` now controls the backup source, the restore target, and the audit-log target (see Section 6). Pointing `DATABASE_PATH` at the throwaway file means the drill backs up that throwaway file end-to-end, never touching the original. Do not run `npm run seed:demo` inside the drill — it still writes to the default `server/lawfirm.db` and would touch the live development database regardless of `DATABASE_PATH`.

4. Capture pre-backup evidence from the throwaway source database. Open `$drillDb` read-only with `sqlite3` and record row counts for at least `users` and `matters`, plus `PRAGMA integrity_check`.

5. Create the encrypted backup:

   ```powershell
   cd server
   npm run backup
   ```

   This writes a `lawfirm-<timestamp>.db.enc` file into `$drillBackupDir`, runs a verification pass that decrypts to a temp file and runs `PRAGMA integrity_check`, rotates retained backups, and emits a `backup_created` audit event. The audit event is inserted into `$drillDb` itself, which is the same file that was just backed up.

6. Record the backup file path and SHA256:

   ```powershell
   $backup = Get-ChildItem $drillBackupDir -Filter "*.db.enc" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
   Get-FileHash $backup.FullName -Algorithm SHA256
   ```

7. Prove the restore refuses to overwrite without `--force`:

   ```powershell
   npm run restore:backup -- $backup.FullName
   ```

   Expected output includes `Error: Target database already exists` and `Use --force to overwrite`. `$drillDb` size and contents remain unchanged.

8. Modify `$drillDb` to simulate post-incident drift, for example by adding a `restore_drill_marker` table with a single row.

9. Restore with `--force`:

   ```powershell
   npm run restore:backup -- $backup.FullName --force
   ```

   Expected output: `Overwriting existing database`, `Decrypting backup`, `Writing to target database`, `Restore completed successfully`, `Audit event backup_restored recorded in restored database`. No backup key should appear in the output.

10. Verify the restored database. The row counts for `users` and `matters` must match the pre-backup evidence, and the marker table you added in step 8 must be absent. Also confirm `PRAGMA integrity_check` returns `ok` and that a `backup_restored` row exists in `audit_events`.

11. Validate retention. Run `npm run backup` enough times to exceed `LEXFLOW_BACKUP_RETENTION_COUNT` (default for the drill: 3, so run 4 backups in close succession with brief sleeps to keep filenames unique). After the runs, count `.db.enc` files in `$drillBackupDir` and confirm it is no more than `LEXFLOW_BACKUP_RETENTION_COUNT`.

12. After the drill, remove `$drillRoot` if you do not need to retain the artifacts. Confirm the repository working tree is still clean (`git status --short` empty) and that no drill files were written under `server/` or `backups/` inside the repository.

### 8.5 Post-Restore Smoke Checks

After a real restore (not just the drill), run these against the restored deployment:

- `GET /health` returns `status: ok`.
- Staff login succeeds.
- Matter list loads.
- Document list loads and a document can be downloaded.
- `npm run backup` from `server/` succeeds with production env and produces a fresh `.db.enc` file.

### 8.6 Operational Logging

When running this drill or a real restore in pilot operations, record:

- Date and time.
- Operator name.
- Backup file path and SHA256.
- Source environment (e.g. nightly cron, manual ad-hoc).
- Restore target path (must be the production `DATABASE_PATH` for a real restore, a throwaway path for the drill).
- Outcome (success/failure and any deviations from expected output).
- Smoke check results.

Store these records outside the repository, alongside operational change logs.

## 9. Pilot Limitations

- Generated documents are text drafts only.
- PDF, docx, pleading formatting, pagination, court formatting, and line numbering are not implemented yet.
- No automatic court filing is performed.
- No generated draft is automatically released to clients.
- Generated drafts remain internal until staff explicitly share them.
- Template management is API-based; there is no frontend template-management UI (see `docs/TEMPLATE_SETUP.md` for the full template setup guide).

## 10. Smoke Tests

Run these checks after deployment and after any rollback:

1. Open `/health` and confirm `status: ok`.
2. Confirm staff login works.
3. Create or list a matter.
4. Upload and download a document.
5. Generate a draft from an active template as managing staff.
6. Confirm the generated draft is labelled as generated and remains Internal until explicitly shared.
7. Run `npm run backup` with production backup env loaded and verify a recent encrypted backup exists.

## 11. Related Documentation

- `docs/TEMPLATE_SETUP.md` — Full guide for creating, managing, previewing, and generating document templates.
- `docs/PILOT_OPERATIONS.md` — Day-1 pilot acceptance checklist covering deployment, roles, workflows, and audit verification.
