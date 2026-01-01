import axios from 'axios';
import tokenManager from '../auth/token_manager.js';
import modelCooldownManager from '../auth/model_cooldown_manager.js';
import config from '../config/config.js';
import { log } from '../utils/logger.js';
import { generateRequestId, generateToolCallId } from '../utils/idGenerator.js';
import AntigravityRequester from '../AntigravityRequester.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import { registerTextThoughtSignature, registerThoughtSignature } from '../utils/utils.js';

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

        // 支持两种格式：
        // 1. { "error": { "code": 429, ... } } - 标准格式
        // 2. { "code": 429, "status": "RESOURCE_EXHAUSTED", ... } - 直接格式
        let errorObj = null;

        if (parsed?.error) {
            errorObj = parsed.error;
        } else if (parsed?.code || parsed?.status) {
            // 直接格式：{ "code": 429, "status": "RESOURCE_EXHAUSTED", "message": "..." }
            errorObj = parsed;
        }

        if (!errorObj) return null;

        const status = statusFromStatusText(errorObj.code || errorObj.status);
        const retryDelayMs = parseRetryDelayMs(errorObj, errorObj.message || body);

        // 提取模型冷却信息
        let modelCooldown = null;
        if (status === 429 && errorObj.details && Array.isArray(errorObj.details)) {
            const errorInfo = errorObj.details.find(
                detail => typeof detail === 'object' && detail['@type']?.includes('ErrorInfo')
            );
            if (errorInfo?.metadata) {
                const model = errorInfo.metadata.model;
                const resetTimestamp = errorInfo.metadata.quotaResetTimeStamp;
                if (model) {
                    modelCooldown = {
                        model,
                        resetTimestamp: resetTimestamp || null,
                        reason: errorInfo.reason || 'RESOURCE_EXHAUSTED'
                    };
                }
            }
        }

        return {
            status,
            message: JSON.stringify(errorObj, null, 2),
            retryDelayMs,
            disableToken: status === 401,
            modelCooldown
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
    let modelCooldown = error?.modelCooldown || null;

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
        modelCooldown = embeddedError.modelCooldown ?? modelCooldown;
        message = embeddedError.message;
    }

    return {
        status: status ?? 'Unknown',
        message,
        retryDelayMs,
        disableToken,
        modelCooldown
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(operationFactory, initialToken, requestModel = null) {
    const maxTokenSwitches = Math.max(config.retry?.maxAttempts || 3, 1);
    const retryStatusCodes = config.retry?.statusCodes?.length
        ? config.retry.statusCodes
        : [429, 500];
    const maxAttemptsPerToken = 2; // 每个token最多尝试2次（首次 + 1次重试）

    let currentToken = initialToken;
    let tokenAttempts = 0; // 当前token的尝试次数
    let tokenSwitches = 0; // 已切换token的次数
    const triedProjectIds = new Set([currentToken.projectId]);
    let lastError = null;

    log.info(`[withRetry] 开始请求，maxTokenSwitches=${maxTokenSwitches}, retryStatusCodes=${retryStatusCodes.join(',')}, model=${requestModel || 'unknown'}`);

    while (tokenSwitches < maxTokenSwitches) {
        try {
            return await operationFactory(currentToken);
        } catch (error) {
            lastError = error;
            const details = await extractErrorDetails(error);

            log.warn(`[withRetry] 请求失败，status=${details.status}, tokenAttempts=${tokenAttempts}, tokenSwitches=${tokenSwitches}`);

            if (details.disableToken || details.status === 401) {
                log.warn(`[withRetry] Token需要禁用 (status=${details.status}, disableToken=${details.disableToken})`);
                tokenManager.disableCurrentToken(currentToken);
                throw error;
            }

            const is429 = details.status === 429;
            const shouldRetry = retryStatusCodes.includes(details.status);

            log.info(`[withRetry] is429=${is429}, shouldRetry=${shouldRetry}`);

            if (!shouldRetry) {
                log.warn(`[withRetry] 状态码 ${details.status} 不在重试列表中，直接抛出错误`);
                throw error;
            }

            // 处理 429 错误中的模型冷却信息
            if (is429 && details.modelCooldown) {
                const { model, resetTimestamp, reason } = details.modelCooldown;
                const cooldownModel = model || requestModel;

                if (cooldownModel && resetTimestamp) {
                    // 先查询额度，判断是临时限流还是真的耗尽
                    let quotaRemaining = 0;
                    try {
                        const { getModelsWithQuotas } = await import('../api/client.js');
                        const quotas = await getModelsWithQuotas(currentToken);
                        const group = modelCooldownManager.getModelGroup ? 
                            (await import('../auth/model_cooldown_manager.js')).getModelGroup(cooldownModel) : null;
                        
                        if (group) {
                            const { getModelsInGroup } = await import('../auth/model_cooldown_manager.js');
                            const groupModels = getModelsInGroup(group);
                            let total = 0, count = 0;
                            for (const m of groupModels) {
                                if (quotas[m]) { total += quotas[m].remaining || 0; count++; }
                            }
                            quotaRemaining = count > 0 ? total / count : 0;
                        } else if (quotas[cooldownModel]) {
                            quotaRemaining = quotas[cooldownModel].remaining || 0;
                        }
                    } catch (e) {
                        log.warn(`[withRetry] 查询额度失败: ${e.message}`);
                    }

                    // 额度 > 1% 且是首次尝试，等待后重试同一账号
                    if (quotaRemaining > 0.01 && tokenAttempts === 0) {
                        tokenAttempts += 1;
                        const delayMs = Math.min(details.retryDelayMs || 2000, 5000);
                        log.info(`[withRetry] 额度还有 ${(quotaRemaining * 100).toFixed(1)}%，等待 ${delayMs}ms 后重试同一账号`);
                        await delay(delayMs);
                        continue;
                    }

                    // 额度为0或重试后仍失败，设置冷却并切换账号
                    await modelCooldownManager.setCooldown(
                        currentToken.projectId,
                        cooldownModel,
                        resetTimestamp,
                        reason,
                        currentToken
                    );
                    log.info(`[withRetry] 模型 ${cooldownModel} 在账号 ${currentToken.projectId} 上已设置冷却，将于 ${resetTimestamp} 解禁`);

                    // 尝试获取其他有该模型额度的账号
                    const nextToken = await modelCooldownManager.getAvailableTokenForModel(
                        cooldownModel,
                        Array.from(triedProjectIds)
                    );

                    if (nextToken && !triedProjectIds.has(nextToken.projectId)) {
                        triedProjectIds.add(nextToken.projectId);
                        currentToken = nextToken;
                        tokenAttempts = 0;
                        tokenSwitches += 1;
                        log.info(`[withRetry] 已切换到账号 ${nextToken.projectId}，该账号的模型 ${cooldownModel} 未冷却 (第${tokenSwitches}次切换)`);
                        continue;
                    } else {
                        // 所有账号都不可用，返回友好提示
                        const groupName = (await import('../auth/model_cooldown_manager.js')).getModelGroup(cooldownModel) || cooldownModel;
                        log.warn(`[withRetry] 所有账号的模型 ${cooldownModel} 都已冷却或尝试过，无法继续`);
                        throw new Error(`${groupName} 模块下所有账号额度已耗尽，请等待额度重置后再试`);
                    }
                }
            }

            tokenAttempts += 1;

            // 429错误：当前token已重试1次后，切换到下一个token
            if (is429 && tokenAttempts >= maxAttemptsPerToken) {
                log.info(`[withRetry] 429错误，当前token已重试${tokenAttempts}次，尝试切换到下一个token...`);
                tokenManager.moveToNextToken();
                const nextToken = await tokenManager.getToken(requestModel);

                if (!nextToken) {
                    log.warn('[withRetry] 没有可用的token了');
                    throw error;
                }

                // 检查是否已经尝试过这个token（避免循环）
                if (triedProjectIds.has(nextToken.projectId)) {
                    log.warn('[withRetry] 所有token都已尝试过，仍然失败');
                    throw error;
                }

                triedProjectIds.add(nextToken.projectId);
                currentToken = nextToken;
                tokenAttempts = 0;
                tokenSwitches += 1;
                log.info(`[withRetry] 已切换到新token (第${tokenSwitches}次切换)`);
                continue;
            }

            // 其他可重试错误或429首次重试：等待后重试
            const delayMs = details.retryDelayMs ?? Math.min(1000 * tokenAttempts, 5000);
            log.info(`[withRetry] ${details.status}错误，等待${delayMs}ms后重试 (当前token第${tokenAttempts + 1}次尝试)`);
            await delay(delayMs);
        }
    }

    log.error('[withRetry] 所有token都已尝试，仍然失败');
    throw lastError || new Error('所有token都已尝试，仍然失败');
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

function flushTextAccumulator(state) {
    if (!state?.textAccumulator) return;
    const { text, signature } = state.textAccumulator;
    if (text && signature) {
        registerTextThoughtSignature(text, signature);
    }
    state.textAccumulator = { text: '', signature: null };
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
                    // 思维链内容 - 直接发送
                    if (part.text) {
                        callback({ type: 'thinking', content: part.text });
                    }
                    // 思维阶段的中间图片，跳过（只发送最终图片）
                } else if (part.text !== undefined) {
                    if (part.thoughtSignature) {
                        registerTextThoughtSignature(part.text, part.thoughtSignature);
                        state.textAccumulator.signature = part.thoughtSignature;
                    }
                    state.textAccumulator.text += part.text || '';
                    callback({ type: 'text', content: part.text });
                } else if (part.functionCall) {
                    // 工具调用
                    state.toolCalls.push(convertToToolCallWithSignature(part.functionCall, part.thoughtSignature));
                } else if (part.inlineData) {
                    // 图片数据
                    const imageUrl = saveBase64Image(part.inlineData.data, part.inlineData.mimeType);
                    callback({
                        type: 'image',
                        url: imageUrl,
                        mimeType: part.inlineData.mimeType,
                        data: part.inlineData.data,
                        thought: part.thought === true
                    });
                }
            }
        }

        // 响应结束时发送工具调用
        if (data.response?.candidates?.[0]?.finishReason) {
            flushTextAccumulator(state);
            if (state.toolCalls.length > 0) {
                callback({ type: 'tool_calls', tool_calls: state.toolCalls });
                state.toolCalls = [];
            }
        }
    } catch (e) {
        // 忽略 JSON 解析错误
    }
}

// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback) {

    const state = { toolCalls: [], usage: null, textAccumulator: { text: '', signature: null } };
    let buffer = ''; // 缓冲区：处理跨 chunk 的不完整行
    let streamChunks = []; // 收集流式响应（用于 debug=high 日志）

    const processChunk = (chunk) => {
        buffer += chunk;
        streamChunks.push(chunk); // 收集响应片段
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留最后一行（可能不完整）
        lines.forEach(line => parseAndEmitStreamChunk(line, state, callback));
    };

    // 记录后端请求
    const startTime = Date.now();
    log.backend({
        type: 'request',
        url: config.api.url,
        method: 'POST',
        headers: buildHeaders(token),
        body: requestBody
    });

    try {
        await withRequesterFallback(async currentUseAxios => withRetry(async (currentToken) => {
            const headers = buildHeaders(currentToken);
            buffer = ''; // 重置缓冲区以防重试

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

        // 记录后端响应（成功）
        log.backend({
            type: 'response',
            status: 200,
            durationMs: Date.now() - startTime,
            body: streamChunks.join('')
        });
    } catch (error) {
        // 记录后端响应（失败）
        log.backend({
            type: 'response',
            status: error?.status || 'Error',
            durationMs: Date.now() - startTime,
            body: error?.message || error
        });
        await handleApiError(error, token);
    }

    return { usage: state.usage };
}

export async function getAvailableModels() {
    const token = await tokenManager.getToken();
    if (!token) throw new Error('没有可用的token，请运行 npm run login 获取token');

    const headers = buildHeaders(token);
    const requestBody = {};

    // 记录后端请求
    const startTime = Date.now();
    log.backend({
        type: 'request',
        url: config.api.modelsUrl,
        method: 'POST',
        headers,
        body: requestBody
    });

    try {
        const data = await withRequesterFallback(async currentUseAxios => withRetry(async (currentToken) => {
            const currentHeaders = buildHeaders(currentToken);

            if (currentUseAxios) {
                return (await axios(buildAxiosConfig(config.api.modelsUrl, currentHeaders, {}))).data;
            }

            const response = await requester.antigravity_fetch(config.api.modelsUrl, buildRequesterConfig(currentHeaders, {}));
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

        // 记录后端响应（成功）
        log.backend({
            type: 'response',
            status: 200,
            durationMs: Date.now() - startTime,
            body: data
        });

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
        // 记录后端响应（失败）
        log.backend({
            type: 'response',
            status: error?.status || 'Error',
            durationMs: Date.now() - startTime,
            body: error?.message || error
        });
        await handleApiError(error, token);
    }
}

// 内部复用的非流式请求封装，返回上游原始 JSON，方便不同上层按需解析
async function callNoStreamApi(requestBody, token) {
    const headers = buildHeaders(token);

    // 记录后端请求
    const startTime = Date.now();
    log.backend({
        type: 'request',
        url: config.api.noStreamUrl,
        method: 'POST',
        headers,
        body: requestBody
    });

    try {
        const data = await withRequesterFallback(async currentUseAxios =>
            withRetry(async (currentToken) => {
                const currentHeaders = buildHeaders(currentToken);

                if (currentUseAxios) {
                    return (await axios(buildAxiosConfig(config.api.noStreamUrl, currentHeaders, requestBody))).data;
                }

                const response = await requester.antigravity_fetch(
                    config.api.noStreamUrl,
                    buildRequesterConfig(currentHeaders, requestBody)
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
            }, token)
        );

        // 记录后端响应（成功）
        log.backend({
            type: 'response',
            status: 200,
            durationMs: Date.now() - startTime,
            body: data
        });

        return data;
    } catch (error) {
        // 记录后端响应（失败）
        log.backend({
            type: 'response',
            status: error?.status || 'Error',
            durationMs: Date.now() - startTime,
            body: error?.message || error
        });
        throw error;
    }
}

export async function generateAssistantResponseNoStream(requestBody, token) {

    let data;
    let aggregatedText = '';
    let aggregatedTextSignature = null;

    try {
        data = await callNoStreamApi(requestBody, token);
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
            if (part.thoughtSignature) {
                registerTextThoughtSignature(part.text, part.thoughtSignature);
                aggregatedTextSignature = part.thoughtSignature;
            }
            aggregatedText += part.text || '';
            content += part.text;
        } else if (part.functionCall) {
            toolCalls.push(convertToToolCallWithSignature(part.functionCall, part.thoughtSignature));
        } else if (part.inlineData) {
            // 保存图片到本地并获取 URL
            const imageUrl = saveBase64Image(part.inlineData.data, part.inlineData.mimeType);
            imageUrls.push(imageUrl);
        }
    }

    // 拼接思维链标签（用于非图像模型的普通响应）
    if (thinkingContent && imageUrls.length === 0) {
        content = `<think>\n${thinkingContent}\n</think>\n${content}`;
    }
    if (aggregatedText && aggregatedTextSignature) {
        registerTextThoughtSignature(aggregatedText, aggregatedTextSignature);
    }

    // 生图模型：转换为 markdown 格式，并返回独立的 thinking 字段
    if (imageUrls.length > 0) {
        let markdown = content ? content + '\n\n' : '';
        markdown += imageUrls.map(url => `![image](${url})`).join('\n\n');
        return { content: markdown, toolCalls, thinking: thinkingContent || null };
    }

    return { content, toolCalls, usage };
}

// 直接返回原始 Gemini 风格响应（用于 Gemini 兼容接口）
export async function generateGeminiResponseNoStream(requestBody, token) {
    try {
        const data = await callNoStreamApi(requestBody, token);
        // 上游返回通常为 { response: { ... } } 结构，这里只透传内部 response
        return data?.response ?? data;
    } catch (error) {
        await handleApiError(error, token);
    }
}

export function closeRequester() {
    if (requester) requester.close();
}
