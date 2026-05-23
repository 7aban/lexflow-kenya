# OPS-2: Docker Local Production Runtime

A minimal Docker Compose setup that runs LexFlow in a production-like configuration on a local machine.

## What OPS-2 provides

- nginx serving the built React frontend on port 8080
- Node/Express backend API on internal port 5000
- Reverse proxy from nginx to the API for `/api/*` and `/health`
- SPA routing with safe cache headers per asset type
- Durable named volumes for SQLite data, encrypted backups, and logs
- Healthcheck on the API container

## What OPS-2 does not provide

- HTTPS / TLS termination (host deployment concern)
- Off-host or cloud backups (host deployment concern)
- Log rotation (host deployment concern)
- Kubernetes manifests (intentionally out of scope)
- CI/CD pipeline
- Monitoring / alerting

## Quick start

### 1. Create your env file

```sh
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` and replace all `REPLACE_*` placeholders with real values.
Generate secrets with:

```sh
# JWT secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Backup encryption key (64 hex characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Never commit `deploy/.env`.** It contains secrets.

### 2. Build and start

```sh
docker compose build
docker compose up -d
```

### 3. Verify

```sh
docker compose ps
curl http://localhost:8080/health
```

Expected: the API container is healthy and `/health` returns JSON with `"status":"ok"`.

Open http://localhost:8080 in a browser.

### 4. Login smoke test

1. Open http://localhost:8080
2. Log in with the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from your env file
3. Verify the matter list loads
4. Create a test matter and confirm it persists after page reload

### 5. Backup smoke test

Run a backup inside the API container:

```sh
docker compose exec lexflow-api node scripts/backup.js
```

Check the backup log:

```sh
docker compose exec lexflow-api cat /logs/backup.log
```

## Volume mapping

| Volume             | Container path | Contents                          |
|--------------------|----------------|-----------------------------------|
| `lexflow-data`     | `/data`        | SQLite database (`lawfirm.db`)    |
| `lexflow-backups`  | `/backups`     | Encrypted backup files            |
| `lexflow-logs`     | `/logs`        | Backup log                        |

## Stopping containers

```sh
docker compose down
```

This stops and removes containers but preserves named volumes.

**Do not delete volumes casually.** They hold your database, backups, and logs.
To remove volumes (destroys all data):

```sh
docker compose down -v
```

## Production caveats

This runtime is suitable for local testing and single-host pilots. For a full production deployment:

- Add TLS termination (e.g., Caddy, Traefik, or a cloud load balancer)
- Configure off-host backup replication
- Set up log rotation on the host or forward logs to a central collector
- Review and harden `CORS_ORIGINS`, `BASE_URL`, and OAuth redirect URIs for the real domain
