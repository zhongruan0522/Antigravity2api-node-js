import axios from 'axios';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { generateRequestId, generateToolCallId } from '../utils/idGenerator.js';
import AntigravityRequester from '../AntigravityRequester.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import { registerThoughtSignature } from '../utils/utils.js';

// 请求客户端：优先使用 AntigravityRequester，失败则降级到 axios
let requester = null;
let useAxios = false;
const REQUESTER_FALLBACK_ERROR_KEYWORDS = ['upstream error', 'do request failed', 'process closed'];

if (config.useNativeAxios === true) {
    useAxios = true;
} else {
    try {
        requester = new AntigravityRequester();
    } catch (error) {
        console.warn('AntigravityRequester 初始化失败，降级使用 axios:', error.message);
        useAxios = true;
    }
}

export function refreshApiClientConfig() {
    if (config.useNativeAxios === true) {
        requester = null;
        useAxios = true;
        return;
    }

    if (config.useNativeAxios === false) {
        useAxios = false;
    }

    if (!requester && !useAxios) {
        try {
            requester = new AntigravityRequester();
        } catch (error) {
            console.warn('重新初始化 AntigravityRequester 失败，继续使用 axios:', error.message);
            useAxios = true;
        }
    }
}

// ==================== 辅助函数 ====================

function buildHeaders(token) {
    return {
        'Host': config.api.host,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
    };
}

function buildAxiosConfig(url, headers, body = null) {
    const axiosConfig = {
        method: 'POST',
        url,
        headers,
        timeout: config.timeout,
        proxy: config.proxy ? (() => {
            const proxyUrl = new URL(config.proxy);
            return { protocol: proxyUrl.protocol.replace(':', ''), host: proxyUrl.hostname, port: parseInt(proxyUrl.port) };
        })() : false
    };
    if (body !== null) axiosConfig.data = body;
    return axiosConfig;
}

// ==================== 额度相关函数 ====================

export async function getModelsWithQuotas(token) {
    const headers = buildHeaders(token);

    try {
        let data;
        if (useAxios) {
            data = (await axios(buildAxiosConfig(config.api.modelsUrl, headers, {}))).data;
        } else {
            const response = await requester.antigravity_fetch(config.api.modelsUrl, buildRequesterConfig(headers, {}));
            if (response.status !== 200) {
                const errorBody = await response.text();
                throw { status: response.status, message: errorBody };
            }
            data = await response.json();
        }

        const quotas = {};
        Object.entries(data.models || {}).forEach(([modelId, modelData]) => {
            if (modelData.quotaInfo) {
                quotas[modelId] = {
                    remaining: modelData.quotaInfo.remainingFraction || modelData.quotaInfo.remaining || 0,
                    resetTime: modelData.quotaInfo.resetTime || null,
                    resetTimeRaw: modelData.quotaInfo.resetTime
                };
            }
        });

        return quotas;
    } catch (error) {
        await handleApiError(error, token);
    }
}

function buildRequesterConfig(headers, body = null) {
    const reqConfig = {
        method: 'POST',
        headers,
        timeout_ms: config.timeout,
        proxy: config.proxy
    };
    if (body !== null) reqConfig.body = JSON.stringify(body);
    return reqConfig;
}

function shouldFallbackToAxios(error) {
    if (useAxios || !error) return false;

    const message = String(error?.message || '').toLowerCase();
    return REQUESTER_FALLBACK_ERROR_KEYWORDS.some(keyword => message.includes(keyword));
}

async function withRequesterFallback(fn) {
    try {
        return await fn(useAxios);
    } catch (error) {
        if (shouldFallbackToAxios(error)) {
            console.warn('AntigravityRequester 调用失败，降级使用 axios:', error.message);
            useAxios = true;
            return await fn(useAxios);
        }

        throw error;
    }
}

function buildGeminiRequest(model, requestBody = {}, token) {
    const { generationConfig, systemInstruction, sessionId, ...rest } = requestBody;

    return {
        project: token.projectId,
        requestId: generateRequestId(),
        request: {
            systemInstruction:
                systemInstruction || {
                    role: 'user',
                    parts: [{ text: config.systemInstruction }]
                },
            generationConfig: {
                topP: config.defaults.top_p,
                topK: config.defaults.top_k,
                temperature: config.defaults.temperature,
                maxOutputTokens: config.defaults.max_tokens,
                ...(generationConfig || {})
            },
            sessionId: sessionId || token.sessionId,
            ...rest
        },
        model,
        userAgent: 'antigravity'
    };
}

