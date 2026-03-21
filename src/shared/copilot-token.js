import { buildCopilotTokenExchangeHeaders, normalizeCopilotNodelessMode } from './copilot-headers.js';

const TOKEN_ARG_KEY = 'tools_githubCopilotToken';
const DEFAULT_API_BASE = 'https://api.githubcopilot.com';

/** @constant {number} Negative cache duration — prevents rapid retry loops on token failure */
const _NEGATIVE_CACHE_MS = 60000;

let _copilotTokenCache = { token: '', expiry: 0 };
let _pendingTokenPromise = null;
let _getArgFn = null;
let _fetchFn = null;
let _apiBase = DEFAULT_API_BASE;

export function sanitizeCopilotToken(raw) {
    if (!raw) return '';
    return String(raw).replace(/[^\x20-\x7E]/g, '').trim();
}

export function clearCopilotTokenCache() {
    _copilotTokenCache = { token: '', expiry: 0 };
    _pendingTokenPromise = null;
    _apiBase = DEFAULT_API_BASE;
}

export function setCopilotGetArgFn(fn) {
    _getArgFn = typeof fn === 'function' ? fn : null;
}

export function setCopilotFetchFn(fn) {
    _fetchFn = typeof fn === 'function' ? fn : null;
}

export function getCopilotApiBase() {
    return _apiBase;
}

/**
 * @param {{ getArg?: (key: string) => Promise<string>, fetchFn?: (url: string, init: any) => Promise<any> }} [deps]
 */
export async function ensureCopilotApiToken(deps = {}) {
    if (_copilotTokenCache.token && Date.now() < _copilotTokenCache.expiry - 60000) {
        return _copilotTokenCache.token;
    }
    // Negative cache: if a recent attempt failed, don't retry immediately
    if (!_copilotTokenCache.token && _copilotTokenCache.expiry > 0 && Date.now() < _copilotTokenCache.expiry) {
        return '';
    }
    if (_pendingTokenPromise) return _pendingTokenPromise;

    const getArg = deps.getArg || _getArgFn;
    const fetchFn = deps.fetchFn || _fetchFn;
    if (typeof getArg !== 'function' || typeof fetchFn !== 'function') return '';

    _pendingTokenPromise = (async () => {
        const githubToken = await getArg(TOKEN_ARG_KEY);
        const cleanToken = sanitizeCopilotToken(githubToken);
        if (!cleanToken) return '';
        const nodelessMode = normalizeCopilotNodelessMode(await getArg('cpm_copilot_nodeless_mode'));

        try {
            const res = await fetchFn('https://api.github.com/copilot_internal/v2/token', {
                method: 'GET',
                headers: buildCopilotTokenExchangeHeaders(cleanToken, nodelessMode),
            });
            if (!res?.ok) {
                _copilotTokenCache = { token: '', expiry: Date.now() + _NEGATIVE_CACHE_MS };
                return '';
            }
            // FIX: Read as text first, then safely parse JSON.
            // Prevents "Unexpected token '/' is not valid JSON" when the V3 bridge
            // returns a JS plugin file (starting with //@api 3.0) instead of API JSON.
            let rawText;
            try { rawText = typeof res.text === 'function' ? await res.text() : ''; } catch { rawText = ''; }
            let data;
            try { data = typeof rawText === 'string' && rawText ? JSON.parse(rawText) : (typeof res.json === 'function' ? await res.json() : {}); }
            catch {
                console.error('[Copilot] Token exchange response is not valid JSON:', String(rawText).substring(0, 200));
                _copilotTokenCache = { token: '', expiry: Date.now() + _NEGATIVE_CACHE_MS };
                return '';
            }
            // Standard token response
            if (data?.token) {
                const expiryMs = data.expires_at ? data.expires_at * 1000 : Date.now() + 1800000;
                _copilotTokenCache = { token: data.token, expiry: expiryMs };
                if (data.endpoints?.api) _apiBase = String(data.endpoints.api).replace(/\/$/, '');
                return data.token;
            }
            // SEC-4: New API format — model list response (data.data array)
            // In this case, the OAuth token itself can be used as the API token.
            // Validate the response contains at least one model entry to confirm
            // this is genuinely a model list and not a spoofed/empty array.
            if (Array.isArray(data?.data) && data.data.length > 0 && data.data[0]?.id) {
                console.log(`[Copilot] Model-list response detected (${data.data.length} models), using OAuth token as API token`);
                _copilotTokenCache = { token: cleanToken, expiry: Date.now() + 1800000 };
                return cleanToken;
            }
            _copilotTokenCache = { token: '', expiry: Date.now() + _NEGATIVE_CACHE_MS };
            return '';
        } catch {
            _copilotTokenCache = { token: '', expiry: Date.now() + _NEGATIVE_CACHE_MS };
            return '';
        } finally {
            _pendingTokenPromise = null;
        }
    })();

    return _pendingTokenPromise;
}
