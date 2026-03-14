// token-usage.js — Shared: 토큰 사용량 정규화 및 추적
// Ported from temp_repo (token-usage.js)

/**
 * @typedef {{ input: number, output: number, reasoning: number, cached: number, total: number, reasoningEstimated?: boolean }} TokenUsage
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function _toFiniteTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Try known explicit Anthropic/proxy reasoning token fields first.
 * Future-proofed for proxy adapters that may expose separate reasoning counts.
 * @param {Object} raw
 * @returns {number}
 */
function _extractAnthropicReasoningTokens(raw) {
    return (
        _toFiniteTokenInt(raw.reasoning_tokens) ||
        _toFiniteTokenInt(raw.thinking_tokens) ||
        _toFiniteTokenInt(raw.output_tokens_details?.reasoning_tokens) ||
        _toFiniteTokenInt(raw.output_tokens_details?.thinking_tokens) ||
        _toFiniteTokenInt(raw.output_token_details?.reasoning_tokens) ||
        _toFiniteTokenInt(raw.output_token_details?.thinking_tokens) ||
        _toFiniteTokenInt(raw.completion_tokens_details?.reasoning_tokens)
    );
}

/**
 * Best-effort local token estimate for visible Claude text when no tokenizer is available.
 * English-ish text uses a char-based heuristic; CJK-heavy text biases higher.
 * @param {string} text
 * @returns {number}
 */
export function _estimateVisibleTextTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
    if (!normalized) return 0;
    const compact = normalized.replace(/\s/g, '');
    const cjkCount = (compact.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
    if (cjkCount > 0 && cjkCount / Math.max(compact.length, 1) >= 0.3) {
        return Math.max(1, cjkCount + Math.ceil((compact.length - cjkCount) / 2));
    }
    return Math.max(1, Math.ceil(normalized.length / 4));
}

/** @type {Map<string, TokenUsage>} In-memory token usage store, keyed by request ID */
export const _tokenUsageStore = new Map();
const _TOKEN_USAGE_LEGACY_NONSTREAM = '_latest';
const _TOKEN_USAGE_LEGACY_STREAM = '_stream_latest';
const _TOKEN_USAGE_STORE_MAX = 100;

/**
 * @param {string} requestId
 * @param {boolean} [isStream]
 * @returns {string}
 */
export function _tokenUsageKey(requestId, isStream = false) {
    if (!requestId || typeof requestId !== 'string') {
        return isStream ? _TOKEN_USAGE_LEGACY_STREAM : _TOKEN_USAGE_LEGACY_NONSTREAM;
    }
    return `${isStream ? '_stream_' : '_nonstream_'}${requestId}`;
}

/**
 * @param {string} requestId
 * @param {TokenUsage} usage
 * @param {boolean} [isStream]
 */
export function _setTokenUsage(requestId, usage, isStream = false) {
    if (!usage || typeof usage !== 'object') return;
    _tokenUsageStore.set(_tokenUsageKey(requestId, isStream), usage);
    if (_tokenUsageStore.size > _TOKEN_USAGE_STORE_MAX) {
        const it = _tokenUsageStore.keys();
        _tokenUsageStore.delete(it.next().value);
    }
}

/**
 * @param {string} requestId
 * @param {boolean} [isStream]
 * @returns {TokenUsage|null}
 */
export function _takeTokenUsage(requestId, isStream = false) {
    const key = _tokenUsageKey(requestId, isStream);
    const scoped = _tokenUsageStore.get(key);
    if (scoped) {
        _tokenUsageStore.delete(key);
        return scoped;
    }
    const legacyKey = isStream ? _TOKEN_USAGE_LEGACY_STREAM : _TOKEN_USAGE_LEGACY_NONSTREAM;
    const legacy = _tokenUsageStore.get(legacyKey);
    if (legacy) {
        _tokenUsageStore.delete(legacyKey);
        return legacy;
    }
    return null;
}

/**
 * Normalize token usage from different API formats into a unified shape.
 * @param {Object} raw - Raw usage object from API response
 * @param {'openai'|'anthropic'|'gemini'} format
 * @param {{ anthropicHasThinking?: boolean, anthropicVisibleText?: string }} [meta]
 * @returns {TokenUsage | null}
 */
export function _normalizeTokenUsage(raw, format, meta = {}) {
    if (!raw || typeof raw !== 'object') return null;
    if (format === 'openai') {
        const input = raw.prompt_tokens || 0;
        const output = raw.completion_tokens || 0;
        const reasoning = raw.completion_tokens_details?.reasoning_tokens || 0;
        const cached = raw.prompt_tokens_details?.cached_tokens || raw.prompt_cache_hit_tokens || 0;
        return { input, output, reasoning, cached, total: raw.total_tokens || (input + output) };
    } else if (format === 'anthropic') {
        const input = raw.input_tokens || 0;
        const output = raw.output_tokens || 0;
        const cached = (raw.cache_read_input_tokens || 0) + (raw.cache_creation_input_tokens || 0);
        const explicitReasoning = _extractAnthropicReasoningTokens(raw);
        if (explicitReasoning > 0) {
            return { input, output, reasoning: explicitReasoning, cached, total: input + output };
        }
        if (meta?.anthropicHasThinking && output > 0) {
            const visibleAnswerTokens = _estimateVisibleTextTokens(meta.anthropicVisibleText || '');
            const estimatedReasoning = Math.max(0, output - visibleAnswerTokens);
            if (estimatedReasoning > 0) {
                return { input, output, reasoning: estimatedReasoning, cached, total: input + output, reasoningEstimated: true };
            }
        }
        return { input, output, reasoning: 0, cached, total: input + output };
    } else if (format === 'gemini') {
        const input = raw.promptTokenCount || 0;
        const output = raw.candidatesTokenCount || 0;
        const reasoning = raw.thoughtsTokenCount || 0;
        const cached = raw.cachedContentTokenCount || 0;
        return { input, output, reasoning, cached, total: raw.totalTokenCount || (input + output) };
    }
    return null;
}
