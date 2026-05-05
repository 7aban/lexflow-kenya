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

// Base URL for invitations/reminders
const BASE_URL = process.env.BASE_URL || (isProduction ? '' : 'http://localhost:5000');

// Seed admin configuration
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@lexflow.co.ke';
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || (isTest ? 'test-password' : (isProduction ? '' : 'password123'));
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin';

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || (isTest ? '0' : '900000'), 10); // 15 min default
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || (isTest ? '999999' : '100'), 10); // 100 requests per window
const AUTH_RATE_LIMIT_WINDOW_MS = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || (isTest ? '0' : '900000'), 10); // 15 min
const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX || (isTest ? '999999' : '5'), 10); // 5 attempts per 15 min

// Disable rate limiting in test mode
function rateLimitConfig(windowMs, max) {
  if (isTest) {
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
const UPLOAD_BODY_LIMIT = process.env.UPLOAD_BODY_LIMIT || '10mb';

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
  BASE_URL,
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_PASSWORD,
  SEED_ADMIN_NAME,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  AUTH_RATE_LIMIT_WINDOW_MS,
  AUTH_RATE_LIMIT_MAX,
  JSON_BODY_LIMIT,
  UPLOAD_BODY_LIMIT,
  CSP_REPORT_ONLY,
  CSP_DIRECTIVES,
  rateLimitConfig,
};
