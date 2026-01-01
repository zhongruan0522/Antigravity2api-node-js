import config from '../config/config.js';
import { generateRequestId } from './idGenerator.js';

/**
 * 直接将 Claude Messages API 格式转换为 Gemini/Vertex AI 格式
 * 跳过中间的 OpenAI 转换层
 *
 * Claude 格式参考: https://docs.anthropic.com/claude/reference/messages_post
 * Gemini 格式参考: https://ai.google.dev/api/generate-content
 */

// 全局思维签名缓存：用于 Gemini 3.x 系列
const thoughtSignatureMap = new Map();
const textThoughtSignatureMap = new Map();

/**
 * 注册工具调用的思维签名
 */
function registerThoughtSignature(id, thoughtSignature) {
  if (!id || !thoughtSignature) return;
  thoughtSignatureMap.set(id, thoughtSignature);
}

/**
 * 获取工具调用的思维签名
 */
function getThoughtSignature(id) {
  if (!id) return undefined;
  return thoughtSignatureMap.get(id);
}

/**
 * 规范化文本用于签名匹配
 */
function normalizeTextForSignature(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * 注册文本的思维签名
 */
function registerTextThoughtSignature(text, thoughtSignature) {
  if (!text || !thoughtSignature) return;
  const originalText = typeof text === 'string' ? text : String(text);
  const trimmed = originalText.trim();
  const normalized = normalizeTextForSignature(trimmed);
  const payload = { signature: thoughtSignature, text: originalText };

  if (originalText) {
    textThoughtSignatureMap.set(originalText, payload);
  }
  if (normalized) {
    textThoughtSignatureMap.set(normalized, payload);
  }
  if (trimmed && trimmed !== normalized) {
    textThoughtSignatureMap.set(trimmed, payload);
  }
}

/**
 * 获取文本的思维签名
 */
function getTextThoughtSignature(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  if (textThoughtSignatureMap.has(text)) {
    return textThoughtSignatureMap.get(text);
  }
  const trimmed = text.trim();
  if (textThoughtSignatureMap.has(trimmed)) {
    return textThoughtSignatureMap.get(trimmed);
  }
  const normalized = normalizeTextForSignature(trimmed);
  if (!normalized) return undefined;
  return textThoughtSignatureMap.get(normalized);
}

/**
 * 清理 JSON Schema 中 Gemini 不支持的字段
 */
function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const validationFields = {
    'minLength': 'minLength',
    'maxLength': 'maxLength',
    'minimum': 'minimum',
    'maximum': 'maximum',
    'minItems': 'minItems',
    'maxItems': 'maxItems',
    'minProperties': 'minProperties',
    'maxProperties': 'maxProperties',
    'pattern': 'pattern',
    'format': 'format',
    'multipleOf': 'multipleOf'
  };

  const fieldsToRemove = new Set([
    '$schema',
    'additionalProperties',
    'uniqueItems',
    'exclusiveMinimum',
    'exclusiveMaximum'
  ]);

  const collectValidations = (obj) => {
    const validations = [];

    for (const [field, value] of Object.entries(validationFields)) {
      if (field in obj) {
        validations.push(`${field}: ${value}`);
        delete obj[field];
      }
    }

    for (const field of fieldsToRemove) {
      if (field in obj) {
        if (field === 'additionalProperties' && obj[field] === false) {
          validations.push('no additional properties');
        }
        delete obj[field];
      }
    }

    return validations;
  };

  const cleanObject = (obj, path = '') => {
    if (Array.isArray(obj)) {
      return obj.map(item => typeof item === 'object' ? cleanObject(item, path) : item);
    } else if (obj && typeof obj === 'object') {
      const validations = collectValidations(obj, path);

      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        if (fieldsToRemove.has(key)) continue;
        if (key in validationFields) continue;

        if (key === 'description' && validations.length > 0 && path === '') {
          cleaned[key] = `${value || ''} (${validations.join(', ')})`.trim();
        } else {
          cleaned[key] = typeof value === 'object' ? cleanObject(value, `${path}.${key}`) : value;
        }
      }

      if (cleaned.required && Array.isArray(cleaned.required)) {
        if (cleaned.properties && typeof cleaned.properties === 'object') {
          const validProps = Object.keys(cleaned.properties);
          cleaned.required = cleaned.required.filter(prop => validProps.includes(prop));
        }
        if (cleaned.required.length === 0) {
          delete cleaned.required;
        }
      }

      return cleaned;
    }
    return obj;
  };

  return cleanObject(schema);
}

