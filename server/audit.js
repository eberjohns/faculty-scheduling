import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logs directory at repository root
const LOGS_DIR = path.resolve(__dirname, '..', 'logs');
const ACTIVE_LOG_FILE = path.join(LOGS_DIR, 'audit.log');

// Log rotation & retention policies
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_ARCHIVED_FILES = 10;              // Retain at most 10 rotated log files (~50MB max)
const MAX_RETENTION_DAYS = 30;              // Purge rotated archives older than 30 days
const MEMORY_BUFFER_LIMIT = 1000;           // Keep last 1,000 entries in RAM for instant UI rendering

// In-memory ring buffer of recent audit entries (newest first)
let recentAuditLogs = [];
let isRotating = false;

// Ensure logs directory exists
export function ensureLogsDir() {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[AuditLogger] Could not create logs directory:', err.message);
  }
}

// Extract Client IP from Express request
export function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

// Initialize Audit Logger on server startup
export function initAuditLogger() {
  ensureLogsDir();

  // Load the most recent entries from audit.log into memory buffer
  try {
    if (fs.existsSync(ACTIVE_LOG_FILE)) {
      const content = fs.readFileSync(ACTIVE_LOG_FILE, 'utf8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      
      const loaded = [];
      // Read up to MEMORY_BUFFER_LIMIT lines from the tail
      const tail = lines.slice(-MEMORY_BUFFER_LIMIT);
      tail.forEach(line => {
        try {
          const parsed = JSON.parse(line);
          loaded.unshift(parsed); // newest first
        } catch (e) {
          // ignore corrupted lines
        }
      });
      recentAuditLogs = loaded.slice(0, MEMORY_BUFFER_LIMIT);
    }
  } catch (err) {
    console.warn('[AuditLogger] Notice during log buffer priming:', err.message);
  }

  // Prune any stale rotated log files on boot
  pruneLogFiles();
  console.log(`[AuditLogger] Audit logging active. Logs stored in: ${LOGS_DIR}`);
}

// Log a structured audit event
export function logAudit({
  action,
  category = 'SYSTEM',
  actor = '',
  user = '',
  role = '',
  details = '',
  ip = '127.0.0.1',
  status = 'SUCCESS',
  metadata = {}
}) {
  ensureLogsDir();

  const resolvedActor = String(actor || user || 'system');
  const resolvedRole = String(role || (resolvedActor === 'admin' ? 'ADMIN' : (resolvedActor === 'system' ? 'SYSTEM' : 'COORDINATOR'))).toUpperCase();

  const entry = {
    id: `aud_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    action: String(action || 'UNKNOWN').toUpperCase(),
    category: String(category || 'SYSTEM').toUpperCase(),
    actor: resolvedActor,
    role: resolvedRole,
    ip: String(ip || '127.0.0.1'),
    status: String(status || 'SUCCESS').toUpperCase(), // SUCCESS, WARNING, FAILURE
    details: String(details || ''),
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  };

  // 1. Prepend to in-memory buffer
  recentAuditLogs.unshift(entry);
  if (recentAuditLogs.length > MEMORY_BUFFER_LIMIT) {
    recentAuditLogs.pop();
  }

  // 2. Append to active audit.log file asynchronously
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(ACTIVE_LOG_FILE, line, 'utf8', (err) => {
    if (err) {
      console.warn('[AuditLogger] Failed to write audit log entry:', err.message);
      return;
    }
    // Check file size for rotation
    checkAndRotate();
  });

  return entry;
}

// Check active log size and trigger rotation if threshold exceeded
function checkAndRotate() {
  if (isRotating) return;

  try {
    if (!fs.existsSync(ACTIVE_LOG_FILE)) return;
    const stats = fs.statSync(ACTIVE_LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE_BYTES) {
      rotateLogFile();
    }
  } catch (err) {
    // Non-fatal file inspection error
  }
}

// Rotate audit.log to an archive file
export function rotateLogFile() {
  if (isRotating) return;
  isRotating = true;

  try {
    if (fs.existsSync(ACTIVE_LOG_FILE)) {
      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const archivePath = path.join(LOGS_DIR, `audit_${dateStr}.log`);

      fs.renameSync(ACTIVE_LOG_FILE, archivePath);
      // Create empty fresh audit.log
      fs.writeFileSync(ACTIVE_LOG_FILE, '', 'utf8');

      console.log(`[AuditLogger] Rotated log file to: ${path.basename(archivePath)}`);
      pruneLogFiles();
    }
  } catch (err) {
    console.error('[AuditLogger] Error during log file rotation:', err);
  } finally {
    isRotating = false;
  }
}

// Automatic pruning of archived log files based on file count and retention days
export function pruneLogFiles({ maxFiles = MAX_ARCHIVED_FILES, maxAgeDays = MAX_RETENTION_DAYS } = {}) {
  try {
    ensureLogsDir();
    if (!fs.existsSync(LOGS_DIR)) return { prunedCount: 0, retainedCount: 0 };

    const files = fs.readdirSync(LOGS_DIR);
    // Find rotated archive files matching audit_*.log
    const archives = files
      .filter(f => f.startsWith('audit_') && f.endsWith('.log'))
      .map(f => {
        const fullPath = path.join(LOGS_DIR, f);
        try {
          const stats = fs.statSync(fullPath);
          return { filename: f, path: fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    let prunedCount = 0;
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    archives.forEach((file, index) => {
      const isPastRetentionAge = (now - file.mtimeMs) > maxAgeMs;
      const isBeyondCountLimit = index >= maxFiles;

      if (isPastRetentionAge || isBeyondCountLimit) {
        try {
          fs.unlinkSync(file.path);
          prunedCount++;
          console.log(`[AuditLogger] Pruned old log archive: ${file.filename}`);
        } catch (unlinkErr) {
          console.warn(`[AuditLogger] Failed to delete archive ${file.filename}:`, unlinkErr.message);
        }
      }
    });

    const retainedCount = Math.max(0, archives.length - prunedCount);
    return { prunedCount, retainedCount };
  } catch (err) {
    console.warn('[AuditLogger] Error pruning log archives:', err.message);
    return { prunedCount: 0, retainedCount: 0, error: err.message };
  }
}

// Get paginated audit logs with search, category filtering & summary statistics
export function getAuditLogs({
  limit = 50,
  offset = 0,
  search = '',
  category = '',
  status = '',
  actor = ''
} = {}) {
  const query = String(search || '').toLowerCase().trim();
  const catUpper = String(category || '').toUpperCase().trim();
  const statUpper = String(status || '').toUpperCase().trim();
  const actLower = String(actor || '').toLowerCase().trim();

  // Filter in-memory buffer
  let filtered = recentAuditLogs.filter(log => {
    if (catUpper && log.category !== catUpper) return false;
    if (statUpper && log.status !== statUpper) return false;
    if (actLower && !log.actor.toLowerCase().includes(actLower)) return false;
    if (query) {
      const matchText = `${log.action} ${log.actor} ${log.details} ${log.ip} ${log.category}`.toLowerCase();
      if (!matchText.includes(query)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  // Compute aggregate metrics
  const stats = {
    totalBuffered: recentAuditLogs.length,
    matching: total,
    authCount: recentAuditLogs.filter(l => l.category === 'AUTH').length,
    dataCount: recentAuditLogs.filter(l => l.category === 'DATA').length,
    schedulingCount: recentAuditLogs.filter(l => l.category === 'SCHEDULING').length,
    systemCount: recentAuditLogs.filter(l => l.category === 'SYSTEM').length,
    warningCount: recentAuditLogs.filter(l => l.status === 'WARNING' || l.status === 'FAILURE').length,
    diskInfo: getLogsDiskUsage()
  };

  return {
    logs: paged,
    total,
    limit,
    offset,
    stats
  };
}

// Calculate disk usage of the logs folder
export function getLogsDiskUsage() {
  try {
    ensureLogsDir();
    if (!fs.existsSync(LOGS_DIR)) return { totalBytes: 0, totalMb: '0.00', fileCount: 0 };

    const files = fs.readdirSync(LOGS_DIR);
    let totalBytes = 0;
    let logFilesCount = 0;

    files.forEach(f => {
      if (f.endsWith('.log')) {
        logFilesCount++;
        try {
          const stats = fs.statSync(path.join(LOGS_DIR, f));
          totalBytes += stats.size;
        } catch (e) {}
      }
    });

    return {
      totalBytes,
      totalMb: (totalBytes / (1024 * 1024)).toFixed(2),
      activeLogBytes: fs.existsSync(ACTIVE_LOG_FILE) ? fs.statSync(ACTIVE_LOG_FILE).size : 0,
      fileCount: logFilesCount,
      maxFileSizeBytes: MAX_LOG_SIZE_BYTES,
      maxArchivedFiles: MAX_ARCHIVED_FILES
    };
  } catch (err) {
    return { totalBytes: 0, totalMb: '0.00', fileCount: 0 };
  }
}

// Read raw active log file content for download
export function getActiveLogContent() {
  ensureLogsDir();
  if (!fs.existsSync(ACTIVE_LOG_FILE)) return '';
  return fs.readFileSync(ACTIVE_LOG_FILE, 'utf8');
}

// Clear or prune logs manually
export function manualClearLogs({ olderThanDays = 0, keepLastCount = 5 } = {}) {
  const result = pruneLogFiles({ maxFiles: keepLastCount, maxAgeDays: olderThanDays });

  // If olderThanDays is 0 and keepLastCount is 0, also reset in-memory buffer and truncate active log
  if (olderThanDays === 0 && keepLastCount === 0) {
    recentAuditLogs = [];
    try {
      if (fs.existsSync(ACTIVE_LOG_FILE)) {
        fs.writeFileSync(ACTIVE_LOG_FILE, '', 'utf8');
      }
    } catch (e) {}
  }

  logAudit({
    category: 'SYSTEM',
    action: 'LOGS_PRUNED',
    actor: 'admin',
    role: 'ADMIN',
    details: `Pruned ${result.prunedCount} archive log file(s). Retained ${result.retainedCount} file(s).`,
    status: 'SUCCESS'
  });

  return result;
}
