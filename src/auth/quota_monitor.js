import { log } from '../utils/logger.js';
import quotaManager from './quota_manager.js';
import fs from 'fs';

/**
 * 额度监控器
 * 功能：
 * 1. 每 30 分钟检查所有凭证的额度
 * 2. 如果凭证在过去 30 分钟内未使用，允许跳过检查，但单个凭证最多连续跳过 5 小时
 * 3. 当某个模型的剩余额度 ≤ 5% 时，自动禁用该凭证对该模型的调用
 */
class QuotaMonitor {
  constructor(tokenManager, accountsFilePath) {
    this.tokenManager = tokenManager;
    this.accountsFilePath = accountsFilePath;
    this.intervalId = null;
    this.checkInterval = 30 * 60 * 1000; // 30 分钟
    this.maxSkipMs = 5 * 60 * 60 * 1000; // 最多连续跳过 5 小时
    this.quotaThreshold = 0.05; // 5% 阈值
    this.isChecking = false;

    // 内存缓存：存储每个凭证的额度信息
    // key: projectId（若缺失则回退到 refresh_token）
    // value: { models: {...}, lastCheck: timestamp, lastUsed: timestamp }
    this.quotaCache = new Map();

    log.info('QuotaMonitor 初始化完成');
  }

  /**
   * 启动定时监控
   */
  start() {
    if (this.intervalId) {
      log.warn('QuotaMonitor 已经在运行中');
      return;
    }

    log.info(`QuotaMonitor 启动，检查间隔: ${this.checkInterval / 1000 / 60} 分钟`);

    // 立即执行一次初始化检查
    this.checkAllQuotas();

    // 设置定时任务
    this.intervalId = setInterval(() => {
      this.checkAllQuotas();
    }, this.checkInterval);
  }

  /**
   * 停止定时监控
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info('QuotaMonitor 已停止');
    }
  }

  /**
   * 记录凭证最后使用时间
   */
  markTokenUsed(credentialKey) {
    if (!credentialKey) return;

    const cacheEntry = this.quotaCache.get(credentialKey) || {
      models: {},
      lastCheck: 0,
      lastUsed: 0
    };

    cacheEntry.lastUsed = Date.now();
    this.quotaCache.set(credentialKey, cacheEntry);
  }