/**
 * 根据内容类型决定签名放置位置
 * 优先级：functionCall > text > thinking
 * 确保单轮对话中只有一个 Part 携带 thoughtSignature
 */
function applySignatureToParts(parts, signature) {
  // 优先级 1: 有 functionCall → 放在第一个 functionCall
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].functionCall) {
      parts[i].thoughtSignature = signature;
      return;
    }
  }

  // 优先级 2: 纯文本 → 放在最后一个非 thinking 的 text
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) {
      parts[i].thoughtSignature = signature;
      return;
    }
  }

  // 优先级 3: 只有 thinking → 放在最后一个 thinking
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].thought) {
      parts[i].thoughtSignature = signature;
      return;
    }
  }
}

/**
 * 将 Claude 的 content block 转换为 Gemini parts
 * 参考 Go 版本的两阶段处理：
 * 1. 第一阶段：解析所有内容块，提取 thinking 签名
 * 2. 第二阶段：根据内容类型决定签名放置位置（优先级：functionCall > text > thinking）
 */
function convertClaudeContentToGeminiParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ text: String(content) }];
  }

  const parts = [];
  let thinkingSignature = ''; // 从 thinking 块提取的签名

  // 第一阶段：解析所有内容块，提取签名
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    switch (block.type) {
      case 'text':
        if (block.text) {
          parts.push({ text: block.text });
        }
        break;

      case 'image':
        // Claude 图片格式: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
        if (block.source?.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type || 'image/png',
              data: block.source.data
            }
          });
        } else if (block.source?.type === 'url') {
          console.warn('Gemini does not support image URLs, skipping image block');
        }
        break;

      case 'thinking':
        // Claude 思考块: { type: "thinking", thinking: "...", signature: "..." }
        // 只取第一个非空签名
        if (block.signature && !thinkingSignature) {
          thinkingSignature = block.signature;
        }
        if (block.thinking) {
          parts.push({ text: block.thinking, thought: true });
        }
        break;

      case 'redacted_thinking':
        // Claude 隐藏的思考块
        parts.push({ text: '[思考内容已隐藏]', thought: true });
        break;

      case 'tool_use':
        // Claude 工具调用: { type: "tool_use", id: "...", name: "...", input: {...} }
        parts.push({
          functionCall: {
            id: block.id,
            name: block.name,
            args: block.input || {}
          }
        });
        break;

      case 'tool_result':
        // Claude 工具结果: { type: "tool_result", tool_use_id: "...", content: "...", is_error: false }
        const isError = block.is_error === true;
        let contentStr = '';

        // 提取工具结果内容
        if (typeof block.content === 'string') {
          contentStr = block.content;
        } else if (Array.isArray(block.content)) {
          // content 可能是数组：[{ type: "text", text: "..." }]
          contentStr = block.content
            .filter(item => item?.type === 'text')
            .map(item => item.text || '')
            .join('\n');
        } else if (block.content && typeof block.content === 'object') {
          contentStr = JSON.stringify(block.content);
        }

        // 直接传递原始字符串，不做 JSON 解析（工具已经处理过格式了）
        const response = {};
        if (isError) {
          response.error = contentStr;
        } else {
          response.result = contentStr;
        }

        parts.push({
          functionResponse: {
            id: block.tool_use_id,
            name: '', // 需要从历史中查找
            response
          }
        });
        break;

      default:
        console.warn(`Unknown Claude content block type: ${block.type}`);
    }
  }

  // 第二阶段：根据内容类型决定签名放置位置（只放一处）
  if (thinkingSignature) {
    applySignatureToParts(parts, thinkingSignature);
  }

  return parts;
}

