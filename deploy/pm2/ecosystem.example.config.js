// PM2 ecosystem configuration for LexFlow
// Copy to ecosystem.config.js in /opt/lexflow/server and adjust paths.

module.exports = {
  apps: [{
    name: 'lexflow',
    script: 'server.js',
    cwd: '/opt/lexflow/server',

    // Environment
    env: {
      NODE_ENV: 'production',
      // Other env vars loaded from .env.production via dotenv
    },

    // Single instance — SQLite does not support multiple writers
    instances: 1,
    exec_mode: 'fork',

    // Auto-restart
    autorestart: true,
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: '10s',

    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/var/log/lexflow/lexflow-error.log',
    out_file: '/var/log/lexflow/lexflow-out.log',
    merge_logs: true,

    // Resource limits
    max_memory_restart: '500M',

    // Do NOT use watch mode in production
    watch: false,
  }],
};
