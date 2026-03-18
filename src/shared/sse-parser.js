// sse-parser.js — Shared: SSE 스트리밍 유틸
import { safeGetBoolArg } from './helpers.js';
import { stripThoughtDisplayContent, stripInternalTags } from './sanitize.js';
import { _normalizeTokenUsage, _setTokenUsage } from './token-usage.js';
import { updateApiRequest } from './api-request-log.js';

/** @typedef {import('./types').OpenAISSEConfig} OpenAISSEConfig */
/** @typedef {import('./types').GeminiSSEConfig} GeminiSSEConfig */
/** @typedef {import('./types').ClaudeSSEConfig} ClaudeSSEConfig */
/** @typedef {import('./types').ProviderResult} ProviderResult */

// Thought signature cache (lightweight per-plugin instance)
/** @type {Map<string, string>} */
const _sigCache = new Map();
/** @constant {number} 최대 캐시 엔트리 수 */
const SIG_MAX = 50;
/** @constant {number} 시그니처 캐시 키 최대 길이 */
const SIG_KEY_MAX_LENGTH = 500;
/** @constant {number} 에러 스니펫 최대 길이 */
const ERROR_SNIPPET_LENGTH = 300;

/** @type {string[]} Gemini block finish reasons that indicate content was blocked */
export const GEMINI_BLOCK_REASONS = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'OTHER', 'SPII'];

/** @constant {number} Claude 에러 스니펫 최대 길이 */
const CLAUDE_ERROR_SNIPPET_LENGTH = 500;
export const ThoughtSignatureCache = {
    /** @param {string} text @returns {string} normalized key */
    _keyOf(text) {
        const normalized = stripThoughtDisplayContent(stripInternalTags(String(text || '')) || '');
        return normalized.substring(0, SIG_KEY_MAX_LENGTH);
    },
    save(text, sig) { if (!text || !sig) return; if (_sigCache.size >= SIG_MAX) { const first = _sigCache.keys().next().value; _sigCache.delete(first); } _sigCache.set(this._keyOf(text), sig); },
    get(text) { if (!text) return null; return _sigCache.get(this._keyOf(text)) || null; },
    clear() { _sigCache.clear(); },
};

/**
 * SSE Response를 ReadableStream으로 변환
 * @param {Response} response fetch 응답
 * @param {(line: string) => string | null} lineParser 한 라인 파서
 * @param {AbortSignal} [abortSignal] 중단 신호
 * @param {() => string | null} [onComplete] 완료 콜백
 * @returns {ReadableStream<string>}
 */
export function createSSEStream(response, lineParser, abortSignal, onComplete) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let _completeCalled = false;
    function callOnComplete() {
        if (_completeCalled || typeof onComplete !== 'function') return null;
        _completeCalled = true;
        try { return onComplete(); } catch { return null; }
    }
    return new ReadableStream({
        async pull(controller) {
            try {
                while (true) {
                    if (abortSignal?.aborted) {
                        reader.cancel();
                        const extra = callOnComplete();
                        if (extra) controller.enqueue(extra);
                        controller.close(); return;
                    }
                    const { done, value } = await reader.read();
                    if (done) {
                        if (buffer.trim()) { const d = lineParser(buffer.trim()); if (d) controller.enqueue(d); }
                        const extra = callOnComplete();
                        if (extra) controller.enqueue(extra);
                        controller.close(); return;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(':')) continue;
                        const d = lineParser(trimmed);
                        if (d) controller.enqueue(d);
                    }
                }
            } catch (e) {
                const extra = callOnComplete();
                if (extra && e.name === 'AbortError') { /* skip enqueue on error */ }
                if (e.name !== 'AbortError') controller.error(e);
                else controller.close();
            }
        },
        cancel() {
            callOnComplete();
            reader.cancel();
        }
    });
}

/**
 * OpenAI SSE 단일 라인 파싱
 * @param {string} line data: 접두사 포함 라인
 * @param {OpenAISSEConfig} [config] 스트리밍 상태
 * @returns {string | null} 파싱된 텍스트 또는 null
 */
