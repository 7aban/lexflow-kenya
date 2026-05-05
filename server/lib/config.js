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

module.exports = {
  isProduction,
  isTest,
  nodeEnv: process.env.NODE_ENV || 'development',
  JWT_SECRET,
  PORT,
  CORS_ORIGINS,
  DATABASE_PATH,
  BACKUP_DIR,
  BACKUP_LOG,
  BASE_URL,
};
