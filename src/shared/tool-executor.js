/**
 * @fileoverview Tool execution functions.
 * Shared by Layer 1 (registerMCP callTool) and Layer 2 (CPM tool-loop).
 * Each function returns a plain object; callers format it per API spec.
 * Migrated from _temp_repo/src/lib/tool-use/tool-executor.js
 */

import { getWebSearchConfig } from './tool-config.js';
import { getRisu } from './ipc-protocol.js';

// ── Built-in: get_current_datetime ──

export function getCurrentDatetime(args) {
    const tz = args?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const locale = args?.locale || 'ko-KR';
    const now = new Date();
    return {
        iso: now.toISOString(),
        formatted: now.toLocaleString(locale, { timeZone: tz }),
        timezone: tz,
        unix: Math.floor(now.getTime() / 1000)
    };
}

// ── Built-in: calculate ──

const SAFE_MATH_NAMES = new Set([
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'sqrt', 'cbrt', 'pow', 'abs', 'log', 'log2', 'log10', 'exp',
    'floor', 'ceil', 'round', 'trunc', 'sign',
    'min', 'max', 'random',
    'PI', 'E', 'LN2', 'LN10', 'SQRT2'
]);

/**
 * Safe math expression evaluator using whitelist-only approach.
 * Only allows numeric literals, basic operators, and Math.* functions.
 * @param {Record<string,any>} args
 * @returns {{result?:number, error?:string, expression?:string}}
 */
export function calculate(args) {
    const expr = String(args?.expression || '').trim();
    if (!expr) return { error: 'expression is empty' };
    if (expr.length > 500) return { error: 'expression too long (max 500 chars)' };

    // Strip Math. prefix for whitelist check, then reconstruct
    const withoutMathPrefix = expr.replace(/Math\./g, '');

    // Allow: digits, operators, parens, decimal, spaces, commas, e/E
    // Use * (not +) so expressions consisting solely of named constants (PI, E) pass
    const safePattern = /^[0-9+\-*/().%\s,eE^]*$/;
    const namesCleaned = withoutMathPrefix.replace(/\b(sin|cos|tan|asin|acos|atan|atan2|sqrt|cbrt|pow|abs|log|log2|log10|exp|floor|ceil|round|trunc|sign|min|max|random|PI|E|LN2|LN10|SQRT2)\b/g, '');
    if (!safePattern.test(namesCleaned)) {
        return { error: 'Disallowed characters in expression', expression: expr };
    }

    // Reconstruct with Math. prefix where needed
    const sanitized = expr.replace(/\b(sin|cos|tan|asin|acos|atan|atan2|sqrt|cbrt|pow|abs|log|log2|log10|exp|floor|ceil|round|trunc|sign|min|max|random|PI|E|LN2|LN10|SQRT2)\b/g,
        (match) => SAFE_MATH_NAMES.has(match) ? `Math.${match}` : match
    );
    // Avoid duplicate Math.Math.
    let final = sanitized;
    while (final.includes('Math.Math.')) {
        final = final.replace(/Math\.Math\./g, 'Math.');
    }

    try {
        const result = Function('"use strict"; return (' + final + ')')();
        if (typeof result !== 'number' || !Number.isFinite(result)) {
            return { error: 'Result is Infinity or NaN', expression: expr };
        }
        return { result, expression: expr };
    } catch (e) {
        return { error: /** @type {Error} */(e).message, expression: expr };
    }
}

// ── Built-in: roll_dice ──

export function rollDice(args) {
    const notation = String(args?.notation || '1d6').trim();
    const match = notation.match(/^(\d{1,3})d(\d{1,4})(?:([+-])(\d{1,4}))?$/i);
    if (!match) return { error: 'Invalid notation. Use NdM format (e.g. 2d6, 3d8+5)', notation };
    const n = Math.min(parseInt(match[1], 10), 100);
    const s = Math.min(parseInt(match[2], 10), 1000);
    if (n < 1 || s < 1) return { error: 'Count and sides must be >= 1', notation };
    const rolls = Array.from({ length: n }, () => Math.floor(Math.random() * s) + 1);
    let total = rolls.reduce((a, b) => a + b, 0);
    if (match[3] === '+') total += parseInt(match[4], 10);
    else if (match[3] === '-') total -= parseInt(match[4], 10);
    return { rolls, total, notation };
}

// ── External: web_search ──

const WEB_SEARCH_DEFAULTS = {
    brave: { url: 'https://api.search.brave.com/res/v1/web/search', authHeader: 'X-Subscription-Token' },
    serpapi: { url: 'https://serpapi.com/search', authHeader: null },
    google_cse: { url: 'https://www.googleapis.com/customsearch/v1', authHeader: null },
};

/**
 * @param {Record<string,any>} data
 * @param {string} provider
 * @returns {Array<{title:string, url:string, snippet:string}>}
 */