export function parseOpenAISSELine(line, config = {}) {
    if (!line.startsWith('data:')) return null;
    const jsonStr = line.slice(5).trim();
    if (jsonStr === '[DONE]') return null;
    try {
        const obj = JSON.parse(jsonStr);
        const delta = obj.choices?.[0]?.delta;
        if (!delta) {
            // C-11: 토큰 사용량 추적 (OpenAI usage 필드)
            if (obj.usage && config._requestId) {
                const usage = _normalizeTokenUsage(obj.usage, 'openai');
                if (usage) _setTokenUsage(config._requestId, usage, true);
            }
            return null;
        }
        let text = '';
        // C-12 FIX: delta.reasoning_content ?? delta.reasoning (OpenRouter/DeepSeek 호환)
        const reasoningContent = delta.reasoning_content ?? delta.reasoning;
        if (config.showThinking && reasoningContent) {
            if (!config._inThinking) { config._inThinking = true; text += '<Thoughts>\n'; }
            text += reasoningContent;
        }
        if (delta.content) {
            if (config._inThinking) { config._inThinking = false; text += '\n</Thoughts>\n\n'; }
            text += delta.content;
        }
        return text || null;
    } catch { return null; }
}

/**
 * OpenAI SSE 스트림 생성 (onComplete로 Thoughts 닫기 + 토큰 사용량 finalize)
 * @param {Response} response fetch 응답
 * @param {AbortSignal} [abortSignal] 중단 신호
 * @param {OpenAISSEConfig} [config] 스트리밍 상태
 * @returns {ReadableStream<string>}
 */
export function createOpenAISSEStream(response, abortSignal, config = {}) {
    config._accumulatedContent = '';
    return createSSEStream(
        response,
        (line) => {
            const text = parseOpenAISSELine(line, config);
            if (text) config._accumulatedContent += text;
            return text;
        },
        abortSignal,
        () => {
            let extra = '';
            if (config._inThinking) { config._inThinking = false; extra += '\n</Thoughts>\n\n'; }
            // STB-9: Stream content logging
            if (config._requestId && config._accumulatedContent) {
                try { updateApiRequest(config._requestId, { streamContent: config._accumulatedContent }); } catch {}
            }
            return extra || null;
        }
    );
}

/**
 * Anthropic SSE 스트림 생성 (event: 라인 기반)
 * @param {Response} response fetch 응답
 * @param {AbortSignal} [abortSignal] 중단 신호
 * @param {ClaudeSSEConfig} [config] 스트리밍 설정
 * @returns {ReadableStream<string>}
 */
