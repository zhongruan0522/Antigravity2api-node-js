import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import tokenManager from './token_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COOLDOWNS_FILE = path.join(__dirname, '..', '..', 'data', 'model_cooldowns.json');

// 模型组定义
const MODEL_GROUPS = {
  'Claude/GPT': ['claude-sonnet-4-5-thinking', 'claude-opus-4-5-thinking', 'claude-sonnet-4-5', 'gpt-oss-120b-medium'],
  'Tab补全': ['chat_23310', 'chat_20706'],
  '香蕉绘图': ['gemini-2.5-flash-image'],
  '香蕉Pro': ['gemini-3-pro-image'],
  'Gemini其他': ['gemini-3-pro-high', 'rev19-uic3-1p', 'gemini-2.5-flash', 'gemini-3-pro-low', 'gemini-2.5-flash-thinking', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']
};

// 根据模型名获取所属组
function getModelGroup(model) {
  for (const [group, models] of Object.entries(MODEL_GROUPS)) {
    if (models.includes(model)) return group;
  }
  return null;
}

// 获取组内所有模型
function getModelsInGroup(group) {
  return MODEL_GROUPS[group] || [];
}


class ModelCooldownManager {
  constructor() {
    // Map<string, Date> - key: "projectId:model"
    this.cooldownMap = new Map();
    // Map<string, NodeJS.Timeout> - timers for auto-removal
    this.timerMap = new Map();
  }

  /**
   * Initialize: load from file and restore timers
   */
  initialize() {
    try {
      const data = this.loadFromFile();
      const now = new Date();
      let expiredCount = 0;

      for (const record of data.cooldowns || []) {
        const resetTime = new Date(record.resetTimestamp);

        if (resetTime <= now) {
          expiredCount++;
          continue;
        }

        // Restore cooldown and timer
        this.setCooldownInternal(
          record.projectId,
          record.model,
          record.resetTimestamp,
          record.reason,
          false // don't save to file during initialization
        );
      }

      if (expiredCount > 0) {
        log.info(`[ModelCooldown] 已清理 ${expiredCount} 条过期的冷却记录`);
        this.saveToFile();
      }

      log.info(`[ModelCooldown] 初始化完成，当前有 ${this.cooldownMap.size} 个模型处于冷却中`);
    } catch (error) {
      log.warn('[ModelCooldown] 初始化失败:', error.message);
    }
  }

  /**
   * Build map key from projectId and model
   */
  buildKey(projectId, model) {
    return `${projectId}:${model}`;
  }

  
  /**
   * Set cooldown for a specific account's model
   * 如果模型属于某个组且该组额度为0，则禁用该组内所有模型
   */
  async setCooldown(projectId, model, resetTimestamp, reason = 'RESOURCE_EXHAUSTED', token = null) {
    const group = getModelGroup(model);
    if (group && token) {
      // 先查询额度，确认该组额度是否真的为0
      try {
        const { getModelsWithQuotas } = await import('../api/client.js');
        const quotas = await getModelsWithQuotas(token);
        const groupModels = getModelsInGroup(group);
        
        // 计算该组的平均额度
        let totalRemaining = 0;
        let count = 0;
        for (const m of groupModels) {
          if (quotas[m]) {
            totalRemaining += quotas[m].remaining || 0;
            count++;
          }
        }
        const avgRemaining = count > 0 ? totalRemaining / count : 0;
        
        if (avgRemaining > 0.01) {
          // 额度 > 1%，只是临时限流，不禁用整组
          log.info(`[ModelCooldown] 模型组 "${group}" 额度还有 ${(avgRemaining * 100).toFixed(1)}%，仅临时冷却单个模型`);
          this.setCooldownInternal(projectId, model, resetTimestamp, reason, true);
          return;
        }
        
        // 额度确实为0，禁用整个模型组
        log.info(`[ModelCooldown] 模型组 "${group}" 额度为 ${(avgRemaining * 100).toFixed(1)}%，将禁用该组所有 ${groupModels.length} 个模型`);
        for (const m of groupModels) {
          this.setCooldownInternal(projectId, m, resetTimestamp, reason, false);
        }
        this.saveToFile();
      } catch (e) {
        log.warn(`[ModelCooldown] 查询额度失败: ${e.message}，仅冷却单个模型`);
        this.setCooldownInternal(projectId, model, resetTimestamp, reason, true);
      }
    } else {
      this.setCooldownInternal(projectId, model, resetTimestamp, reason, true);
    }
  }


  /**
   * Internal method to set cooldown
   */
  setCooldownInternal(projectId, model, resetTimestamp, reason, shouldSave) {
    const key = this.buildKey(projectId, model);
    const resetTime = new Date(resetTimestamp);
    const delayMs = resetTime.getTime() - Date.now();

    // Clear existing timer if any
    if (this.timerMap.has(key)) {
      clearTimeout(this.timerMap.get(key));
      this.timerMap.delete(key);
    }

    // Store in memory
    this.cooldownMap.set(key, {
      projectId,
      model,
      resetTimestamp,
      resetTime,
      reason,
      createdAt: new Date().toISOString()
    });

    // Set timer for auto-removal
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.removeCooldown(projectId, model);
        log.info(`[ModelCooldown] 模型 ${model} 在账号 ${projectId} 上已自动解禁`);
      }, delayMs);

      // Prevent timer from keeping the process alive
      if (timer.unref) timer.unref();

      this.timerMap.set(key, timer);
      log.info(`[ModelCooldown] 已设置冷却: ${model}@${projectId}, 将于 ${resetTimestamp} 解禁 (${Math.ceil(delayMs / 1000)}秒后)`);
    } else {
      // Already expired, don't add
      this.cooldownMap.delete(key);
      log.info(`[ModelCooldown] 冷却时间已过期，跳过: ${model}@${projectId}`);
      return;
    }

    // Persist to file
    if (shouldSave) {
      this.saveToFile();
    }
  }

  /**
   * Remove cooldown for a specific account's model
   */
  removeCooldown(projectId, model) {
    const key = this.buildKey(projectId, model);

    // Clear timer
    if (this.timerMap.has(key)) {
      clearTimeout(this.timerMap.get(key));
      this.timerMap.delete(key);
    }

    // Remove from memory
    this.cooldownMap.delete(key);

    // Update file
    this.saveToFile();
  }

  /**
   * Check if a specific account's model is on cooldown
   */
  isOnCooldown(projectId, model) {
    const key = this.buildKey(projectId, model);
    const info = this.cooldownMap.get(key);

    if (!info) return false;

    // Double-check if expired
    if (info.resetTime <= new Date()) {
      this.removeCooldown(projectId, model);
      return false;
    }

    return true;
  }

  /**
   * Get cooldown info for a specific account's model
   */
  getCooldownInfo(projectId, model) {
    const key = this.buildKey(projectId, model);
    const info = this.cooldownMap.get(key);

    if (!info) return null;

    // Double-check if expired
    if (info.resetTime <= new Date()) {
      this.removeCooldown(projectId, model);
      return null;
    }

    return {
      projectId: info.projectId,
      model: info.model,
      resetTimestamp: info.resetTimestamp,
      remainingMs: info.resetTime.getTime() - Date.now(),
      reason: info.reason
    };
  }

  /**
   * Get all cooldowns (for API response)
   */
  getAllCooldowns() {
    const result = [];
    const now = new Date();

    for (const [key, info] of this.cooldownMap.entries()) {
      if (info.resetTime <= now) {
        // Expired, clean up
        const [projectId, model] = key.split(':');
        this.removeCooldown(projectId, model);
        continue;
      }

      result.push({
        projectId: info.projectId,
        model: info.model,
        resetTimestamp: info.resetTimestamp,
        remainingMs: info.resetTime.getTime() - now.getTime(),
        reason: info.reason,
        createdAt: info.createdAt
      });
    }

    return result;
  }

  /**
   * Get cooldowns for a specific account
   */
  getCooldownsForProject(projectId) {
    const result = [];
    const now = new Date();

    for (const [key, info] of this.cooldownMap.entries()) {
      if (!key.startsWith(`${projectId}:`)) continue;

      if (info.resetTime <= now) {
        this.removeCooldown(info.projectId, info.model);
        continue;
      }

      result.push({
        model: info.model,
        resetTimestamp: info.resetTimestamp,
        remainingMs: info.resetTime.getTime() - now.getTime(),
        reason: info.reason
      });
    }

    return result;
  }

  /**
   * Get an available token for a specific model
   * Returns null if no token is available
   */
  async getAvailableTokenForModel(model, excludeProjectIds = []) {
    const tokens = tokenManager.tokens || [];
    const excludeSet = new Set(excludeProjectIds);

    for (const token of tokens) {
      if (token.enable === false) continue;
      if (excludeSet.has(token.projectId)) continue;
      if (this.isOnCooldown(token.projectId, model)) continue;

      // Check if token is valid and refresh if needed
      try {
        if (tokenManager.isExpired(token)) {
          await tokenManager.refreshToken(token);
        }
        return token;
      } catch (error) {
        log.warn(`[ModelCooldown] Token ${token.projectId} 刷新失败:`, error.message);
        continue;
      }
    }

    return null;
  }

  /**
   * Load cooldowns from file
   */
  loadFromFile() {
    try {
      if (!fs.existsSync(COOLDOWNS_FILE)) {
        return { cooldowns: [] };
      }

      const content = fs.readFileSync(COOLDOWNS_FILE, 'utf8');
      return JSON.parse(content) || { cooldowns: [] };
    } catch (error) {
      log.warn('[ModelCooldown] 读取冷却文件失败:', error.message);
      return { cooldowns: [] };
    }
  }

  /**
   * Save cooldowns to file
   */
  saveToFile() {
    try {
      const dir = path.dirname(COOLDOWNS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const cooldowns = [];
      for (const info of this.cooldownMap.values()) {
        cooldowns.push({
          projectId: info.projectId,
          model: info.model,
          resetTimestamp: info.resetTimestamp,
          createdAt: info.createdAt,
          reason: info.reason
        });
      }

      fs.writeFileSync(
        COOLDOWNS_FILE,
        JSON.stringify({ cooldowns }, null, 2),
        'utf8'
      );
    } catch (error) {
      log.error('[ModelCooldown] 保存冷却文件失败:', error.message);
    }
  }

  /**
   * Clear all cooldowns (for testing/admin)
   */
  clearAll() {
    for (const timer of this.timerMap.values()) {
      clearTimeout(timer);
    }
    this.timerMap.clear();
    this.cooldownMap.clear();
    this.saveToFile();
    log.info('[ModelCooldown] 已清除所有模型冷却记录');
  }
}

const modelCooldownManager = new ModelCooldownManager();

// Initialize on module load
modelCooldownManager.initialize();

export { MODEL_GROUPS, getModelGroup, getModelsInGroup };
export default modelCooldownManager;
