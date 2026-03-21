/**
 * @fileoverview Prefetch Web Search — 메인 모델 호출 전에 웹검색을 수행하고
 * 결과를 시스템 프롬프트에 주입. Function Calling 없이 모델 1회 호출로 완료.
 *
 * 기존 Tool Use (Layer 1/2)와 별개의 독립 기능.
 * Tool Use가 꺼져 있어도 이 기능만 단독으로 사용 가능.
 *
 * Migrated from _temp_repo/src/lib/tool-use/prefetch-search.js
 */

import { getWebSearchConfig } from './tool-config.js';
import { safeGetArg, safeGetBoolArg } from './helpers.js';
import { getRisu } from './ipc-protocol.js';
import { _parseSearchResults } from './tool-executor.js';

/**
 * 프리페치 검색이 활성화되었는지 확인.
 * @returns {Promise<boolean>}
 */
export async function isPrefetchSearchEnabled() {
    return safeGetBoolArg('cpm_prefetch_search_enabled', false);
}

/**
 * 프리페치 검색 결과 삽입 위치.
 * @returns {Promise<'before'|'after'>}
 */
async function getInsertPosition() {
    const v = await safeGetArg('cpm_prefetch_search_position');
    return v === 'before' ? 'before' : 'after';
}

/**
 * 프리페치 검색 결과 최대 건수.
 * @returns {Promise<number>}
 */
async function getMaxResults() {
    const v = await safeGetArg('cpm_prefetch_search_max_results');
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n >= 1) ? Math.min(n, 10) : 5;
}

/**
 * @returns {Promise<boolean>}
 */
async function getSnippetOnly() {
    return safeGetBoolArg('cpm_prefetch_search_snippet_only', false);
}

// ── Web search providers ──

const WEB_SEARCH_DEFAULTS = {
    brave: { url: 'https://api.search.brave.com/res/v1/web/search', authHeader: 'X-Subscription-Token' },
    serpapi: { url: 'https://serpapi.com/search', authHeader: null },
    google_cse: { url: 'https://www.googleapis.com/customsearch/v1', authHeader: null },
};

/**
 * 웹 검색 실행.
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<{success: boolean, results?: Array<{title:string, url:string, snippet:string}>, error?: string}>}
 */
async function doWebSearch(query, maxResults) {
    const cfg = await getWebSearchConfig();
    if (!cfg.key) return { success: false, error: 'Web search API key not configured.' };

    const preset = WEB_SEARCH_DEFAULTS[cfg.provider];
    const baseUrl = cfg.url || preset?.url || '';
    if (!baseUrl) return { success: false, error: 'Web search API URL not configured.' };

    let url, headers;
    switch (cfg.provider) {
        case 'brave':
            url = `${baseUrl}?q=${encodeURIComponent(query)}&count=${maxResults}`;
            headers = { 'X-Subscription-Token': cfg.key, 'Accept': 'application/json' };
            break;
        case 'serpapi':
            url = `${baseUrl}?q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(cfg.key)}&num=${maxResults}`;
            headers = { 'Accept': 'application/json' };
            break;
        case 'google_cse':
            if (!cfg.cx) return { success: false, error: 'Google CSE requires CX ID.' };
            url = `${baseUrl}?q=${encodeURIComponent(query)}&key=${encodeURIComponent(cfg.key)}&cx=${encodeURIComponent(cfg.cx)}&num=${maxResults}`;
            headers = { 'Accept': 'application/json' };
            break;
        default:
            url = baseUrl.includes('{query}')
                ? baseUrl.replace('{query}', encodeURIComponent(query))
                : `${baseUrl}?q=${encodeURIComponent(query)}`;
            headers = { 'Authorization': `Bearer ${cfg.key}`, 'Accept': 'application/json' };
    }

    try {
        const Risu = getRisu();
        const res = await Risu.nativeFetch(url, { method: 'GET', headers });
        if (!res.ok) return { success: false, error: `Search API error: HTTP ${res.status}` };
        const data = await res.json();
        const results = _parseSearchResults(data, cfg.provider).slice(0, maxResults);
        return { success: true, results };
    } catch (e) {
        return { success: false, error: `Search failed: ${/** @type {Error} */(e).message}` };
    }
}