export function createAnthropicSSEStream(response, abortSignal, config = {}) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let thinking = false;
    let showThinkingResolved = false;
    // C-11: Anthropic 토큰 사용량 추적
    const _accumulatedUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let _visibleText = '';
    let _hasThinking = false;
    return new ReadableStream({
        async pull(controller) {
            try {
                if (!showThinkingResolved) {
                    showThinkingResolved = true;
                    if (config.showThinking === undefined) {
                        try { config.showThinking = await safeGetBoolArg('cpm_streaming_show_thinking', false); } catch { config.showThinking = false; }
                    }
                }
                while (true) {
                    if (abortSignal?.aborted) {
                        reader.cancel();
                        if (thinking) { controller.enqueue('\n</Thoughts>\n\n'); thinking = false; }
                        // Finalize usage on abort
                        if (config._requestId && _accumulatedUsage.input_tokens > 0) {
                            const usage = _normalizeTokenUsage(_accumulatedUsage, 'anthropic', { anthropicHasThinking: _hasThinking, anthropicVisibleText: _visibleText });
                            if (usage) _setTokenUsage(config._requestId, usage, true);
                        }
                        // STB-9: Stream content logging
                        if (config._requestId && _visibleText) {
                            try { updateApiRequest(config._requestId, { streamContent: _visibleText }); } catch {}
                        }
                        controller.close(); return;
                    }
                    const { done, value } = await reader.read();
                    if (done) {
                        if (thinking) { controller.enqueue('\n</Thoughts>\n\n'); thinking = false; }
                        // Finalize usage on completion
                        if (config._requestId && _accumulatedUsage.input_tokens > 0) {
                            const usage = _normalizeTokenUsage(_accumulatedUsage, 'anthropic', { anthropicHasThinking: _hasThinking, anthropicVisibleText: _visibleText });
                            if (usage) _setTokenUsage(config._requestId, usage, true);
                        }
                        // STB-9: Stream content logging
                        if (config._requestId && _visibleText) {
                            try { updateApiRequest(config._requestId, { streamContent: _visibleText }); } catch {}
                        }
                        controller.close(); return;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) { currentEvent = ''; continue; }
                        if (trimmed.startsWith('event:')) { currentEvent = trimmed.slice(6).trim(); continue; }
                        if (trimmed.startsWith('data:')) {
                            try {
                                const obj = JSON.parse(trimmed.slice(5).trim());
                                // C-11: Anthropic usage 추적
                                if (currentEvent === 'message_start' && obj.message?.usage) {
                                    _accumulatedUsage.input_tokens = obj.message.usage.input_tokens || 0;
                                    if (obj.message.usage.cache_read_input_tokens) _accumulatedUsage.cache_read_input_tokens = obj.message.usage.cache_read_input_tokens;
                                    if (obj.message.usage.cache_creation_input_tokens) _accumulatedUsage.cache_creation_input_tokens = obj.message.usage.cache_creation_input_tokens;
                                }
                                if (currentEvent === 'message_delta' && obj.usage) {
                                    if (obj.usage.output_tokens) _accumulatedUsage.output_tokens = obj.usage.output_tokens;
                                }
                                if (currentEvent === 'content_block_start') {
                                    // m-5: content_block_start에서 redacted_thinking 처리
                                    if (obj.content_block?.type === 'redacted_thinking') {
                                        _hasThinking = true;
                                        if (config.showThinking) {
                                            let dt = '';
                                            if (!thinking) { thinking = true; dt += '<Thoughts>\n'; }
                                            dt += '\n{{redacted_thinking}}\n';
                                            controller.enqueue(dt);
                                        }
                                    }
                                }
                                if (currentEvent === 'content_block_delta') {
                                    let dt = '';
                                    if (obj.delta?.type === 'thinking' || obj.delta?.type === 'thinking_delta') {
                                        _hasThinking = true;
                                        if (config.showThinking && obj.delta.thinking) {
                                            if (!thinking) { thinking = true; dt += '<Thoughts>\n'; }
                                            dt += obj.delta.thinking;
                                        }
                                    } else if (obj.delta?.type === 'redacted_thinking') {
                                        _hasThinking = true;
                                        if (config.showThinking) { if (!thinking) { thinking = true; dt += '<Thoughts>\n'; } dt += '\n{{redacted_thinking}}\n'; }
                                    } else if (obj.delta?.type === 'text_delta' || obj.delta?.type === 'text') {
                                        if (obj.delta.text) {
                                            if (thinking) { thinking = false; dt += '\n</Thoughts>\n\n'; }
                                            dt += obj.delta.text;
                                            _visibleText += obj.delta.text;
                                        }
                                    }
                                    if (dt) controller.enqueue(dt);
                                } else if (currentEvent === 'error' || obj.type === 'error') {
                                    controller.enqueue(`\n[Stream Error: ${obj.error?.message || obj.message || 'Unknown'}]\n`);
                                }
                            } catch {}
                        }
                    }
                }
            } catch (e) {
                if (thinking) { try { controller.enqueue('\n</Thoughts>\n\n'); } catch {} thinking = false; }
                // Finalize usage on error
                if (config._requestId && _accumulatedUsage.input_tokens > 0) {
                    const usage = _normalizeTokenUsage(_accumulatedUsage, 'anthropic', { anthropicHasThinking: _hasThinking, anthropicVisibleText: _visibleText });
                    if (usage) _setTokenUsage(config._requestId, usage, true);
                }
                // STB-9: Stream content logging
                if (config._requestId && _visibleText) {
                    try { updateApiRequest(config._requestId, { streamContent: _visibleText }); } catch {}
                }
                if (e.name !== 'AbortError') controller.error(e);
                else controller.close();
            }
        },
        cancel() {
            // H-11: Save token usage on cancel (stream consumer may call cancel() directly)
            if (config._requestId && (_accumulatedUsage.input_tokens > 0 || _accumulatedUsage.output_tokens > 0)) {
                const usage = _normalizeTokenUsage(_accumulatedUsage, 'anthropic', { anthropicHasThinking: _hasThinking, anthropicVisibleText: _visibleText });
                if (usage) _setTokenUsage(config._requestId, usage, true);
            }
            // STB-9: Stream content logging
            if (config._requestId && _visibleText) {
                try { updateApiRequest(config._requestId, { streamContent: _visibleText }); } catch {}
            }
            reader.cancel();
        }
    });
}