/**
 * 将 Claude messages 转换为 Gemini contents
 * @param {Array} claudeMessages - Claude 格式的消息数组
 * @param {string} modelName - 模型名称
 * @returns {Object} { contents: Array, shouldDisableThinking: boolean }
 */
function convertClaudeMessagesToGeminiContents(claudeMessages, modelName) {
  const contents = [];
  const allowThoughtSignature = typeof modelName === 'string' && modelName.includes('gemini-3');
  let shouldDisableThinking = false;

  for (const message of claudeMessages) {
    if (!message || !message.role) continue;

    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = convertClaudeContentToGeminiParts(message.content);

    // 处理 thinking block (如果有)
    if (allowThoughtSignature && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'thinking' && block.thinking) {
          registerTextThoughtSignature(block.thinking, block.thinking);
        }
      }
    }

    // 处理 tool_result 时需要找到对应的 tool name
    if (role === 'user') {
      for (const part of parts) {
        if (part.functionResponse && !part.functionResponse.name) {
          // 从之前的消息中查找对应的 functionCall
          for (let i = contents.length - 1; i >= 0; i--) {
            if (contents[i].role === 'model') {
              for (const prevPart of contents[i].parts || []) {
                if (prevPart.functionCall?.id === part.functionResponse.id) {
                  part.functionResponse.name = prevPart.functionCall.name;
                  break;
                }
              }
              if (part.functionResponse.name) break;
            }
          }
        }
      }
    }

    // 合并相同角色的连续消息
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === role) {
      lastContent.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  // Claude Extended Thinking 要求：最后一条 assistant 消息必须以 thinking block 开头
  // 如果最后一条 model 消息没有 thinking block，我们需要禁用 thinking
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === 'rev19-uic3-1p' ||
    modelName === 'gpt-oss-120b-medium' ||
    modelName.includes('claude');

  if (enableThinking) {
    // 检查历史消息中是否有不带 signature 的 thinking block
    // 如果有，说明这是客户端发来的历史对话，应该禁用 thinking
    for (const claudeMessage of claudeMessages) {
      if (claudeMessage.role === 'assistant' && Array.isArray(claudeMessage.content)) {
        for (const block of claudeMessage.content) {
          if (block?.type === 'thinking' && !block.signature) {
            // 发现不带 signature 的 thinking block，禁用 thinking
            shouldDisableThinking = true;
            break;
          }
        }
        if (shouldDisableThinking) break;
      }
    }

    // 如果没有历史 thinking 问题，再检查最后一条 model 消息
    if (!shouldDisableThinking) {
      // 从后往前找最后一条 model 消息
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i].role === 'model') {
          const parts = contents[i].parts || [];
          // 检查第一个 part 是否是 thinking
          if (parts.length > 0) {
            const hasThinking = parts.some(p => p.thought);
            if (!hasThinking) {
              // 完全没有 thinking，禁用 thinking 功能
              shouldDisableThinking = true;
            } else if (!parts[0].thought) {
              // 有 thinking 但不在开头，重新排序：thinking parts 移到前面
              const thinkingParts = parts.filter(p => p.thought);
              const otherParts = parts.filter(p => !p.thought);
              contents[i].parts = [...thinkingParts, ...otherParts];
            }
          }
          break; // 只处理最后一条 model 消息
        }
      }
    }
  }

  return { contents, shouldDisableThinking };
}

/**
 * 将 Claude tools 转换为 Gemini tools
 */
