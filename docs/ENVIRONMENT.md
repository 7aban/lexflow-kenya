# LexFlow Environment Configuration

## Overview

LexFlow uses environment variables for configuration. This document describes the required and optional variables for development, testing, and production.

## Quick Start

1. Copy the example file to create your `.env` file:
   ```bash
   cd server
   cp .env.example .env
   ```

2. Generate a strong JWT secret:
   ```bash
   openssl rand -hex 32
   ```

3. Paste the generated secret into your `.env` file as `JWT_SECRET`.

4. Set a strong seed admin password (production):
   ```bash
   SEED_ADMIN_PASSWORD=your-strong-password-12plus-chars
   ```

5. Start the server:
   ```bash
   cd server
   npm start
   ```

## Environment Variables

### Required in Production

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for signing JWT tokens (min 32 chars) | `a1b2c3d4e5f6...` |
| `CORS_ORIGINS` | Comma-separated allowed origins | `https://lexflow.co.ke` |
| `SEED_ADMIN_PASSWORD` | Strong password for initial admin (12+ chars) | `MyStr0ngP@ssw0rd2026!` |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Set to `production` in production |
| `PORT` | `5000` | Server port |
| `DATABASE_PATH` | `lawfirm.db` | Path to SQLite database |
| `BACKUP_DIR` | `../backups` | Backup storage directory |
| `BACKUP_LOG` | `../logs/backup.log` | Backup log file path |
| `BASE_URL` | `http://localhost:5000` (dev) | Base URL for invitations/reminders |
| `SEED_ADMIN_EMAIL` | `admin@lexflow.co.ke` | Initial admin email |
| `SEED_ADMIN_NAME` | `Admin` | Initial admin display name |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | General rate limit window |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | Auth rate limit window |
| `AUTH_RATE_LIMIT_MAX` | `5` | Max auth attempts per window |
| `JSON_BODY_LIMIT` | `1mb` | JSON body size limit |
| `UPLOAD_BODY_LIMIT` | `10mb` | Upload body size limit |
| `CSP_REPORT_ONLY` | `false` | Enable CSP report-only mode |
| `CSP_DIRECTIVES` | (see below) | JSON string of CSP directives |

## Default Admin Bootstrap

### First-Time Setup
On first run, if no users exist, LexFlow creates an admin account using these env vars:

| Variable | Default | Required in Prod |
|----------|---------|-------------------|
| `SEED_ADMIN_EMAIL` | `admin@lexflow.co.ke` | No |
| `SEED_ADMIN_PASSWORD` | `password123` (dev only) | **YES** (must be 12+ chars, not weak) |
| `SEED_ADMIN_NAME` | `Admin` | No |

### Production Requirements
- `SEED_ADMIN_PASSWORD` **must** be set
- Password must be 12+ characters
- Password cannot be a common weak password (`password123`, `admin123`, etc.)
- If requirements not met, server fails to start (fail-fast)

### Development/Test
- Default password `password123` allowed in development (warned)
- Test environment uses isolated test credentials
- Password strength validation skipped in development

## Rate Limiting

### Configuration
Rate limiting is now applied to:
1. **General API routes** (`/api/*`): Configurable via `RATE_LIMIT_*`
2. **Auth routes** (`/login`, `/register`, `/invitations`): Stricter limits via `AUTH_RATE_LIMIT_*`

### Defaults
| Environment | Window | Max Requests |
|-------------|--------|--------------|
| Production | 15 min | 100 (general), 5 (auth) |
| Development | 15 min | 100 (general), 5 (auth) |
| Test | Disabled | 999999 (effectively unlimited) |

## Helmet & CSP

### Content Security Policy
Helmet is enabled with CSP configuration:

**Production defaults:**
- `default-src 'self'`
- `script-src 'self'`
- `style-src 'self' 'unsafe-inline'` (required for some inline styles)
- `img-src 'self' data: blob:`
- `connect-src 'self'` + configured CORS origins
- `object-src 'none'`
- `base-uri 'self'`
- `frame-ancestors 'none'`

**Development:**
- CSP is disabled (allows Vite HMR and localhost)

**Custom CSP:**
Set `CSP_DIRECTIVES` as JSON:
```bash
CSP_DIRECTIVES={"defaultSrc":["'self'"],"scriptSrc":["'self'","'unsafe-inline'"]}
```

