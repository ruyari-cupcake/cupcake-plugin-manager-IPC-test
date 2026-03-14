const TOKEN_ARG_KEY = 'tools_githubCopilotToken';
const DEFAULT_API_BASE = 'https://api.githubcopilot.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.109.2 Chrome/142.0.7444.265 Electron/39.3.0 Safari/537.36';
const CODE_VERSION = '1.109.2';
const CHAT_VERSION = '0.37.4';

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
    if (_pendingTokenPromise) return _pendingTokenPromise;

    const getArg = deps.getArg || _getArgFn;
    const fetchFn = deps.fetchFn || _fetchFn;
    if (typeof getArg !== 'function' || typeof fetchFn !== 'function') return '';

    _pendingTokenPromise = (async () => {
        const githubToken = await getArg(TOKEN_ARG_KEY);
        const cleanToken = sanitizeCopilotToken(githubToken);
        if (!cleanToken) return '';

        try {
            const res = await fetchFn('https://api.github.com/copilot_internal/v2/token', {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${cleanToken}`,
                    'User-Agent': USER_AGENT,
                    'Editor-Version': `vscode/${CODE_VERSION}`,
                    'Editor-Plugin-Version': `copilot-chat/${CHAT_VERSION}`,
                    'X-GitHub-Api-Version': '2024-12-15',
                },
            });
            if (!res?.ok) return '';
            const data = await res.json();
            // Standard token response
            if (data?.token) {
                const expiryMs = data.expires_at ? data.expires_at * 1000 : Date.now() + 1800000;
                _copilotTokenCache = { token: data.token, expiry: expiryMs };
                if (data.endpoints?.api) _apiBase = String(data.endpoints.api).replace(/\/$/, '');
                return data.token;
            }
            // SEC-4: New API format — model list response (data.data array)
            // In this case, the OAuth token itself can be used as the API token
            if (Array.isArray(data?.data)) {
                console.log('[Copilot] Model-list response detected, using OAuth token as API token');
                _copilotTokenCache = { token: cleanToken, expiry: Date.now() + 1800000 };
                return cleanToken;
            }
            return '';
        } catch {
            return '';
        } finally {
            _pendingTokenPromise = null;
        }
    })();

    return _pendingTokenPromise;
}