/**
 * 검색 결과를 시스템 프롬프트용 텍스트 블록으로 포맷.
 * @param {Array<{title:string, url:string, snippet:string}>} results
 * @param {string} query
 * @param {boolean} snippetOnly
 * @returns {string}
 */
export function formatSearchBlock(results, query, snippetOnly) {
    if (!results || results.length === 0) return '';
    const lines = [`[Web Search Results for: "${query}"]`];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (snippetOnly) {
            if (r.snippet) lines.push(`${i + 1}. ${r.snippet}`);
        } else {
            lines.push(`${i + 1}. ${r.title}`);
            if (r.snippet) lines.push(`   ${r.snippet}`);
            if (r.url) lines.push(`   URL: ${r.url}`);
        }
    }
    lines.push('[End of Web Search Results]');
    return lines.join('\n');
}

/**
 * @param {string} userQuery
 * @returns {Promise<boolean>}
 */
export async function shouldTriggerPrefetch(userQuery) {
    const raw = await safeGetArg('cpm_prefetch_search_keywords');
    if (!raw || !raw.trim()) return true;
    const keywords = raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) return true;
    const lowerQuery = userQuery.toLowerCase();
    return keywords.some(kw => lowerQuery.includes(kw));
}

/**
 * 사용자의 마지막 메시지에서 검색 쿼리를 추출.
 * @param {Array<{role:string, content:any}>} messages
 * @returns {string}
 */
export function extractUserQuery(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            const content = messages[i].content;
            if (typeof content === 'string') return content.trim();
            if (Array.isArray(content)) {
                const textPart = content.find(p => p.type === 'text');
                if (textPart?.text) return textPart.text.trim();
            }
            break;
        }
    }
    return '';
}

/**
 * 프리페치 검색을 수행하고 messages 배열의 시스템 프롬프트에 결과를 주입.
 * messages 배열을 직접 수정(mutation)하지 않고 새 배열을 반환.
 *
 * @param {Array<{role:string, content:any}>} messages - sanitized messages
 * @returns {Promise<{messages: Array<{role:string, content:any}>, searched: boolean, query?: string, error?: string}>}
 */
export async function injectPrefetchSearch(messages) {
    if (!(await isPrefetchSearchEnabled())) {
        return { messages, searched: false };
    }

    const userQuery = extractUserQuery(messages);
    if (!userQuery) {
        return { messages, searched: false };
    }

    // 쿼리가 너무 짧으면 검색 스킵
    if (userQuery.length < 2) {
        return { messages, searched: false };
    }

    if (!(await shouldTriggerPrefetch(userQuery))) {
        console.log('[CPM Prefetch Search] Skipped - no trigger keyword found');
        return { messages, searched: false };
    }

    const maxResults = await getMaxResults();
    const position = await getInsertPosition();
    const snippetOnly = await getSnippetOnly();

    console.log(`[CPM Prefetch Search] Searching: "${userQuery.substring(0, 80)}" (max ${maxResults}, snippet=${snippetOnly})`);

    const searchResult = await doWebSearch(userQuery, maxResults);
    if (!searchResult.success || !searchResult.results || searchResult.results.length === 0) {
        console.warn(`[CPM Prefetch Search] ${searchResult.error || 'No results'}`);
        return { messages, searched: false, error: searchResult.error };
    }

    const searchBlock = formatSearchBlock(searchResult.results, userQuery, snippetOnly);
    if (!searchBlock) {
        return { messages, searched: false };
    }

    console.log(`[CPM Prefetch Search] Got ${searchResult.results.length} results, injecting into system prompt (${position})`);

    // 새 배열 생성 (원본 변경 방지)
    const newMessages = messages.map(m => ({ ...m }));

    // 시스템 프롬프트 찾기
    const sysIdx = newMessages.findIndex(m => m.role === 'system');

    if (sysIdx >= 0) {
        const existing = typeof newMessages[sysIdx].content === 'string'
            ? newMessages[sysIdx].content
            : JSON.stringify(newMessages[sysIdx].content);

        if (position === 'before') {
            newMessages[sysIdx] = { ...newMessages[sysIdx], content: searchBlock + '\n\n' + existing };
        } else {
            newMessages[sysIdx] = { ...newMessages[sysIdx], content: existing + '\n\n' + searchBlock };
        }
    } else {
        newMessages.unshift({ role: 'system', content: searchBlock });
    }

    return { messages: newMessages, searched: true, query: userQuery };
}