function convertClaudeToolsToGeminiTools(claudeTools) {
  if (!Array.isArray(claudeTools) || claudeTools.length === 0) {
    return [];
  }

  return claudeTools.map(tool => ({
    functionDeclarations: [{
      name: tool.name,
      description: tool.description,
      parameters: cleanJsonSchema(tool.input_schema || {})
    }]
  }));
}

/**
 * 生成 Gemini generationConfig
 */
function generateGenerationConfig(claudeRequest, modelName, forceDisableThinking = false) {
  const enableThinking = !forceDisableThinking && (
    modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === 'rev19-uic3-1p' ||
    modelName === 'gpt-oss-120b-medium'
  );

  const generationConfig = {
    topP: claudeRequest.top_p ?? config.defaults.top_p,
    topK: claudeRequest.top_k ?? config.defaults.top_k,
    temperature: claudeRequest.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: claudeRequest.max_tokens ?? config.defaults.max_tokens,
    stopSequences: claudeRequest.stop_sequences || [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  };

  // Claude 模型删除 topP
  if (enableThinking && modelName.includes('claude')) {
    delete generationConfig.topP;
  }

  return generationConfig;
}

/**
 * 将 Claude Messages API 请求转换为 Gemini/Vertex AI 请求
 * @param {Object} claudeRequest - Claude 格式的请求体
 * @param {Object} token - 认证 token
 * @returns {Object} Gemini/Vertex AI 格式的请求体
 */
export function convertClaudeToGeminiRequest(claudeRequest, token) {
  const {
    model,
    messages,
    system,
    tools,
    max_tokens,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    stream = false,
    thinking
  } = claudeRequest;

  // 基础验证
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages 不能为空');
  }

  // 针对 Claude 模型自动补全 max_tokens(64000 是官网拉取的结果)
  let finalMaxTokens = max_tokens;
  if (typeof finalMaxTokens !== 'number' || Number.isNaN(finalMaxTokens)) {
    finalMaxTokens = 64000;
  }

  // 更新 claudeRequest.max_tokens 为补全后的值,供后续 generateGenerationConfig 使用
  claudeRequest.max_tokens = finalMaxTokens;

  const actualModelName = model || 'gemini-2.0-flash-exp';

  // 转换 messages
  const { contents, shouldDisableThinking } = convertClaudeMessagesToGeminiContents(messages, actualModelName);

  // Claude 模型需要移除 thoughtSignature
  if (actualModelName.includes('claude')) {
    for (const content of contents) {
      if (!content?.parts) continue;
      for (const part of content.parts) {
        if (part && Object.prototype.hasOwnProperty.call(part, 'thoughtSignature')) {
          delete part.thoughtSignature;
        }
      }
    }
  }

  // 处理 system instruction
  let systemInstruction = {
    role: 'user',
    parts: [{ text: config.systemInstruction }]
  };

  if (system) {
    let systemText = '';
    if (Array.isArray(system)) {
      systemText = system
        .map(block => {
          if (typeof block === 'string') return block;
          if (block?.type === 'text') return block.text || '';
          return '';
        })
        .join('\n');
    } else if (typeof system === 'string') {
      systemText = system;
    }

    if (systemText) {
      systemInstruction.parts[0].text = systemText;
    }
  }

  // 转换 tools
  const geminiTools = convertClaudeToolsToGeminiTools(tools);

  // 生成配置 - 如果最后一条 assistant 没有 thinking，则禁用 thinking
  const generationConfig = generateGenerationConfig(claudeRequest, actualModelName, shouldDisableThinking);

  // 组装最终请求
  const request = {
    contents,
    systemInstruction,
    tools: geminiTools.length > 0 ? geminiTools : undefined,
    toolConfig: geminiTools.length > 0 ? {
      functionCallingConfig: {
        mode: 'VALIDATED'
      }
    } : undefined,
    generationConfig,
    sessionId: token.sessionId
  };

  return {
    project: token.projectId,
    requestId: generateRequestId(),
    request,
    model: actualModelName,
    userAgent: 'antigravity'
  };
}

