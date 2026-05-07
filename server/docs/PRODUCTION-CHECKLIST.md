# Production Deployment Checklist

## Pre-Deployment

- [ ] Code reviewed and tested on staging
- [ ] All backend tests pass (`npm run test:seeded` → 242+ passing)
- [ ] Frontend build succeeds (`npm run build`)
- [ ] Git tag created for this release
- [ ] Bundle backup created (`git bundle create ...`)

## Environment & Secrets

- [ ] `NODE_ENV=production` set
- [ ] `JWT_SECRET` generated securely (64 hex chars)
- [ ] `LEXFLOW_BACKUP_KEY` generated securely (64 hex chars)
- [ ] `OAUTH_STATE_SECRET` generated securely (64 hex chars)
- [ ] `CORS_ORIGINS` set to production frontend URL only
- [ ] `BASE_URL` set to production HTTPS URL
- [ ] `.env.production` file created with `chmod 600`
- [ ] No `.env` files committed to Git
- [ ] Secrets stored in password manager / vault

## HTTPS & Networking

- [ ] DNS A record configured and propagated
- [ ] Firewall allows ports 80, 443, 22
- [ ] Nginx installed and configured
- [ ] Let's Encrypt certificate obtained
- [ ] HTTP-to-HTTPS redirect working
- [ ] `curl https://YOUR_DOMAIN/health` returns `{"status":"ok"}`

## OAuth Configuration

- [ ] Google OAuth redirect URI set: `https://YOUR_DOMAIN/api/auth/oauth/google/callback`
- [ ] Microsoft OAuth redirect URI set: `https://YOUR_DOMAIN/api/auth/oauth/microsoft/callback`
- [ ] `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set
- [ ] `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` set
- [ ] OAuth login tested with a staff account

## Process Management

- [ ] PM2 or systemd service configured and enabled
- [ ] Service auto-starts on boot
- [ ] Logs accessible and rotating
- [ ] Health check configured (polling `/health`)

## Backup

- [ ] Backup encryption verified (test decrypt succeeds)
- [ ] Daily backup scheduled (cron or systemd timer)
- [ ] Off-site backup copy configured
- [ ] Backup key stored separately from backup files
- [ ] Initial restore drill completed
- [ ] Restore drill scheduled quarterly

## SQLite

- [ ] WAL mode enabled (default in LexFlow)
- [ ] `busy_timeout=5000` active (default in LexFlow)
- [ ] Database file permissions restricted
- [ ] Disk space monitoring configured
- [ ] No load balancer with multiple backend instances

## Post-Deployment

- [ ] `/health` endpoint responds with `{"status":"ok"}`
- [ ] Login with email/password works
- [ ] Staff OAuth login works (Google and/or Microsoft)
- [ ] Client portal accessible
- [ ] Nginx config tested with `nginx -t`
- [ ] Application logs show no errors on startup
- [ ] Git tag deployed and documented

## Security

- [ ] No `.env` committed to Git (verify with `git ls-files | grep .env`)
- [ ] No hardcoded secrets in source code
- [ ] `.env.production` permissions are `600`
- [ ] Database file permissions are `660` or stricter
- [ ] Nginx security headers present (X-Frame-Options, X-Content-Type-Options)
- [ ] HTTPS enforced — no HTTP access to API

## See Also

- [Environment Variables](ENVIRONMENT.md)
- [Reverse Proxy & HTTPS](REVERSE-PROXY-HTTPS.md)
- [Process Management](PROCESS-MANAGEMENT.md)
- [SQLite Production Notes](SQLITE-PRODUCTION.md)
- [Backup Automation](BACKUP-AUTOMATION.md)
- [Restore Guide](RESTORE.md)
