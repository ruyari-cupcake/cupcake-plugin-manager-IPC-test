/**
 * @fileoverview Parse API responses to extract tool_calls (format-specific).
 * Used by Layer 2 (CPM tool-use loop).
 * Migrated from _temp_repo/src/lib/tool-use/tool-parsers.js
 */

/**
 * @typedef {Object} ParsedToolCalls
 * @property {boolean} hasToolCalls
 * @property {any} [assistantMessage] - The full assistant message to add to history
 * @property {Array<{id:string, name:string, arguments:Record<string,any>}>} [toolCalls]
 * @property {string} [textContent] - Any text content from the response
 */

/**
 * Parse OpenAI non-streaming response for tool_calls.
 * @param {Record<string,any>} data - Parsed JSON response
 * @returns {ParsedToolCalls}
 */
export function parseOpenAIToolCalls(data) {
    const msg = data?.choices?.[0]?.message;
    if (!msg) return { hasToolCalls: false };
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return { hasToolCalls: false, textContent: msg.content || '' };
    }
    return {
        hasToolCalls: true,
        assistantMessage: msg,
        toolCalls: msg.tool_calls.map(/** @param {any} tc */ tc => ({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function?.name || '',
            arguments: _safeParse(tc.function?.arguments)
        })),
        textContent: msg.content || ''
    };
}

/**
 * Parse Anthropic non-streaming response for tool_use blocks.
 * @param {Record<string,any>} data - Parsed JSON response
 * @returns {ParsedToolCalls}
 */
export function parseAnthropicToolCalls(data) {
    const content = data?.content;
    if (!Array.isArray(content)) return { hasToolCalls: false };
    const toolBlocks = content.filter(b => b.type === 'tool_use');
    if (toolBlocks.length === 0) {
        const textBlock = content.find(b => b.type === 'text');
        return { hasToolCalls: false, textContent: textBlock?.text || '' };
    }
    return {
        hasToolCalls: true,
        assistantMessage: { role: 'assistant', content },
        toolCalls: toolBlocks.map(b => ({
            id: b.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: b.name || '',
            arguments: b.input || {}
        })),
        textContent: content.filter(b => b.type === 'text').map(b => b.text).join('') || ''
    };
}

/**
 * Parse Google Gemini non-streaming response for functionCall parts.
 * @param {Record<string,any>} data - Parsed JSON response
 * @returns {ParsedToolCalls}
 */
export function parseGeminiToolCalls(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return { hasToolCalls: false };
    const fcParts = parts.filter(p => p.functionCall);
    if (fcParts.length === 0) {
        const textPart = parts.find(p => p.text !== undefined);
        return { hasToolCalls: false, textContent: textPart?.text || '' };
    }
    return {
        hasToolCalls: true,
        assistantMessage: { role: 'model', parts },
        toolCalls: fcParts.map(p => ({
            id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: p.functionCall.name || '',
            arguments: p.functionCall.args || {}
        })),
        textContent: parts.filter(p => p.text !== undefined).map(p => p.text).join('') || ''
    };
}

/**
 * Format-dispatched parser.
 * @param {Record<string,any>} data - Parsed JSON response
 * @param {string} format - 'openai' | 'anthropic' | 'google'
 * @returns {ParsedToolCalls}
 */
export function parseToolCalls(data, format) {
    if (format === 'anthropic') return parseAnthropicToolCalls(data);
    if (format === 'google') return parseGeminiToolCalls(data);
    return parseOpenAIToolCalls(data);
}

/**
 * Build tool result message in the correct format for re-request.
 * @param {{id:string, name:string}} call
 * @param {string} resultText
 * @param {string} format
 * @returns {Record<string,any>}
 */
export function formatToolResult(call, resultText, format) {
    if (format === 'anthropic') {
        return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: resultText }]
        };
    }
    if (format === 'google') {
        return {
            role: 'function',
            parts: [{ functionResponse: { name: call.name, response: { result: resultText } } }]
        };
    }
    // OpenAI
    return { role: 'tool', tool_call_id: call.id, content: resultText };
}

/** @param {any} str */
function _safeParse(str) {
    if (typeof str !== 'string') return str || {};
    try { return JSON.parse(str); } catch { return {}; }
}