function statusFromStatusText(statusText) {
    if (!statusText) return null;

    const normalized = String(statusText).toUpperCase();
    if (normalized === 'RESOURCE_EXHAUSTED') return 429;
    if (normalized === 'INTERNAL') return 500;
    if (normalized === 'UNAUTHENTICATED') return 401;

    const numeric = parseInt(statusText, 10);
    return Number.isNaN(numeric) ? null : numeric;
}

function parseRetryDelayMs(errorInfo, message) {
    let retryDelayMs = null;

    const retryDetail = errorInfo?.details?.find(
        detail => typeof detail === 'object' && detail['@type']?.includes('RetryInfo')
    );

    if (retryDetail?.retryDelay) {
        const secondsMatch = /([0-9]+(?:\.[0-9]+)?)s/.exec(retryDetail.retryDelay);
        if (secondsMatch) {
            retryDelayMs = Math.ceil(parseFloat(secondsMatch[1]) * 1000);
        }
    }

    if (!retryDelayMs && typeof message === 'string') {
        const messageMatch = /retry in ([0-9]+(?:\.[0-9]+)?)s/i.exec(message);
        if (messageMatch) {
            retryDelayMs = Math.ceil(parseFloat(messageMatch[1]) * 1000);
        }
    }

    return retryDelayMs;
}

function detectEmbeddedError(body) {
    if (!body) return null;

    try {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        if (!parsed?.error) return null;

        const status = statusFromStatusText(parsed.error.code || parsed.error.status);
        const retryDelayMs = parseRetryDelayMs(parsed.error, parsed.error.message || body);

        return {
            status,
            message: JSON.stringify(parsed.error, null, 2),
            retryDelayMs,
            disableToken: status === 401
        };
    } catch (e) {
        return null;
    }
}

