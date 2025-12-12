const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function logMessage(level, ...args) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const color = { info: colors.green, warn: colors.yellow, error: colors.red }[level];
  console.log(`${colors.gray}${timestamp}${colors.reset} ${color}[${level}]${colors.reset}`, ...args);
}

function logRequest(method, path, status, duration, clientIP, userAgent) {
  const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
  const ipInfo = clientIP ? ` ${colors.cyan}[${clientIP}]${colors.reset}` : '';
  const uaInfo = userAgent && userAgent.length > 50 ? ` ${colors.gray}${userAgent.substring(0, 50)}...${colors.reset}` : userAgent ? ` ${colors.gray}${userAgent}${colors.reset}` : '';
  console.log(`${colors.cyan}[${method}]${colors.reset} - ${path} ${statusColor}${status}${colors.reset} ${colors.gray}${duration}ms${colors.reset}${ipInfo}${uaInfo}`);
}

const DebugLevel = {
  OFF: 0,
  LOW: 1,
  HIGH: 2
};

function getDebugLevel() {
  // 1. 优先检查命令行参数
  const args = process.argv.slice(2);
  const debugIndex = args.indexOf('-debug');

  if (debugIndex !== -1) {
    const nextArg = args[debugIndex + 1];
    if (nextArg === 'high') {
      return DebugLevel.HIGH;
    }
    return DebugLevel.LOW;
  }

  // 2. 检查环境变量
  const envDebug = process.env.DEBUG ? String(process.env.DEBUG).toLowerCase() : '';
  if (envDebug === 'high') {
    return DebugLevel.HIGH;
  }
  if (['low', 'true', '1', 'on'].includes(envDebug)) {
    return DebugLevel.LOW;
  }

  return DebugLevel.OFF;
}

const currentDebugLevel = getDebugLevel();

function logDetail(data) {
  if (currentDebugLevel < DebugLevel.LOW) {
    return;
  }

  const { method, path, status, durationMs, request, response, error } = data;
  const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;

  console.log('----------------------------------------------------');
  console.log(`${colors.cyan}[${method}]${colors.reset} ${path} ${statusColor}${status}${colors.reset} ${colors.gray}${durationMs}ms${colors.reset}`);

  if (error) {
    console.log(`${colors.red}Error:${colors.reset} ${error}`);
  }

  if (request) {
    console.log(`${colors.cyan}Request Headers:${colors.reset}`);
    console.log(JSON.stringify(request.headers || {}, null, 2));
    if (request.body) {
      console.log(`${colors.cyan}Request Body:${colors.reset}`);
      console.log(JSON.stringify(request.body, null, 2));
    }
  }

  if (response) {
    if (response.headers) {
      // console.log(`${colors.green}Response Headers:${colors.reset}`);
      // console.log(JSON.stringify(response.headers, null, 2));
    }
    if (response.body || response.modelOutput) {
      console.log(`${colors.green}Response Output:${colors.reset}`);
      const out = response.modelOutput || response.body;
      console.log(JSON.stringify(out, null, 2));
    }
  }
  console.log('----------------------------------------------------');
}

/**
 * 截断 base64 数据，只保留前 maxLength 个字符
 * @param {any} obj - 要处理的对象
 * @param {number} maxLength - 最大保留长度，默认 100
 * @returns {any} - 处理后的对象
 */
function truncateBase64(obj, maxLength = 100) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // 检测是否为 base64 数据（长度较长且符合 base64 格式）
    // base64 通常只包含 A-Za-z0-9+/= 字符
    const base64Regex = /^[A-Za-z0-9+/=]{200,}$/;
    if (base64Regex.test(obj)) {
      const totalLength = obj.length;
      return obj.substring(0, maxLength) + `...[已截断, 共 ${totalLength} 字符]`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => truncateBase64(item, maxLength));
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[key] = truncateBase64(obj[key], maxLength);
    }
    return result;
  }

  return obj;
}

/**
 * 记录后端 API 的请求和响应（仅 debug=high 时生效）
 * @param {Object} data - 日志数据
 * @param {string} data.type - 'request' 或 'response'
 * @param {string} data.url - 请求 URL
 * @param {string} data.method - HTTP 方法
 * @param {Object} data.headers - 请求/响应头
 * @param {any} data.body - 请求/响应体
 * @param {number} data.status - 响应状态码（仅 response）
 * @param {number} data.durationMs - 请求耗时（仅 response）
 */
function logBackend(data) {
  if (currentDebugLevel < DebugLevel.HIGH) {
    return;
  }

  const { type, url, method, headers, body, status, durationMs } = data;

  console.log('==================== BACKEND ====================');

  if (type === 'request') {
    console.log(`${colors.yellow}[Backend Request]${colors.reset} ${colors.cyan}${method}${colors.reset} ${url}`);
    if (headers) {
      console.log(`${colors.yellow}Headers:${colors.reset}`);
      // 隐藏敏感的 Authorization 头
      const safeHeaders = { ...headers };
      if (safeHeaders.Authorization) {
        safeHeaders.Authorization = safeHeaders.Authorization.substring(0, 20) + '...[HIDDEN]';
      }
      console.log(JSON.stringify(safeHeaders, null, 2));
    }
    if (body) {
      console.log(`${colors.yellow}Body:${colors.reset}`);
      // 截断 base64 数据
      const truncatedBody = truncateBase64(body);
      const bodyStr = typeof truncatedBody === 'string' ? truncatedBody : JSON.stringify(truncatedBody, null, 2);
      console.log(bodyStr);
    }
  } else if (type === 'response') {
    const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
    console.log(`${colors.green}[Backend Response]${colors.reset} ${statusColor}${status}${colors.reset} ${colors.gray}${durationMs}ms${colors.reset}`);
    if (body) {
      console.log(`${colors.green}Body:${colors.reset}`);
      // 截断 base64 数据
      const truncatedBody = truncateBase64(body);
      const bodyStr = typeof truncatedBody === 'string' ? truncatedBody : JSON.stringify(truncatedBody, null, 2);
      console.log(bodyStr);
    }
  }

  console.log('==================================================');
}

export const log = {
  info: (...args) => logMessage('info', ...args),
  warn: (...args) => logMessage('warn', ...args),
  error: (...args) => logMessage('error', ...args),
  request: logRequest,
  detail: logDetail,
  backend: logBackend,
  level: currentDebugLevel,
  DebugLevel
};

export default log;