export function _parseSearchResults(data, provider) {
    const results = [];
    if (provider === 'brave') {
        for (const r of (data?.web?.results || []).slice(0, 10)) {
            results.push({ title: r.title, url: r.url, snippet: r.description || '' });
        }
    } else if (provider === 'serpapi') {
        for (const r of (data?.organic_results || []).slice(0, 10)) {
            results.push({ title: r.title, url: r.link, snippet: r.snippet || '' });
        }
    } else if (provider === 'google_cse') {
        for (const r of (data?.items || []).slice(0, 10)) {
            results.push({ title: r.title, url: r.link, snippet: r.snippet || '' });
        }
    } else {
        // Custom: try common patterns
        const items = data?.results || data?.items || data?.web?.results || data?.organic_results || [];
        for (const r of (Array.isArray(items) ? items : []).slice(0, 10)) {
            results.push({
                title: r.title || r.name || '',
                url: r.url || r.link || r.href || '',
                snippet: r.snippet || r.description || r.content || ''
            });
        }
    }
    return results;
}

/**
 * @param {Record<string,any>} args
 * @returns {Promise<{query?:string, results?:Array<{title:string,url:string,snippet:string}>, error?:string, message?:string}>}
 */
export async function webSearch(args) {
    const query = String(args?.query || '').trim();
    if (!query) return { error: 'Search query is empty' };
    const count = Math.min(Math.max(parseInt(args?.count) || 5, 1), 10);

    const cfg = await getWebSearchConfig();
    if (!cfg.key) return { error: 'Web search API key not configured. Go to CPM Settings → Tool Use to set it.' };

    const preset = WEB_SEARCH_DEFAULTS[cfg.provider];
    const baseUrl = cfg.url || preset?.url || '';
    if (!baseUrl) return { error: 'Web search API URL not configured.' };

    let url, headers;
    switch (cfg.provider) {
        case 'brave':
            url = `${baseUrl}?q=${encodeURIComponent(query)}&count=${count}`;
            headers = { 'X-Subscription-Token': cfg.key, 'Accept': 'application/json' };
            break;
        case 'serpapi':
            url = `${baseUrl}?q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(cfg.key)}&num=${count}`;
            headers = { 'Accept': 'application/json' };
            break;
        case 'google_cse':
            if (!cfg.cx) return { error: 'Google CSE requires CX ID. Set cpm_tool_websearch_cx in settings.' };
            url = `${baseUrl}?q=${encodeURIComponent(query)}&key=${encodeURIComponent(cfg.key)}&cx=${encodeURIComponent(cfg.cx)}&num=${count}`;
            headers = { 'Accept': 'application/json' };
            break;
        default: // custom
            url = baseUrl.includes('{query}')
                ? baseUrl.replace('{query}', encodeURIComponent(query))
                : `${baseUrl}?q=${encodeURIComponent(query)}`;
            headers = { 'Authorization': `Bearer ${cfg.key}`, 'Accept': 'application/json' };
    }

    try {
        const Risu = getRisu();
        const res = await Risu.nativeFetch(url, { method: 'GET', headers });
        if (!res.ok) return { error: `Search API error: HTTP ${res.status}`, query };
        const data = await res.json();
        const results = _parseSearchResults(data, cfg.provider);
        if (results.length === 0) return { query, results: [], message: 'No results found.' };
        return { query, results };
    } catch (e) {
        return { error: `Search request failed: ${/** @type {Error} */(e).message}`, query };
    }
}

// ── External: fetch_url ──

const PRIVATE_IP_PATTERN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|\[::1\]|\[fd[0-9a-f]{2}:|::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)|\[::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.))/i;

/**
 * @param {Record<string,any>} args
 * @returns {Promise<{url?:string, content?:string, length?:number, error?:string}>}
 */
export async function fetchUrl(args) {
    const url = String(args?.url || '').trim();
    if (!url) return { error: 'URL is empty' };
    if (!/^https?:\/\//i.test(url)) return { error: 'Only HTTP/HTTPS URLs are supported.' };
    if (PRIVATE_IP_PATTERN.test(url)) return { error: 'Private/localhost URLs are blocked for security.' };

    try {
        const Risu = getRisu();
        const res = await Risu.nativeFetch(url, {
            method: 'GET',
            headers: { 'Accept': 'text/html,text/plain,application/json' }
        });
        if (!res.ok) return { error: `HTTP ${res.status}`, url };
        const text = await res.text();
        const cleaned = text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 8000);
        return { url, content: cleaned, length: cleaned.length };
    } catch (e) {
        return { error: `Fetch failed: ${/** @type {Error} */(e).message}`, url };
    }
}

// ── Executor dispatch ──

const EXECUTORS = {
    get_current_datetime: getCurrentDatetime,
    calculate: calculate,
    roll_dice: rollDice,
    web_search: webSearch,
    fetch_url: fetchUrl,
};

/**
 * Execute a tool by name with given arguments.
 * Returns MCPToolCallContent[] compatible format.
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @returns {Promise<Array<{type:string, text:string}>>}
 */
export async function executeToolCall(toolName, args) {
    const fn = EXECUTORS[toolName];
    if (!fn) {
        return [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }];
    }
    try {
        const result = await fn(args || {});
        return [{ type: 'text', text: JSON.stringify(result) }];
    } catch (e) {
        return [{ type: 'text', text: JSON.stringify({ error: `Tool execution failed: ${/** @type {Error} */(e).message}` }) }];
    }
}

// Export PRIVATE_IP_PATTERN for testing
export { PRIVATE_IP_PATTERN };