async function extractErrorDetails(error) {
    let status = statusFromStatusText(error?.status || error?.statusCode || error?.response?.status);
    let message = error?.message || error?.response?.statusText || 'Unknown error';
    let retryDelayMs = error?.retryDelayMs || null;
    let disableToken = error?.disableToken === true;

    if (error?.response?.data?.readable) {
        const chunks = [];
        for await (const chunk of error.response.data) {
            chunks.push(chunk);
        }
        message = Buffer.concat(chunks).toString();
    } else if (typeof error?.response?.data === 'object') {
        message = JSON.stringify(error.response.data, null, 2);
    } else if (error?.response?.data) {
        message = error.response.data;
    } else if (error?.message && error?.message !== message) {
        message = error.message;
    }

    const embeddedError = detectEmbeddedError(message);
    if (embeddedError) {
        status = embeddedError.status ?? status;
        retryDelayMs = embeddedError.retryDelayMs ?? retryDelayMs;
        disableToken = embeddedError.disableToken || disableToken;
        message = embeddedError.message;
    }

    return {
        status: status ?? 'Unknown',
        message,
        retryDelayMs,
        disableToken
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(operation, token) {
    const maxAttempts = Math.max(config.retry?.maxAttempts || 1, 1);
    const retryStatusCodes = config.retry?.statusCodes?.length
        ? config.retry.statusCodes
        : [429, 500];

    let attempt = 0;
    while (attempt < maxAttempts) {
        try {
            return await operation();
        } catch (error) {
            const details = await extractErrorDetails(error);

            if (details.disableToken || details.status === 401) {
                tokenManager.disableCurrentToken(token);
                throw error;
            }

            const shouldRetry = retryStatusCodes.includes(details.status);
            if (!shouldRetry || attempt === maxAttempts - 1) {
                throw error;
            }

            const delayMs = details.retryDelayMs ?? Math.min(1000 * (attempt + 1), 5000);
            await delay(delayMs);
            attempt += 1;
        }
    }
}

// 统一错误处理
async function handleApiError(error, token) {
    const details = await extractErrorDetails(error);

    if (details.status === 403 || details.status === 401 || details.disableToken) {
        tokenManager.disableCurrentToken(token);
        throw new Error(`该账号没有使用权限或凭证失效，已自动禁用。错误详情: ${details.message}`);
    }

    throw new Error(`API请求失败 (${details.status}): ${details.message}`);
}

// 转换 functionCall 为 OpenAI 格式
function convertToToolCall(functionCall) {
    return {
        id: functionCall.id || generateToolCallId(),
        type: 'function',
        function: {
            name: functionCall.name,
            arguments: JSON.stringify(functionCall.args)
        }
    };
  }
  
  
// 辅助函数：在保留原有结构的同时记录 thoughtSignature
function convertToToolCallWithSignature(functionCall, thoughtSignature) {
    const toolCall = convertToToolCall(functionCall);
    if (thoughtSignature && toolCall && toolCall.id) {
        registerThoughtSignature(toolCall.id, thoughtSignature);
    }
    return toolCall;
}

// 解析并发送流式响应片段（会修改 state 并触发 callback）
function toOpenAiUsage(usageMetadata) {
    if (!usageMetadata) return null;

    const prompt = usageMetadata.promptTokenCount ?? usageMetadata.inputTokenCount ?? null;
    const completion = usageMetadata.candidatesTokenCount ?? usageMetadata.outputTokenCount ?? null;
    const total =
        usageMetadata.totalTokenCount ??
        (Number.isFinite(prompt) && Number.isFinite(completion) ? prompt + completion : null);
    const inferredCompletion =
        completion ?? (Number.isFinite(total) && Number.isFinite(prompt) ? Math.max(total - prompt, 0) : total);

    return {
        prompt_tokens: prompt,
        completion_tokens: inferredCompletion,
        total_tokens:
            total ?? (Number.isFinite(prompt) && Number.isFinite(inferredCompletion) ? prompt + inferredCompletion : null)
    };
}

function parseAndEmitStreamChunk(line, state, callback) {
    if (!line.startsWith('data: ')) return;

    try {
        const data = JSON.parse(line.slice(6));
        const parts = data.response?.candidates?.[0]?.content?.parts;

        if (data.response?.usageMetadata) {
            state.usage = toOpenAiUsage(data.response.usageMetadata);
        }

        if (parts) {
            for (const part of parts) {
                if (part.thought === true) {
                    // 思维链内容 - 不添加标签，直接发送
                    callback({ type: 'thinking', content: part.text || '' });
                } else if (part.text !== undefined) {
                    callback({ type: 'text', content: part.text });
                } else if (part.functionCall) {
                    // 工具调用
                    state.toolCalls.push(convertToToolCall(part.functionCall));
                }
            }
        }

        // 响应结束时发送工具调用
        if (data.response?.candidates?.[0]?.finishReason && state.toolCalls.length > 0) {
            callback({ type: 'tool_calls', tool_calls: state.toolCalls });
            state.toolCalls = [];
        }
    } catch (e) {
        // 忽略 JSON 解析错误
    }
}

// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback) {

    const headers = buildHeaders(token);
    const state = { toolCalls: [], usage: null };
    let buffer = ''; // 缓冲区：处理跨 chunk 的不完整行

    const processChunk = (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留最后一行（可能不完整）
        lines.forEach(line => parseAndEmitStreamChunk(line, state, callback));
    };

    try {
        await withRequesterFallback(async currentUseAxios => withRetry(async () => {
            if (currentUseAxios) {
                const axiosConfig = { ...buildAxiosConfig(config.api.url, headers, requestBody), responseType: 'stream' };
                const response = await axios(axiosConfig);

                response.data.on('data', chunk => processChunk(chunk.toString()));
                await new Promise((resolve, reject) => {
                    response.data.on('end', resolve);
                    response.data.on('error', reject);
                });
                return;
            }

            const streamResponse = requester.antigravity_fetchStream(config.api.url, buildRequesterConfig(headers, requestBody));
            let errorBody = '';
            let statusCode = null;

            await new Promise((resolve, reject) => {
                streamResponse
                    .onStart(({ status }) => { statusCode = status; })
                    .onData((chunk) => statusCode !== 200 ? errorBody += chunk : processChunk(chunk))
                    .onEnd(() => statusCode !== 200 ? reject({ status: statusCode, message: errorBody }) : resolve())
                    .onError(reject);
            });
        }, token));
    } catch (error) {
        await handleApiError(error, token);
    }

    return { usage: state.usage };
}

export async function getAvailableModels() {
    const token = await tokenManager.getToken();
    if (!token) throw new Error('没有可用的token，请运行 npm run login 获取token');

    const headers = buildHeaders(token);

    try {
        const data = await withRequesterFallback(async currentUseAxios => withRetry(async () => {
            if (currentUseAxios) {
                return (await axios(buildAxiosConfig(config.api.modelsUrl, headers, {}))).data;
            }

            const response = await requester.antigravity_fetch(config.api.modelsUrl, buildRequesterConfig(headers, {}));
            const bodyText = await response.text();
            const embeddedError = detectEmbeddedError(bodyText);

            if (response.status !== 200 || embeddedError) {
                throw {
                    status: embeddedError?.status ?? response.status,
                    message: embeddedError?.message ?? bodyText,
                    retryDelayMs: embeddedError?.retryDelayMs,
                    disableToken: embeddedError?.disableToken
                };
            }

            return JSON.parse(bodyText);
        }, token));

        return {
            object: 'list',
            data: Object.keys(data.models).map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'google'
            }))
        };
    } catch (error) {
        await handleApiError(error, token);
    }
}

