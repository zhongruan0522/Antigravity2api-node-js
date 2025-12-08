import axios from 'axios';
import config from '../config/config.js';
import logger from '../utils/logger.js';

function getResourceManagerBaseUrl() {
  const base = config.resourceManagerApiUrl || 'https://cloudresourcemanager.googleapis.com';
  return base.replace(/\/+$/, '');
}

function buildAxiosProxyConfig() {
  if (!config.proxy) return false;

  try {
    const proxyUrl = new URL(config.proxy);
    return {
      protocol: proxyUrl.protocol.replace(':', ''),
      host: proxyUrl.hostname,
      port: Number.parseInt(proxyUrl.port, 10)
    };
  } catch (e) {
    logger.warn(`解析代理地址失败，将不使用代理: ${e?.message || e}`);
    return false;
  }
}

export async function fetchActiveProjects(accessToken) {
  if (!accessToken) {
    throw new Error('缺少 access_token，无法查询项目列表');
  }

  const resourceManagerBaseUrl = getResourceManagerBaseUrl();
  const url = `${resourceManagerBaseUrl}/v1/projects`;

  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'antigravity-oauth/1.0'
    },
    timeout: config.timeout,
    proxy: buildAxiosProxyConfig()
  };

  const res = await axios(axiosConfig);
  const data = res.data || {};
  const projects = Array.isArray(data.projects) ? data.projects : [];

  return projects.filter(p => {
    if (!p) return false;
    if (!p.lifecycleState) return true;
    return String(p.lifecycleState).toUpperCase() === 'ACTIVE';
  });
}

export function selectDefaultProjectId(projects) {
  if (!projects || projects.length === 0) {
    return null;
  }

  if (projects.length === 1) {
    return projects[0].projectId || null;
  }

  const withDefault = projects.find(p => {
    const name = String(p.displayName || '').toLowerCase();
    const id = String(p.projectId || '').toLowerCase();
    return name.includes('default') || id.includes('default');
  });

  if (withDefault && withDefault.projectId) {
    return withDefault.projectId;
  }

  return projects[0].projectId || null;
}

export async function fetchUserEmail(accessToken) {
  if (!accessToken) {
    throw new Error('缺少 access_token，无法获取用户邮箱');
  }

  const axiosConfig = {
    method: 'GET',
    url: 'https://www.googleapis.com/oauth2/v2/userinfo',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'antigravity-oauth/1.0'
    },
    timeout: 10000,
    proxy: buildAxiosProxyConfig()
  };

  try {
    const res = await axios(axiosConfig);
    const data = res.data || {};
    return data.email || null;
  } catch (error) {
    logger.warn(`获取用户邮箱失败: ${error?.message || error}`);
    return null;
  }
}

export async function resolveProjectIdFromAccessToken(accessToken) {
  try {
    const projects = await fetchActiveProjects(accessToken);
    const projectId = selectDefaultProjectId(projects);
    logger.info(`获取到 ${projects.length} 个项目，选择的项目ID: ${projectId}`);
    return { projectId, projects, error: null };
  } catch (error) {
    logger.warn(
      `尝试通过 Resource Manager 获取项目ID失败，将保留原有 projectId 或使用占位值: ${error?.message || error}`
    );
    return { projectId: null, projects: null, error };
  }
}