/**
 * ==============================================
 * 以下为从 claudeAdapter.js 迁移的工具函数
 * 用于支持 Claude SSE 流式响应和 Token 统计
 * ==============================================
 */

/**
 * 估算文本的 Token 数量（粗略估算：字符数 / 4）
 */
export function estimateTokensFromText(text) {
  if (!text) return 0;
  const normalized = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.max(1, Math.ceil(normalized.length / 4));
}

/**
 * 从 Claude messages 中提取所有文本内容用于 token 统计
 */
function extractTextFromClaudeMessages(messages = []) {
  return messages
    .map(msg => {
      if (typeof msg?.content === 'string') return msg.content;
      if (!Array.isArray(msg?.content)) return '';
      return msg.content
        .map(block => {
          if (!block || typeof block !== 'object') return '';
          if (block.type === 'text') return block.text || '';
          if (block.type === 'thinking') return block.thinking || '';
          if (block.type === 'tool_use') {
            return `<invoke name="${block.name}">${JSON.stringify(block.input || {})}</invoke>`;
          }
          if (block.type === 'tool_result') {
            return `<tool_result id="${block.tool_use_id}">${block.content ?? ''}</tool_result>`;
          }
          return '';
        })
        .join('');
    })
    .join('\n');
}

/**
 * 统计 Claude 请求的 Token 数量（包括 messages、system、tools）
 */
export function countClaudeTokens(request) {
  if (!request || !Array.isArray(request.messages)) {
    throw new Error('messages 不能为空');
  }

  let totalText = extractTextFromClaudeMessages(request.messages);

  if (request.system) {
    const systemText = Array.isArray(request.system)
      ? request.system.map(block => (typeof block === 'string' ? block : block?.text || '')).join('\n')
      : request.system;
    totalText += `\n${systemText || ''}`;
  }

  if (request.tools && request.tools.length > 0) {
    totalText += `\n${JSON.stringify(request.tools)}`;
  }

  const inputTokens = estimateTokensFromText(totalText);

  return {
    input_tokens: inputTokens,
    token_count: inputTokens,
    tokens: inputTokens
  };
}

/**
 * 安全地解析 JSON 字符串
 */
function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string') return raw ?? fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * 将 OpenAI 格式的 tool_calls 转换为 Claude content blocks
 */
export function convertToolCallsToClaudeBlocks(toolCalls = []) {
  return (toolCalls || []).map(call => {
    const args = safeJsonParse(call?.function?.arguments, call?.function?.arguments || {});
    return {
      type: 'tool_use',
      id: call?.id || `toolu_${generateRequestId()}`,
      name: call?.function?.name || 'tool',
      input: args || {}
    };
  });
}

/**
 * 构建 Claude content blocks（用于非流式响应）
 */
export function buildClaudeContentBlocks(content, toolCalls = []) {
  const blocks = [];
  if (content) {
    blocks.push({ type: 'text', text: content });
  }
  if (toolCalls && toolCalls.length > 0) {
    blocks.push(...convertToolCallsToClaudeBlocks(toolCalls));
  }
  return blocks;
}

/**
 * 构建 message_start 事件的 payload
 */
function buildMessageStartPayload(requestId, model, inputTokens = 0) {
  return {
    type: 'message_start',
    message: {
      id: `msg_${requestId}`,
      type: 'message',
      role: 'assistant',
      model: model || 'claude-proxy',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0
      },
      content: [],
      stop_reason: null
    }
  };
}

/**
 * 写入 SSE 事件到响应流
 */
function writeSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Claude SSE 流式响应发送器
 * 用于模拟 Claude Messages API 的 SSE 事件流
 */
