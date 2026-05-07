# LexFlow Environment Variables

All configuration for the LexFlow backend is managed through environment variables.

## Security Rules

- **Never commit `.env` files** to the repository.
- Use `.env.production.example` as a template — fill in real values on the server only.
- Each environment (development, staging, production) must have its own set of secrets.
- Rotate secrets on a schedule and after any suspected compromise.

## Core Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | `development`, `test`, or `production` |
| `PORT` | No | `5000` | HTTP port the Node backend listens on |
| `DATABASE_PATH` | No | `server/lawfirm.db` | Path to the SQLite database file |
| `JWT_SECRET` | **Yes (prod)** | _(dev only)_ | HMAC-SHA256 secret for signing JWT tokens. Must be at least 32 bytes. |
| `JWT_EXPIRES_IN` | No | `1h` (prod/test), `8h` (dev) | Access token expiry duration (e.g. `1h`, `30m`, `7d`) |
| `CORS_ORIGINS` | **Yes (prod)** | _(localhost in dev)_ | Comma-separated list of allowed frontend origins |
| `JSON_BODY_LIMIT` | No | `1mb` | Max size for JSON request bodies |
| `UPLOAD_BODY_LIMIT` | No | `10mb` | Max size for multipart upload bodies |

## Backup Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BACKUP_DIR` | No | `backups/` | Directory for encrypted backup files |
| `BACKUP_LOG` | No | `logs/backup.log` | Path to the backup log file |
| `LEXFLOW_BACKUP_KEY` | No _(but encryption disabled without it)_ | _(none)_ | 64 hex characters (32 bytes). Used for AES-256-CBC encryption of backups. |
| `LEXFLOW_BACKUP_RETENTION_COUNT` | No | `7` | Number of recent backups to keep (max 100) |

## OAuth Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OAUTH_STAFF_ENABLED` | No | `false` | Set to `true` to enable staff OAuth login |
| `OAUTH_CLIENT_ENABLED` | No | `false` | Deferred — set to `true` when client OAuth is ready |
| `OAUTH_STATE_SECRET` | No _(but CSRF disabled without it)_ | _(none)_ | HMAC secret for OAuth state tokens. 64 hex chars recommended. |
| `OAUTH_REQUIRE_VERIFIED_EMAIL` | No | `true` | Require `email_verified` from OAuth providers |
| `OAUTH_ALLOWED_DOMAINS` | No | _(none — unrestricted)_ | Comma-separated list of allowed email domains |
| `GOOGLE_CLIENT_ID` | No _(for Google OAuth)_ | _(none)_ | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | No _(for Google OAuth)_ | _(none)_ | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | No _(for Google OAuth)_ | `{BASE_URL}/api/auth/oauth/google/callback` | Must match Google Console exactly |
| `MICROSOFT_CLIENT_ID` | No _(for MS OAuth)_ | _(none)_ | Microsoft Entra (Azure AD) application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | No _(for MS OAuth)_ | _(none)_ | Microsoft Entra client secret |
| `MICROSOFT_TENANT_ID` | No | `common` | Azure AD tenant ID or `common`/`organizations`/`consumers` |
| `MICROSOFT_REDIRECT_URI` | No _(for MS OAuth)_ | `{BASE_URL}/api/auth/oauth/microsoft/callback` | Must match Azure portal exactly |

## Seed Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEED_ADMIN_EMAIL` | No | `admin@lexflow.co.ke` | Admin email for initial database seed |
| `SEED_ADMIN_PASSWORD` | No | `password123` (dev), `""` (prod) | Admin password for initial seed |
| `SEED_ADMIN_NAME` | No | `Admin` | Admin display name for initial seed |

## Rate Limiting

| Variable | Required | Default | Description |
|---|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | No | `900000` (15 min) | General rate limit window in milliseconds |
| `RATE_LIMIT_MAX` | No | `100` | Max requests per window for general endpoints |
| `AUTH_RATE_LIMIT_WINDOW_MS` | No | `900000` (15 min) | Auth-specific rate limit window |
| `AUTH_RATE_LIMIT_MAX` | No | `5` | Max login attempts per window |