export async function generateAssistantResponseNoStream(requestBody, token) {

    const headers = buildHeaders(token);
    let data;

    try {
        data = await withRequesterFallback(async currentUseAxios => withRetry(async () => {
            if (currentUseAxios) {
                return (await axios(buildAxiosConfig(config.api.noStreamUrl, headers, requestBody))).data;
            }

            const response = await requester.antigravity_fetch(config.api.noStreamUrl, buildRequesterConfig(headers, requestBody));
            const bodyText = await response.text();
            const embeddedError = detectEmbeddedError(bodyText);

            if (response.status !== 200 || embeddedError) {
                throw {
                    status: embeddedError?.status ?? response.status,
                    message: embeddedError?.message ?? bodyText,
                    retryDelayMs: embeddedError?.retryDelayMs,
                    disableToken: embeddedError?.disableToken
                };
            }

            return JSON.parse(bodyText);
        }, token));
    } catch (error) {
        await handleApiError(error, token);
    }

    // 解析响应内容
    const parts = data.response?.candidates?.[0]?.content?.parts || [];
    const usage = toOpenAiUsage(data.response?.usageMetadata);
    let content = '';
    let thinkingContent = '';
    const toolCalls = [];
    const imageUrls = [];

    for (const part of parts) {
        if (part.thought === true) {
            thinkingContent += part.text || '';
        } else if (part.text !== undefined) {
            content += part.text;
        } else if (part.functionCall) {
            toolCalls.push(convertToToolCall(part.functionCall));
        } else if (part.inlineData) {
            // 保存图片到本地并获取 URL
            const imageUrl = saveBase64Image(part.inlineData.data, part.inlineData.mimeType);
            imageUrls.push(imageUrl);
        }
    }

    // 拼接思维链标签
    if (thinkingContent) {
        content = `<think>\n${thinkingContent}\n</think>\n${content}`;
    }

    // 生图模型：转换为 markdown 格式
    if (imageUrls.length > 0) {
        let markdown = content ? content + '\n\n' : '';
        markdown += imageUrls.map(url => `![image](${url})`).join('\n\n');
        return { content: markdown, toolCalls };
    }

    return { content, toolCalls, usage };
}

export function closeRequester() {
    if (requester) requester.close();
}

export async function streamGeminiContent(model, requestBody, token, onChunk) {
    const headers = buildHeaders(token);
    const payload = buildGeminiRequest(model, requestBody, token);

    try {
        await withRequesterFallback(async currentUseAxios => withRetry(async () => {
            if (currentUseAxios) {
                const axiosConfig = { ...buildAxiosConfig(config.api.url, headers, payload), responseType: 'stream' };
                const response = await axios(axiosConfig);

                response.data.on('data', chunk => onChunk(chunk.toString()));
                await new Promise((resolve, reject) => {
                    response.data.on('end', resolve);
                    response.data.on('error', reject);
                });
                return;
            }

            const streamResponse = requester.antigravity_fetchStream(
                config.api.url,
                buildRequesterConfig(headers, payload)
            );
            let errorBody = '';
            let statusCode = null;

            await new Promise((resolve, reject) => {
                streamResponse
                    .onStart(({ status }) => {
                        statusCode = status;
                    })
                    .onData(chunk => (statusCode !== 200 ? (errorBody += chunk) : onChunk(chunk)))
                    .onEnd(() => (statusCode !== 200 ? reject({ status: statusCode, message: errorBody }) : resolve()))
                    .onError(reject);
            });
        }, token));
    } catch (error) {
        await handleApiError(error, token);
    }
}

export async function generateGeminiContent(model, requestBody, token) {
    const headers = buildHeaders(token);
    const payload = buildGeminiRequest(model, requestBody, token);

    try {
        return await withRequesterFallback(async currentUseAxios => withRetry(async () => {
            if (currentUseAxios) {
                return (await axios(buildAxiosConfig(config.api.noStreamUrl, headers, payload))).data;
            }

            const response = await requester.antigravity_fetch(
                config.api.noStreamUrl,
                buildRequesterConfig(headers, payload)
            );
            const bodyText = await response.text();
            const embeddedError = detectEmbeddedError(bodyText);

            if (response.status !== 200 || embeddedError) {
                throw {
                    status: embeddedError?.status ?? response.status,
                    message: embeddedError?.message ?? bodyText,
                    retryDelayMs: embeddedError?.retryDelayMs,
                    disableToken: embeddedError?.disableToken
                };
            }
            return JSON.parse(bodyText);
        }, token));
    } catch (error) {
        await handleApiError(error, token);
    }
}
