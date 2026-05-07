# Reverse Proxy & HTTPS for LexFlow

## Architecture

```
Internet
  │
  ▼
┌─────────────┐    HTTPS :443     ┌──────────────────┐
│   Nginx     │ ─────────────────▶│  Let's Encrypt   │
│  (reverse   │                   │  Certbot         │
│   proxy)    │                   └──────────────────┘
│             │
│  /          │─── serves ───▶ /var/www/lexflow/client/dist (React static)
│  /api/      │─── proxies ──▶ http://127.0.0.1:5000 (Node backend)
└─────────────┘
```

- **Nginx terminates HTTPS** — the Node backend only listens on `localhost` / `127.0.0.1`.
- **Nginx serves the React static build** directly for all non-API paths.
- **Nginx proxies `/api/`** to the local Node backend.
- **Node never binds to a public interface.**

## Prerequisites

1. **VPS** with Ubuntu 22.04+ or Debian 12+ (or equivalent).
2. **DNS A record** pointing your domain (e.g. `lexflow.example.com`) to the VPS IP.
3. **Firewall** allowing ports 80 and 443 inbound.
4. **Node.js 18+** installed on the server.
5. **Git** installed for deploying the codebase.

## DNS

```
lexflow.example.com.  IN  A  203.0.113.50
```

Wait for propagation before requesting certificates.

## Firewall

```bash
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP (for certbot challenge)
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable
```

## Nginx Installation

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## Let's Encrypt Certificate

```bash
sudo certbot --nginx -d lexflow.example.com
```

Certbot will:
- Verify domain ownership via HTTP-01 challenge.
- Generate and install the certificate.
- Configure automatic renewal via systemd timer.

## Nginx Configuration

See [`deploy/nginx/lexflow.example.conf`](../../deploy/nginx/lexflow.example.conf) for a full sample.

Key directives:

### SPA Fallback

```nginx
location / {
    root /var/www/lexflow/client/dist;
    try_files $uri /index.html;
}
```

This serves the React app and handles client-side routing.

### API Proxy

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Upload Size

```nginx
client_max_body_size 50m;
```

Must match or exceed `UPLOAD_BODY_LIMIT` in the Node config.

### Proxy Timeouts

For long-running operations (backups, large uploads):

```nginx
proxy_connect_timeout 60s;
proxy_send_timeout 120s;
proxy_read_timeout 120s;
```

### Security Headers

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

Avoid overly strict `Content-Security-Policy` until the app and OAuth flows are fully tested.

### HTTP-to-HTTPS Redirect

Certbot typically configures this automatically. If manual:

```nginx
server {
    listen 80;
    server_name lexflow.example.com;
    return 301 https://$host$request_uri;
}
```

## OAuth Production Callback URLs

You **must** configure these in your OAuth provider consoles:

| Provider | Redirect URI |
|---|---|
| Google | `https://YOUR_DOMAIN/api/auth/oauth/google/callback` |
| Microsoft | `https://YOUR_DOMAIN/api/auth/oauth/microsoft/callback` |

Replace `YOUR_DOMAIN` with your actual domain.

**Google Console:** https://console.cloud.google.com/apis/credentials
**Azure Portal:** https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade

## Log Paths

| Log | Path |
|---|---|
| Nginx access | `/var/log/nginx/lexflow-access.log` |
| Nginx error | `/var/log/nginx/lexflow-error.log` |
| Node stdout/stderr | `/var/log/lexflow/` (configured by PM2/systemd) |

## Rollback

1. Keep the previous Nginx config: `sudo cp /etc/nginx/sites-available/lexflow /etc/nginx/sites-available/lexflow.bak`
2. If the new config breaks: `sudo cp /etc/nginx/sites-available/lexflow.bak /etc/nginx/sites-available/lexflow && sudo nginx -t && sudo systemctl reload nginx`
3. To revert to HTTP only: comment out the SSL block in Nginx config and reload.

## Certificate Renewal

Certbot auto-renews via systemd timer. Verify:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

## See Also

- [Environment Variables](ENVIRONMENT.md)
- [Process Management](PROCESS-MANAGEMENT.md)
- [Nginx Sample Config](../../deploy/nginx/lexflow.example.conf)
- [Production Checklist](PRODUCTION-CHECKLIST.md)
