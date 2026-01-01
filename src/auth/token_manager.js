import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { log } from '../utils/logger.js';
import { generateProjectId, generateSessionId } from '../utils/idGenerator.js';
import config from '../config/config.js';
import { getUsageCountSince } from '../utils/log_store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

function getTokenSuffix(token) {
  const accessToken = token?.access_token;
  if (typeof accessToken === 'string' && accessToken.length) {
    return accessToken.slice(-8);
  }

  const refreshToken = token?.refresh_token;
  if (typeof refreshToken === 'string' && refreshToken.length) {
    return refreshToken.slice(-8);
  }

  return 'unknown';
}

class TokenManager {
  constructor(filePath = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    this.hourlyLimit = Number.isFinite(Number(config.credentials?.maxUsagePerHour))
      ? Number(config.credentials.maxUsagePerHour)
      : 20;
    this.quotaMonitor = null; // 额度监控器实例（将在 server 初始化时注入）
    this.initialize();
  }

  ensureDataFile() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]', 'utf8');
      log.warn(`未找到账号文件，已创建空文件: ${this.filePath}`);
    }
  }

  setHourlyLimit(limit) {
    if (!Number.isFinite(Number(limit))) return;
    this.hourlyLimit = Number(limit);
  }

  /**
   * 注入额度监控器实例
   */
  setQuotaMonitor(monitor) {
    this.quotaMonitor = monitor;
    log.info('QuotaMonitor 已注入到 TokenManager');
  }

  /**
   * 检查 token 的某个模型是否被禁用
   * @param {Object} token - token 对象
   * @param {string} modelName - 模型名称（如 "gemini-2.0-flash-exp"）
   * @returns {boolean} - 是否被禁用
   */
  isModelDisabled(token, modelName) {
    if (!token || !modelName) return false;
    const disabledModels = token.disabledModels || [];
    return disabledModels.includes(modelName);
  }

  isWithinHourlyLimit(token) {
    if (!this.hourlyLimit || Number.isNaN(this.hourlyLimit)) return true;

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const usage = getUsageCountSince(token.projectId, oneHourAgo);

    if (usage >= this.hourlyLimit) {
      log.warn(
        `账号 ${token.projectId || '未知'} 已达到每小时 ${this.hourlyLimit} 次上限，切换下一个账号`
      );
      return false;
    }

    return true;
  }

  moveToNextToken() {
    if (this.tokens.length === 0) {
      this.currentIndex = 0;
      return;
    }
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
  }

  initialize() {
    try {
      log.info('正在初始化token管理器...');
      this.ensureDataFile();

      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data || '[]');
      const tokenArray = Array.isArray(parsed) ? parsed : [];

      this.tokens = tokenArray.filter(token => token.enable !== false).map(token => ({
        ...token,
        sessionId: generateSessionId(),
        disabledModels: token.disabledModels || [] // 初始化禁用模型列表
      }));
      this.currentIndex = 0;
      log.info(`成功加载 ${this.tokens.length} 个可用token`);
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  async fetchProjectId(token) {
    const response = await axios({
      method: 'POST',
      url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
      headers: {
        'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
        'User-Agent': 'antigravity/1.11.9 windows/amd64',
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      timeout: config.timeout,
      proxy: config.proxy ? (() => {
        const proxyUrl = new URL(config.proxy);
        return { protocol: proxyUrl.protocol.replace(':', ''), host: proxyUrl.hostname, port: parseInt(proxyUrl.port) };
      })() : false
    });
    return response.data?.cloudaicompanionProject;
  }

  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - 300000;
  }

  async refreshToken(token) {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    try {
      const response = await axios({
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        data: body.toString(),
        timeout: config.timeout,
        proxy: config.proxy ? (() => {
          const proxyUrl = new URL(config.proxy);
          return { protocol: proxyUrl.protocol.replace(':', ''), host: proxyUrl.hostname, port: parseInt(proxyUrl.port) };
        })() : false
      });

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile();
      return token;
    } catch (error) {
      throw { statusCode: error.response?.status, message: error.response?.data || error.message };
    }
  }

  saveToFile() {
    try {
      this.ensureDataFile();
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);

      this.tokens.forEach(memToken => {
        const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
        if (index !== -1) {
          const { sessionId, ...tokenToSave } = memToken;
          allTokens[index] = tokenToSave;
        }
      });
      
      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
    } catch (error) {
      log.error('保存文件失败:', error.message);
    }
  }

  disableToken(token) {
    log.warn(`禁用token ...${getTokenSuffix(token)}`)
    token.enable = false;
    this.saveToFile();
    this.tokens = this.tokens.filter(t => t.refresh_token !== token.refresh_token);
    this.currentIndex = this.currentIndex % Math.max(this.tokens.length, 1);
  }

  async getToken(modelName = null) {
    if (this.tokens.length === 0) return null;

    let attempts = 0;
    const totalTokens = this.tokens.length;
    const effectiveModelName =
      typeof modelName === 'string' && modelName.trim() ? modelName.trim() : null;

    while (attempts < totalTokens) {
      const token = this.tokens[this.currentIndex];

      try {
        // 如果当前请求指定了模型，且该凭证对该模型已被禁用，则直接尝试下一个凭证
        if (effectiveModelName && this.isModelDisabled(token, effectiveModelName)) {
          this.moveToNextToken();
          attempts += 1;
          continue;
        }

        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }

        if (!token.projectId) {
          if (config.skipProjectIdFetch) {
            token.projectId = generateProjectId();
            this.saveToFile();
            log.info(`...${getTokenSuffix(token)}: 使用随机生成的projectId: ${token.projectId}`);
          } else {
            try {
              const projectId = await this.fetchProjectId(token);
              if (projectId === undefined) {
                log.warn(`...${getTokenSuffix(token)}: 无资格获取projectId，跳过保存`);
                this.disableToken(token);
                if (this.tokens.length === 0) return null;
                attempts += 1;
                continue;
              }
              token.projectId = projectId;
              this.saveToFile();
            } catch (error) {
              log.error(`...${getTokenSuffix(token)}: 获取projectId失败:`, error.message);
              this.moveToNextToken();
              attempts += 1;
              continue;
            }
          }
        }

        if (!this.isWithinHourlyLimit(token)) {
          this.moveToNextToken();
          attempts += 1;
          continue;
        }

        // 通知 quotaMonitor 该凭证被使用
        if (this.quotaMonitor && token.projectId) {
          this.quotaMonitor.markTokenUsed(token.projectId);
        }

        return token;
      } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 400) {
          const accountNum = this.currentIndex + 1;
          log.warn(`账号 ${accountNum}: Token 已失效或错误，已自动禁用该账号`);
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
        } else {
          log.error(`Token ${this.currentIndex + 1} 刷新失败:`, error.message);
          this.moveToNextToken();
        }
      }

      attempts += 1;
    }

    return null;
  }

  async getTokenByProjectId(projectId) {
    if (!projectId || this.tokens.length === 0) return null;

    const token = this.tokens.find(t => t.projectId === projectId && t.enable !== false);
    if (!token) return null;

    try {
      if (this.isExpired(token)) {
        await this.refreshToken(token);
      }

      // 通知 quotaMonitor 该凭证被使用
      if (this.quotaMonitor && token.projectId) {
        this.quotaMonitor.markTokenUsed(token.projectId);
      }
      return token;
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 400) {
        log.warn(`账号 ${projectId}: Token 已失效或错误，已自动禁用该账号`);
        this.disableToken(token);
        return null;
      }

      log.error(`Token ${projectId} 刷新失败:`, error.message);
      return null;
    }
  }

  disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      this.disableToken(found);
    }
  }
}
const tokenManager = new TokenManager();
export default tokenManager;
