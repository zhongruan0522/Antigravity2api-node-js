import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import config from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_FILE = config.logging.requestLogFile
  ? path.resolve(config.logging.requestLogFile)
  : path.join(__dirname, '..', '..', 'data', 'request_logs.json');
const DETAIL_DIR = config.logging.requestLogDetailDir
  ? path.resolve(config.logging.requestLogDetailDir)
  : path.join(path.dirname(LOG_FILE), 'request_logs');

const MAX_LOGS = config.logging.requestLogMaxItems;
const RETENTION_DAYS = Math.max(1, config.logging.requestLogRetentionDays);
const LOG_RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getLogLevel() {
  const raw = (config.logging.requestLogLevel || '').toLowerCase();
  if (raw === 'off' || raw === 'error' || raw === 'all') return raw;
  return 'all';
}

function shouldLogEntry(entry) {
  const level = getLogLevel();
  if (level === 'off') return false;
  if (level === 'error') {
    const status = Number(entry?.status);
    const success = entry?.success;
    const isErrorStatus = Number.isFinite(status) && status >= 400;
    const isFailed = success === false;
    return isErrorStatus || isFailed;
  }
  return true;
}

function parseTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? null : parsed;
}

function pruneLogs(logs, now = Date.now()) {
  const cutoff = now - LOG_RETENTION_MS;
  return logs.filter(log => {
    const timestamp = parseTimestamp(log?.timestamp);
    return timestamp !== null && timestamp >= cutoff;
  });
}

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(DETAIL_DIR)) {
    fs.mkdirSync(DETAIL_DIR, { recursive: true });
  }
}

function detailFilePath(id) {
  return path.join(DETAIL_DIR, `${id}.json`);
}

function compressDetail(detail) {
  try {
    const json = JSON.stringify(detail ?? {});
    const compressed = gzipSync(Buffer.from(json, 'utf-8'));
    return { compressed: true, encoding: 'base64', data: compressed.toString('base64') };
  } catch {
    return { compressed: false, encoding: 'utf-8', data: detail };
  }
}

function decompressDetail(payload) {
  try {
    if (!payload) return null;
    if (payload.compressed && payload.encoding === 'base64' && typeof payload.data === 'string') {
      const buffer = Buffer.from(payload.data, 'base64');
      const json = gunzipSync(buffer).toString('utf-8');
      return JSON.parse(json);
    }

    return payload.data ?? payload;
  } catch {
    return null;
  }
}

function writeDetail(id, detail) {
  try {
    ensureDir();
    const payload = compressDetail(detail);
    const filePath = detailFilePath(id);
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
    const size = Buffer.byteLength(payload.data || '', 'utf-8');
    return { detailRef: path.basename(filePath), detailSize: size };
  } catch {
    return {};
  }
}

function readDetail(detailRef) {
  try {
    const filePath = path.isAbsolute(detailRef) ? detailRef : path.join(DETAIL_DIR, detailRef);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const payload = JSON.parse(raw);
    return decompressDetail(payload);
  } catch {
    return null;
  }
}

function deleteDetail(detailRef) {
  if (!detailRef) return;
  try {
    const filePath = path.isAbsolute(detailRef) ? detailRef : path.join(DETAIL_DIR, detailRef);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup errors
  }
}

function cleanupRemovedLogs(original, retained) {
  const retainedIds = new Set(retained.map(log => log.id || log.timestamp));
  original
    .filter(log => !retainedIds.has(log.id || log.timestamp))
    .forEach(log => deleteDetail(log.detailRef));
}

export function readLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const normalized = (Array.isArray(data) ? data : []).map(entry => ({
      ...entry,
      id: entry?.id || randomUUID()
    }));
    const needsIdPersist = (Array.isArray(data) ? data : []).some(entry => !entry?.id);

    let pruned = pruneLogs(normalized);
    let updated = pruned.length !== normalized.length || needsIdPersist;

    if (updated) cleanupRemovedLogs(normalized, pruned);

    if (pruned.length > MAX_LOGS) {
      const sliced = pruned.slice(-MAX_LOGS);
      cleanupRemovedLogs(pruned, sliced);
      pruned = sliced;
      updated = true;
    }

    if (updated) {
      ensureDir();
      fs.writeFileSync(LOG_FILE, JSON.stringify(pruned, null, 2));
    }

    return pruned;
  } catch {
    return [];
  }
}