**Report-only mode:**
```bash
CSP_REPORT_ONLY=true
```

## JSON/Upload Body Limits

### Configuration
| Type | Variable | Default | Purpose |
|------|----------|---------|---------|
| JSON requests | `JSON_BODY_LIMIT` | `1mb` | General API requests |
| Uploads | `UPLOAD_BODY_LIMIT` | `10mb` | Document uploads (base64) |

### Notes
- General JSON limit reduced from 25mb to 1mb
- Upload limit separate for document routes (`/api/documents`)
- If using base64 document uploads, ensure `UPLOAD_BODY_LIMIT` is sufficient

## Development vs Production

### Development
- `NODE_ENV=development` (default)
- Allows localhost CORS origins
- JWT_SECRET can use development fallback (warns)
- Weaker default admin password allowed (warned)
- Hot reload enabled via Vite
- CSP disabled

### Production
- `NODE_ENV=production` (must be set)
- JWT_SECRET **must** be set (throws error if missing)
- CORS_ORIGINS **must** be configured (no open CORS)
- `SEED_ADMIN_PASSWORD` **must** be set (12+ chars, not weak)
- CSP enabled with production defaults
- No default secrets allowed

## Security Notes

### JWT Secret
- **Never commit `.env` file** - add it to `.gitignore`
- Use a strong random secret in production (32+ bytes)
- Do NOT use the old default: `lexflow-kenya-law-secret`
- Rotate secrets periodically

Generate a secure secret:
```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### CORS Configuration
In production, explicitly set allowed origins:
```bash
CORS_ORIGINS=https://lexflow.co.ke,https://app.lexflow.co.ke
```

Multiple origins supported:
```bash
CORS_ORIGINS=https://site1.com,https://site2.com
```

### Default Credentials
The default admin account is created on first run with these requirements:
- **Production**: Must set `SEED_ADMIN_PASSWORD` (12+ chars, not weak)
- **Development**: Uses `password123` by default (warned to change)
- **Change password** immediately after first login!

### Rate Limiting
- Login: 5 attempts per 15 minutes
- General API: 100 requests per 15 minutes
- Configurable via environment variables

### Helmet/CSP
- Enabled in production with secure defaults
- Protects against XSS, clickjacking, etc.
- CSP can be customized via `CSP_DIRECTIVES`

## File Locations

| File | Purpose |
|------|---------|
| `server/.env.example` | Template with documented variables |
| `server/.env` | Your local environment (gitignored) |
| `server/lib/config.js` | Centralized config module |
| `docs/ENVIRONMENT.md` | This documentation |

## Troubleshooting

### "JWT_SECRET environment variable is required in production"
Set `JWT_SECRET` in your environment or `.env` file.

### "CORS: no allowed origins configured in production"
Set `CORS_ORIGINS` to your frontend URL(s).

### "SEED_ADMIN_PASSWORD must be at least 12 characters"
Set a strong password (12+ chars) in production environment.

### "SEED_ADMIN_PASSWORD cannot be a common weak password"
Choose a password that isn't in the weak password list (`password123`, `admin123`, etc.)

### Server starts but frontend can't connect
1. Check `CORS_ORIGINS` includes your frontend URL
2. Check `PORT` matches what frontend expects
3. Check `BASE_URL` if using invitations

### Rate limit exceeded
- Check `RATE_LIMIT_*` environment variables
- In test environment, limits are effectively disabled

## Migration from Old Config

If upgrading from a version without centralized config:

1. The old hardcoded secret `lexflow-kenya-law-secret` will cause an error in production
2. Create `.env` with a new strong `JWT_SECRET`
3. Set `SEED_ADMIN_PASSWORD` in production (12+ chars)
4. All hardcoded config in `server.js` and `middleware/auth.js` now uses `server/lib/config.js`

## Testing

Run tests with test-specific config:
```bash
cd server
npm test
```

Test environment uses:
- `NODE_ENV=test`
- JWT_SECRET: `test-jwt-secret-for-unit-tests-only`
- Auth rate limit: disabled (999999 max)
- Isolated test database

## Windows Task Scheduler

If using the backup scheduled task, ensure the task runs with the correct environment:
- Task runs from `server/` directory
- `.env` file should be in `server/` folder
- `npm run backup` reads config from centralized module