/**
 * Gemini SSE 단일 라인 파싱
 * @param {string} line data: 접두사 포함 라인
 * @param {GeminiSSEConfig} [config] 스트리밍 상태
 * @returns {string | null}
 */
export function parseGeminiSSELine(line, config = {}) {
    if (!line.startsWith('data:')) return null;
    try {
        const obj = JSON.parse(line.slice(5).trim());
        const blockReason = obj?.promptFeedback?.blockReason ?? obj?.candidates?.[0]?.finishReason;
        if (blockReason && GEMINI_BLOCK_REASONS.includes(blockReason)) {
            const msg = config._inThoughtBlock ? '\n</Thoughts>\n\n' : '';
            config._inThoughtBlock = false;
            return msg + `\n\n[⚠️ Gemini Safety Block: ${blockReason}] ${JSON.stringify(obj.promptFeedback || obj.candidates?.[0]?.safetyRatings || '').substring(0, ERROR_SNIPPET_LENGTH)}`;
        }
        // C-11: Gemini usage 추적
        if (obj.usageMetadata) {
            config._streamUsageMetadata = obj.usageMetadata;
        }
        let text = '';
        if (obj.candidates?.[0]?.content?.parts) {
            for (const part of obj.candidates[0].content.parts) {
                if (part.thought) {
                    if (config.showThoughtsToken && part.text) {
                        if (!config._inThoughtBlock) { config._inThoughtBlock = true; text += '<Thoughts>\n'; }
                        text += part.text;
                    }
                } else if (part.text !== undefined) {
                    if (config._inThoughtBlock) { config._inThoughtBlock = false; text += '\n</Thoughts>\n\n'; }
                    text += part.text;
                    if (config.useThoughtSignature) config._streamResponseText = (config._streamResponseText || '') + part.text;
                }
                if (config.useThoughtSignature && (part.thought_signature || part.thoughtSignature)) {
                    // 최신 시그너처로 업데이트 (temp_repo 동작)
                    config._lastSignature = part.thought_signature || part.thoughtSignature;
                }
            }
        }
        const finishReason = obj?.candidates?.[0]?.finishReason;
        if (config._inThoughtBlock && finishReason) { config._inThoughtBlock = false; text += '\n</Thoughts>\n\n'; }
        return text || null;
    } catch { return null; }
}

/**
 * Gemini 비스트리밍 응답 파싱
 * @param {object} data Gemini API 응답 본문
 * @param {GeminiSSEConfig} [config] 파싱 설정
 * @returns {ProviderResult}
 */
export function parseGeminiNonStreamingResponse(data, config = {}) {
    const blockReason = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason;
    const BLOCK = ['SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'];
    if (blockReason && BLOCK.includes(blockReason)) {
        return { success: false, content: `[⚠️ Gemini Safety Block: ${blockReason}] ${JSON.stringify(data.promptFeedback || data.candidates?.[0]?.safetyRatings || '').substring(0, ERROR_SNIPPET_LENGTH)}` };
    }
    let result = '', contentOnly = '', inThought = false, extractedSig = null;
    if (data.candidates?.[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
            if (part.thought) { if (config.showThoughtsToken && part.text) { if (!inThought) { inThought = true; result += '<Thoughts>\n'; } result += part.text; } }
            else if (part.text !== undefined) { if (inThought) { inThought = false; result += '\n</Thoughts>\n\n'; } result += part.text; contentOnly += part.text; }
            if (config.useThoughtSignature && (part.thought_signature || part.thoughtSignature)) extractedSig = part.thought_signature || part.thoughtSignature;
        }
    }
    if (inThought) result += '\n</Thoughts>\n\n';
    if (extractedSig && contentOnly) ThoughtSignatureCache.save(contentOnly, extractedSig);
    // M-7: Non-streaming Gemini token usage tracking
    if (data.usageMetadata && config._requestId) {
        const usage = _normalizeTokenUsage(data.usageMetadata, 'gemini');
        if (usage) _setTokenUsage(config._requestId, usage);
    }
    return { success: true, content: result };
}

