# Process Management for LexFlow

## Architecture

- **Single Node.js backend instance** — SQLite is a file database and does not support concurrent writers from multiple processes.
- **Nginx reverse proxy** in front — handles HTTPS, static files, and routing.
- **Process manager** keeps the Node backend running and restarts on crash.

## ⚠️ SQLite Single-Instance Warning

**Never run multiple LexFlow backend instances** against the same SQLite database file. SQLite supports concurrent readers but serializes writes. Multiple Node processes will cause `SQLITE_BUSY` errors and potential data corruption.

If you need horizontal scaling, migrate to PostgreSQL first (see [SQLite Production Notes](SQLITE-PRODUCTION.md)).

## Option A: PM2

PM2 is a process manager for Node.js applications.

### Installation

```bash
npm install -g pm2
```

### Starting LexFlow

```bash
cd /opt/lexflow/server
NODE_ENV=production pm2 start ecosystem.config.js
pm2 save
pm2 startup   # generates systemd service for auto-start on boot
```

### Commands

| Command | Description |
|---|---|
| `pm2 status` | Show running processes |
| `pm2 logs lexflow` | Tail application logs |
| `pm2 restart lexflow` | Restart the application |
| `pm2 reload lexflow` | Zero-downtime reload (not needed for single instance) |
| `pm2 stop lexflow` | Stop the application |
| `pm2 delete lexflow` | Remove from PM2 management |

### Health Checks with PM2

```bash
curl -s http://127.0.0.1:5000/health
```

PM2 can auto-restart on health check failure:

```javascript
// In ecosystem.config.js
restart_delay: 3000,
autorestart: true,
```

### Log Rotation

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## Option B: systemd

### Service File

See [`deploy/systemd/lexflow.service.example`](../../deploy/systemd/lexflow.service.example).

### Installation

```bash
sudo cp deploy/systemd/lexflow.service /etc/systemd/system/lexflow.service
sudo systemctl daemon-reload
sudo systemctl enable lexflow
sudo systemctl start lexflow
```

### Commands

| Command | Description |
|---|---|
| `sudo systemctl status lexflow` | Check service status |
| `sudo journalctl -u lexflow -f` | Tail application logs |
| `sudo systemctl restart lexflow` | Restart the service |
| `sudo systemctl stop lexflow` | Stop the service |

### Health Check Script

```bash
#!/bin/bash
# /opt/lexflow/scripts/healthcheck.sh
STATUS=$(curl -sf http://127.0.0.1:5000/health | grep -o '"status":"ok"')
if [ "$STATUS" != '"status":"ok"' ]; then
    echo "Health check failed at $(date)"
    systemctl restart lexflow
fi
```

Add to crontab:

```cron
*/5 * * * * /opt/lexflow/scripts/healthcheck.sh >> /var/log/lexflow-healthcheck.log 2>&1
```

## Environment File Permissions

```bash
sudo chown root:www-data /opt/lexflow/server/.env.production
sudo chmod 640 /opt/lexflow/server/.env.production
```

The process user must be able to read the `.env` file, but no other users should have access.

## Reviewing Logs

```bash
# PM2
pm2 logs lexflow --lines 200

# systemd
sudo journalctl -u lexflow --since "1 hour ago" --no-pager
```

Look for:
- Repeated `SQLITE_BUSY` errors
- Unhandled promise rejections
- Out-of-memory (OOM) kills (`dmesg | grep -i oom`)

## Crash / Restart Procedure

1. Check logs: `pm2 logs lexflow` or `journalctl -u lexflow -n 100`
2. Identify the error (bad migration, corrupted DB, OOM, etc.)
3. Fix the root cause
4. Restart: `pm2 restart lexflow` or `sudo systemctl restart lexflow`
5. Verify health: `curl http://127.0.0.1:5000/health`

## See Also

- [PM2 Config Template](../../deploy/pm2/ecosystem.example.config.js)
- [systemd Service Template](../../deploy/systemd/lexflow.service.example)
- [Reverse Proxy & HTTPS](REVERSE-PROXY-HTTPS.md)
- [Backup Automation](BACKUP-AUTOMATION.md)
