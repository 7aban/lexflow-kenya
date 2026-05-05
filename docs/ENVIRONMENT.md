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

4. Start the server:
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

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Set to `production` in production |
| `PORT` | `5000` | Server port |
| `DATABASE_PATH` | `lawfirm.db` | Path to SQLite database |
| `BACKUP_DIR` | `../backups` | Backup storage directory |
| `BACKUP_LOG` | `../logs/backup.log` | Backup log file path |
| `BASE_URL` | `http://localhost:5000` (dev) | Base URL for invitations/reminders |

## Development vs Production

### Development
- `NODE_ENV=development` (default)
- Allows localhost CORS origins
- JWT_SECRET can use development fallback (warns)
- Hot reload enabled via Vite

### Production
- `NODE_ENV=production` (must be set)
- JWT_SECRET **must** be set (throws error if missing)
- CORS_ORIGINS **must** be configured (no open CORS)
- No default secrets allowed

## Security Notes

### JWT Secret
- **Never commit `.env` file** - add it to `.gitignore`
- Use a strong random secret in production (32+ bytes)
- Do NOT use the old default: `lexflow-kenyan-law-secret`
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
The default admin account is created on first run:
- Email: `admin@lexflow.co.ke`
- Password: `password123`

**Change this password immediately after first login!**

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

### Server starts but frontend can't connect
1. Check `CORS_ORIGINS` includes your frontend URL
2. Check `PORT` matches what frontend expects
3. Check `BASE_URL` if using invitations

## Migration from Old Config

If upgrading from a version without centralized config:

1. The old hardcoded secret `lexflow-kenyan-law-secret` will cause an error in production
2. Create `.env` with a new strong `JWT_SECRET`
3. All hardcoded config in `server.js` and `middleware/auth.js` now uses `server/lib/config.js`

## Testing

Run tests with test-specific config:
```bash
cd server
npm test
```

Test environment uses:
- `NODE_ENV=test`
- JWT_SECRET: `test-jwt-secret-for-unit-tests-only`
- Isolated test database

## Windows Task Scheduler

If using the backup scheduled task, ensure the task runs with the correct environment:
- Task runs from `server/` directory
- `.env` file should be in `server/` folder
- `npm run backup` reads config from centralized module