/**
 * Claude 비스트리밍 응답 파싱
 * @param {object} data Claude API 응답 본문
 * @param {ClaudeSSEConfig} [config] 파싱 설정
 * @returns {ProviderResult}
 */
export function parseClaudeNonStreamingResponse(data, config = {}) {
    if (data.type === 'error' || data.error) {
        return { success: false, content: `[Claude Error] ${data.error?.message || data.message || JSON.stringify(data.error || data).substring(0, CLAUDE_ERROR_SNIPPET_LENGTH)}` };
    }
    let result = '', inThinking = false, hasThinking = false, visibleText = '';
    if (Array.isArray(data.content)) {
        for (const block of data.content) {
            if (block.type === 'thinking') { hasThinking = true; if (config.showThinking && block.thinking) { if (!inThinking) { inThinking = true; result += '<Thoughts>\n'; } result += block.thinking; } }
            else if (block.type === 'redacted_thinking') { hasThinking = true; if (config.showThinking) { if (!inThinking) { inThinking = true; result += '<Thoughts>\n'; } result += '\n{{redacted_thinking}}\n'; } }
            else if (block.type === 'text') { if (inThinking) { inThinking = false; result += '\n</Thoughts>\n\n'; } const t = block.text || ''; result += t; visibleText += t; }
        }
    }
    if (inThinking) result += '\n</Thoughts>\n\n';
    // M-7: Non-streaming Claude token usage tracking
    if (data.usage && config._requestId) {
        const usage = _normalizeTokenUsage(data.usage, 'anthropic', { anthropicHasThinking: hasThinking, anthropicVisibleText: visibleText });
        if (usage) _setTokenUsage(config._requestId, usage);
    }
    return { success: true, content: result };
}

// ==========================================
// C-9: Responses API (GPT-5.4+) SSE 스트림 파서
// ==========================================

/**
 * Responses API SSE 스트림 생성 (GPT-5.4+)
 * @param {Response} response fetch 응답
 * @param {AbortSignal} [abortSignal] 중단 신호
 * @param {{ showThinking?: boolean, _requestId?: string }} [config]
 * @returns {ReadableStream<string>}
 */
export function createResponsesAPISSEStream(response, abortSignal, config = {}) {
    let inReasoning = false;
    return createSSEStream(
        response,
        (line) => {
            if (!line.startsWith('data:')) return null;
            const jsonStr = line.slice(5).trim();
            if (jsonStr === '[DONE]') return null;
            try {
                const obj = JSON.parse(jsonStr);
                let text = '';
                if (obj.type === 'response.output_text.delta' && obj.delta) {
                    if (inReasoning) { inReasoning = false; text += '\n</Thoughts>\n\n'; }
                    text += obj.delta;
                } else if (obj.type === 'response.reasoning_summary_text.delta' && obj.delta) {
                    if (config.showThinking) {
                        if (!inReasoning) { inReasoning = true; text += '<Thoughts>\n'; }
                        text += obj.delta;
                    }
                } else if (obj.type === 'response.completed' && obj.response?.usage) {
                    const usage = _normalizeTokenUsage(obj.response.usage, 'openai');
                    if (usage && config._requestId) _setTokenUsage(config._requestId, usage, true);
                }
                return text || null;
            } catch { return null; }
        },
        abortSignal,
        () => {
            if (inReasoning) { inReasoning = false; return '\n</Thoughts>\n\n'; }
            return null;
        }
    );
}

// ==========================================
// C-10: OpenAI 비스트리밍 응답 파서
// ==========================================

/**
 * OpenAI 메시지 content 정규화
 * @param {string | null | Array<{text?: string}> | undefined} content
 * @returns {string}
 */
export function normalizeOpenAIMessageContent(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (Array.isArray(content)) {
        let out = '';
        for (const part of content) {
            if (typeof part === 'string') { out += part; continue; }
            if (!part || typeof part !== 'object') continue;
            const typedPart = /** @type {{ text?: string, type?: string, content?: string }} */ (part);
            if (typeof typedPart.text === 'string') { out += typedPart.text; continue; }
            if (typedPart.type === 'text' && typeof typedPart.content === 'string') { out += typedPart.content; }
        }
        return out;
    }
    return String(content);
}

