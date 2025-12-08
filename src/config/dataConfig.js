import fs from 'fs';
import path from 'path';
import log from '../utils/logger.js';

const DATA_DIR = './data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 默认配置结构
const DEFAULT_DATA_CONFIG = {
  // 服务器配置
  PORT: 8045,
  HOST: '0.0.0.0',

  // API 配置
  API_URL: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  API_MODELS_URL: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  API_NO_STREAM_URL: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
  API_HOST: 'daily-cloudcode-pa.sandbox.googleapis.com',
  API_USER_AGENT: 'antigravity/1.11.3 windows/amd64',

  // 默认参数
  DEFAULT_TEMPERATURE: 1,
  DEFAULT_TOP_P: 0.85,
  DEFAULT_TOP_K: 50,
  DEFAULT_MAX_TOKENS: 8096,

  // 安全配置
  MAX_REQUEST_SIZE: '50mb',

  // 其他配置
  USE_NATIVE_AXIOS: false,
  TIMEOUT: 180000,
  MAX_IMAGES: 10,
  IMAGE_BASE_URL: '',
  CREDENTIAL_MAX_USAGE_PER_HOUR: 20,
  RETRY_STATUS_CODES: '429,500',
  RETRY_MAX_ATTEMPTS: 3,
  SYSTEM_INSTRUCTION: '',
  PROXY: ''
};

// 环境变量优先级配置（这些只能在 Docker 环境变量中设置）
const DOCKER_ONLY_KEYS = [
  'PANEL_USER',
  'PANEL_PASSWORD',
  'API_KEY'
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log.info('✓ 已创建 data 目录');
  }
}

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_DATA_CONFIG, null, 2), 'utf8');
    log.info('✓ 已创建默认 data/config.json 文件');
  }
}

function loadDataConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      ensureDataDir();
      ensureConfigFile();
      return DEFAULT_DATA_CONFIG;
    }

    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(content);
    log.info('✓ 已加载 data/config.json 配置');
    return { ...DEFAULT_DATA_CONFIG, ...config };
  } catch (error) {
    log.error('读取 data/config.json 失败:', error.message);
    return DEFAULT_DATA_CONFIG;
  }
}

function saveDataConfig(config) {
  try {
    ensureDataDir();
    const mergedConfig = { ...loadDataConfig(), ...config };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(mergedConfig, null, 2), 'utf8');
    log.info('✓ 已将配置保存到 data/config.json');
    return mergedConfig;
  } catch (error) {
    log.error('保存 data/config.json 失败:', error.message);
    throw error;
  }
}

// 生效配置：
// - 普通项：始终以 /data/config.json 为准（支持热更新）
// - DOCKER_ONLY_KEYS：仅从 Docker 环境变量读取，不写入 /data/config.json
function getEffectiveConfig() {
  const dataConfig = loadDataConfig();
  const effectiveConfig = { ...dataConfig };

  DOCKER_ONLY_KEYS.forEach(key => {
    if (process.env[key] !== undefined) {
      effectiveConfig[key] = process.env[key];
    } else {
      // 未设置则从生效配置中移除，启动阶段会强制校验
      delete effectiveConfig[key];
    }
  });

  return effectiveConfig;
}

function isDockerOnlyKey(key) {
  return DOCKER_ONLY_KEYS.includes(key);
}

function getDockerOnlyKeys() {
  return DOCKER_ONLY_KEYS;
}

export {
  loadDataConfig,
  saveDataConfig,
  getEffectiveConfig,
  isDockerOnlyKey,
  getDockerOnlyKeys,
  DEFAULT_DATA_CONFIG
};
