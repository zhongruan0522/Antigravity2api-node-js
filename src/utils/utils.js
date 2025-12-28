import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';

// 全局思维签名缓存：用于记录 Gemini 返回的 thoughtSignature（工具调用与文本），
// 并在后续请求中复用，避免后端报缺失错误。
const thoughtSignatureMap = new Map();
const textThoughtSignatureMap = new Map();

function registerThoughtSignature(id, thoughtSignature) {
  if (!id || !thoughtSignature) return;
  thoughtSignatureMap.set(id, thoughtSignature);
}

function getThoughtSignature(id) {
  if (!id) return undefined;
  return thoughtSignatureMap.get(id);
}

function normalizeTextForSignature(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

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

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleToolCall(message, antigravityMessages) {
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }

  // 处理 content 可能是字符串或对象的情况
  let output = message.content;
  if (typeof output === 'object' && output !== null) {
    // 如果是对象，尝试提取文本内容
    output = output.text || JSON.stringify(output);
  } else if (Array.isArray(output)) {
    // 如果是数组，提取第一个文本元素
    const textItem = output.find(item => item?.type === 'text' || typeof item === 'string');
    output = textItem?.text || textItem || JSON.stringify(output);
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: output
      }
    }
  };

  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages, modelName) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === "user" || message.role === "system") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, modelName);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }

  return antigravityMessages;
}
function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
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
  }
  if (enableThinking && actualModelName.includes("claude")) {
    delete generationConfig.topP;
  }
  return generationConfig
}
function convertOpenAIToolsToAntigravity(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return [];

  return openaiTools.map((tool) => {
    // 复制一份参数对象，避免修改原始数据
    const parameters = tool.function.parameters ? { ...tool.function.parameters } : {};

    // 清理 JSON Schema，移除 Gemini 不支持的字段
    const cleanedParameters = cleanJsonSchema(parameters);

    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: cleanedParameters
        }
      ]
    };
  });
}

