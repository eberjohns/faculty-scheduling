import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------
// Secret Key Management
// -------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');

function getSecretKey() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(KEY_FILE)) {
      const stored = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (stored.length >= 32) return stored;
    }
    const newKey = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_FILE, newKey, 'utf8');
    return newKey;
  } catch (err) {
    // In-memory fallback if filesystem write is restricted
    return 'fallback_sec_key_' + (process.env.PORT || '5000') + '_2026';
  }
}

const SERVER_SECRET = getSecretKey();

// -------------------------------------------------------------
// Constant-Time String Comparison (Prevents Timing Attacks)
// -------------------------------------------------------------
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// -------------------------------------------------------------
// Password Hashing & Verification (scrypt with Salt)
// -------------------------------------------------------------
export function hashPassword(plainPassword) {
  if (typeof plainPassword !== 'string' || !plainPassword) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(plainPassword, storedPassword) {
  if (!storedPassword || typeof plainPassword !== 'string') {
    return { valid: false, needsUpgrade: false };
  }

  // If already hashed with scrypt
  if (typeof storedPassword === 'string' && storedPassword.startsWith('scrypt:')) {
    const parts = storedPassword.split(':');
    if (parts.length === 3) {
      const [, salt, expectedHash] = parts;
      try {
        const computed = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
        const valid = safeCompare(expectedHash, computed);
        return { valid, needsUpgrade: false };
      } catch (err) {
        return { valid: false, needsUpgrade: false };
      }
    }
  }

  // Transparent backward compatibility: if stored as plain text, safely compare
  // and flag for automatic inline upgrade
  const valid = safeCompare(plainPassword, String(storedPassword));
  return { valid, needsUpgrade: valid };
}

// -------------------------------------------------------------
// AES-256-GCM Reversible Encryption for Department Passcodes
// -------------------------------------------------------------
const DEPT_ENC_KEY = crypto.scryptSync(SERVER_SECRET, 'timetable_dept_passcode_salt', 32);

export function encryptDeptPasscode(plainText) {
  if (typeof plainText !== 'string' || !plainText) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DEPT_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptDeptPasscode(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return '';
  if (!cipherText.startsWith('enc:')) {
    // Legacy plaintext stored password
    return cipherText;
  }
  const parts = cipherText.split(':');
  if (parts.length !== 4) return cipherText;
  try {
    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', DEPT_ENC_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (err) {
    return '';
  }
}

export function verifyDeptPassword(plainPassword, storedCipherOrPlain) {
  if (!storedCipherOrPlain || typeof plainPassword !== 'string') {
    return { valid: false, needsUpgrade: false };
  }
  if (typeof storedCipherOrPlain === 'string' && storedCipherOrPlain.startsWith('enc:')) {
    const decrypted = decryptDeptPasscode(storedCipherOrPlain);
    const valid = safeCompare(plainPassword, decrypted);
    return { valid, needsUpgrade: false };
  }
  // If stored as legacy plain text:
  const valid = safeCompare(plainPassword, String(storedCipherOrPlain));
  return { valid, needsUpgrade: valid };
}

// -------------------------------------------------------------
// Cryptographically Signed Session Tokens (HMAC-SHA256)
// -------------------------------------------------------------
export function generateToken(payload) {
  const role = payload.role || 'user';
  const dept = Buffer.from(payload.departmentName || '', 'utf8').toString('base64url');
  const exp = payload.exp || (Date.now() + 7 * 24 * 60 * 60 * 1000); // 7-day session
  const data = `v1.${role}.${dept}.${exp}`;
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  // Support legacy static tokens during graceful transition
  if (token === 'admin-token') {
    return { role: 'admin', legacy: true };
  }
  if (token.startsWith('dept-token-')) {
    const deptName = token.substring('dept-token-'.length);
    return { role: 'department', departmentName: deptName, legacy: true };
  }

  // Parse v1 signed token
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;

  const [v, role, deptEncoded, expStr, sig] = parts;
  const data = `${v}.${role}.${deptEncoded}.${expStr}`;
  const expectedSig = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('base64url');

  if (!safeCompare(sig, expectedSig)) return null;

  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Date.now() > exp) return null;

  let departmentName = '';
  try {
    departmentName = Buffer.from(deptEncoded, 'base64url').toString('utf8');
  } catch (e) {
    departmentName = '';
  }

  return {
    role,
    departmentName: departmentName || undefined
  };
}

// -------------------------------------------------------------
// Rate Limiters
// -------------------------------------------------------------
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 login attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts from this IP address. Please wait 15 minutes before trying again.'
  }
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 600, // 600 requests per minute per IP (generous for multi-tab auto-sync)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please slow down.'
  }
});

// -------------------------------------------------------------
// Input Sanitization (Prevents Prototype Pollution & Null Bytes)
// -------------------------------------------------------------
export function sanitizeString(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/\0/g, '').trim();
}

export function sanitizeExcelRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    if (Array.isArray(row)) {
      return row.map(cell => {
        if (typeof cell === 'string') {
          const trimmed = cell.trim();
          if (trimmed === '__proto__' || trimmed === 'constructor' || trimmed === 'prototype') return '';
          return sanitizeString(cell);
        }
        return cell;
      });
    }
    const clean = {};
    for (const key of Object.keys(row)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const cleanKey = String(key).replace(/\0/g, '');
      const val = row[key];
      clean[cleanKey] = (typeof val === 'string') ? sanitizeString(val) : val;
    }
    return clean;
  });
}
