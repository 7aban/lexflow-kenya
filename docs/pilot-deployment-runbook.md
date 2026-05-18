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

- `DATABASE_PATH` as the SQLite source database.
- `BACKUP_DIR` for encrypted backup output.
- `BACKUP_LOG` for backup logs.
- `LEXFLOW_BACKUP_KEY` for encryption.
- `LEXFLOW_BACKUP_RETENTION_COUNT` for rotation.

A successful run logs backup creation, verification, retention rotation, and a non-fatal audit event attempt. Verify backup success by checking the process exit code, backup log, and presence of a recent `.db.enc` file in `BACKUP_DIR`.

Keep `BACKUP_DIR` and `BACKUP_LOG` outside the repository or in ignored operational paths.

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

The Git bundle or tag alone is not enough to restore pilot data. A complete recovery requires both the approved code version and a valid encrypted database backup. A timed restore drill with evidence should be handled in the next hardening phase.

## 8. Pilot Limitations

- Generated documents are text drafts only.
- PDF, docx, pleading formatting, pagination, court formatting, and line numbering are not implemented yet.
- No automatic court filing is performed.
- No generated draft is automatically released to clients.
- Generated drafts remain internal until staff explicitly share them.
- Template management UI may be limited; use only the current approved admin/template paths.

## 9. Smoke Tests

Run these checks after deployment and after any rollback:

1. Open `/health` and confirm `status: ok`.
2. Confirm staff login works.
3. Create or list a matter.
4. Upload and download a document.
5. Generate a draft from an active template as managing staff.
6. Confirm the generated draft is labelled as generated and remains Internal until explicitly shared.
7. Run `npm run backup` with production backup env loaded and verify a recent encrypted backup exists.