/**
 * OpenAI Chat Completions 비스트리밍 응답 파싱
 * @param {object} data API 응답 본문
 * @param {{ showThinking?: boolean, _requestId?: string }} [config]
 * @returns {ProviderResult}
 */
export function parseOpenAINonStreamingResponse(data, config = {}) {
    if (data?.error) {
        return { success: false, content: `[OpenAI Error] ${data.error.message || JSON.stringify(data.error)}` };
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) {
        return { success: false, content: `[OpenAI] Unexpected response: ${JSON.stringify(data).substring(0, 500)}` };
    }
    // Token usage tracking
    if (data.usage && config._requestId) {
        const usage = _normalizeTokenUsage(data.usage, 'openai');
        if (usage) _setTokenUsage(config._requestId, usage);
    }
    let result = '';
    // Reasoning content: o-series (reasoning_content), OpenRouter (reasoning), DeepSeek (<think>)
    if (config.showThinking) {
        const reasoning = msg.reasoning_content || msg.reasoning;
        if (reasoning) {
            result += '<Thoughts>\n' + reasoning + '\n</Thoughts>\n\n';
        } else if (typeof msg.content === 'string' && msg.content.includes('<think>')) {
            // DeepSeek <think> block extraction
            const thinkMatch = msg.content.match(/<think>([\s\S]*?)<\/think>/);
            if (thinkMatch) {
                result += '<Thoughts>\n' + thinkMatch[1].trim() + '\n</Thoughts>\n\n';
                const afterThink = msg.content.replace(/<think>[\s\S]*?<\/think>\s*/, '');
                return { success: true, content: result + afterThink };
            }
        }
    }
    result += normalizeOpenAIMessageContent(msg.content);
    return { success: true, content: result };
}

/**
 * Responses API 비스트리밍 응답 파싱 (GPT-5.4+)
 * @param {object} data API 응답 본문
 * @param {{ showThinking?: boolean, _requestId?: string }} [config]
 * @returns {ProviderResult}
 */
export function parseResponsesAPINonStreamingResponse(data, config = {}) {
    if (data?.error) {
        return { success: false, content: `[Responses API Error] ${data.error.message || JSON.stringify(data.error)}` };
    }
    // Token usage
    if (data.usage && config._requestId) {
        const usage = _normalizeTokenUsage(data.usage, 'openai');
        if (usage) _setTokenUsage(config._requestId, usage);
    }
    let result = '';
    if (Array.isArray(data.output)) {
        for (const item of data.output) {
            if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part.type === 'output_text' && part.text) result += part.text;
                }
            }
            if (item.type === 'reasoning' && config.showThinking && Array.isArray(item.summary)) {
                let reasoning = '';
                for (const s of item.summary) {
                    if (s.type === 'summary_text' && s.text) reasoning += s.text;
                }
                if (reasoning) result = '<Thoughts>\n' + reasoning + '\n</Thoughts>\n\n' + result;
            }
        }
    }
    if (result) return { success: true, content: result };
    // Fallback: try chat completions format
    const msg = data?.choices?.[0]?.message;
    if (msg) return { success: true, content: normalizeOpenAIMessageContent(msg.content) };
    return { success: false, content: `[Responses API] Unexpected: ${JSON.stringify(data).substring(0, 500)}` };
}

/**
 * Gemini 스트림 완료 후 thought signature 저장 + 토큰 사용량 처리
 * @param {GeminiSSEConfig} config Gemini SSE 파싱 설정
 * @returns {string | null}
 */
export function saveThoughtSignatureFromStream(config) {
    let extra = '';
    if (config._inThoughtBlock) {
        config._inThoughtBlock = false;
        extra += '\n</Thoughts>\n\n';
    }
    if (config._lastSignature && config._streamResponseText) {
        ThoughtSignatureCache.save(config._streamResponseText, config._lastSignature);
    }
    // C-11: Gemini usage finalization
    if (config._requestId && config._streamUsageMetadata) {
        const usage = _normalizeTokenUsage(config._streamUsageMetadata, 'gemini');
        if (usage) _setTokenUsage(config._requestId, usage, true);
    }
    return extra || null;
}