export class ClaudeSseEmitter {
  constructor(res, requestId, { model, inputTokens } = {}) {
    this.res = res;
    this.requestId = requestId || generateRequestId();
    this.model = model || 'claude-proxy';
    this.inputTokens = inputTokens || 0;
    this.nextIndex = 0;
    this.textBlockIndex = null;
    this.thinkingBlockIndex = null;
    this.finished = false;
    this.totalOutputTokens = 0;
  }

  start() {
    writeSSE(this.res, 'message_start', buildMessageStartPayload(this.requestId, this.model, this.inputTokens));
  }

  ensureTextBlock() {
    if (this.textBlockIndex !== null) return;
    this.textBlockIndex = this.nextIndex++;
    writeSSE(this.res, 'content_block_start', {
      type: 'content_block_start',
      index: this.textBlockIndex,
      content_block: { type: 'text', text: '' }
    });
  }

  ensureThinkingBlock() {
    if (this.thinkingBlockIndex !== null) return;
    this.thinkingBlockIndex = this.nextIndex++;
    writeSSE(this.res, 'content_block_start', {
      type: 'content_block_start',
      index: this.thinkingBlockIndex,
      content_block: { type: 'thinking', thinking: '' }
    });
  }

  sendText(text) {
    if (!text) return;
    // 确保思考块先结束，避免与正文交叉
    this.closeThinkingBlock();
    this.ensureTextBlock();
    this.totalOutputTokens += estimateTokensFromText(text);
    writeSSE(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.textBlockIndex,
      delta: { type: 'text_delta', text }
    });
  }

  sendThinking(thinking) {
    if (!thinking) return;
    // thinking 到来时关闭已有正文块，避免嵌套
    this.closeTextBlock();
    this.ensureThinkingBlock();
    this.totalOutputTokens += estimateTokensFromText(thinking);
    writeSSE(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.thinkingBlockIndex,
      delta: { type: 'thinking_delta', thinking }
    });
  }

  async sendToolCalls(toolCalls = []) {
    if (!toolCalls || toolCalls.length === 0) return;
    await this.closeTextBlock();
    await this.closeThinkingBlock();

    toolCalls.forEach(call => {
      const index = this.nextIndex++;
      const args = call?.function?.arguments ?? '{}';
      const inputJson = typeof args === 'string' ? args : JSON.stringify(args);
      this.totalOutputTokens += estimateTokensFromText(inputJson);
      writeSSE(this.res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id || `toolu_${generateRequestId()}`,
          name: call?.function?.name || 'tool',
          input: {}
        }
      });
      writeSSE(this.res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: inputJson }
      });
      writeSSE(this.res, 'content_block_stop', { type: 'content_block_stop', index });
    });
  }

  async closeTextBlock() {
    if (this.textBlockIndex === null) return;
    const index = this.textBlockIndex;
    this.textBlockIndex = null;
    writeSSE(this.res, 'content_block_stop', { type: 'content_block_stop', index });
  }

  async closeThinkingBlock() {
    if (this.thinkingBlockIndex === null) return;
    const index = this.thinkingBlockIndex;
    this.thinkingBlockIndex = null;
    writeSSE(this.res, 'content_block_stop', { type: 'content_block_stop', index });
  }

  finish(usage) {
    if (this.finished) return;
    this.finished = true;
    this.closeTextBlock();
    this.closeThinkingBlock();

    const outputTokens =
      usage?.completion_tokens ??
      usage?.output_tokens ??
      (this.totalOutputTokens ?? 0);
    const inputTokens =
      usage?.prompt_tokens ??
      usage?.input_tokens ??
      (this.inputTokens ?? null);

    writeSSE(this.res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: outputTokens || 0
      }
    });
    writeSSE(this.res, 'message_stop', { type: 'message_stop' });
    this.res.end();
  }
}

/**
 * 导出思维签名相关函数供其他模块使用
 */
export {
  registerThoughtSignature,
  registerTextThoughtSignature,
  getTextThoughtSignature,
  getThoughtSignature
};