  /**
   * 检查所有凭证的额度
   */
  async checkAllQuotas() {
    if (this.isChecking) {
      log.warn('QuotaMonitor: 上一轮额度检查尚未结束，跳过本轮');
      return;
    }

    this.isChecking = true;

    try {
      if (!fs.existsSync(this.accountsFilePath)) {
        log.warn('QuotaMonitor: accounts.json 不存在，跳过检查');
        return;
      }

      const accounts = JSON.parse(fs.readFileSync(this.accountsFilePath, 'utf-8'));
      if (!Array.isArray(accounts) || accounts.length === 0) {
        log.warn('QuotaMonitor: 没有可用凭证');
        return;
      }

      const enabledAccounts = accounts.filter(acc => acc.enable !== false && acc.refresh_token);
      log.info(`QuotaMonitor: 开始检查 ${enabledAccounts.length} 个凭证的额度`);

      for (let i = 0; i < enabledAccounts.length; i++) {
        const account = enabledAccounts[i];
        const credentialKey = account.projectId || account.refresh_token;

        if (!credentialKey) {
          log.debug(`QuotaMonitor: 凭证 ${i} 缺少标识信息（projectId/refresh_token），跳过`);
          continue;
        }

        // 检查是否需要跳过此次检查
        if (this.shouldSkipCheck(credentialKey)) {
          log.debug(`QuotaMonitor: 凭证 ${credentialKey} 长时间未使用，跳过检查`);
          continue;
        }

        // 执行额度检查
        await this.checkQuotaForAccount(account);
      }

      log.info('QuotaMonitor: 本轮额度检查完成');
    } catch (error) {
      log.error('QuotaMonitor: 检查额度时发生错误:', error.message);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * 判断是否应该跳过检查
   * 规则：
   * 1. 如果凭证在过去 30 分钟内被使用过，不跳过
   * 2. 如果上次检查距今已超过 5 小时，不跳过
   * 3. 否则，跳过
   */
  shouldSkipCheck(credentialKey) {
    const cacheEntry = this.quotaCache.get(credentialKey);
    if (!cacheEntry) return false;

    const now = Date.now();
    const lastUsed = cacheEntry.lastUsed || 0;
    const lastCheck = cacheEntry.lastCheck || 0;

    const hasBeenUsedRecently = lastUsed > 0 && now - lastUsed < this.checkInterval;

    if (hasBeenUsedRecently) {
      return false; // 最近使用过，不跳过
    }

    if (!lastCheck) {
      return false; // 没有检查记录，不跳过
    }

    const checkedRecentlyEnough = now - lastCheck < this.maxSkipMs;
    return checkedRecentlyEnough;
  }

  /**
   * 检查单个账户的额度
   */
  async checkQuotaForAccount(account) {
    const projectId = account.projectId;
    const refreshToken = account.refresh_token;
    const credentialKey = projectId || refreshToken;

    try {
      // 调用 quota_manager 获取额度
      const quotaResult = await quotaManager.getQuotas(refreshToken, account);

      if (!quotaResult || !quotaResult.models) {
        log.warn(`QuotaMonitor: 凭证 ${credentialKey || projectId || 'unknown'} 获取额度失败`);
        return;
      }

      // 更新缓存
      const lastUsed = this.quotaCache.get(credentialKey)?.lastUsed || 0;
      this.quotaCache.set(credentialKey, {
        models: quotaResult.models,
        lastCheck: Date.now(),
        lastUsed
      });

      // 检查每个模型的额度
      const disabledModels = Array.isArray(account.disabledModels) ? [...account.disabledModels] : [];
      let hasChanges = false;

      for (const [modelName, modelInfo] of Object.entries(quotaResult.models)) {
        const remaining = modelInfo.remaining || 0;

        // 如果剩余额度 <= 5%，且该模型未被禁用
        if (remaining <= this.quotaThreshold && !disabledModels.includes(modelName)) {
          log.warn(
            `QuotaMonitor: 凭证 ${credentialKey || projectId || 'unknown'} 的模型 ${modelName} 额度不足 (${(remaining * 100).toFixed(2)}%)，自动禁用该模型`
          );

          disabledModels.push(modelName);
          hasChanges = true;
        }
        // 如果额度恢复到 > 5%，且该模型已被禁用，自动启用
        else if (remaining > this.quotaThreshold && disabledModels.includes(modelName)) {
          log.info(
            `QuotaMonitor: 凭证 ${credentialKey || projectId || 'unknown'} 的模型 ${modelName} 额度已恢复 (${(remaining * 100).toFixed(2)}%)，自动启用该模型`
          );

          const index = disabledModels.indexOf(modelName);
          disabledModels.splice(index, 1);
          hasChanges = true;
        }
      }

      // 如果有变更，保存到文件
      if (hasChanges) {
        this.updateAccountDisabledModels(refreshToken, disabledModels);
      }
    } catch (error) {
      log.error(`QuotaMonitor: 检查凭证 ${credentialKey || projectId || 'unknown'} 额度失败:`, error.message);
    }
  }

  /**
   * 更新账户的禁用模型列表
   */
  updateAccountDisabledModels(refreshToken, disabledModels) {
    try {
      const accounts = JSON.parse(fs.readFileSync(this.accountsFilePath, 'utf-8'));

      const accountIndex = accounts.findIndex(acc => acc?.refresh_token === refreshToken);
      if (accountIndex === -1) {
        log.warn('QuotaMonitor: 更新禁用模型列表失败，未找到对应凭证');
        return;
      }

      accounts[accountIndex].disabledModels = disabledModels;
      fs.writeFileSync(this.accountsFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

      // 同步更新 tokenManager 的内存数据
      const token = this.tokenManager.tokens.find(t => t.refresh_token === refreshToken);
      if (token) {
        token.disabledModels = disabledModels;
      }

      log.info(
        `QuotaMonitor: 已更新凭证 ${accounts[accountIndex].projectId || refreshToken} 的禁用模型列表: ${JSON.stringify(disabledModels)}`
      );
    } catch (error) {
      log.error('QuotaMonitor: 更新禁用模型列表失败:', error.message);
    }
  }

  /**
   * 获取指定凭证的额度信息（从缓存）
   */
  getQuotaFromCache(projectId) {
    return this.quotaCache.get(projectId);
  }

  /**
   * 检查凭证的某个模型是否可用
   * @param {string} projectId - 凭证的 projectId
   * @param {string} modelName - 模型名称
   * @returns {boolean} - 是否可用
   */
  isModelAvailable(projectId, modelName) {
    const quotaInfo = this.quotaCache.get(projectId);
    if (!quotaInfo || !quotaInfo.models) return true; // 没有缓存数据时默认可用

    const modelQuota = quotaInfo.models[modelName];
    if (!modelQuota) return true; // 没有该模型的额度数据时默认可用

    const remaining = modelQuota.remaining || 0;
    return remaining > this.quotaThreshold;
  }
}

export default QuotaMonitor;
