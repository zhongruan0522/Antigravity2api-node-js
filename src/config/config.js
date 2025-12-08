import dotenv from 'dotenv';
import fs from 'fs';
import log from '../utils/logger.js';
import {
  loadDataConfig,
  saveDataConfig,
  getEffectiveConfig as getEffectiveDataConfig,
  isDockerOnlyKey,
  getDockerOnlyKeys
} from './dataConfig.js';

const envPath = '.env';
const defaultEnv = `# 服务器配置
PORT=8045
HOST=0.0.0.0

# API 配置
API_URL=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse
API_MODELS_URL=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels
API_NO_STREAM_URL=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent
API_HOST=daily-cloudcode-pa.sandbox.googleapis.com
API_USER_AGENT=antigravity/1.11.3 windows/amd64

# 默认参数
DEFAULT_TEMPERATURE=1
DEFAULT_TOP_P=0.85
DEFAULT_TOP_K=50
DEFAULT_MAX_TOKENS=8096

# 安全配置
MAX_REQUEST_SIZE=50mb
API_KEY=sk-text

# 其他配置
USE_NATIVE_AXIOS=false
TIMEOUT=180000
# PROXY=http://127.0.0.1:7897
MAX_IMAGES=10 # 最大保存的图片数量，超过就会删除时间最早的
# IMAGE_BASE_URL=http://your-domain.com  # 可选：自定义图片访问基础 URL，默认使用宿主机 IP 或本地回环
CREDENTIAL_MAX_USAGE_PER_HOUR=20
RETRY_STATUS_CODES=429,500
RETRY_MAX_ATTEMPTS=3

SYSTEM_INSTRUCTION=
`;

function ensureEnvFile() {
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, defaultEnv, 'utf8');
    log.info('✓ 已创建默认 .env 文件');
  }
}

// 按你的要求：
// - PANEL_USER / PANEL_PASSWORD / API_KEY 仅能从 Docker 环境变量读取，必须配置且不支持热更新
// - 其余所有配置项都以 /data/config.json 为主，并支持热更新
function loadConfigFromEnv() {
  // getEffectiveDataConfig 已经把 DOCKER_ONLY_KEYS 从环境变量注入进来了
  const flat = getEffectiveDataConfig();

  const config = {
    server: {
      port: parseInt(flat.PORT ?? 8045, 10) || 8045,
      host: flat.HOST || '0.0.0.0'
    },
    imageBaseUrl: flat.IMAGE_BASE_URL || null,
    maxImages: parseInt(flat.MAX_IMAGES ?? 10, 10) || 10,
    api: {
      url:
        flat.API_URL ||
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      modelsUrl:
        flat.API_MODELS_URL ||
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
      noStreamUrl:
        flat.API_NO_STREAM_URL ||
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
      host: flat.API_HOST || 'daily-cloudcode-pa.sandbox.googleapis.com',
      userAgent: flat.API_USER_AGENT || 'antigravity/1.11.3 windows/amd64'
    },
    defaults: {
      temperature:
        parseFloat(flat.DEFAULT_TEMPERATURE ?? 1) || 1,
      top_p:
        parseFloat(flat.DEFAULT_TOP_P ?? 0.85) || 0.85,
      top_k:
        parseInt(flat.DEFAULT_TOP_K ?? 50, 10) || 50,
      max_tokens:
        parseInt(flat.DEFAULT_MAX_TOKENS ?? 8096, 10) || 8096
    },
    security: {
      maxRequestSize: flat.MAX_REQUEST_SIZE || '50mb',
      // 安全：API_KEY 永远只从环境变量（Docker 设置）读取
      apiKey: flat.API_KEY || null
    },
    credentials: {
      maxUsagePerHour:
        parseInt(flat.CREDENTIAL_MAX_USAGE_PER_HOUR, 10) || 20
    },
    retry: {
      statusCodes: (flat.RETRY_STATUS_CODES || '429,500')
        .split(',')
        .map(code => parseInt(String(code).trim(), 10))
        .filter(code => !Number.isNaN(code)),
      maxAttempts:
        parseInt(flat.RETRY_MAX_ATTEMPTS ?? 3, 10) || 3
    },
    useNativeAxios: String(flat.USE_NATIVE_AXIOS).toLowerCase() !== 'false',
    timeout: parseInt(flat.TIMEOUT ?? 30000, 10) || 30000,
    proxy: flat.PROXY || null,
    systemInstruction: flat.SYSTEM_INSTRUCTION || '',
    resourceManagerApiUrl:
      flat.RESOURCE_MANAGER_API_URL ||
      'https://cloudresourcemanager.googleapis.com',
    oauth: {
      clientId:
        flat.GOOGLE_CLIENT_ID ||
        '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
      clientSecret:
        flat.GOOGLE_CLIENT_SECRET ||
        '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'
    },
    logging: {
      requestLogFile: flat.REQUEST_LOG_FILE || null,
      requestLogDetailDir: flat.REQUEST_LOG_DETAIL_DIR || null,
      requestLogMaxItems:
        parseInt(flat.REQUEST_LOG_MAX_ITEMS ?? 200, 10) || 200,
      requestLogRetentionDays:
        parseInt(flat.REQUEST_LOG_RETENTION_DAYS ?? 7, 10) || 7,
      requestLogLevel: flat.REQUEST_LOG_LEVEL || 'all'
    },
    // 面板账号相关：仅从 Docker 环境变量读取，启动时在 server 里强制校验
    panelUser: flat.PANEL_USER || null,
    panelPassword: flat.PANEL_PASSWORD || null
  };

  return config;
}

function parseEnvLines(content) {
  const lines = content.split(/\r?\n/);
  const keyIndexMap = new Map();

  lines.forEach((line, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) {
      keyIndexMap.set(match[1], index);
    }
  });

  return { lines, keyIndexMap };
}

function writeEnvFile(lines) {
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function stringifyEnvValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

// 设置页热更新：
// - 所有非 Docker 专用项写入 /data/config.json
// - 同时把这些值同步到 process.env，方便设置页展示“当前环境变量值”，但不会改变优先级
export function updateEnvValues(updates = {}) {
  const dataConfigUpdates = {};

  Object.entries(updates).forEach(([key, value]) => {
    if (isDockerOnlyKey(key)) {
      // Docker 专用配置项不允许通过面板修改
      log.warn(`跳过 Docker 专用配置项: ${key}`);
      return;
    }

    dataConfigUpdates[key] = value;
  });

  if (Object.keys(dataConfigUpdates).length > 0) {
    try {
      saveDataConfig(dataConfigUpdates);

      // 同步到当前进程的 process.env（仅用于展示，不参与优先级决策）
      Object.entries(dataConfigUpdates).forEach(([key, value]) => {
        if (value === '' || value === null || value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = String(value);
        }
      });
    } catch (error) {
      log.error('保存配置失败:', error.message);
      throw error;
    }
  }

  return reloadConfigFromEnv();
}

ensureEnvFile();
dotenv.config();

let config = loadConfigFromEnv();

export function reloadConfigFromEnv() {
  config = loadConfigFromEnv();
  log.info('✓ 配置已重新加载');
  return config;
}

log.info('✓ 配置加载成功');

export default config;