function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // 需要移除的验证字段
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

  // 需要完全移除的字段
  const fieldsToRemove = new Set([
    '$schema',
    'additionalProperties',
    'uniqueItems',
    'exclusiveMinimum',
    'exclusiveMaximum'
  ]);

  // 收集验证信息（从所有层级）
  const collectValidations = (obj, path = '') => {
    const validations = [];

    for (const [field, value] of Object.entries(validationFields)) {
      if (field in obj) {
        validations.push(`${field}: ${value}`);
        // 从对象中移除验证字段
        delete obj[field];
      }
    }

    // 移除特定字段
    for (const field of fieldsToRemove) {
      if (field in obj) {
        // 对于 additionalProperties，记录但不保留
        if (field === 'additionalProperties' && obj[field] === false) {
          validations.push('no additional properties');
        }
        delete obj[field];
      }
    }

    return validations;
  };

  // 递归清理嵌套对象
  const cleanObject = (obj, path = '') => {
    if (Array.isArray(obj)) {
      return obj.map(item => typeof item === 'object' ? cleanObject(item, path) : item);
    } else if (obj && typeof obj === 'object') {
      // 先收集当前层的验证信息
      const validations = collectValidations(obj, path);

      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        if (fieldsToRemove.has(key)) continue;
        if (key in validationFields) continue;

        if (key === 'description' && validations.length > 0 && path === '') {
          // 只在顶层追加验证要求
          cleaned[key] = `${value || ''} (${validations.join(', ')})`.trim();
        } else {
          cleaned[key] = typeof value === 'object' ? cleanObject(value, `${path}.${key}`) : value;
        }
      }

      // 处理 required 数组
      if (cleaned.required && Array.isArray(cleaned.required)) {
        // 过滤掉 required 中不存在于 properties 的属性
        if (cleaned.properties && typeof cleaned.properties === 'object') {
          const validProps = Object.keys(cleaned.properties);
          cleaned.required = cleaned.required.filter(prop => validProps.includes(prop));
        }
        // 确保 required 不为空数组
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
function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {

  const actualModelName = modelName;

  // 检测对话中是否已经存在带有 tool_calls 的 assistant 消息
  const hasAssistantToolCalls =
    Array.isArray(openaiMessages) &&
    openaiMessages.some(
      (msg) =>
        msg &&
        msg.role === 'assistant' &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0
    );

  // 基础的思维链启用逻辑：按模型名判断
  const baseEnableThinking =
    modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium";

  // 为避免 Anthropic thinking + tools 触发
  // “messages.*.content[0].type 必须是 thinking” 的报错，
  // 当使用 Claude 系列思维模型且历史中已出现工具调用时，关闭 thinking。
  const enableThinking =
    baseEnableThinking &&
    !(actualModelName.includes('claude') && hasAssistantToolCalls);

  // 先将 OpenAI 风格 messages 转换为 Antigravity/Gemini contents
  const contents = openaiMessageToAntigravity(openaiMessages, actualModelName);

  // 对 Claude 系列模型：当前不支持 thoughtSignature 字段，需剔除
  if (actualModelName.includes('claude')) {
    for (const msg of contents) {
      if (!msg?.parts) continue;
      for (const part of msg.parts) {
        if (part && Object.prototype.hasOwnProperty.call(part, 'thoughtSignature')) {
          delete part.thoughtSignature;
        }
      }
    }
  }

  return {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      systemInstruction: {
        role: "user",
        parts: [{ text: config.systemInstruction }]
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  }
}
function getDefaultIp() {
  const interfaces = os.networkInterfaces();
  if (interfaces.WLAN) {
    for (const inter of interfaces.WLAN) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  } else if (interfaces.wlan2) {
    for (const inter of interfaces.wlan2) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}

// 将 Gemini 原生 GenerateContentRequest 直接包装为 AntigravityRequester 所需的请求体
// 这样可以对外暴露 Gemini 规范，而内部仍复用同一套后端调用链
function generateRequestBodyFromGemini(geminiRequest, modelName, token) {
  const actualModelName = modelName;

  // 是否启用思维链，沿用现有逻辑，避免行为不一致
  const baseEnableThinking =
    actualModelName.endsWith('-thinking') ||
    actualModelName === 'gemini-2.5-pro' ||
    actualModelName.startsWith('gemini-3-pro-') ||
    actualModelName === 'rev19-uic3-1p' ||
    actualModelName === 'gpt-oss-120b-medium';
  const enableThinking = baseEnableThinking && !actualModelName.includes('claude');

  const contents = Array.isArray(geminiRequest?.contents) ? geminiRequest.contents : [];

  const systemInstruction =
    geminiRequest?.systemInstruction && typeof geminiRequest.systemInstruction === 'object'
      ? geminiRequest.systemInstruction
      : {
          role: 'user',
          parts: [{ text: config.systemInstruction }]
        };

  const request = {
    contents,
    systemInstruction,
    tools: Array.isArray(geminiRequest?.tools) ? geminiRequest.tools : undefined,
    toolConfig: geminiRequest?.toolConfig,
    safetySettings: geminiRequest?.safetySettings,
    generationConfig:
      geminiRequest?.generationConfig ||
      generateGenerationConfig({}, enableThinking, actualModelName),
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

// 覆盖上方的 handleAssistantMessage 实现：
// 当找不到 Gemini 思维签名时，降级为普通文本发送，而不是直接丢弃该 assistant 文本，避免导致请求 400。
function handleAssistantMessage(message, antigravityMessages, modelName) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const allowThoughtSignature = typeof modelName === 'string' && modelName.includes('gemini-3');

  // 统一提取 assistant 的纯文本内容
  let contentText = '';
  if (message.content) {
    if (Array.isArray(message.content)) {
      contentText = message.content
        .filter(item => item.type === 'text')
        .map(item => item.text || '')
        .join('');
    } else if (typeof message.content === 'string') {
      contentText = message.content;
    }
  }
  const hasContent = contentText.trim() !== '';

  // 将 OpenAI 风格的 tool_calls 转成 Antigravity/Gemini 所需的 functionCall part
  const antigravityTools = hasToolCalls ? message.tool_calls.map(toolCall => {
    let args = {};
    try {
      if (typeof toolCall.function.arguments === 'string') {
        args = JSON.parse(toolCall.function.arguments);
      } else if (typeof toolCall.function.arguments === 'object') {
        args = toolCall.function.arguments;
      }
    } catch (e) {
      console.warn('Failed to parse tool call arguments:', e);
    }

    const thoughtSignature = getThoughtSignature(toolCall.id);
    const part = {
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: args
      }
    };

    if (thoughtSignature) {
      part.thoughtSignature = thoughtSignature;
    }

    return part;
  }) : [];

  // 如果只是补齐工具调用结果且没有新文本，直接合并到上一条 model 消息里
  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...antigravityTools);
    return;
  }

  const parts = [];

  // 这里是关键改动：
  // 1. 优先尝试从缓存中找到与文本匹配的思维签名
  // 2. 找不到时，仍然发送纯文本（只是不带 thoughtSignature），避免直接丢弃 assistant 文本
  if (hasContent) {
    const textThoughtSignature = allowThoughtSignature ? getTextThoughtSignature(contentText) : undefined;
    const textPart = { text: textThoughtSignature?.text ?? contentText };

    if (allowThoughtSignature && textThoughtSignature?.signature) {
      textPart.thoughtSignature = textThoughtSignature.signature;
    }

    parts.push(textPart);
  }

  parts.push(...antigravityTools);

  antigravityMessages.push({
    role: 'model',
    parts
  });
}
export {
  generateRequestId,
  generateRequestBody,
  generateRequestBodyFromGemini,
  getDefaultIp,
  cleanJsonSchema,
  registerThoughtSignature,
  registerTextThoughtSignature,
  getTextThoughtSignature,
  getThoughtSignature
}