## Content Security Policy

| Variable | Required | Default | Description |
|---|---|---|---|
| `CSP_REPORT_ONLY` | No | `false` | Set `true` to use `Content-Security-Policy-Report-Only` header |
| `CSP_DIRECTIVES` | No | _(sane defaults)_ | JSON object overriding default CSP directives |

## Base URL

| Variable | Required | Default | Description |
|---|---|---|---|
| `BASE_URL` | No | `http://localhost:5000` (dev), `""` (prod) | Public URL of the backend. Used for OAuth callbacks, invitation links, etc. |

## Generating Secure Keys

### PowerShell (Windows)

```powershell
# JWT_SECRET (32 bytes = 64 hex chars)
-join ((0..31) | ForEach-Object { "{0:x2}" -f (Get-Random -Minimum 0 -Maximum 256) })

# LEXFLOW_BACKUP_KEY (32 bytes = 64 hex chars)
-join ((0..31) | ForEach-Object { "{0:x2}" -f (Get-Random -Minimum 0 -Maximum 256) })

# OAUTH_STATE_SECRET (32 bytes = 64 hex chars)
-join ((0..31) | ForEach-Object { "{0:x2}" -f (Get-Random -Minimum 0 -Maximum 256) })
```

### OpenSSL (Linux/macOS)

```bash
# Any 32-byte hex key
openssl rand -hex 32
```

## Per-Environment Separation

| Environment | File | Notes |
|---|---|---|
| Development | `.env` (gitignored) | Local defaults, short-lived tokens |
| Staging | `.env.staging` (gitignored) | Production-like, separate secrets |
| Production | `.env.production` (gitignored) | Strong secrets, strict CORS, short tokens |

Use a secrets manager (e.g. HashiCorp Vault, AWS Secrets Manager) for production if available.

## Secret Rotation

### JWT Secret

1. Generate a new `JWT_SECRET`.
2. Update the server environment and restart.
3. **All existing sessions are invalidated** — users must log in again.
4. Schedule rotation during low-traffic windows.

### Backup Key

1. Generate a new `LEXFLOW_BACKUP_KEY`.
2. **Decrypt and re-encrypt all existing backups** with the new key before switching.
3. Update the server environment and restart.
4. If the old key is lost, existing encrypted backups are unrecoverable.

### OAuth Secrets

1. Rotate in the provider console (Google Cloud Console / Azure Portal).
2. Update `GOOGLE_CLIENT_SECRET` / `MICROSOFT_CLIENT_SECRET`.
3. Restart the server.
4. No user sessions are affected — only new OAuth flows use the new secret.

### OAUTH_STATE_SECRET

1. Generate a new secret.
2. Restart the server.
3. Any in-flight OAuth flows will fail — this is safe and expected.

## Launch Checklist

- [ ] All `JWT_SECRET`, `LEXFLOW_BACKUP_KEY`, and `OAUTH_STATE_SECRET` are generated securely
- [ ] `NODE_ENV=production` is set
- [ ] `CORS_ORIGINS` lists only the production frontend URL
- [ ] `BASE_URL` matches the public HTTPS URL
- [ ] OAuth redirect URIs in provider consoles match `BASE_URL`
- [ ] `.env` file permissions restricted (`chmod 600` on Linux)
- [ ] Backup encryption verified with a test decrypt
- [ ] No `.env` files committed to Git

## See Also

- [Reverse Proxy & HTTPS](REVERSE-PROXY-HTTPS.md)
- [Process Management](PROCESS-MANAGEMENT.md)
- [SQLite Production Notes](SQLITE-PRODUCTION.md)
- [Backup Automation](BACKUP-AUTOMATION.md)
- [Production Checklist](PRODUCTION-CHECKLIST.md)