export function appendLog(entry) {
  if (!entry || !shouldLogEntry(entry)) {
    return null;
  }

  const { detail, ...rest } = entry || {};
  const timestamp = rest?.timestamp || new Date().toISOString();
  const id = rest?.id || randomUUID();
  const normalizedEntry = { ...rest, id, timestamp };
  const now = parseTimestamp(timestamp) || Date.now();

  ensureDir();
  const baseLogs = pruneLogs(readLogs(), now);
  const mergedEntry = {
    ...normalizedEntry,
    ...(detail ? writeDetail(id, detail) : {})
  };

  const updated = [...baseLogs, mergedEntry];
  let sliced = updated;
  if (updated.length > MAX_LOGS) {
    sliced = updated.slice(-MAX_LOGS);
    cleanupRemovedLogs(updated, sliced);
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(sliced, null, 2));
  return mergedEntry;
}

export function getRecentLogs(limit = 200) {
  const logs = readLogs();
  const list = !limit || Number.isNaN(limit) ? logs : logs.slice(-limit);
  return list
    .reverse()
    .map(log => ({ ...log, hasDetail: Boolean(log.detailRef) }));
}

export function getLogDetail(id) {
  if (!id) return null;
  const logs = readLogs();
  const found = logs.find(log => log.id === id);
  if (!found) return null;
  const detail = found.detailRef ? readDetail(found.detailRef) : null;
  return { ...found, detail };
}

export function getUsageCountsWithinWindow(windowMs = 60 * 60 * 1000) {
  const since = Date.now() - Math.abs(windowMs);
  const summary = {};

  readLogs().forEach(log => {
    const timestamp = Date.parse(log.timestamp || '');
    if (Number.isNaN(timestamp) || timestamp < since) return;

    const key = log.projectId || '未知项目';
    if (!summary[key]) {
      summary[key] = { count: 0, success: 0, failed: 0, lastUsedAt: null };
    }

    summary[key].count += 1;
    summary[key].lastUsedAt = log.timestamp || summary[key].lastUsedAt;
    if (log.success) {
      summary[key].success += 1;
    } else {
      summary[key].failed += 1;
    }
  });

  return Object.entries(summary)
    .map(([projectId, stats]) => ({ projectId, ...stats }))
    .sort((a, b) => b.count - a.count);
}

export function getUsageCountSince(projectId, sinceTimestampMs) {
  if (!projectId) return 0;

  const since = Number.isFinite(Number(sinceTimestampMs))
    ? Number(sinceTimestampMs)
    : Date.now() - 60 * 60 * 1000;

  return readLogs().filter(log => {
    if (!log?.projectId || log.projectId !== projectId) return false;
    if (log.success === false) return false;

    const timestamp = Date.parse(log.timestamp || '');
    if (Number.isNaN(timestamp)) return false;

    return timestamp >= since;
  }).length;
}

export function getUsageSummary() {
  const logs = readLogs();
  const summary = {};

  logs.forEach(log => {
    const key = log.projectId || '未知项目';
    if (!summary[key]) {
      summary[key] = {
        total: 0,
        success: 0,
        failed: 0,
        lastUsedAt: null,
        models: new Set()
      };
    }

    summary[key].total += 1;
    summary[key].models.add(log.model || '未指定模型');
    if (log.success) {
      summary[key].success += 1;
    } else {
      summary[key].failed += 1;
    }
    summary[key].lastUsedAt = log.timestamp || summary[key].lastUsedAt;
  });

  // Convert Set to array for serialization convenience
  Object.keys(summary).forEach(key => {
    summary[key].models = Array.from(summary[key].models);
  });

  return summary;
}

export function clearLogs() {
  try {
    // 根据索引文件记录的 detailRef 做一次定向清理
    if (fs.existsSync(LOG_FILE)) {
      try {
        const raw = fs.readFileSync(LOG_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          data.forEach(entry => {
            if (entry && entry.detailRef) {
              deleteDetail(entry.detailRef);
            }
          });
        }
      } catch {
        // 索引解析失败直接忽略，继续做兜底清理
      }

      try {
        fs.unlinkSync(LOG_FILE);
      } catch {
        // 索引删除失败不影响后续清理
      }
    }

    // 兜底：清空详情目录中的所有文件，防止历史残留
    if (fs.existsSync(DETAIL_DIR)) {
      try {
        const files = fs.readdirSync(DETAIL_DIR);
        files.forEach(name => {
          const filePath = path.join(DETAIL_DIR, name);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              fs.unlinkSync(filePath);
            }
          } catch {
            // 单个文件删除失败不影响整体
          }
        });
      } catch {
        // 目录读取异常可忽略
      }
    }

    return true;
  } catch {
    return false;
  }
}

