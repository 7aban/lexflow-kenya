// PM2 ecosystem configuration for LexFlow.
// Copy to ecosystem.config.js in /opt/lexflow/server and adjust paths.
//
// PM2 does not automatically load server/.env.production for this app.
// Provide the production variables in env below, through your PM2 startup
// environment, or with a deployment wrapper that exports the env file first.

module.exports = {
  apps: [{
    name: 'lexflow',
    script: 'server.js',
    cwd: '/opt/lexflow/server',

    // Environment
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      DATABASE_PATH: '/opt/lexflow/server/lawfirm.db',
      BASE_URL: 'https://lexflow.example.com',
      CORS_ORIGINS: 'https://lexflow.example.com',

      // Replace all placeholder values before use. Do not commit real secrets.
      JWT_SECRET: 'replace_with_high_entropy_jwt_secret',
      JWT_EXPIRES_IN: '1h',
      JWT_ISSUER: 'lexflow-production',
      JWT_AUDIENCE: 'lexflow-users',
      LEXFLOW_BACKUP_KEY: 'replace_with_64_hex_character_backup_encryption_key',
      LEXFLOW_BACKUP_RETENTION_COUNT: '30',
      BACKUP_DIR: '/opt/lexflow/backups',
      BACKUP_LOG: '/opt/lexflow/logs/backup.log',
      SEED_ADMIN_EMAIL: 'admin@example.com',
      SEED_ADMIN_NAME: 'LexFlow Admin',
      SEED_ADMIN_PASSWORD: 'replace_with_temporary_first_admin_password',
      OAUTH_STAFF_ENABLED: 'true',
      OAUTH_CLIENT_ENABLED: 'false',
      OAUTH_STATE_SECRET: 'replace_with_high_entropy_oauth_state_secret',
      OAUTH_ALLOWED_DOMAINS: 'example.com',
      OAUTH_REQUIRE_VERIFIED_EMAIL: 'true',
      GOOGLE_CLIENT_ID: 'replace_with_google_client_id',
      GOOGLE_CLIENT_SECRET: 'replace_with_google_client_secret',
      GOOGLE_REDIRECT_URI: 'https://lexflow.example.com/api/auth/oauth/google/callback',
      MICROSOFT_CLIENT_ID: 'replace_with_microsoft_client_id',
      MICROSOFT_CLIENT_SECRET: 'replace_with_microsoft_client_secret',
      MICROSOFT_TENANT_ID: 'common',
      MICROSOFT_REDIRECT_URI: 'https://lexflow.example.com/api/auth/oauth/microsoft/callback',
      JSON_BODY_LIMIT: '1mb',
      UPLOAD_BODY_LIMIT: '10mb',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX: '100',
      AUTH_RATE_LIMIT_WINDOW_MS: '900000',
      AUTH_RATE_LIMIT_MAX: '5',
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
