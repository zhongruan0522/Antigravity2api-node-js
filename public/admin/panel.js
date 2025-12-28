const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const statusEl = document.getElementById('status');
const tomlStatusEl = document.getElementById('tomlStatus');
const listEl = document.getElementById('accountsList');
const refreshBtn = document.getElementById('refreshBtn');
const refreshAllBtn = document.getElementById('refreshAllBtn');
const logsRefreshBtn = document.getElementById('logsRefreshBtn');
const logsClearBtn = document.getElementById('logsClearBtn');
const hourlyUsageEl = document.getElementById('hourlyUsage');
const manageStatusEl = document.getElementById('manageStatus');
const callbackUrlInput = document.getElementById('callbackUrlInput');
const customProjectIdInput = document.getElementById('customProjectIdInput');
const allowRandomProjectIdCheckbox = document.getElementById('allowRandomProjectId');
const submitCallbackBtn = document.getElementById('submitCallbackBtn');
const logsEl = document.getElementById('logs');
const usageStatusEl = document.getElementById('usageStatus');
const settingsGrid = document.getElementById('settingsGrid');
const settingsStatusEl = document.getElementById('settingsStatus');
const settingsRefreshBtn = document.getElementById('settingsRefreshBtn');
const importTomlBtn = document.getElementById('importTomlBtn');
const tomlInput = document.getElementById('tomlInput');
const replaceExistingCheckbox = document.getElementById('replaceExisting');
const filterDisabledCheckbox = document.getElementById('filterDisabled');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const deleteDisabledBtn = document.getElementById('deleteDisabledBtn');
const usageRefreshBtn = document.getElementById('usageRefreshBtn');
const paginationInfo = document.getElementById('paginationInfo');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const logPaginationInfo = document.getElementById('logPaginationInfo');
const logPrevPageBtn = document.getElementById('logPrevPageBtn');
const logNextPageBtn = document.getElementById('logNextPageBtn');
const statusFilterSelect = document.getElementById('statusFilter');
const errorFilterCheckbox = document.getElementById('errorFilter');
const themeToggleBtn = document.getElementById('themeToggleBtn');

const HOUR_WINDOW_MINUTES = 60;
const HOURLY_LIMIT = 20;

const PAGE_SIZE = 5;
let accountsData = [];
let filteredAccounts = [];
let currentPage = 1;
const LOG_PAGE_SIZE = 20;
let logsData = [];
let logCurrentPage = 1;
let statusFilter = 'all';
let errorOnly = false;
const logDetailCache = new Map();

let logLevelSelect = null;
let replaceIndex = null;
let modelCooldownsData = []; // 模型冷却数据
let cooldownTimerInterval = null; // 倒计时定时器

if (window.AgTheme) {
  window.AgTheme.initTheme();
  window.AgTheme.bindThemeToggle(themeToggleBtn);
}

function setStatus(text, type = 'info', target = statusEl) {
  if (!target) return;
  if (!text) {
    target.style.display = 'none';
    return;
  }
  target.textContent = text;
  target.className = `badge badge-${type}`;
  target.style.display = 'inline-block';
}

function activateTab(target) {
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tabTarget === target);
  });
  tabPanels.forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tab === target);
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatJson(value) {
  try {
    return escapeHtml(JSON.stringify(value ?? {}, null, 2));
  } catch (e) {
    return escapeHtml(String(value));
  }
}

