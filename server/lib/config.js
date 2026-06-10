const path = require('path');

// Load .env file in development if dotenv is available
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  } catch (e) {
    // dotenv not installed - that's fine for production
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// Helper to require env var in production
function requireEnv(varName, fallback) {
  const value = process.env[varName];
  if (!value) {
    if (isProduction) {
      throw new Error(`Environment variable ${varName} is required in production`);
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Environment variable ${varName} is required`);
  }
  return value;
}

// JWT Secret - REQUIRED in production, no insecure fallbacks
const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (isProduction) {
      throw new Error('JWT_SECRET environment variable is required in production');
    }
    // Only allow development/test defaults
    if (isTest) {
      return 'test-jwt-secret-for-unit-tests-only';
    }
    return 'dev-jwt-secret-change-in-production';
  }
  // Warn if using the old default secret
  if (secret === 'lexflow-kenyan-law-secret') {
    if (isProduction) {
      throw new Error('JWT_SECRET cannot use the default value "lexflow-kenyan-law-secret" in production');
    }
    console.warn('WARNING: Using default JWT_SECRET. Set JWT_SECRET environment variable for production!');
  }
  return secret;
})();

// JWT Access Token Expiry - configurable
const JWT_EXPIRES_IN = (() => {
  const expiresIn = process.env.JWT_EXPIRES_IN;
  if (expiresIn) {
    return expiresIn;
  }
  if (isTest) {
    return '1h'; // Short expiry for tests
  }
  if (isProduction) {
    return '1h'; // Short-lived tokens in production - use refresh tokens for longer sessions
  }
  return '8h'; // Development default
})();

// JWT algorithm constraint
const JWT_ALGORITHM = 'HS256';

// Optional JWT issuer/audience for extra validation
const JWT_ISSUER = process.env.JWT_ISSUER || '';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || '';

// Port configuration
const PORT = parseInt(process.env.PORT || '5000', 10);

// CORS origins - configurable via environment
const CORS_ORIGINS = (() => {
  const origins = process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS;
  if (origins) {
    return origins.split(',').map(o => o.trim());
  }
  if (isProduction) {
    return []; // Must be explicitly configured in production
  }
  // Development defaults
  return [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ];
})();

// Database path
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'lawfirm.db');

// Backup configuration
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const BACKUP_LOG = process.env.BACKUP_LOG || path.join(__dirname, '..', '..', 'logs', 'backup.log');
const BACKUP_RETENTION_COUNT = (() => {
  const count = parseInt(process.env.LEXFLOW_BACKUP_RETENTION_COUNT || '7', 10);
  if (isNaN(count) || count < 1) return 7;
  if (count > 100) return 100; // safety cap
  return count;
})();
const BACKUP_KEY = (() => {
  const key = process.env.LEXFLOW_BACKUP_KEY;
  if (!key) return null;
  if (key.length !== 64) {
    if (isProduction) {
      throw new Error('LEXFLOW_BACKUP_KEY must be 64 hex characters (32 bytes)');
    }
    return null;
  }
  return Buffer.from(key, 'hex');
})();

const CONNECTED_ACCOUNTS_TOKEN_KEY = (() => {
  const key = process.env.CONNECTED_ACCOUNTS_TOKEN_KEY;
  if (!key) {
    if (isTest) {
      return Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    if (isProduction) {
      throw new Error('CONNECTED_ACCOUNTS_TOKEN_KEY must be 64 hex characters (32 bytes)');
    }
    return null;
  }
  return Buffer.from(key, 'hex');
})();

// Base URL for invitations/reminders
const BASE_URL = process.env.BASE_URL || (isProduction ? '' : 'http://localhost:5000');

// Seed admin configuration
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@lexflow.co.ke';
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || (isTest ? 'test-password' : (isProduction ? '' : 'password123'));
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin';

// LOCAL-PILOT-FIX-2: pilot-friendly password minimum length. The shared policy
// (lib/passwordPolicy.js) defaults to 12; routes pass this value instead.
// Complexity rules (upper/lower/digit/symbol, common-password list) unchanged.
const PASSWORD_MIN_LENGTH = (() => {
  const value = parseInt(process.env.LEXFLOW_PASSWORD_MIN_LENGTH || '8', 10);
  if (isNaN(value) || value < 6) return 8;
  if (value > 128) return 128;
  return value;
})();

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || (isTest ? '0' : '900000'), 10); // 15 min default
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || (isTest ? '999999' : '100'), 10); // 100 requests per window
const AUTH_RATE_LIMIT_WINDOW_MS = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || (isTest ? '0' : '900000'), 10); // 15 min
const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX || (isTest ? '999999' : '5'), 10); // 5 attempts per 15 min

// LOCAL-PILOT-FIX-1: allow disabling rate limiting entirely for local pilot
// runs via LEXFLOW_DISABLE_RATE_LIMIT=true. Never honoured in production.
const DISABLE_RATE_LIMIT = process.env.LEXFLOW_DISABLE_RATE_LIMIT === 'true' && !isProduction;

// Disable rate limiting in test mode or when explicitly disabled for local pilot
function rateLimitConfig(windowMs, max) {
  if (isTest || DISABLE_RATE_LIMIT) {
    return {
      windowMs: 1000, // 1 second (minimum valid value)
      max: 999999, // effectively unlimited
      message: { error: 'Too many requests, please try again later.' },
      standardHeaders: true,
      legacyHeaders: false,
    };
  }
  return {
    windowMs: windowMs,
    max: max,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  };
}

// JSON body limit
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '1mb';
// LOCAL-PILOT-FIX-1: uploads are base64 JSON, which inflates files by ~4/3.
// A 34mb body limit accepts files up to UPLOAD_MAX_FILE_MB (25 MB) once the
// base64 inflation and JSON envelope are accounted for. Keep both in sync if
// either is overridden via environment.
const UPLOAD_BODY_LIMIT = process.env.UPLOAD_BODY_LIMIT || '34mb';
const UPLOAD_MAX_FILE_MB = (() => {
  const value = parseInt(process.env.UPLOAD_MAX_FILE_MB || '25', 10);
  return isNaN(value) || value < 1 ? 25 : value;
})();

// Helmet CSP configuration
const CSP_REPORT_ONLY = process.env.CSP_REPORT_ONLY === 'true';
const CSP_DIRECTIVES = process.env.CSP_DIRECTIVES ? JSON.parse(process.env.CSP_DIRECTIVES) : {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"], // Needed for some inline styles
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'"].concat(CORS_ORIGINS.length > 0 ? CORS_ORIGINS : []),
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
};

// OAuth configuration
const OAUTH_STAFF_ENABLED = process.env.OAUTH_STAFF_ENABLED === 'true';
const OAUTH_CLIENT_ENABLED = process.env.OAUTH_CLIENT_ENABLED === 'true'; // deferred
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || '';
const OAUTH_REQUIRE_VERIFIED_EMAIL = process.env.OAUTH_REQUIRE_VERIFIED_EMAIL !== 'false'; // default true
const OAUTH_ALLOWED_DOMAINS = (() => {
  const domains = process.env.OAUTH_ALLOWED_DOMAINS || '';
  if (!domains) return null; // no domain restriction
  return domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
})();

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/api/auth/oauth/google/callback`;

// Microsoft OAuth
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'common';
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || `${BASE_URL}/api/auth/oauth/microsoft/callback`;

module.exports = {
  isProduction,
  isTest,
  nodeEnv: process.env.NODE_ENV || 'development',
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_ALGORITHM,
  JWT_ISSUER,
  JWT_AUDIENCE,
  PORT,
  CORS_ORIGINS,
  DATABASE_PATH,
  BACKUP_DIR,
  BACKUP_LOG,
  BACKUP_RETENTION_COUNT,
  BACKUP_KEY,
  CONNECTED_ACCOUNTS_TOKEN_KEY,
  BASE_URL,
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_PASSWORD,
  SEED_ADMIN_NAME,
  PASSWORD_MIN_LENGTH,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  AUTH_RATE_LIMIT_WINDOW_MS,
  AUTH_RATE_LIMIT_MAX,
  DISABLE_RATE_LIMIT,
  JSON_BODY_LIMIT,
  UPLOAD_BODY_LIMIT,
  UPLOAD_MAX_FILE_MB,
  CSP_REPORT_ONLY,
  CSP_DIRECTIVES,
  rateLimitConfig,
  OAUTH_STAFF_ENABLED,
  OAUTH_CLIENT_ENABLED,
  OAUTH_STATE_SECRET,
  OAUTH_REQUIRE_VERIFIED_EMAIL,
  OAUTH_ALLOWED_DOMAINS,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  MICROSOFT_TENANT_ID,
  MICROSOFT_REDIRECT_URI,
};