// 格式化剩余时间
function formatRemainingTime(remainingMs) {
  if (remainingMs <= 0) return '已解禁';
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// 获取模型冷却数据
async function fetchModelCooldowns() {
  try {
    const data = await fetchJson('/auth/model-cooldowns');
    modelCooldownsData = data.cooldowns || [];
    return modelCooldownsData;
  } catch (e) {
    console.warn('获取模型冷却数据失败:', e.message);
    return [];
  }
}

// 获取指定账号的冷却模型
function getCooldownsForProject(projectId) {
  if (!projectId || !modelCooldownsData.length) return [];
  return modelCooldownsData.filter(c => c.projectId === projectId);
}

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

// 渲染冷却模型列表（按组显示）
function renderCooldownModels(projectId) {
  const cooldowns = getCooldownsForProject(projectId);
  if (!cooldowns.length) return '';

  // 按组聚合
  const groups = {};
  const ungrouped = [];
  
  for (const c of cooldowns) {
    const group = getModelGroup(c.model);
    if (group) {
      if (!groups[group]) {
        groups[group] = { models: [], resetTimestamp: c.resetTimestamp };
      }
      groups[group].models.push(c.model);
      // 取最晚的重置时间
      if (new Date(c.resetTimestamp) > new Date(groups[group].resetTimestamp)) {
        groups[group].resetTimestamp = c.resetTimestamp;
      }
    } else {
      ungrouped.push(c);
    }
  }

  let items = '';
  
  // 渲染分组
  for (const [groupName, data] of Object.entries(groups)) {
    const remaining = new Date(data.resetTimestamp).getTime() - Date.now();
    items += `
      <div class="cooldown-item" data-reset="${escapeHtml(data.resetTimestamp)}">
        <span class="cooldown-icon">🚫</span>
        <span class="cooldown-model">${escapeHtml(groupName)} (${data.models.length}个模型)</span>
        <span class="cooldown-timer">${formatRemainingTime(remaining)}</span>
      </div>
    `;
  }
  
  // 渲染未分组的
  for (const c of ungrouped) {
    const remaining = new Date(c.resetTimestamp).getTime() - Date.now();
    items += `
      <div class="cooldown-item" data-reset="${escapeHtml(c.resetTimestamp)}">
        <span class="cooldown-icon">🚫</span>
        <span class="cooldown-model">${escapeHtml(c.model)}</span>
        <span class="cooldown-timer">${formatRemainingTime(remaining)}</span>
      </div>
    `;
  }

  return `
    <div class="cooldown-models" data-project="${escapeHtml(projectId)}">
      <div class="cooldown-header">⏳ 冷却中的模块</div>
      ${items}
    </div>
  `;
}

// 更新所有倒计时显示
function updateCooldownTimers() {
  const now = Date.now();
  document.querySelectorAll('.cooldown-item').forEach(item => {
    const resetTime = new Date(item.dataset.reset).getTime();
    const remaining = resetTime - now;
    const timerEl = item.querySelector('.cooldown-timer');
    if (timerEl) {
      if (remaining <= 0) {
        item.remove();
      } else {
        timerEl.textContent = formatRemainingTime(remaining);
      }
    }
  });

  // 更新额度卡片中的冷却倒计时
  document.querySelectorAll('.quota-cooldown').forEach(el => {
    const resetTime = new Date(el.dataset.reset).getTime();
    const remaining = resetTime - now;
    if (remaining <= 0) {
      el.remove();
    } else {
      el.textContent = `🚫 ${formatRemainingTime(remaining)}`;
    }
  });

  // 清理空的冷却容器
  document.querySelectorAll('.cooldown-models').forEach(container => {
    if (!container.querySelector('.cooldown-item')) {
      container.remove();
    }
  });
}

// 启动倒计时定时器
function startCooldownTimer() {
  if (cooldownTimerInterval) {
    clearInterval(cooldownTimerInterval);
  }
  cooldownTimerInterval = setInterval(updateCooldownTimers, 1000);
}

// 停止倒计时定时器
function stopCooldownTimer() {
  if (cooldownTimerInterval) {
    clearInterval(cooldownTimerInterval);
    cooldownTimerInterval = null;
  }
}

function getAccountDisplayName(acc) {
  if (!acc) return '未知账号';
  if (acc.email) return acc.email;
  if (acc.user_email) return acc.user_email;
  if (acc.projectId) return acc.projectId;
  if (typeof acc.index === 'number') return `账号 #${acc.index + 1}`;
  return '未知账号';
}

function renderUsageCard(account) {
  const { usage = {} } = account;
  const models = usage.models && usage.models.length > 0 ? usage.models.join(', ') : '暂无数据';
  const lastUsed = usage.lastUsedAt ? new Date(usage.lastUsedAt).toLocaleString() : '未使用';
  return `
    <div class="usage"> 
      <div class="usage-row"><span>累计调用</span><strong>${usage.total || 0}</strong></div>
      <div class="usage-row"><span>成功 / 失败</span><strong>${usage.success || 0} / ${usage.failed || 0}</strong></div>
      <div class="usage-row"><span>最近使用</span><strong>${lastUsed}</strong></div>
      <div class="usage-row"><span>使用过的模型</span><strong>${models}</strong></div>
    </div>
  `;
}

function updateFilteredAccounts() {
  filteredAccounts = accountsData.filter(acc => {
    const matchesStatus =
      statusFilter === 'all' || (statusFilter === 'enabled' && acc.enable) || (statusFilter === 'disabled' && !acc.enable);

    const failedCount = acc?.usage?.failed || 0;
    const matchesError = !errorOnly || failedCount > 0;

    return matchesStatus && matchesError;
  });

  currentPage = 1;
  renderAccountsList();
}

async function refreshAllAccountsBatch() {
  if (!accountsData.length) {
    setStatus('暂无凭证可刷新。', 'info', manageStatusEl);
    return;
  }

  if (refreshAllBtn) refreshAllBtn.disabled = true;
  setStatus('正在批量刷新凭证...', 'info', manageStatusEl);

  try {
    const { refreshed = 0, failed = 0 } = await fetchJson('/auth/accounts/refresh-all', { method: 'POST' });
    const message = `批量刷新完成：成功 ${refreshed} 个，失败 ${failed} 个。`;
    setStatus(message, failed > 0 ? 'warning' : 'success', manageStatusEl);
    await refreshAccounts();
  } catch (e) {
    setStatus('批量刷新失败: ' + e.message, 'error', manageStatusEl);
  } finally {
    if (refreshAllBtn) refreshAllBtn.disabled = false;
  }
}

function bindAccountActions() {
  document.querySelectorAll('[data-action="refresh"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      btn.disabled = true;
      setStatus('正在刷新凭证...', 'info', manageStatusEl);
      try {
        await fetchJson(`/auth/accounts/${idx}/refresh`, { method: 'POST' });
        setStatus('刷新成功', 'success', manageStatusEl);
        refreshAccounts();
      } catch (e) {
        setStatus('刷新失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="toggle"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      const enable = btn.dataset.enable === 'false';
      btn.disabled = true;
      setStatus(enable ? '正在启用账号...' : '正在停用账号...', 'info', manageStatusEl);
      try {
        await fetchJson(`/auth/accounts/${idx}/enable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable })
        });
        setStatus(enable ? '已启用账号' : '已停用账号', 'success', manageStatusEl);
        refreshAccounts();
      } catch (e) {
        setStatus('更新状态失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="delete"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      if (!confirm('确认删除这个账号吗？删除后无法恢复')) return;
      btn.disabled = true;
      setStatus('正在删除账号...', 'info', manageStatusEl);
      try {
        await fetchJson(`/auth/accounts/${idx}`, { method: 'DELETE' });
        setStatus('账号已删除', 'success', manageStatusEl);
        refreshAccounts();
      } catch (e) {
        setStatus('删除失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="reauthorize"]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      replaceIndex = Number(btn.dataset.index);
      setStatus(`请重新授权账号 #${replaceIndex + 1}，完成后粘贴新的回调 URL 提交。`, 'info', manageStatusEl);
      loginBtn?.click();
    });
  });

  document.querySelectorAll('[data-action="refreshProjectId"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      if (idx === undefined) return;

      btn.disabled = true;
      setStatus(`正在刷新账号 #${Number(idx) + 1} 的项目ID...`, 'info', manageStatusEl);

      try {
        const res = await fetch('/auth/accounts/' + idx + '/refresh-project-id', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        setStatus(
          `项目ID 已刷新为：${data.projectId || '未知'}`,
          'success',
          manageStatusEl
        );
        await refreshAccounts();
      } catch (e) {
        setStatus('刷新项目ID失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="toggleQuota"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      const projectId = btn.dataset.project;
      if (idx === undefined) return;

      const quotaSection = document.getElementById(`quota-${idx}`);
      if (!quotaSection) return;

      quotaSection.style.display = 'block';
      btn.textContent = '📊 刷新额度';
      await loadQuota(idx, true, projectId);
    });
  });
}

async function loadQuota(accountIndex, showLoading = false, projectId = null) {
  const quotaSection = document.getElementById(`quota-${accountIndex}`);
  if (!quotaSection) return;

  try {
    if (showLoading) {
      quotaSection.innerHTML = '<div class="quota-loading">加载中...</div>';
    }
    const data = await fetchJson(`/admin/tokens/${accountIndex}/quotas`, { cache: 'no-store' });
    renderQuota(quotaSection, data.data, projectId);
  } catch (e) {
    quotaSection.innerHTML = `<div class="quota-error">加载失败: ${e.message}</div>`;
  }
}

function renderQuota(container, quotaData, projectId = null) {
  if (!quotaData || !quotaData.models) {
    container.innerHTML = '<div class="quota-error">暂无额度数据</div>';
    return;
  }

  const lastUpdated = quotaData.lastUpdated ?
    new Date(quotaData.lastUpdated).toLocaleString() : '未知时间';

  // 模型分组配置
  const modelGroups = {
    'Claude/GPT': {
      models: ['claude-sonnet-4-5-thinking', 'claude-opus-4-5-thinking', 'claude-sonnet-4-5', 'gpt-oss-120b-medium'],
      icon: '🧠',
      description: 'Claude和GPT模型共享额度'
    },
    'Tab补全': {
      models: ['chat_23310', 'chat_20706'],
      icon: '📝',
      description: 'Tab补全模型'
    },
    '🍌香蕉绘图': {
      models: ['gemini-2.5-flash-image'],
      icon: '🍌',
      description: 'Gemini图像生成模型'
    },
    '香蕉Pro': {
      models: ['gemini-3-pro-image'],
      icon: '🌟',
      description: 'Gemini Pro图像生成模型'
    },
    'Gemini其他': {
      models: ['gemini-3-pro-high', 'rev19-uic3-1p', 'gemini-2.5-flash', 'gemini-3-pro-low', 'gemini-2.5-flash-thinking', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
      icon: '💎',
      description: '其他Gemini模型共享额度'
    }
  };

  // 对模型进行分组
  const groupedModels = {};
  const otherModels = [];

  // 初始化分组
  Object.keys(modelGroups).forEach(groupName => {
    groupedModels[groupName] = {
      ...modelGroups[groupName],
      modelIds: [],
      remaining: [],
      resetTime: null
    };
  });

  // 将模型分配到对应分组
  for (const [modelName, modelInfo] of Object.entries(quotaData.models)) {
    let assigned = false;

    for (const [groupName, groupConfig] of Object.entries(modelGroups)) {
      if (groupConfig.models.includes(modelName)) {
        groupedModels[groupName].modelIds.push(modelName);
        groupedModels[groupName].remaining.push(modelInfo.remaining);
        if (!groupedModels[groupName].resetTime) {
          groupedModels[groupName].resetTime = modelInfo.resetTime;
        }
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      otherModels.push({
        name: modelName,
        remaining: modelInfo.remaining,
        resetTime: modelInfo.resetTime
      });
    }
  }

  // 获取折叠状态，默认为展开
  const isCollapsed = localStorage.getItem('quota-models-collapsed') === 'true';

  let html = `
    <div class="quota-header">
      <span class="quota-title">模型额度信息（分组显示）</span>
      <div class="quota-header-actions">
        <span class="quota-updated">更新时间: ${lastUpdated}</span>
        <button class="quota-toggle-btn" data-collapsed="${isCollapsed}" type="button">
          <span class="quota-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>
          <span class="quota-toggle-text">${isCollapsed ? '展开模型' : '收起模型'}</span>
        </button>
      </div>
    </div>
    <div class="quota-groups" data-collapsed="${isCollapsed}">
  `;

  // 渲染分组模型
  for (const [groupName, groupData] of Object.entries(groupedModels)) {
    if (groupData.modelIds.length === 0) continue;

    // 计算平均剩余额度
    const avgRemaining = groupData.remaining.length > 0
      ? groupData.remaining.reduce((a, b) => a + b, 0) / groupData.remaining.length
      : 0;
    const remainingPercentage = Math.round(avgRemaining * 100);
    const resetTime = groupData.resetTime || '未知时间';
    const colorClass = remainingPercentage > 50 ? 'quota-high' :
                      remainingPercentage > 20 ? 'quota-medium' : 'quota-low';

    // 检查该模型组是否在冷却中，或者额度为0
    let cooldownHtml = '';
    if (projectId) {
      const cooldowns = getCooldownsForProject(projectId);
      const groupModels = groupData.modelIds;
      const cooldown = cooldowns.find(c => groupModels.includes(c.model));
      
      if (cooldown) {
        // 有冷却记录，用冷却记录的时间
        const remaining = new Date(cooldown.resetTimestamp).getTime() - Date.now();
        if (remaining > 0) {
          cooldownHtml = `<span class="quota-cooldown" data-reset="${escapeHtml(cooldown.resetTimestamp)}">🚫 ${formatRemainingTime(remaining)}</span>`;
        }
      } else if (remainingPercentage === 0 && resetTime && resetTime !== '未知时间') {
        // 额度为0但没在冷却列表中，用 API 返回的重置时间计算倒计时
        // resetTime 格式如 "12-29 01:25"，需要转换为完整日期
        const now = new Date();
        const [monthDay, time] = resetTime.split(' ');
        const [month, day] = monthDay.split('-').map(Number);
        const [hour, minute] = time.split(':').map(Number);
        const resetDate = new Date(now.getFullYear(), month - 1, day, hour, minute);
        // 如果重置时间已过，可能是明年
        if (resetDate < now) resetDate.setFullYear(now.getFullYear() + 1);
        const remaining = resetDate.getTime() - now.getTime();
        if (remaining > 0) {
          cooldownHtml = `<span class="quota-cooldown" data-reset="${resetDate.toISOString()}">🚫 ${formatRemainingTime(remaining)}</span>`;
        } else {
          cooldownHtml = `<span class="quota-cooldown-static">🚫 已耗尽</span>`;
        }
      } else if (remainingPercentage === 0) {
        cooldownHtml = `<span class="quota-cooldown-static">🚫 已耗尽</span>`;
      }
    }

    html += `
      <div class="quota-group-item">
        <div class="quota-group-header">
          <span class="quota-group-icon">${groupData.icon}</span>
          <div class="quota-group-info">
            <div class="quota-group-name">${escapeHtml(groupName)}${cooldownHtml}</div>
            <div class="quota-group-models" data-collapsible="true">(${groupData.modelIds.map(id => escapeHtml(id)).join(', ')})</div>
            <div class="quota-group-description">${escapeHtml(groupData.description)}</div>
          </div>
        </div>
        <div class="quota-progress-bar">
          <div class="quota-progress-fill ${colorClass}" style="width: ${remainingPercentage}%"></div>
        </div>
        <div class="quota-group-stats">
          <span class="quota-percentage">${remainingPercentage}%</span>
          <span class="quota-reset-time">重置: ${resetTime}</span>
          <span class="quota-model-count">${groupData.modelIds.length} 个模型</span>
        </div>
      </div>
    `;
  }

  // 渲染其他模型
  if (otherModels.length > 0) {
    html += `
      <div class="quota-group-item quota-other-group">
        <div class="quota-group-header">
          <span class="quota-group-icon">📋</span>
          <div class="quota-group-info">
            <div class="quota-group-name">其他模型</div>
            <div class="quota-group-description">未分组模型单独计费</div>
          </div>
        </div>
        <div class="quota-other-models">
    `;

    otherModels.forEach(model => {
      const remainingPercentage = Math.round(model.remaining * 100);
      const colorClass = remainingPercentage > 50 ? 'quota-high' :
                        remainingPercentage > 20 ? 'quota-medium' : 'quota-low';

      html += `
        <div class="quota-single-model">
          <div class="quota-model-name">${escapeHtml(model.name)}</div>
          <div class="quota-progress-bar">
            <div class="quota-progress-fill ${colorClass}" style="width: ${remainingPercentage}%"></div>
          </div>
          <div class="quota-model-info">
            <span class="quota-percentage">${remainingPercentage}%</span>
            <span class="quota-reset-time">重置: ${model.resetTime}</span>
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;

  // 绑定折叠按钮事件
  const toggleBtn = container.querySelector('.quota-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      const isCollapsed = this.getAttribute('data-collapsed') === 'true';
      const newState = !isCollapsed;

      // 更新状态
      this.setAttribute('data-collapsed', newState);
      container.querySelector('.quota-groups').setAttribute('data-collapsed', newState);

      // 更新按钮显示
      this.querySelector('.quota-toggle-icon').textContent = newState ? '▶' : '▼';
      this.querySelector('.quota-toggle-text').textContent = newState ? '展开模型' : '收起模型';

      // 保存到localStorage
      localStorage.setItem('quota-models-collapsed', newState);
    });
  }
}

async function refreshAccounts() {
  try {
    // 同时获取账号和冷却数据
    const [accountData] = await Promise.all([
      fetchJson('/auth/accounts'),
      fetchModelCooldowns()
    ]);
    accountsData = accountData.accounts || [];
    updateFilteredAccounts();
    loadHourlyUsage();
    startCooldownTimer(); // 启动倒计时
  } catch (e) {
    listEl.textContent = '加载失败: ' + e.message;
  }
}

function renderAccountsList() {
  if (!filteredAccounts.length) {
    listEl.textContent = accountsData.length ? '没有符合筛选条件的凭证。' : '暂无账号，请先添加一个。';
    if (paginationInfo) paginationInfo.textContent = '第 0 / 0 页';
    if (prevPageBtn) prevPageBtn.disabled = true;
    if (nextPageBtn) nextPageBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredAccounts.slice(start, start + PAGE_SIZE);

  listEl.innerHTML = pageItems
    .map(acc => {
      const created = acc.createdAt ? new Date(acc.createdAt).toLocaleString() : '时间未知';
      const statusClass = acc.enable ? 'status-ok' : 'status-off';
      const statusText = acc.enable ? '启用中' : '已停用';
      const displayName = escapeHtml(getAccountDisplayName(acc));
      const projectId = acc.projectId ? escapeHtml(acc.projectId) : null;
      return `
        <div class="account-item">
          <div class="account-header">
            <div class="account-info">
              <div class="account-title">
                ${displayName}
                ${projectId ? `<span class="badge">${projectId}</span>` : ''}
              </div>
              <div class="account-meta">创建时间：${created}</div>
            </div>
            <div class="account-status">
              <div class="status-pill ${statusClass}">${statusText}</div>
            </div>
          </div>

          <div class="account-content">
            <div class="account-data">
              ${renderUsageCard(acc)}
            </div>

            <div class="account-actions">
              <div class="action-row primary">
                <button class="mini-btn" data-action="refresh" data-index="${acc.index}">🔁 刷新</button>
              </div>
              <div class="action-row secondary">
                <button class="mini-btn" data-action="toggle" data-enable="${acc.enable}" data-index="${acc.index}">${
        acc.enable ? '⏸️ 停用' : '▶️ 启用'
      }</button>
                <button class="mini-btn" data-action="reauthorize" data-index="${acc.index}">🔑 重新授权</button>
                <button class="mini-btn danger" data-action="delete" data-index="${acc.index}">🗑️ 删除</button>
              </div>
              <div class="action-row secondary">
                <button class="mini-btn" data-action="refreshProjectId" data-index="${acc.index}">🔄 刷新项目ID</button>
                <button class="mini-btn" data-action="toggleQuota" data-index="${acc.index}" data-project="${acc.projectId || ''}">📊 查看额度</button>
              </div>
            </div>
            <div class="quota-section" id="quota-${acc.index}" style="display: none;">
              <div class="quota-loading">加载中...</div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  if (paginationInfo) {
    paginationInfo.textContent = `第 ${currentPage} / ${totalPages} 页，共 ${filteredAccounts.length} 个凭证`;
  }
  if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages;
  bindAccountActions();
}

async function deleteDisabledAccounts() {
  const disabledAccounts = accountsData
    .filter(acc => !acc.enable)
    .sort((a, b) => b.index - a.index);
  if (disabledAccounts.length === 0) {
    setStatus('没有停用的凭证需要删除。', 'info', manageStatusEl);
    return;
  }

  if (!confirm(`确认删除 ${disabledAccounts.length} 个停用凭证吗？删除后无法恢复。`)) return;

  deleteDisabledBtn.disabled = true;
  setStatus('正在删除停用凭证...', 'info', manageStatusEl);

  try {
    for (const acc of disabledAccounts) {
      await fetchJson(`/auth/accounts/${acc.index}`, { method: 'DELETE' });
    }
    setStatus(`已删除 ${disabledAccounts.length} 个停用凭证。`, 'success', manageStatusEl);
    await refreshAccounts();
  } catch (e) {
    setStatus('删除停用凭证失败: ' + e.message, 'error', manageStatusEl);
  } finally {
    deleteDisabledBtn.disabled = false;
  }
}

function renderSettings(groups) {
  if (!settingsGrid) return;
  if (!groups || groups.length === 0) {
    settingsGrid.textContent = '暂无配置数据';
    return;
  }

  const html = groups
    .map(group => {
      const items = (group.items || [])
        .map(item => {
          const currentValue = item?.value ?? '未设置';
          const editableValue = item.sensitive ? '' : currentValue;
          const defaultValue = item?.defaultValue ?? '无默认值';

          // 显示格式：如果设置了环境变量，显示"环境变量值 (默认值: 默认值)"
          const displayValue = item.isDefault
            ? (item.defaultValue !== null && item.defaultValue !== undefined ? defaultValue : currentValue)
            : `${currentValue} ${defaultValue !== '无默认值' ? `(默认值: ${defaultValue})` : ''}`;

          const badges = [
            `<span class="chip ${item.isDefault ? '' : item.source === 'docker' ? 'chip-warning' : item.source === 'env' ? 'chip-info' : 'chip-success'}">${
              item.isDefault ? '默认值' :
              item.source === 'docker' ? 'Docker环境变量' :
              item.source === 'env' ? '环境变量' :
              '配置文件'
            }</span>`,
            item.sensitive ? '<span class="chip chip-warning">敏感信息</span>' : '',
            item.dockerOnly ? '<span class="chip chip-warning">Docker专用</span>' : ''
          ]
            .filter(Boolean)
            .join('');

          const metaParts = [
            item.isDefault ? '使用默认值' :
              item.source === 'docker' ? '来自Docker环境变量' :
              item.source === 'env' ? '来自环境变量' :
              '来自data/config.json文件',
            `环境变量名: ${item.key}`,
            item.description ? escapeHtml(item.description) : ''
          ]
            .filter(Boolean)
            .join(' · ');

          return `
            <div class="setting-item ${item.isMissing ? 'missing' : ''}">
              <div class="setting-header">
                <div class="setting-key">${escapeHtml(item.label || item.key)}</div>
                ${badges}
              </div>
              <div class="setting-value">${escapeHtml(displayValue)}</div>
              <div class="setting-meta">${metaParts}</div>
              <div class="setting-actions">
                <button
                  class="mini-btn setting-edit-btn"
                  data-key="${escapeHtml(item.key)}"
                  data-label="${escapeHtml(item.label || item.key)}"
                  data-sensitive="${item.sensitive ? 'true' : 'false'}"
                  data-current="${escapeHtml(String(editableValue ?? ''))}"
                >
                  ✏️ 修改
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="settings-group">
          <div class="settings-group-header">${escapeHtml(group.name || '配置')}</div>
          <div class="settings-list">${items || '<div class="setting-item">暂无配置</div>'}</div>
        </div>
      `;
    })
    .join('');

  settingsGrid.innerHTML = html;
}

async function loadSettings() {
  if (!settingsGrid) return;
  settingsGrid.textContent = '加载中...';
  try {
    const data = await fetchJson('/admin/settings');
    renderSettings(data.groups || []);
    if (data.updatedAt) {
      setStatus(`已更新：${new Date(data.updatedAt).toLocaleString()}`, 'success', settingsStatusEl);
    }
  } catch (e) {
    settingsGrid.textContent = '加载设置失败: ' + e.message;
    setStatus('刷新失败: ' + e.message, 'error', settingsStatusEl);
  }
}

async function updateSettingValue({ key, label, isSensitive, currentValue }) {
  if (!key) return;

  const promptMessage = [
    `${label || key} (${key})`,
    '留空可回退到默认值，更新后会立即保存到 data/config.json。',
    isSensitive ? '敏感信息不会显示当前值，请直接输入新值。' : null
  ]
    .filter(Boolean)
    .join('\n');

  const newValue = window.prompt(promptMessage, isSensitive ? '' : currentValue || '');
  if (newValue === null) return;

  try {
    setStatus('保存配置中...', 'info', settingsStatusEl);
    const response = await fetchJson('/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: newValue })
    });

    if (response.dockerOnly) {
      // Docker专用配置的特殊提示
      setStatus(`此配置为 Docker 专用，请在 docker-compose.yml 的 environment 部分修改。`, 'warning', settingsStatusEl);
      alert(`⚠️ ${response.error}\n\n请在 docker-compose.yml 的 environment 部分修改此配置：\n${key}=你的值`);
    } else {
      await loadSettings();
      setStatus('已保存到 data/config.json。', 'success', settingsStatusEl);
    }
  } catch (e) {
    setStatus('更新失败: ' + e.message, 'error', settingsStatusEl);
  }
}

async function loadLogSettings() {
  if (!logLevelSelect) return;
  try {
    const data = await fetchJson('/admin/logs/settings');
    const raw = (data.level || 'all').toLowerCase();
    logLevelSelect.value = ['off', 'error', 'all'].includes(raw) ? raw : 'all';
  } catch (e) {
    console.error('加载调用日志配置失败:', e);
  }
}

function initLogSettingsUI() {
  const logsHeader = document.querySelector('[data-tab="logs"] .card-header');
  if (!logsHeader || !logsRefreshBtn) return;

  if (logLevelSelect) {
    loadLogSettings();
    return;
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const label = document.createElement('label');
  label.className = 'setting-inline';
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '8px';

  const span = document.createElement('span');
  span.textContent = '调用日志级别';


  label.appendChild(span);
  label.appendChild(select);
  actions.appendChild(label);

  logsHeader.removeChild(logsRefreshBtn);
  actions.appendChild(logsRefreshBtn);
  logsHeader.appendChild(actions);

  logLevelSelect = select;

  logLevelSelect.addEventListener('change', async () => {
    const level = logLevelSelect.value;
    try {
      setStatus('正在更新调用日志设置...', 'info', statusEl);
      await fetchJson('/admin/logs/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level })
      });
      setStatus('调用日志设置已更新', 'success', statusEl);
      await loadLogs();
    } catch (e) {
      setStatus('更新调用日志设置失败: ' + e.message, 'error', statusEl);
    }
  });

  loadLogSettings();
}

async function loadLogs() {
  if (!logsEl) return;
  logsEl.textContent = '加载中...';
  if (logPaginationInfo) logPaginationInfo.textContent = '加载中...';
  if (logPrevPageBtn) logPrevPageBtn.disabled = true;
  if (logNextPageBtn) logNextPageBtn.disabled = true;
  try {
    const data = await fetchJson('/admin/logs?limit=200');
    logsData = data.logs || [];
    logCurrentPage = 1;
    renderLogs();
  } catch (e) {
    logsEl.textContent = '加载日志失败: ' + e.message;
    if (logPaginationInfo) logPaginationInfo.textContent = '';
  }
}

async function fetchLogDetail(logId) {
  if (!logId) throw new Error('缺少日志 ID');
  if (logDetailCache.has(logId)) return logDetailCache.get(logId);
  const data = await fetchJson(`/admin/logs/${logId}`);
  const detail = data.log;
  logDetailCache.set(logId, detail);
  return detail;
}

function renderLogDetailContent(detail, container) {
  if (!container) return;
  if (!detail) {
    container.textContent = '未找到日志详情';
    return;
  }

  const requestSnapshot = detail.detail?.request;
  const responseSnapshot = detail.detail?.response;
  const modelAnswer =
    responseSnapshot?.modelOutput ||
    responseSnapshot?.body?.modelOutput ||
    responseSnapshot?.body?.text ||
    responseSnapshot?.body ||
    responseSnapshot;

  container.innerHTML = `
    <details class="log-detail-section" open>
      <summary>模型回答</summary>
      <div class="log-detail-body">
        <pre>${formatJson(modelAnswer || '暂无模型回答')}</pre>
      </div>
    </details>

    <details class="log-detail-section">
      <summary>用户完整请求体</summary>
      <div class="log-detail-body">
        <pre>${formatJson(requestSnapshot?.body || requestSnapshot || '暂无请求')}</pre>
      </div>
    </details>

    <details class="log-detail-section">
      <summary>全部请求/响应</summary>
      <div class="log-detail-body">
        <div class="log-detail-block">
          <h4>请求</h4>
          <pre>${formatJson(requestSnapshot)}</pre>
        </div>
        <div class="log-detail-block">
          <h4>响应</h4>
          <pre>${formatJson(responseSnapshot)}</pre>
        </div>
      </div>
    </details>
  `;
}

function renderErrorDetailContent(detail, container) {
  if (!container) return;
  if (!detail) {
    container.textContent = '未找到错误详情';
    return;
  }

  const requestSnapshot = detail.detail?.request;
  const responseSnapshot = detail.detail?.response;
  const errorSummary = { status: detail.status || null, message: detail.message || '未知错误' };

  container.innerHTML = `
    <div class="log-detail-block">
      <h4>错误摘要</h4>
      <pre>${formatJson(errorSummary)}</pre>
    </div>
    <details class="log-detail-section" open>
      <summary>响应内容</summary>
      <div class="log-detail-body">
        <pre>${formatJson(responseSnapshot?.body || responseSnapshot || '暂无响应')}</pre>
      </div>
    </details>
    <details class="log-detail-section">
      <summary>请求快照</summary>
      <div class="log-detail-body">
        <pre>${formatJson(requestSnapshot || '暂无请求')}</pre>
      </div>
    </details>
  `;
}

function bindLogDetailToggles() {
  document.querySelectorAll('.log-detail-toggle')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.detailTarget;
      const detailEl = document.getElementById(targetId);
      if (!detailEl) return;
      const isOpen = detailEl.classList.contains('open');
      if (isOpen) {
        detailEl.classList.remove('open');
        detailEl.style.display = 'none';
        btn.textContent = '查看请求/响应详情';
        return;
      }

      detailEl.style.display = 'block';
      detailEl.textContent = '加载中...';
      btn.disabled = true;
      try {
        const detail = await fetchLogDetail(btn.dataset.logId);
        renderLogDetailContent(detail, detailEl);
        detailEl.classList.add('open');
        btn.textContent = '收起详情';
      } catch (e) {
        detailEl.textContent = '加载详情失败: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.log-error-toggle')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.errorTarget;
      const errorEl = document.getElementById(targetId);
      if (!errorEl) return;
      const isOpen = errorEl.classList.contains('open');
      if (isOpen) {
        errorEl.classList.remove('open');
        errorEl.style.display = 'none';
        btn.textContent = '查看错误';
        return;
      }

      errorEl.style.display = 'block';
      errorEl.textContent = '加载中...';
      btn.disabled = true;
      try {
        const detail = await fetchLogDetail(btn.dataset.logId);
        renderErrorDetailContent(detail, errorEl);
        errorEl.classList.add('open');
        btn.textContent = '收起错误';
      } catch (e) {
        errorEl.textContent = '加载错误详情失败: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function renderLogs() {
  if (!logsEl) return;

  if (!logsData.length) {
    logsEl.textContent = '暂无调用日志';
    if (logPaginationInfo) logPaginationInfo.textContent = '第 0 / 0 页';
    if (logPrevPageBtn) logPrevPageBtn.disabled = true;
    if (logNextPageBtn) logNextPageBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(logsData.length / LOG_PAGE_SIZE));
  logCurrentPage = Math.min(Math.max(logCurrentPage, 1), totalPages);
  const start = (logCurrentPage - 1) * LOG_PAGE_SIZE;
  const pageItems = logsData.slice(start, start + LOG_PAGE_SIZE);

  logsEl.innerHTML = pageItems
    .map((log, idx) => {
      const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : '未知时间';
      const cls = log.success ? 'log-success' : 'log-fail';
      const hasError = !log.success;
      const detailId = `log-detail-${start + idx}`;
      const errorDetailId = `log-error-${start + idx}`;
      const statusText = log.status ? `HTTP ${log.status}` : log.success ? '成功' : '失败';
      const durationText = log.durationMs ? `${log.durationMs} ms` : '未知耗时';
      const pathText = `${log.method || '未知方法'} ${log.path || log.route || '未知路径'}`;
      const errorHint = hasError && log.message ? `<div class="log-error-hint">失败原因：${escapeHtml(log.message)}</div>` : '';
      const detailButton =
        log.hasDetail && log.id
          ? `<button class="mini-btn log-detail-toggle" data-log-id="${log.id}" data-detail-target="${detailId}">查看请求/响应详情</button>
             <div class="log-detail" id="${detailId}"></div>`
          : '';

      const errorButton =
        hasError && log.id
          ? `<button class="mini-btn log-error-toggle" data-log-id="${log.id}" data-error-target="${errorDetailId}">查看错误</button>
             <div class="log-error-detail" id="${errorDetailId}"></div>`
          : '';

      return `
        <div class="log-item ${cls}">
          <div class="log-content">
            <div class="log-time">${time}</div>
            <div class="log-meta">模型：${log.model || '未知模型'} | 项目：${log.projectId || '未知项目'}</div>
            <div class="log-meta">${pathText}</div>
            <div class="log-meta">${statusText} | ${durationText}</div>
            ${errorHint}
            ${errorButton}
            ${detailButton}
          </div>
          <div class="log-status">${log.success ? '成功' : '失败'}</div>
        </div>
      `;
    })
    .join('');

  if (logPaginationInfo) {
    logPaginationInfo.textContent = `第 ${logCurrentPage} / ${totalPages} 页，共 ${logsData.length} 条`;
  }
  if (logPrevPageBtn) logPrevPageBtn.disabled = logCurrentPage === 1;
  if (logNextPageBtn) logNextPageBtn.disabled = logCurrentPage === totalPages;
  bindLogDetailToggles();
}

async function loadHourlyUsage() {
  if (!hourlyUsageEl) return;
  hourlyUsageEl.textContent = '加载中...';
  try {
    const data = await fetchJson('/admin/logs/usage');
    const usageMap = new Map();
    (data.usage || []).forEach(item => {
      if (!item) return;
      usageMap.set(item.projectId || '未知项目', item);
    });

    const merged = (accountsData.length ? accountsData : Array.from(usageMap.values()))
      .map(acc => {
        const projectId = acc.projectId || acc.project || acc.id || '未知项目';
        const stats = usageMap.get(projectId) || acc || {};
        const usage = acc.usage || {};

        const totalCalls = usage.total ?? stats.count ?? 0;
        const successCalls = usage.success ?? stats.success ?? 0;
        const failedCalls = usage.failed ?? stats.failed ?? 0;
        const lastUsedAt = usage.lastUsedAt || stats.lastUsedAt || null;

        const hasActivity =
          (stats.count || 0) > 0 ||
          (totalCalls || 0) > 0 ||
          (successCalls || 0) > 0 ||
          (failedCalls || 0) > 0 ||
          !!lastUsedAt;

        return {
          projectId,
          label: getAccountDisplayName(acc),
          count: stats.count || 0,
          success: successCalls,
          failed: failedCalls,
          total: totalCalls,
          lastUsedAt,
          hasActivity
        };
      })
      .filter(item => item.hasActivity);

    const windowMinutes = data.windowMinutes || HOUR_WINDOW_MINUTES;
    const limit = data.limitPerCredential || HOURLY_LIMIT;

    if (!merged.length) {
      hourlyUsageEl.textContent = '暂无最近 1 小时内的调用记录';
      return;
    }

    const sorted = merged.sort((a, b) => {
      const aTime = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bTime = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      if (aTime !== bTime) return bTime - aTime;
      return (b.count || 0) - (a.count || 0);
    });

    const html = sorted
      .map(item => {
        const percent = Math.min(100, Math.round(((item.count || 0) / limit) * 100));
        const lastUsedText = item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : '暂无';
        return `
          <div class="log-usage-row">
            <div class="log-usage-header">
              <div class="log-usage-title">${escapeHtml(item.label)}</div>
              <div class="log-usage-meta">${item.count || 0} / ${limit} 次 · ${windowMinutes} 分钟</div>
            </div>
            <div class="progress-bar" aria-label="${escapeHtml(item.label)} 用量">
              <div class="progress" style="width:${percent}%;"></div>
            </div>
            <div class="log-usage-stats">
              <div class="log-usage-stat">
                <span class="stat-label">总调用</span>
                <span class="stat-value">${item.total || 0}</span>
              </div>
              <div class="log-usage-stat">
                <span class="stat-label">成功 / 失败</span>
                <span class="stat-value">${item.success || 0} / ${item.failed || 0}</span>
              </div>
              <div class="log-usage-stat">
                <span class="stat-label">最近使用</span>
                <span class="stat-value">${escapeHtml(lastUsedText)}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    hourlyUsageEl.innerHTML = html;
  } catch (e) {
    hourlyUsageEl.textContent = '加载用量失败: ' + e.message;
  }
}

if (loginBtn) {
  loginBtn.addEventListener('click', async () => {
    try {
      loginBtn.disabled = true;
      setStatus('获取授权链接中...', 'info');
      const data = await fetchJson('/auth/oauth/url');
      if (!data.url) throw new Error('未返回 url');
      setStatus('已打开授权页面，请完成 Google 授权，然后复制回调页面地址栏中的完整 URL，粘贴到下方输入框并提交。', 'info');
      window.open(data.url, '_blank', 'noopener');
    } catch (e) {
      setStatus('获取授权链接失败: ' + e.message, 'error');
    } finally {
      loginBtn.disabled = false;
    }
  });
}

if (submitCallbackBtn && callbackUrlInput) {
  submitCallbackBtn.addEventListener('click', async () => {
    const url = callbackUrlInput.value.trim();
    if (!url) {
      setStatus('请先粘贴包含 code 参数的完整回调 URL。', 'error');
      return;
    }

    const customProjectId = customProjectIdInput ? customProjectIdInput.value.trim() : '';

    try {
      submitCallbackBtn.disabled = true;
      setStatus('正在解析回调 URL 并交换 token...', 'info');
      await fetchJson('/auth/oauth/parse-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          replaceIndex,
          customProjectId,
          allowRandomProjectId: !!allowRandomProjectIdCheckbox?.checked
        })
      });

      setStatus('授权成功，账号已添加。', 'success');
      callbackUrlInput.value = '';
      if (customProjectIdInput) {
        customProjectIdInput.value = '';
      }
      replaceIndex = null;
      refreshAccounts();
    } catch (e) {
      setStatus('解析回调 URL 失败: ' + e.message, 'error');
    } finally {
      submitCallbackBtn.disabled = false;
    }
  });
}

if (importTomlBtn && tomlInput) {
  importTomlBtn.addEventListener('click', async () => {
    const content = tomlInput.value.trim();
    if (!content) {
      setStatus('请粘贴 TOML 凭证内容后再导入。', 'error', tomlStatusEl);
      return;
    }

    const replaceExisting = !!replaceExistingCheckbox?.checked;
    const filterDisabled = filterDisabledCheckbox ? !!filterDisabledCheckbox.checked : true;

    try {
      importTomlBtn.disabled = true;
      setStatus('正在导入 TOML 凭证...', 'info', tomlStatusEl);
      const result = await fetchJson('/auth/accounts/import-toml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toml: content, replaceExisting, filterDisabled })
      });

      const summary = `导入成功：有效 ${result.imported ?? 0} 条，跳过 ${result.skipped ?? 0} 条，总计 ${result.total ?? 0} 个账号。`;
      setStatus(summary, 'success', tomlStatusEl);
      tomlInput.value = '';
      refreshAccounts();
      loadLogs();
    } catch (e) {
      setStatus('导入失败: ' + e.message, 'error', tomlStatusEl);
    } finally {
      importTomlBtn.disabled = false;
    }
  });
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tabTarget));
});

if (deleteDisabledBtn) {
  deleteDisabledBtn.addEventListener('click', deleteDisabledAccounts);
}

if (prevPageBtn) {
  prevPageBtn.addEventListener('click', () => {
    currentPage = Math.max(1, currentPage - 1);
    renderAccountsList();
  });
}

if (nextPageBtn) {
  nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
    currentPage = Math.min(totalPages, currentPage + 1);
    renderAccountsList();
  });
}

if (logPrevPageBtn) {
  logPrevPageBtn.addEventListener('click', () => {
    logCurrentPage = Math.max(1, logCurrentPage - 1);
    renderLogs();
  });
}

if (logNextPageBtn) {
  logNextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(logsData.length / LOG_PAGE_SIZE));
    logCurrentPage = Math.min(totalPages, logCurrentPage + 1);
    renderLogs();
  });
}

if (statusFilterSelect) {
  statusFilterSelect.addEventListener('change', () => {
    statusFilter = statusFilterSelect.value || 'all';
    updateFilteredAccounts();
  });
}

if (errorFilterCheckbox) {
  errorFilterCheckbox.addEventListener('change', () => {
    errorOnly = !!errorFilterCheckbox.checked;
    updateFilteredAccounts();
  });
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    if (autoThemeTimer) {
      clearInterval(autoThemeTimer);
      autoThemeTimer = null;
    }
    applyTheme(next);
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      logoutBtn.disabled = true;
      setStatus('正在退出登录...', 'info');
      await fetch('/admin/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin'
      });
      window.location.href = '/admin/login';
    } catch (e) {
      setStatus('退出录失败: ' + e.message, 'error');
      logoutBtn.disabled = false;
    }
  });
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    refreshAccounts();
    loadLogs();
    loadHourlyUsage();
  });
}

if (refreshAllBtn) {
  refreshAllBtn.addEventListener('click', () => {
    refreshAllAccountsBatch();
  });
}

if (logsRefreshBtn) {
  logsRefreshBtn.addEventListener('click', async () => {
    try {
      logsRefreshBtn.disabled = true;
      logsRefreshBtn.textContent = '刷新中...';
      await loadLogs();
    } finally {
      logsRefreshBtn.textContent = '🔄 刷新日志';
      logsRefreshBtn.disabled = false;
    }
  });
}

if (logsClearBtn) {
  logsClearBtn.addEventListener('click', async () => {
    if (!confirm('确认清空所有调用日志吗？该操作不可恢复。')) return;

    try {
      logsClearBtn.disabled = true;
      logsClearBtn.textContent = '清空中...';
      await fetchJson('/admin/logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      setStatus('调用日志已清空', 'success', statusEl);
      logsData = [];
      logCurrentPage = 1;
      renderLogs();
      await loadHourlyUsage();
    } catch (e) {
      setStatus('清空日志失败: ' + e.message, 'error', statusEl);
    } finally {
      logsClearBtn.textContent = '🗑 清空日志';
      logsClearBtn.disabled = false;
    }
  });
}

if (usageRefreshBtn) {
  usageRefreshBtn.addEventListener('click', async () => {
    try {
      usageRefreshBtn.disabled = true;
      usageRefreshBtn.textContent = '刷新中...';
      await loadHourlyUsage();
      setStatus('用量已刷新', 'success', usageStatusEl);
    } catch (e) {
      setStatus('刷新用量失败: ' + e.message, 'error', usageStatusEl);
    } finally {
      usageRefreshBtn.textContent = '🔄 刷新用量';
      usageRefreshBtn.disabled = false;
    }
  });
}

if (settingsRefreshBtn) {
  settingsRefreshBtn.addEventListener('click', async () => {
    try {
      settingsRefreshBtn.disabled = true;
      settingsRefreshBtn.textContent = '刷新中...';
      await loadSettings();
    } finally {
      settingsRefreshBtn.textContent = '🔄 刷新配置';
      settingsRefreshBtn.disabled = false;
    }
  });
}

if (settingsGrid) {
  settingsGrid.addEventListener('click', async event => {
    const target = event.target.closest('.setting-edit-btn');
    if (!target) return;

    await updateSettingValue({
      key: target.dataset.key,
      label: target.dataset.label,
      isSensitive: target.dataset.sensitive === 'true',
      currentValue: target.dataset.current
    });
  });
}

refreshAccounts();
loadLogs();
loadHourlyUsage();
loadSettings();
initLogSettingsUI();
