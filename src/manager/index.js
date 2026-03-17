/**
 * manager/index.js — CPM Manager v2: IPC-based Provider Hub
 *
 * 핵심 설계 (RisuAI V3 Plugin Channel 기반):
 *   - postPluginChannelMessage(대상이름, 채널, 메시지) ← 3인자!
 *   - addPluginChannelListener(채널, 콜백) ← 2인자, 키 = 내이름 + 채널
 *   - 각 플러그인은 독립 iframe → getArgument/setArgument도 플러그인별 독립
 *   - 따라서 매니저가 모든 설정값을 소유하고, IPC fetch 시 settings로 전달
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 파일 구조 (섹션 검색: "// §" 접두사)                          │
 * │                                                                │
 * │  § IMPORTS & STATE ................ L11-33   핵심 상태/상수    │
 * │  § COPILOT TOKEN MANAGEMENT ....... L35-203  GitHub Copilot    │
 * │  § SETTINGS BACKUP ................ L205-285 pluginStorage     │
 * │  § SLOT HEURISTIC ................. L287-330 자동 슬롯 추론    │
 * │  § IPC RESPONSE LISTENER .......... L332-355 응답 채널         │
 * │  § IPC FETCH ...................... L357-460 프로바이더 요청    │
 * │  § REQUEST HANDLER ................ L463-577 handleRequest     │
 * │  § CUSTOM ENDPOINT ................ L580-1042 커스텀 모델      │
 * │  § CONTROL CHANNEL ................ L1044-1087 등록 채널       │
 * │  § MODEL REGISTRATION ............. L1089-1180 모델 등록       │
 * │  § API REQUEST LOG ................ L1182-1192 요청 로그       │
 * │  § SETTINGS UI .................... L1194+     설정 화면       │
 * │  §   ├ DIAGNOSTICS TAB ............ 진단/버그리포트 UI        │
 * │  §   ├ API LOG TAB ................ API 요청 로그 전용 탭     │
 * │  §   └ COPILOT / CUSTOMS / etc.                               │
 * │  § PERSISTENCE .................... 저장                       │
 * │  § MAIN INIT ...................... 초기화                     │
 * └────────────────────────────────────────────────────────────────┘
 */

import { CH, MSG, safeUUID, getRisu, setupChannelCleanup } from '../shared/ipc-protocol.js';
import { safeGetArg, safeGetBoolArg, setArg, safeStringify, smartFetch, streamingFetch, collectStream, checkStreamCapability, shouldEnableStreaming, _resetCompatibilityModeCache } from '../shared/helpers.js';
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../shared/message-format.js';
import { sanitizeMessages, sanitizeBodyJSON, hasNonEmptyMessageContent, hasAttachedMultimodals } from '../shared/sanitize.js';
import { getGeminiSafetySettings, buildGeminiThinkingConfig, validateGeminiParams, cleanExperimentalModelParams } from '../shared/gemini-helpers.js';
import { parseClaudeNonStreamingResponse, parseGeminiNonStreamingResponse, createSSEStream, createOpenAISSEStream, createAnthropicSSEStream, createResponsesAPISSEStream, parseGeminiSSELine, parseOpenAINonStreamingResponse, parseResponsesAPINonStreamingResponse, saveThoughtSignatureFromStream } from '../shared/sse-parser.js';
import { KeyPool } from '../shared/key-pool.js';
import { _normalizeTokenUsage, _setTokenUsage, _takeTokenUsage } from '../shared/token-usage.js';
import { showTokenToast } from '../shared/token-toast.js';
import { supportsOpenAIReasoningEffort, needsCopilotResponsesAPI, shouldStripOpenAISamplingParams, shouldStripGPT54SamplingForReasoning, needsMaxCompletionTokens } from '../shared/model-helpers.js';
import { mergeDynamicModels } from '../shared/dynamic-models.js';
import { ensureCopilotApiToken, getCopilotApiBase, clearCopilotTokenCache } from '../shared/copilot-token.js';
import { storeApiRequest, getAllApiRequests, getApiRequestById, clearApiRequests, updateApiRequest } from '../shared/api-request-log.js';
import { createSettingsBackup } from '../shared/settings-backup.js';
import { COPILOT_CHAT_VERSION, VSCODE_VERSION, getCopilotStaticHeaders, shouldUseLegacyCopilotRequestHeaders, normalizeCopilotNodelessMode, setCopilotVersionOverrides } from '../shared/copilot-headers.js';
import { VERSIONS_URL, MAIN_UPDATE_URL, UPDATE_BUNDLE_URL } from '../shared/endpoints.js';
import { createUpdateToast } from '../shared/update-toast.js';
import { createAutoUpdater } from '../shared/auto-updater.js';
import { parseCustomModelsValue, normalizeCustomModel, serializeCustomModelExport, serializeCustomModelsSetting } from '../shared/custom-model-serialization.js';
import { TAILWIND_CSS } from '../shared/tailwind-css.generated.js';

const CPM_VERSION = '2.0.0';
const Risu = getRisu();

// ==========================================
// STATE
// ==========================================
const registeredProviders = new Map();  // providerName → { pluginName, models, settingsFields }
const ALL_DEFINED_MODELS = [];
/** @type {Record<string, any>[]} */
const CUSTOM_MODELS_CACHE = [];
const pendingRequests = new Map();      // requestId → { resolve, timer }
const pendingControlRequests = new Map(); // requestId → { resolve, timer }
const registeredModelKeys = new Set();
const CPM_SLOT_LIST = ['translation', 'emotion', 'memory', 'other'];
let _abortBridgeProbeDone = false;

// ── Retry / CORS Proxy utilities (migrated from _temp_repo fetch-custom.js) ──
/** @param {number} ms */
const _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @param {any} headers */
function _parseRetryAfterMs(headers) {
    const raw = headers?.get?.('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(0, Math.floor(seconds * 1000));
    }
    const retryAt = Date.parse(raw);
    if (Number.isNaN(retryAt)) return 0;
    return Math.max(0, retryAt - Date.now());
}

/** @param {number} status */
function _isRetriableHttpStatus(status) {
    // 524 = Cloudflare timeout — retrying immediately won't help, skip it
    return status === 408 || status === 429 || (status >= 500 && status !== 524);
}

/**
 * Retry wrapper: retries a request factory up to maxAttempts with exponential
 * backoff and Retry-After header parsing.
 * Migrated from _temp_repo/fetch-custom.js `_executeRequest`.
 * @param {() => Promise<Response>} requestFactory
 * @param {string} label
 * @param {number} [maxAttempts=3]
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<Response>}
 */
async function _executeWithRetry(requestFactory, label, maxAttempts = 3, abortSignal) {
    let attempt = 0;
    let response;

    while (attempt < maxAttempts) {
        response = await requestFactory();
        if (response?.ok) return response;

        const status = response?.status || 0;
        if (!_isRetriableHttpStatus(status) || attempt >= maxAttempts - 1 || abortSignal?.aborted) {
            return response;
        }

        response?.body?.cancel?.();
        attempt++;
        const retryAfterMs = _parseRetryAfterMs(response?.headers);
        const exponentialDelay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
        const retryDelay = retryAfterMs || exponentialDelay;
        console.warn(`[CPM] ${label} retry ${attempt}/${maxAttempts - 1} after HTTP ${status} (delay: ${retryDelay}ms)`);
        await _sleep(retryDelay);
    }

    return response;
}

/**
 * Apply CORS proxy URL rewriting.
 * Migrated from _temp_repo/fetch-custom.js proxyUrl handling.
 * @param {string} url
 * @param {string} proxyUrl
 * @returns {string | {url: string, targetUrl: string, mode: string}}
 */
function _applyCorsProxy(url, proxyUrl, proxyDirect = false) {
    if (!proxyUrl || !url) return url;
    let cleanProxy = proxyUrl.replace(/\/+$/, '');
    // Auto-prepend https:// if user entered bare domain (migrated from _temp_repo)
    if (!/^https?:\/\//i.test(cleanProxy)) {
        cleanProxy = 'https://' + cleanProxy;
        console.log(`[CPM] proxyUrl missing scheme — auto-prepended https:// → ${cleanProxy}`);
    }
    if (proxyDirect) {
        // Direct mode: proxy URL로 직접 요청, 원본 URL은 X-Target-URL 헤더로 전달
        console.log(`[CPM] CORS Proxy (Direct mode) → proxy=${cleanProxy.substring(0, 60)}, target=${url.substring(0, 60)}`);
        return { url: cleanProxy, targetUrl: url, mode: 'direct' };
    }
    try {
        const origUrl = new URL(url);
        const proxyBase = new URL(cleanProxy);
        const result = proxyBase.origin + proxyBase.pathname.replace(/\/+$/, '') + origUrl.pathname + origUrl.search;
        console.log(`[CPM] CORS Proxy (Rewrite mode) active → ${result}`);
        return result;
    } catch (e) {
        console.error(`[CPM] ❌ Invalid proxyUrl "${cleanProxy}" — proxy NOT applied.`, e);
        return url;
    }
}

/**
 * customParams blocklist — structural/security-critical fields that must not be
 * overridden. Migrated from _temp_repo/fetch-custom.js (full 16-field list).
 */
const CUSTOM_PARAMS_BLOCKLIST = [
    // conversation content — replacing these would discard the user's actual chat
    'messages', 'contents', 'input', 'prompt',
    // streaming control — CPM sets this based on caller intent; override would break the SSE parser
    'stream', 'stream_options',
    // model identity — the model is chosen in the provider tab UI; overriding here is almost always a mistake
    'model',
    // tool / function injection — could execute arbitrary tool definitions the user didn't intend
    'tools', 'functions', 'function_call', 'tool_choice', 'tool_config',
    // system-level overrides (both snake_case and camelCase variants)
    'system', 'system_instruction', 'systemInstruction',
];

// ── Auto-updater & toast (injected) ──
function _escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const UpdateToast = createUpdateToast({ Risu, escHtml: _escHtml });
const AutoUpdater = createAutoUpdater({
    Risu,
    currentVersion: CPM_VERSION,
    pluginName: 'Cupcake Provider Manager',
    versionsUrl: VERSIONS_URL,
    mainUpdateUrl: MAIN_UPDATE_URL,
    updateBundleUrl: UPDATE_BUNDLE_URL,
    toast: UpdateToast,
});

// ==========================================
// COPILOT TOKEN MANAGEMENT
// ==========================================
let _copilotMachineId = null;
let _copilotSessionId = null;
/** @type {string} Dynamic Copilot API base (may be updated from token exchange) */
let _copilotApiBase = 'https://api.githubcopilot.com';

/**
 * Auto-exchange stored GitHub OAuth token for a short-lived Copilot API token.
 * Caches the token until ~60s before expiry.
 */
async function _ensureCopilotApiToken() {
    const token = await ensureCopilotApiToken({
        getArg: (key) => safeGetArg(key, ''),
        fetchFn: (url, init) => Risu.nativeFetch(url, init),
    });
    const apiBase = getCopilotApiBase();
    if (apiBase) _copilotApiBase = apiBase;
    if (!token) {
        console.warn('[CPM] Copilot: No GitHub OAuth token found or token exchange failed. Set token via Copilot Manager (🔑 탭).');
    }
    return token;
}

// ── Copilot OAuth/API helpers (for settings UI) ──
const COPILOT_CLIENT_ID = '01ab8ac9400c4e429b23';
const COPILOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.7444.265 Electron/39.3.0';
const COPILOT_CODE_VER = VSCODE_VERSION;
const COPILOT_CHAT_VER = COPILOT_CHAT_VERSION;
const COPILOT_TOKEN_KEY = 'tools_githubCopilotToken';

function _sanitizeCopilotHeaders(h) {
    const c = {};
    for (const [k, v] of Object.entries(h)) {
        c[k] = Array.from(String(v)).filter((ch) => ch.charCodeAt(0) <= 0xFF).join('');
    }
    return c;
}
function _wrapRisuResult(r) {
    const ok = !!r.ok, status = r.status || (ok ? 200 : 400);
    return {
        ok, status,
        json: async () => {
            if (typeof r.data === 'object' && r.data !== null) return r.data;
            try { return JSON.parse(r.data); }
            catch { return { error: { message: `Non-JSON response (${status})`, raw: String(r.data).substring(0, 500) } }; }
        },
        text: async () => typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
    };
}
function _isRealHttp(r) {
    return (r.headers && Object.keys(r.headers).length > 0) || (r.status && r.status !== 400) || (r.data && typeof r.data === 'object');
}
async function _copilotFetch(url, opts = {}) {
    const method = opts.method || 'POST';
    const headers = _sanitizeCopilotHeaders(opts.headers || {});
    const canUseRisuFetch = typeof Risu.risuFetch === 'function';
    let body;
    if (opts.body) { try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body; } catch { body = opts.body; } }
    if (url.includes('github.com/login/')) {
        if (canUseRisuFetch) {
            const r = await Risu.risuFetch(url, { method, headers, body, rawResponse: false, plainFetchDeforce: true });
            return _wrapRisuResult(r);
        }
        const nfBody = body ? new TextEncoder().encode(JSON.stringify(body)) : undefined;
        return Risu.nativeFetch(url, { method, headers, body: nfBody });
    }
    try {
        // Encode body as Uint8Array to prevent V3 bridge serialization corruption
        // (string bodies can be corrupted by postMessage bridge → "not valid JSON" errors)
        const nfBody = body ? new TextEncoder().encode(JSON.stringify(body)) : undefined;
        const res = await Risu.nativeFetch(url, { method, headers, body: nfBody });
        if (res.ok || (res.status && res.status !== 0)) return res;
    } catch {}
    if (canUseRisuFetch) {
        try {
            const r = await Risu.risuFetch(url, { method, headers, body, rawResponse: false, plainFetchForce: true });
            if (_isRealHttp(r)) return _wrapRisuResult(r);
        } catch {}
        try {
            const r = await Risu.risuFetch(url, { method, headers, body, rawResponse: false, plainFetchDeforce: true });
            if (_isRealHttp(r)) return _wrapRisuResult(r);
        } catch {}
    }
    throw new Error('네트워크 요청 실패');
}
async function _copilotRequestDeviceCode() {
    const res = await _copilotFetch('https://github.com/login/device/code', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': COPILOT_UA },
        body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: 'user:email' })
    });
    if (!res.ok) throw new Error(`디바이스 코드 요청 실패 (${res.status})`);
    return res.json();
}
async function _copilotExchangeAccessToken(deviceCode) {
    const res = await _copilotFetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': COPILOT_UA },
        body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    });
    if (!res.ok) throw new Error(`액세스 토큰 요청 실패 (${res.status})`);
    const d = await res.json();
    if (d.error === 'authorization_pending') throw new Error('인증 미완료. GitHub에서 코드 입력 후 다시 시도.');
    if (d.error === 'slow_down') throw new Error('요청 과다. 잠시 후 재시도.');
    if (!d.access_token) throw new Error('액세스 토큰 없음');
    return d.access_token;
}
async function _copilotCheckTokenStatus(token) {
    const t = (token || '').replace(/[^\x20-\x7E]/g, '').trim();
    if (!t) throw new Error('토큰이 비어있습니다.');
    const res = await _copilotFetch('https://api.github.com/copilot_internal/v2/token', {
        method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${t}`, 'User-Agent': COPILOT_UA }
    });
    if (!res.ok) { if (res.status === 401) throw new Error('토큰 만료/무효. 새 토큰 생성 필요.'); throw new Error(`상태 확인 실패 (${res.status})`); }
    return res.json();
}
async function _copilotFetchModelList(token) {
    const tid = await _copilotCheckTokenStatus(token);
    if (!tid.token) throw new Error('Tid 토큰 불가');
    const res = await _copilotFetch(`${_copilotApiBase}/models`, {
        method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${tid.token}`,
            'Editor-Version': `vscode/${COPILOT_CODE_VER}`, 'Editor-Plugin-Version': `copilot-chat/${COPILOT_CHAT_VER}`,
            'Copilot-Integration-Id': 'vscode-chat', 'User-Agent': COPILOT_UA }
    });
    if (!res.ok) throw new Error(`모델 목록 실패 (${res.status})`);
    return res.json();
}
async function _copilotCheckQuota(token) {
    const tid = await _copilotCheckTokenStatus(token);
    const info = { plan: tid.sku || 'unknown', token_meta: {} };
    for (const [k, v] of Object.entries(tid)) { if (k !== 'token' && k !== 'tracking_id' && k !== 'sku') info.token_meta[k] = v; }
    try {
        let userData = null;
        const qh = { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        if (typeof Risu.risuFetch === 'function') {
            try { const r = await Risu.risuFetch('https://api.github.com/copilot_internal/user', { method: 'GET', headers: qh, rawResponse: false, plainFetchForce: true }); if (r?.ok && r.data && typeof r.data === 'object') userData = r.data; } catch {}
            if (!userData) { try { const r = await Risu.risuFetch('https://api.github.com/copilot_internal/user', { method: 'GET', headers: qh, rawResponse: false, plainFetchDeforce: true }); if (r?.ok && r.data && typeof r.data === 'object') userData = r.data; } catch {} }
        }
        if (userData) {
            if (userData.token && userData.tracking_id && !userData.quota_snapshots && !userData.limited_user_quotas) {
                info.proxyCacheWarning = true;
                console.warn('[CPM] Copilot /user returned token endpoint-like data. Quota data may be missing due to proxy cache.');
            }
            info.copilot_user = userData;
            if (userData.quota_snapshots) info.quota_snapshots = userData.quota_snapshots;
            if (userData.limited_user_quotas) {
                info.limited_user_quotas = userData.limited_user_quotas;
                info.limited_user_reset_date = userData.limited_user_reset_date;
            }
        }
    } catch {}
    return info;
}
async function _getCopilotToken() {
    return (await safeGetArg(COPILOT_TOKEN_KEY, '')).replace(/[^\x20-\x7E]/g, '').trim();
}
function _setCopilotToken(val) {
    const clean = (val || '').replace(/[^\x20-\x7E]/g, '').trim();
    setArg(COPILOT_TOKEN_KEY, clean);
}
function _maskToken(t) {
    if (!t) return '토큰 없음';
    return t.length > 16 ? t.substring(0, 8) + '••••••••' + t.substring(t.length - 4) : t;
}

// ==========================================
// SETTINGS BACKUP (pluginStorage-backed)
// ==========================================
const SettingsBackup = createSettingsBackup({
    Risu,
    safeGetArg,
    slotList: CPM_SLOT_LIST,
    getRegisteredProviders: () => registeredProviders,
});

// ==========================================
// SLOT INFERENCE
// ==========================================
const SLOT_HEURISTICS = {
    translation: {
        patterns: [
            /translat(?:e|ion|ing)/i, /번역/, /翻[译訳]/,
            /source\s*(?:language|lang|text)/i, /target\s*(?:language|lang)/i,
            /\b(?:en|ko|ja|zh|de|fr|es|ru)\s*(?:→|->|to|에서|으로)\s*(?:en|ko|ja|zh|de|fr|es|ru)\b/i,
            /\[(?:SL|TL|Source|Target)\]/i,
            /output\s*(?:only\s*)?(?:the\s+)?translat/i,
        ],
        weight: 2
    },
    emotion: {
        patterns: [
            /emotion|감정|표정|expression|mood|sentiment/i, /\bemote\b/i,
            /facial\s*express/i,
            /character.*(?:emotion|feeling|mood)/i,
            /(?:detect|classify|analyze).*(?:emotion|sentiment)/i,
        ],
        weight: 2
    },
    memory: {
        patterns: [
            /summar(?:y|ize|izing|isation)/i, /요약/,
            /\bmemory\b/i, /메모리/, /\brecap\b/i,
            /condense.*(?:context|conversation|chat)|compress.*(?:context|conversation|chat)/i,
            /key\s*(?:points|events|details)/i,
            /\bhypa(?:memory|v[23])\b/i, /\bsupa(?:memory)?\b/i,
        ],
        weight: 2
    },
    other: {
        patterns: [
            /\blua\b/i, /\bscript/i, /\btrigger\b/i, /트리거/,
            /\bfunction\s*call/i, /\btool\s*(?:use|call)/i,
            /\bexecute\b/i, /\butility\b/i, /\bhelper\b/i,
        ],
        weight: 1
    }
};

function scoreSlotHeuristic(promptText, slotName) {
    const h = SLOT_HEURISTICS[slotName];
    if (!h || !promptText) return 0;
    let score = 0;
    for (const p of h.patterns) { if (p.test(promptText)) score += h.weight; }
    return score;
}

/**
 * C-5/C-6: 슬롯 추론 — heuristicConfirmed 반환
 * 1개 매치 → 휴리스틱 확인 필요 (score > 0)
 * 2개+ 매치 → 휴리스틱이 명확히 구분해야 함
 * @returns {Promise<{slot: string, heuristicConfirmed: boolean}>}
 */
async function inferSlot(activeModelDef, args) {
    const matchingSlots = [];
    for (const slot of CPM_SLOT_LIST) {
        const configuredId = await safeGetArg(`cpm_slot_${slot}`, '');
        if (configuredId && configuredId === activeModelDef.uniqueId) matchingSlots.push(slot);
    }
    if (matchingSlots.length === 0) return { slot: 'chat', heuristicConfirmed: false };

    const isMultiCollision = matchingSlots.length > 1;

    let promptText = '';
    if (args?.prompt_chat && Array.isArray(args.prompt_chat)) {
        for (let i = 0; i < args.prompt_chat.length; i++) {
            const m = args.prompt_chat[i];
            if (!m) continue;
            const content = typeof m.content === 'string' ? m.content : '';
            if (m.role === 'system' || i < 3 || i >= args.prompt_chat.length - 2) promptText += content + '\n';
        }
        promptText = promptText.substring(0, 3000);
    }
    if (!promptText.trim()) {
        console.warn('[CPM] ⚠️ inferSlot: No prompt content for heuristic. Falling back to chat.');
        return { slot: 'chat', heuristicConfirmed: false };
    }

    let bestSlot = null, bestScore = 0, secondBest = 0;
    for (const slot of matchingSlots) {
        const score = scoreSlotHeuristic(promptText, slot);
        if (score > bestScore) { secondBest = bestScore; bestScore = score; bestSlot = slot; }
        else if (score > secondBest) secondBest = score;
    }

    if (bestSlot && bestScore > 0) {
        if (!isMultiCollision || bestScore > secondBest) {
            return { slot: bestSlot, heuristicConfirmed: true };
        }
    }

    console.warn(`[CPM] ⚠️ inferSlot: Heuristic ${isMultiCollision ? 'inconclusive' : 'unconfirmed'} (best: ${bestScore}). Using Risu params.`);
    return { slot: 'chat', heuristicConfirmed: false };
}

async function collectProviderSettings(provider) {
    const settings = {};
    if (Array.isArray(provider?.settingsFields)) {
        for (const field of provider.settingsFields) {
            if (!field?.key) continue;
            if (field.type === 'checkbox') {
                settings[field.key] = await safeGetBoolArg(field.key, field.defaultValue || false);
            } else {
                settings[field.key] = await safeGetArg(field.key, field.defaultValue || '');
            }
        }
    }
    settings.cpm_streaming_enabled = await safeGetBoolArg('cpm_streaming_enabled', false);
    settings.cpm_streaming_show_thinking = await safeGetBoolArg('cpm_streaming_show_thinking', false);
    settings.cpm_streaming_show_token_usage = await safeGetBoolArg(
        'cpm_streaming_show_token_usage',
        await safeGetBoolArg('cpm_show_token_usage', false)
    );
    settings.cpm_show_token_usage = settings.cpm_streaming_show_token_usage;
    settings.cpm_compatibility_mode = await safeGetBoolArg('cpm_compatibility_mode', false);
    settings.cpm_copilot_nodeless_mode = await safeGetArg('cpm_copilot_nodeless_mode', 'off');
    return settings;
}

function sortAllDefinedModels() {
    ALL_DEFINED_MODELS.sort((a, b) => {
        const p = String(a.provider || '').localeCompare(String(b.provider || ''));
        return p !== 0 ? p : String(a.name || '').localeCompare(String(b.name || ''));
    });
}

async function applyDynamicModels(providerName, incomingModels) {
    const provider = registeredProviders.get(providerName);
    if (!provider) {
        return { success: false, content: `[CPM] Provider '${providerName}' not found` };
    }

    const { mergedModels, addedModels } = mergeDynamicModels(provider.models, incomingModels, providerName);
    registeredProviders.set(providerName, { ...provider, models: mergedModels });

    let newCount = 0;
    for (const model of mergedModels) {
        const normalized = { ...model, provider: providerName };
        const uid = normalized.uniqueId || `${providerName}::${normalized.id || normalized.name}`;
        const existing = ALL_DEFINED_MODELS.find((entry) => (entry.uniqueId || `${entry.provider}::${entry.id || entry.name}`) === uid);
        if (existing) {
            Object.assign(existing, normalized);
            continue;
        }
        ALL_DEFINED_MODELS.push(normalized);
        newCount++;
        if (managerReady) {
            await registerModelWithRisu(normalized);
        }
    }

    sortAllDefinedModels();
    return {
        success: true,
        fetchedCount: Array.isArray(incomingModels) ? incomingModels.length : 0,
        mergedCount: mergedModels.length,
        newCount,
        addedModels,
    };
}

async function requestDynamicModels(providerName) {
    const provider = registeredProviders.get(providerName);
    if (!provider) return { success: false, content: `[CPM] Provider '${providerName}' not found` };
    if (!provider.supportsDynamicModels) return { success: false, content: `[CPM] Provider '${providerName}' does not support dynamic models` };

    const requestId = safeUUID();
    const settings = await collectProviderSettings(provider);

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingControlRequests.delete(requestId);
            resolve({ success: false, content: `[CPM] Dynamic model fetch timeout for '${providerName}' (45s)` });
        }, 45000);

        pendingControlRequests.set(requestId, {
            resolve: (payload) => {
                clearTimeout(timer);
                pendingControlRequests.delete(requestId);
                resolve(payload);
            },
            timer,
        });

        Risu.postPluginChannelMessage(provider.pluginName, CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId,
            settings,
        });
    });
}

async function refreshProviderDynamicModels(providerName) {
    const fetched = await requestDynamicModels(providerName);
    if (!fetched?.success) return fetched;
    return applyDynamicModels(providerName, fetched.models || []);
}

// ==========================================
// IPC: RESPONSE HANDLER (단일 리스너)
// ==========================================
// Active streaming sessions: requestId → { controller: TransformStreamDefaultController }
const _activeStreams = new Map();

function setupResponseListener() {
    Risu.addPluginChannelListener(CH.RESPONSE, (msg) => {
        if (!msg || !msg.requestId) return;

        // ── Streaming chunk handling ──
        if (msg.type === MSG.STREAM_CHUNK) {
            const stream = _activeStreams.get(msg.requestId);
            if (stream) {
                // Existing stream — enqueue chunk
                try { stream.controller.enqueue(msg.chunk); } catch { /* stream may be closed */ }
            } else {
                // First chunk — create TransformStream, resolve pending request with readable
                const pending = pendingRequests.get(msg.requestId);
                if (!pending) return;

                const ts = new TransformStream();
                const writer = ts.writable.getWriter();
                _activeStreams.set(msg.requestId, { writer, controller: null });

                // We need the controller — use a different approach with ReadableStream
                const readable = new ReadableStream({
                    start(controller) {
                        _activeStreams.set(msg.requestId, { controller });
                        try { controller.enqueue(msg.chunk); } catch { /* ignore */ }
                    },
                    cancel() {
                        _activeStreams.delete(msg.requestId);
                    }
                });

                // Resolve with ReadableStream — don't cleanup timer yet
                clearTimeout(pending.timer);
                pendingRequests.delete(msg.requestId);
                if (pending._abortCleanup) pending._abortCleanup();
                pending.resolve({ success: true, content: readable });
            }
            return;
        }

        if (msg.type === MSG.STREAM_END) {
            const stream = _activeStreams.get(msg.requestId);
            if (stream?.controller) {
                try { stream.controller.close(); } catch { /* already closed */ }
            }
            _activeStreams.delete(msg.requestId);

            // If pending request still exists (no STREAM_CHUNK was received), resolve empty
            const pending = pendingRequests.get(msg.requestId);
            if (pending) {
                clearTimeout(pending.timer);
                pendingRequests.delete(msg.requestId);
                if (pending._abortCleanup) pending._abortCleanup();
                pending.resolve({ success: true, content: '' });
            }
            return;
        }

        // ── Non-streaming response handling ──
        const pending = pendingRequests.get(msg.requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        pendingRequests.delete(msg.requestId);
        if (pending._abortCleanup) pending._abortCleanup();

        switch (msg.type) {
            case MSG.RESPONSE:
                // If _streamed flag is set, the stream was already returned — skip
                if (/** @type {any} */ (msg.data)?._streamed && _activeStreams.has(msg.requestId)) {
                    _activeStreams.delete(msg.requestId);
                    return;
                }
                pending.resolve(msg.data);
                break;
            case MSG.ERROR:
                pending.resolve({ success: false, content: msg.error || 'Provider error' });
                break;
            default:
                pending.resolve({ success: false, content: `[CPM] Unknown response type: ${msg.type}` });
        }
    });
}

// ==========================================
// IPC: FETCH → SUB-PLUGIN
// ==========================================
async function ipcFetchProvider(providerName, modelDef, messages, temp, maxTokens, args, abortSignal) {
    const provider = registeredProviders.get(providerName);
    if (!provider) return { success: false, content: `[CPM] Provider '${providerName}' not found` };

    // Pre-flight abort check (LBI pattern: check before any work)
    if (abortSignal?.aborted) {
        return { success: true, content: '' };
    }

    const requestId = safeUUID();

    // 매니저가 보유한 설정값을 수집해서 IPC 메시지에 포함
    const settings = await collectProviderSettings(provider);

    return new Promise((resolve) => {
        let settled = false;

        const cleanup = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingRequests.delete(requestId);
            if (abortCleanup) abortCleanup();
        };

        const timer = setTimeout(() => {
            cleanup();
            resolve({ success: false, content: `[CPM] Provider '${providerName}' timeout (300s)` });
        }, 300000);

        // ── ABORT signal → IPC ABORT 전파 ──
        // factory.ts의 ABORT_SIGNAL_REF 메커니즘을 통해 AbortSignal이 정상적으로
        // 브릿지를 통과합니다. Host가 AbortSignal → {__type:'ABORT_SIGNAL_REF', abortId}로
        // 변환 → Guest에서 로컬 AbortController로 재구성 → addEventListener 가능.
        // 주의: 이 AbortSignal은 Risu.risuFetch()/nativeFetch()에 직접 전달하면 안 됨
        // (structured-clone 불가 → DataCloneError). helpers.js에서 signal을 추출하여 처리.
        let abortCleanup = null;
        if (abortSignal) {
            const onAbort = () => {
                // 서브플러그인에 중단 신호 전송
                try {
                    Risu.postPluginChannelMessage(provider.pluginName, CH.ABORT, {
                        type: MSG.ABORT,
                        requestId,
                    });
                } catch { /* plugin may already be unloaded */ }

                // Close active stream if exists
                const stream = _activeStreams.get(requestId);
                if (stream?.controller) {
                    try { stream.controller.close(); } catch { /* already closed */ }
                    _activeStreams.delete(requestId);
                    // Stream was already returned to RisuAI — just cleanup
                    cleanup();
                    return;
                }

                cleanup();
                resolve({ success: true, content: '' });
            };
            if (abortSignal.aborted) {
                // Already aborted before we started
                cleanup();
                resolve({ success: true, content: '' });
                return;
            }
            abortSignal.addEventListener('abort', onAbort, { once: true });
            abortCleanup = () => abortSignal.removeEventListener('abort', onAbort);
        }

        pendingRequests.set(requestId, {
            resolve: (data) => { cleanup(); resolve(data); },
            timer,
            _abortCleanup: abortCleanup,
        });

        // 3인자: (대상 플러그인 이름, 채널명, 메시지)
        Risu.postPluginChannelMessage(provider.pluginName, CH.FETCH, {
            type: MSG.FETCH_REQUEST,
            requestId,
            modelDef,
            messages,
            temperature: temp,
            maxTokens,
            args: {
                temperature: args.temperature,
                max_tokens: args.max_tokens,
                max_context_tokens: args.max_context_tokens,
                top_p: args.top_p,
                top_k: args.top_k,
                top_a: args.top_a,
                min_p: args.min_p,
                frequency_penalty: args.frequency_penalty,
                presence_penalty: args.presence_penalty,
                repetition_penalty: args.repetition_penalty,
                thinking_tokens: args.thinking_tokens,
                mode: args.mode,
            },
            settings,
        });
    });
}

// ==========================================
// REQUEST HANDLER
// ==========================================
async function handleRequest(args, activeModelDef, abortSignal) {
    const parseNumSafe = (value, type) => {
        const s = String(value ?? '').trim();
        if (!s || s === 'undefined' || s === 'null') return undefined;
        const n = type === 'int' ? parseInt(s, 10) : parseFloat(s);
        return Number.isFinite(n) ? n : undefined;
    };

    const { slot, heuristicConfirmed } = await inferSlot(activeModelDef, args);

    // C-5: 휴리스틱이 확인된 경우에만 슬롯 오버라이드 적용
    if (slot !== 'chat' && heuristicConfirmed) {
        const overrides = ['max_out:max_tokens', 'max_context:max_context_tokens', 'temp:temperature',
            'top_p:top_p', 'top_k:top_k', 'rep_pen:repetition_penalty', 'freq_pen:frequency_penalty', 'pres_pen:presence_penalty'];
        for (const pair of overrides) {
            const [suffix, argKey] = pair.split(':');
            const val = await safeGetArg(`cpm_slot_${slot}_${suffix}`);
            if (val !== '') {
                const parsed = suffix.includes('temp') || suffix.includes('pen') || suffix.includes('top_p')
                    ? parseNumSafe(val, 'float')
                    : parseNumSafe(val, 'int');
                if (parsed !== undefined) args[argKey] = parsed;
            }
        }
    }

    // Apply CPM fallbacks
    const fb = {
        temp: await safeGetArg('cpm_fallback_temp'),
        max: await safeGetArg('cpm_fallback_max_tokens'),
        topP: await safeGetArg('cpm_fallback_top_p'),
        freqPen: await safeGetArg('cpm_fallback_freq_pen'),
        presPen: await safeGetArg('cpm_fallback_pres_pen')
    };
    const temp = args.temperature ?? (parseNumSafe(fb.temp, 'float') ?? 0.7);
    const maxTokens = args.max_tokens ?? parseNumSafe(fb.max, 'int');
    if (args.top_p === undefined) {
        const p = parseNumSafe(fb.topP, 'float');
        if (p !== undefined) args.top_p = p;
    }
    if (args.frequency_penalty === undefined) {
        const f = parseNumSafe(fb.freqPen, 'float');
        if (f !== undefined) args.frequency_penalty = f;
    }
    if (args.presence_penalty === undefined) {
        const p = parseNumSafe(fb.presPen, 'float');
        if (p !== undefined) args.presence_penalty = p;
    }

    const messages = args.prompt_chat || [];

    // C-11: 토큰 사용량 추적을 위한 요청 ID
    const _requestId = safeUUID();
    args._requestId = _requestId;

    // Pass abortSignal through args so handleCustomModel can use it for streaming
    // NOTE: signal은 helpers.js에서 bridge 호출 전에 자동으로 추출됨 (DataCloneError 방지)
    args._abortSignal = abortSignal;

    // Pre-flight abort check
    if (abortSignal?.aborted) {
        return { success: true, content: '' };
    }

    let result;
    try {
        const provider = registeredProviders.get(activeModelDef.provider);
        if (provider) {
            result = await ipcFetchProvider(activeModelDef.provider, activeModelDef, messages, temp, maxTokens, args, abortSignal);
        } else if (activeModelDef.provider === 'Custom') {
            result = await handleCustomModel(activeModelDef, messages, temp, maxTokens, args);
        } else {
            result = { success: false, content: `[CPM] Unknown provider: ${activeModelDef.provider}` };
        }
    } catch (e) {
        result = { success: false, content: `[CPM Crash] ${e.message}` };
    }

    if (!result) return { success: false, content: '[CPM] No result' };

    // ─── BUG-S6-5 FIX: abort 체크 — 이미 취소된 요청의 스트림을 불필요하게 처리하지 않음
    if (abortSignal?.aborted) {
        // 스트림이 있으면 취소하여 리소스 해제
        if (result.content instanceof ReadableStream) {
            try { result.content.cancel(); } catch { /* ignore */ }
        }
        return { success: false, content: '[CPM] Request aborted' };
    }

    // Streaming pass-through: conditionally return ReadableStream to RisuAI
    if (result.success && result.content instanceof ReadableStream) {
        const streamEnabled = await safeGetBoolArg('cpm_streaming_enabled', false);
        if (streamEnabled) {
            const bridgeCapable = await checkStreamCapability();
            if (bridgeCapable) {
                // Wrap stream with logging TransformStream before returning to RisuAI
                // Byte cap: 512KB max for response logging (migrated from _temp_repo)
                const _chunks = [];
                let _totalBytes = 0;
                const _STREAM_LOG_CAP = 512 * 1024;
                result.content = result.content.pipeThrough(new TransformStream({
                    transform(chunk, controller) {
                        if (_totalBytes < _STREAM_LOG_CAP) {
                            _chunks.push(chunk);
                            _totalBytes += (typeof chunk === 'string' ? chunk.length : chunk?.byteLength || 0);
                        }
                        controller.enqueue(chunk);
                    },
                    flush() {
                        const full = _chunks.join('');
                        console.log(`[CPM] ✓ Streamed: ${full.length} chars`);
                        // C-11: 스트림 완료 후 토큰 사용량 토스트 표시
                        if (_requestId) {
                            const usage = _takeTokenUsage(_requestId);
                            if (usage) {
                                try { showTokenToast(activeModelDef.name || activeModelDef.model || '', usage); } catch {}
                            }
                        }
                    }
                }));
                console.log('[CPM] ✓ Streaming: returning ReadableStream to RisuAI');
            } else {
                // Bridge can't transfer ReadableStream → collect to string
                console.warn('[CPM] ⚠ Streaming enabled but V3 bridge cannot transfer ReadableStream. Collecting to string.');
                result.content = await collectStream(result.content, abortSignal);
            }
        } else {
            // Streaming disabled → always collect to string
            result.content = await collectStream(result.content, abortSignal);
        }
    }

    // C-11: 토큰 사용량 토스트 표시
    if (result.success && _requestId) {
        // 스트림인 경우 스트림 완료 후 표시, 아닌 경우 즉시 표시
        if (result.content instanceof ReadableStream) {
            // 스트림이 끝난 뒤 토큰 토스트를 표시하도록 TransformStream에서 처리
        } else {
            const usage = _takeTokenUsage(_requestId);
            if (usage) {
                try { showTokenToast(activeModelDef.name || activeModelDef.model || '', usage); } catch {}
            }
        }
    }

    return result;
}

function buildCustomEndpointUrl(rawUrl, format, modelId) {
    const defaults = {
        openai: 'https://api.openai.com/v1/chat/completions',
        anthropic: 'https://api.anthropic.com/v1/messages',
        google: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId || 'gemini-2.5-flash')}:generateContent`
    };

    const f = format || 'openai';
    const input = String(rawUrl || '').trim();
    if (!input) return defaults[f] || defaults.openai;

    let u;
    try {
        u = new URL(input);
    } catch {
        return input;
    }

    const path = u.pathname || '';

    if (f === 'anthropic') {
        if (/\/v1\/messages$/i.test(path)) return u.toString();
        if (/\/v1$/i.test(path)) u.pathname = `${path}/messages`;
        else u.pathname = `${path.replace(/\/+$/, '')}/v1/messages`;
        return u.toString();
    }

    if (f === 'google') {
        if (/:generateContent$|:streamGenerateContent$/i.test(path)) return u.toString();
        if (/\/v\d+(?:beta)?\/models\/[^/]+$/i.test(path)) {
            u.pathname = `${path}:generateContent`;
            return u.toString();
        }
        const mid = encodeURIComponent(modelId || 'gemini-2.5-flash');
        u.pathname = `${path.replace(/\/+$/, '')}/v1beta/models/${mid}:generateContent`;
        return u.toString();
    }

    // openai-compatible
    if (/\/chat\/completions$/i.test(path)) return u.toString();
    if (/\/v\d+(?:\.\d+)?$/i.test(path)) u.pathname = `${path}/chat/completions`;
    else u.pathname = `${path.replace(/\/+$/, '')}/v1/chat/completions`;
    return u.toString();
}

// ==========================================
// CUSTOM MODEL HANDLER (built-in, no IPC)
// ==========================================
async function handleCustomModel(modelDef, messagesRaw, temp, maxTokens, args) {
    const cDef = CUSTOM_MODELS_CACHE.find(m => m.uniqueId === modelDef.uniqueId);
    if (!cDef) return { success: false, content: '[CPM] Custom model config not found.' };

    // GAP-FIX: sanitize raw messages before formatting (migrated from _temp_repo)
    const messages = sanitizeMessages(messagesRaw);

    const parseBool = (value) => {
        if (value === true || value === false) return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value !== 'string') return false;
        const v = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(v)) return true;
        if (['false', '0', 'no', 'off', 'undefined', 'null', ''].includes(v)) return false;
        return false;
    };
    const parsePositiveInt = (value) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };

    const sysfirst = parseBool(cDef.sysfirst);
    const altrole = parseBool(cDef.altrole);
    const mustuser = parseBool(cDef.mustuser);
    const mergesys = parseBool(cDef.mergesys);
    const thought = parseBool(cDef.thought);
    const decoupled = parseBool(cDef.decoupled);
    const maxout = parseBool(cDef.maxout);
    const streaming = (cDef.streaming === undefined || cDef.streaming === null || cDef.streaming === '')
        ? undefined
        : parseBool(cDef.streaming);
    const thinkingBudget = parsePositiveInt(cDef.thinkingBudget);

    // GAP-FIX: clamp maxTokens BEFORE body construction (migrated from _temp_repo)
    if (cDef.maxOutputLimit && cDef.maxOutputLimit > 0 && typeof maxTokens === 'number' && maxTokens > cDef.maxOutputLimit) {
        console.warn(`[CPM-Custom] max_tokens ${maxTokens} → clamped to ${cDef.maxOutputLimit} for ${cDef.model} (user limit)`);
        maxTokens = cDef.maxOutputLimit;
    }

    const format = cDef.format || 'openai';
    let formattedMessages, systemPrompt = '';

    if (format === 'anthropic') {
        const { messages: anthMsgs, system: anthSys } = formatToAnthropic(messages, {
            sysfirst, altrole, mustuser, mergesys
        });
        formattedMessages = anthMsgs;
        systemPrompt = anthSys;
    } else if (format === 'google') {
        const { contents: gContents, systemInstruction: gSys } = formatToGemini(messages, {
            preserveSystem: sysfirst !== false,
            useThoughtSignature: thought,
            sysfirst, altrole, mustuser, mergesys
        });
        formattedMessages = gContents;
        systemPrompt = gSys.length > 0 ? gSys.join('\n\n') : '';
    } else {
        // GAP-FIX: set developerRole BEFORE formatting so formatter can use it (migrated from _temp_repo)
        const modelId = String(cDef.model || '');
        const developerRole = /(?:^|\/)(?:gpt-5|o[2-9]|o1(?!-(?:preview|mini)))/i.test(modelId);
        formattedMessages = formatToOpenAI(messages, {
            sysfirst, altrole,
            mustuser, mergesys,
            developerRole
        });
    }

    // Final role normalization for OpenAI-compatible APIs
    if (format === 'openai' && Array.isArray(formattedMessages)) {
        const _validRoles = new Set(['system', 'user', 'assistant', 'tool', 'function', 'developer']);
        for (const _fm of formattedMessages) {
            if (_fm && typeof _fm.role === 'string' && !_validRoles.has(_fm.role)) {
                _fm.role = (_fm.role === 'model' || _fm.role === 'char') ? 'assistant' : 'user';
            }
        }
    }

    // Deep-clone + filter messages/contents (strip nulls, validate structure)
    if (Array.isArray(formattedMessages)) {
        try { formattedMessages = JSON.parse(JSON.stringify(formattedMessages)); } catch { }
        const before = formattedMessages.length;
        if (format === 'google') {
            // Gemini contents entries have { role, parts: [...] }, NOT content
            formattedMessages = formattedMessages.filter(m => m != null && typeof m === 'object');
        } else {
            formattedMessages = formattedMessages.filter(m => {
                if (m == null || typeof m !== 'object') return false;
                // GAP-FIX: stricter message filtering using hasNonEmptyMessageContent + hasAttachedMultimodals (migrated from _temp_repo)
                if (!hasNonEmptyMessageContent(m.content) && !hasAttachedMultimodals(m)) return false;
                if (typeof m.role !== 'string' || !m.role) return false;
                return true;
            });
        }
        if (formattedMessages.length < before) {
            console.warn(`[CPM] Removed ${before - formattedMessages.length} invalid entries from formatted messages`);
        }
        if (formattedMessages.length === 0) {
            return { success: false, content: '[CPM] Messages are empty after sanitization — cannot send request.' };
        }
    }

    // Build body per format
    /** @type {Record<string, any>} */
    const body = {};
    if (format === 'anthropic') {
        body.model = cDef.model;
        body.messages = formattedMessages;
        body.max_tokens = maxTokens || 4096;
        if (temp !== undefined) body.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
        if (systemPrompt) body.system = systemPrompt;

        // GAP-FIX: Anthropic adaptive/effort/budget thinking logic (migrated exactly from _temp_repo)
        const effortRaw = String(cDef.effort || '').trim().toLowerCase();
        const thinkingMode = String(cDef.thinking || cDef.thinking_level || '').trim().toLowerCase();
        const adaptiveToggle = !!cDef.adaptiveThinking;
        const VALID_EFFORTS = ['low', 'medium', 'high', 'max'];

        // Adaptive thinking: only when explicit adaptiveThinking toggle is ON (or legacy thinkingMode === 'adaptive')
        const useAdaptiveThinking = adaptiveToggle || thinkingMode === 'adaptive';
        if (useAdaptiveThinking) {
            body.thinking = { type: 'adaptive' };
            const adaptiveEffort = VALID_EFFORTS.includes(effortRaw) ? effortRaw : 'high';
            body.output_config = { effort: adaptiveEffort };
            body.max_tokens = Math.max(body.max_tokens || 0, 16000);
            delete body.temperature; delete body.top_k; delete body.top_p;
        } else if (VALID_EFFORTS.includes(effortRaw)) {
            // Effort WITHOUT adaptive thinking — set output_config only (no thinking block)
            body.output_config = { effort: effortRaw };
        }

        // Budget-based thinking (type: 'enabled') — independent of adaptive/effort
        if (!useAdaptiveThinking) {
            const explicitBudget = thinkingBudget;
            const legacyBudget = parseInt(cDef.thinking_level) || 0;
            const budget = explicitBudget > 0 ? explicitBudget : legacyBudget;
            if (budget > 0) {
                body.thinking = { type: 'enabled', budget_tokens: budget };
                if (!body.max_tokens || body.max_tokens <= budget) body.max_tokens = budget + 4096;
                delete body.temperature; delete body.top_k; delete body.top_p;
            }
        }
    } else if (format === 'google') {
        body.contents = formattedMessages;
        // GAP-FIX: pass model to getGeminiSafetySettings for model-specific safety (migrated from _temp_repo)
        body.safetySettings = getGeminiSafetySettings(cDef.model);
        const gc = {};
        if (maxTokens) gc.maxOutputTokens = maxTokens;
        if (temp !== undefined) gc.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) gc.topP = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) gc.topK = args.top_k;
        if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) gc.frequencyPenalty = args.frequency_penalty;
        if (args.presence_penalty !== undefined && args.presence_penalty !== null) gc.presencePenalty = args.presence_penalty;

        // GAP-FIX: detect Vertex endpoint for thinking config differences (migrated from _temp_repo)
        const _isVertexEndpoint = !!(cDef.url && (cDef.url.includes('aiplatform.googleapis.com') || cDef.url.includes('vertex')));
        const thinkingLevel = cDef.thinking || cDef.thinking_level || '';
        const thinkingConfig = buildGeminiThinkingConfig(cDef.model, thinkingLevel, thinkingBudget || undefined, _isVertexEndpoint);
        if (thinkingConfig) gc.thinkingConfig = thinkingConfig;

        validateGeminiParams(gc);
        cleanExperimentalModelParams(gc, cDef.model);

        body.generationConfig = gc;
        if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
    } else {
        // OpenAI-compatible
        body.model = cDef.model;
        body.messages = formattedMessages;
        if (temp !== undefined) body.temperature = temp;
        if (maxTokens) {
            if (needsMaxCompletionTokens(cDef.model)) { body.max_completion_tokens = maxTokens; }
            else { body.max_tokens = maxTokens; }
        }
        if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
        // GAP-FIX: include top_k for OpenAI format (migrated from _temp_repo)
        if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
        if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) body.frequency_penalty = args.frequency_penalty;
        if (args.presence_penalty !== undefined && args.presence_penalty !== null) body.presence_penalty = args.presence_penalty;
        if (args.repetition_penalty !== undefined && args.repetition_penalty !== null) body.repetition_penalty = args.repetition_penalty;
        if (args.min_p !== undefined && args.min_p !== null) body.min_p = args.min_p;

        // GAP-FIX: maxout overrides EVERYTHING (migrated from _temp_repo)
        if (maxout && maxTokens) {
            body.max_output_tokens = maxTokens;
            delete body.max_tokens;
            delete body.max_completion_tokens;
        }

        // Reasoning effort (o3/o1/gpt-5 등) — model-helpers 사용
        const reasoning = cDef.reasoning || '';
        if (reasoning && reasoning !== 'none' && reasoning !== 'off') {
            if (supportsOpenAIReasoningEffort(cDef.model)) {
                body.reasoning_effort = reasoning;
            }
        }

        // GAP-FIX: o-series param stripping matches _temp_repo (strips ALL sampling params)
        const _modelStr = String(cDef.model || '').toLowerCase();
        if (shouldStripOpenAISamplingParams(_modelStr)) {
            delete body.temperature; delete body.top_p; delete body.frequency_penalty;
            delete body.presence_penalty; delete body.min_p; delete body.repetition_penalty;
        }
        if (shouldStripGPT54SamplingForReasoning(_modelStr, reasoning)) {
            delete body.temperature;
            delete body.top_p;
        }

        // Verbosity
        const verbosity = cDef.verbosity || '';
        if (verbosity && verbosity !== 'none') body.verbosity = verbosity;

        // Prompt cache retention (OpenAI)
        const cacheRet = cDef.promptCacheRetention || '';
        if (cacheRet && cacheRet !== 'none') body.prompt_cache_retention = cacheRet;
    }

    // Custom parameters (추가 JSON) — full blocklist from _temp_repo (16 fields)
    if (cDef.customParams) {
        try {
            const extra = JSON.parse(cDef.customParams);
            if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
                const safeExtra = { ...extra };
                const stripped = [];
                for (const key of CUSTOM_PARAMS_BLOCKLIST) {
                    if (key in safeExtra) { stripped.push(key); delete safeExtra[key]; }
                }
                if (stripped.length > 0) {
                    console.warn(`[CPM] customParams: blocked field(s) stripped: ${stripped.join(', ')}. Use the main UI settings instead.`);
                }
                // Type guard: reject thenables (Promise-like objects)
                for (const [key, value] of Object.entries(safeExtra)) {
                    if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
                        delete safeExtra[key];
                        console.warn(`[CPM] customParams: rejected non-serializable value for key "${key}"`);
                    }
                }
                Object.assign(body, safeExtra);
            }
        } catch (e) { console.error('[CPM] Failed to parse customParams JSON:', e); }
    }

    // NOTE: maxOutputLimit clamping already applied BEFORE body construction (see above).
    // NOTE: developerRole already set via formatter (see formatToOpenAI config above).

    // URL: 완전한 엔드포인트면 그대로 사용, 불완전하면 포맷별 기본 경로 자동 보완
    let url = buildCustomEndpointUrl(cDef.url, format, cDef.model);

    // Copilot + Anthropic: force canonical endpoint (buildCustomEndpointUrl appends /v1/messages
    // to the user's URL path, but Copilot needs a completely different path)
    if (url.includes('githubcopilot.com') && format === 'anthropic') {
        url = `${_copilotApiBase}/v1/messages`;
    }

    // CORS Proxy support (migrated from _temp_repo/fetch-custom.js)
    const _rawProxyUrl = (cDef.proxyUrl || '').replace(/\/+$/, '');
    const _proxyDirect = !!cDef.proxyDirect;
    let _proxyUrl = _rawProxyUrl;
    let _proxyResult = null;
    const _isProxied = !!_proxyUrl;
    if (_proxyUrl) {
        _proxyResult = _applyCorsProxy(url, _proxyUrl, _proxyDirect);
        if (typeof _proxyResult === 'string') {
            url = _proxyResult;
        } else if (_proxyResult && _proxyResult.mode === 'direct') {
            // Direct mode: url stays as the proxy URL, original URL goes to X-Target-URL header
            _proxyUrl = _proxyResult.url;
        }
    }

    const apiKey = cDef.key || '';

    // Google API key is added to URL inside doFetch (per-key for rotation support)

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && format !== 'google') headers['Authorization'] = `Bearer ${apiKey}`;

    // Copilot auto-detection: if URL is githubcopilot.com, auto-fetch API token + attach Copilot headers
    const isCopilotUrl = url.includes('githubcopilot.com');

    if (format === 'anthropic') {
        // GAP-FIX: Only set x-api-key when URL includes 'api.anthropic.com' (migrated from _temp_repo)
        if (apiKey && url.includes('api.anthropic.com')) {
            headers['x-api-key'] = apiKey;
        } else if (apiKey) {
            headers['x-api-key'] = apiKey;
        }
        headers['anthropic-version'] = '2023-06-01';
        // anthropic-dangerous-direct-browser-access only needed for direct Anthropic API, not Copilot proxy
        if (!isCopilotUrl && !_isProxied) {
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
        }
        delete headers['Authorization'];
        const anthropicBetas = [];
        if (!isCopilotUrl && !_isProxied) {
            // Direct Anthropic API: output-128k beta header (migrated from _temp_repo)
            const effectiveMaxTokens = body.max_tokens || maxTokens || 0;
            if (effectiveMaxTokens > 8192) anthropicBetas.push('output-128k-2025-02-19');
        }
        const hasPromptCaching = Array.isArray(body.messages) && body.messages.some(msg =>
            Array.isArray(msg?.content) && msg.content.some(part => part?.cache_control?.type === 'ephemeral')
        );
        if (hasPromptCaching) anthropicBetas.push('prompt-caching-2024-07-31');
        if (body.thinking) anthropicBetas.push('interleaved-thinking-2025-05-14');
        if (anthropicBetas.length > 0) headers['anthropic-beta'] = anthropicBetas.join(',');
    }

    // CORS proxy + Copilot: pass raw OAuth token so proxy can exchange (migrated from _temp_repo)
    if (_isProxied && isCopilotUrl) {
        let proxiedCopilotToken = apiKey;
        if (!proxiedCopilotToken) {
            const _githubToken = await safeGetArg('tools_githubCopilotToken');
            proxiedCopilotToken = String(_githubToken || '').replace(/[^\x20-\x7E]/g, '').trim();
        }
        if (!proxiedCopilotToken) {
            return { success: false, content: '[CPM] CORS Proxy 사용 시 GitHub Copilot OAuth 토큰이 필요합니다. Copilot Manager 토큰 또는 커스텀 모델 API Key에 OAuth 토큰을 넣어 주세요.' };
        }
        headers['Authorization'] = `Bearer ${proxiedCopilotToken}`;
    }

    const compatibilityMode = await safeGetBoolArg('cpm_compatibility_mode', false);
    const copilotNodelessMode = normalizeCopilotNodelessMode(await safeGetArg('cpm_copilot_nodeless_mode', 'off'));

    if (isCopilotUrl) {
        const copilotApiToken = await _ensureCopilotApiToken();
        if (copilotApiToken) {
            headers['Authorization'] = `Bearer ${copilotApiToken}`;
        } else {
            // GAP-FIX: fail fast on missing Copilot token (migrated from _temp_repo)
            console.error('[CPM] Copilot: Token exchange failed — cannot authenticate.');
            return { success: false, content: '[CPM] Copilot API 토큰 교환 실패. GitHub Copilot OAuth 토큰이 유효한지 확인하세요. (Token exchange failed — check your Copilot OAuth token.)' };
        }

        // Persistent Copilot session IDs
        if (!_copilotMachineId) {
            _copilotMachineId = Array.from({ length: 64 }, () =>
                Math.floor(Math.random() * 16).toString(16)
            ).join('');
        }
        if (!_copilotSessionId) {
            _copilotSessionId = safeUUID() + Date.now().toString();
        }

        Object.assign(headers, getCopilotStaticHeaders(copilotNodelessMode));
        if (!shouldUseLegacyCopilotRequestHeaders(copilotNodelessMode)) {
            headers['Vscode-Machineid'] = _copilotMachineId;
            headers['Vscode-Sessionid'] = _copilotSessionId;
            headers['X-Interaction-Id'] = safeUUID();
            headers['X-Request-Id'] = safeUUID();
        }

        // Copilot-Vision-Request: detect vision content in messages
        if (body.messages && body.messages.some(m =>
            Array.isArray(m?.content) && m.content.some(p => p.type === 'image_url' || p.type === 'image')
        )) {
            headers['Copilot-Vision-Request'] = 'true';
        }

        // Anthropic format via Copilot: add anthropic-version header
        if (format === 'anthropic') {
            headers['anthropic-version'] = '2023-06-01';
        }
    }

    const responsesMode = String(cDef.responsesMode || 'auto').toLowerCase();
    const responsesForceOn = responsesMode === 'on' || responsesMode === 'force' || responsesMode === 'always';
    const responsesForceOff = responsesMode === 'off' || responsesMode === 'disable' || responsesMode === 'disabled';
    const isManualResponsesEndpoint = /\/responses(?:\?|$)/i.test(url);
    const canUseResponsesByUrl = isManualResponsesEndpoint || isCopilotUrl;
    const autoResponsesMatch = isManualResponsesEndpoint || (isCopilotUrl && needsCopilotResponsesAPI(cDef.model));
    const useResponsesAPI = format === 'openai' && !responsesForceOff && canUseResponsesByUrl && (responsesForceOn || autoResponsesMatch);

    // Log API request for API View panel
    const _logEntry = { id: safeUUID(), timestamp: Date.now(), url, modelName: cDef.name || cDef.model, method: 'POST' };
    try { _logEntry.requestBody = JSON.parse(JSON.stringify(body)); } catch { _logEntry.requestBody = body; }
    _logEntry.requestHeaders = { ...headers, Authorization: headers.Authorization ? '***REDACTED***' : undefined };
    _logApiRequest(_logEntry);

    // --- Streaming decision ---
    const streamingEnabled = await safeGetBoolArg('cpm_streaming_enabled', false);
    const perModelStreamingEnabled = (streaming === true)
        || (streaming !== false && !decoupled);
    const useStreaming = shouldEnableStreaming({ cpm_streaming_enabled: streamingEnabled, cpm_compatibility_mode: compatibilityMode }, { isCopilot: isCopilotUrl }) && perModelStreamingEnabled;

    if (compatibilityMode && !isCopilotUrl && perModelStreamingEnabled) {
        console.warn('[CPM] Compatibility mode active — forcing non-streaming for custom non-Copilot request.');
    }

    if (!useStreaming && isCopilotUrl) {
        console.warn('[CPM] Copilot request in non-stream mode. Long responses may return 524 via proxy.');
    }

    // --- Key rotation wrapper ---
    const pool = new KeyPool(apiKey);

    // GAP-FIX: Direct proxy wrapper (migrated from _temp_repo)
    const _proxyObj = (typeof _proxyResult === 'object' && _proxyResult) ? _proxyResult : null;
    const _smartFetchFn = (_proxyDirect && _proxyObj && _proxyObj.mode === 'direct')
        ? async (fetchUrl, options = {}) => {
            const directHeaders = { ...(options.headers || {}), 'X-Target-URL': fetchUrl };
            return smartFetch(_proxyUrl, { ...options, headers: directHeaders });
        }
        : smartFetch;
    const _streamFetchFn = (_proxyDirect && _proxyObj && _proxyObj.mode === 'direct')
        ? async (fetchUrl, options = {}) => {
            const directHeaders = { ...(options.headers || {}), 'X-Target-URL': fetchUrl };
            return streamingFetch(_proxyUrl, { ...options, headers: directHeaders });
        }
        : streamingFetch;

    const doFetch = async (currentKey) => {
        // Apply current key to headers
        const reqHeaders = { ...headers };
        if (format === 'anthropic') {
            // Only set x-api-key if key is non-empty (Copilot models use Authorization instead)
            if (currentKey) reqHeaders['x-api-key'] = currentKey;
        } else if (format === 'google') {
            // Google uses key as URL query parameter — handled below per path
        } else if (!isCopilotUrl && currentKey) {
            reqHeaders['Authorization'] = `Bearer ${currentKey}`;
        }

        if (useStreaming) {
            // === STREAMING PATH ===
            const streamBody = { ...body };
            let streamUrl = url;

            if (format === 'anthropic') {
                streamBody.stream = true;
            } else if (format === 'google') {
                streamUrl = url.replace(':generateContent', ':streamGenerateContent');
                if (currentKey) {
                    const sep = streamUrl.includes('?') ? '&' : '?';
                    streamUrl += `${sep}key=${encodeURIComponent(currentKey)}`;
                }
                if (!streamUrl.includes('alt=')) streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'alt=sse';
            } else if (useResponsesAPI) {
                // C-9: Responses API (GPT-5.4+ Copilot) — URL과 body 변환
                streamUrl = url.replace(/\/chat\/completions$/i, '/responses');
                streamBody.stream = true;
                // C-4: Responses API는 messages 대신 input 사용, name 필드 제거
                if (streamBody.messages) {
                    streamBody.input = Array.isArray(streamBody.messages)
                        ? streamBody.messages.filter(m => m != null && typeof m === 'object').map(({ name: _name, ...rest }) => rest)
                        : [];
                    delete streamBody.messages;
                }
                // C-5: reasoning_effort → reasoning object
                if (streamBody.reasoning_effort) {
                    streamBody.reasoning = { effort: streamBody.reasoning_effort, summary: 'auto' };
                    delete streamBody.reasoning_effort;
                }
                // GAP-FIX: Responses API max_completion_tokens/max_tokens → max_output_tokens (migrated from _temp_repo)
                if (streamBody.max_completion_tokens) { streamBody.max_output_tokens = streamBody.max_completion_tokens; delete streamBody.max_completion_tokens; }
                else if (streamBody.max_tokens) { streamBody.max_output_tokens = streamBody.max_tokens; delete streamBody.max_tokens; }
                // GAP-FIX: Strip sampling params for Responses API (migrated from _temp_repo)
                if (args.temperature === undefined || args.temperature === null) delete streamBody.temperature;
                if (args.top_p === undefined || args.top_p === null) delete streamBody.top_p;
                if (args.frequency_penalty === undefined || args.frequency_penalty === null) delete streamBody.frequency_penalty;
                if (args.presence_penalty === undefined || args.presence_penalty === null) delete streamBody.presence_penalty;
                delete streamBody.min_p; delete streamBody.repetition_penalty;
                // Responses API: stream_options / prompt_cache_retention 미지원
                delete streamBody.stream_options;
                delete streamBody.prompt_cache_retention;
            } else {
                // OpenAI-compatible
                streamBody.stream = true;
                // GAP-FIX: stream_options for token usage tracking (migrated from _temp_repo)
                const _wantStreamUsage = await safeGetBoolArg('cpm_show_token_usage', false);
                if (_wantStreamUsage) streamBody.stream_options = { include_usage: true };
            }

            const finalBody = sanitizeBodyJSON(safeStringify(streamBody));
            // GAP-FIX: body size warning (migrated from _temp_repo)
            const _streamBodyLen = finalBody.length;
            if (_streamBodyLen > 5_000_000) {
                console.warn(`[CPM] ⚠️ Streaming body size: ${(_streamBodyLen / 1_048_576).toFixed(2)} MB (${streamBody.messages?.length || 0} messages). Large bodies may cause 'unexpected EOF' if V3 bridge truncates data.`);
            }

            try {
                // Retry with exponential backoff (migrated from _temp_repo)
                const res = await _executeWithRetry(
                    () => _streamFetchFn(streamUrl, { method: 'POST', headers: reqHeaders, body: finalBody, signal: args._abortSignal }),
                    `${format} stream request`, 3, args._abortSignal
                );

                _logEntry.status = res.status;

                if (!res.ok) {
                    const errText = await res.text();
                    _logEntry.response = errText.substring(0, 2000);
                    // GAP-FIX: Enhanced diagnostic for JSON truncation errors (migrated from _temp_repo)
                    if (res.status === 400 && errText.includes('unexpected EOF')) {
                        console.error(`[CPM] \u274c API returned 'unexpected EOF' \u2014 the JSON body was likely truncated during transfer.`,
                            `\n  Body size: ${_streamBodyLen} chars`,
                            `\n  Message count: ${streamBody.messages?.length || streamBody.input?.length || 0}`,
                            `\n  Format: ${format}`,
                            `\n  URL: ${streamUrl?.substring(0, 80)}`,
                            `\n  Hint: If body > 5MB, try reducing chat history length or removing images.`);
                    }
                    return { success: false, content: `[Custom Error ${res.status}] ${errText}`, _status: res.status };
                }

                // Copilot stream guard: check ReadableStream availability (migrated from _temp_repo)
                const _hasReadableStreamBody = !!(res?.body && typeof res.body.getReader === 'function');
                if (!_hasReadableStreamBody) {
                    const _isCopilotStreamUrl = !!(streamUrl && streamUrl.includes('githubcopilot.com'));
                    if (_isCopilotStreamUrl) {
                        console.error('[CPM] Copilot streaming response body unavailable (no ReadableStream).');
                        return { success: false, content: '[CPM] Copilot 스트리밍 응답 본문을 읽을 수 없습니다. ReadableStream이 지원되지 않는 환경입니다.', _status: 0 };
                    }
                    // Non-streaming fallback for non-Copilot (migrated from _temp_repo)
                    console.warn(`[CPM] Streaming response body unavailable for ${format}; retrying as non-streaming.`);
                    const _toNonStreamingUrl = (urlValue) => {
                        let nextUrl = String(urlValue || streamUrl || '');
                        if (format === 'google') {
                            nextUrl = nextUrl.replace(':streamGenerateContent', ':generateContent');
                            nextUrl = nextUrl.replace(/([?&])alt=sse(&)?/i, (_m, sep, tail) => (tail ? sep : ''));
                            nextUrl = nextUrl.replace(/\\?&/, '?').replace(/[?&]$/, '');
                        }
                        return nextUrl;
                    };
                    const fallbackUrl = _toNonStreamingUrl(streamUrl);
                    const fallbackBodyObj = { ...body };
                    delete fallbackBodyObj.stream_options;
                    if (format !== 'google') fallbackBodyObj.stream = false;
                    const fallbackBody = sanitizeBodyJSON(safeStringify(fallbackBodyObj));
                    const fallbackRes = await _executeWithRetry(
                        () => _smartFetchFn(fallbackUrl, { method: 'POST', headers: reqHeaders, body: fallbackBody, signal: args._abortSignal }),
                        `${format} non-stream fallback`, 3, args._abortSignal
                    );
                    if (!fallbackRes.ok) {
                        const errBody = await fallbackRes.text();
                        return { success: false, content: `[Custom Error ${fallbackRes.status}] ${errBody}`, _status: fallbackRes.status };
                    }
                    const fallbackText = await fallbackRes.text();
                    let fallbackData;
                    try { fallbackData = JSON.parse(fallbackText); } catch {
                        return { success: false, content: `[Custom API Error] Response is not JSON: ${fallbackText.substring(0, 1000)}`, _status: fallbackRes.status };
                    }
                    if (format === 'anthropic') return parseClaudeNonStreamingResponse(fallbackData, { showThinking: thought });
                    if (format === 'google') return parseGeminiNonStreamingResponse(fallbackData, { showThoughtsToken: thought, useThoughtSignature: thought });
                    if (useResponsesAPI) return parseResponsesAPINonStreamingResponse(fallbackData, { showThinking: thought, _requestId: args._requestId });
                    return parseOpenAINonStreamingResponse(fallbackData, { showThinking: thought, _requestId: args._requestId });
                }

                _logEntry.response = '(streaming…)';

                if (format === 'anthropic') {
                    const showThinking = await safeGetBoolArg('cpm_streaming_show_thinking', false);
                    return { success: true, content: createAnthropicSSEStream(res, args._abortSignal, { showThinking, _requestId: args._requestId }) };
                } else if (format === 'google') {
                    const geminiConfig = {
                        showThoughtsToken: thought,
                        useThoughtSignature: thought,
                        _requestId: args._requestId,
                        _accumulatedContent: '',
                    };
                    const onComplete = () => {
                        // STB-9: Stream content logging
                        if (geminiConfig._requestId && geminiConfig._accumulatedContent) {
                            try { updateApiRequest(geminiConfig._requestId, { streamContent: geminiConfig._accumulatedContent }); } catch {}
                        }
                        return saveThoughtSignatureFromStream(geminiConfig);
                    };
                    return { success: true, content: createSSEStream(res, (line) => {
                        const text = parseGeminiSSELine(line, geminiConfig);
                        if (text) geminiConfig._accumulatedContent += text;
                        return text;
                    }, args._abortSignal, onComplete) };
                } else if (useResponsesAPI) {
                    // C-9: Responses API 스트림 (GPT-5.4+ Copilot)
                    const showThinking = await safeGetBoolArg('cpm_streaming_show_thinking', false);
                    return { success: true, content: createResponsesAPISSEStream(res, args._abortSignal, { showThinking, _requestId: args._requestId }) };
                } else {
                    const openaiConfig = { showThinking: thought, _requestId: args._requestId };
                    return { success: true, content: createOpenAISSEStream(res, args._abortSignal, openaiConfig) };
                }
            } catch (e) {
                return { success: false, content: `[Custom Stream] ${e.message}` };
            }
        } else {
            // === NON-STREAMING PATH (existing logic) ===
            try {
                // C-9: Responses API 비스트리밍 — URL/body 변환
                let nonStreamBody = body;
                if (useResponsesAPI) {
                    nonStreamBody = { ...body };
                    // C-4: name 필드 제거
                    if (nonStreamBody.messages) {
                        nonStreamBody.input = Array.isArray(nonStreamBody.messages)
                            ? nonStreamBody.messages.filter(m => m != null && typeof m === 'object').map(({ name: _name, ...rest }) => rest)
                            : [];
                        delete nonStreamBody.messages;
                    }
                    // C-5: reasoning_effort → reasoning object
                    if (nonStreamBody.reasoning_effort) {
                        nonStreamBody.reasoning = { effort: nonStreamBody.reasoning_effort, summary: 'auto' };
                        delete nonStreamBody.reasoning_effort;
                    }
                    // GAP-FIX: Responses API max_completion_tokens/max_tokens → max_output_tokens (migrated from _temp_repo)
                    if (nonStreamBody.max_completion_tokens) { nonStreamBody.max_output_tokens = nonStreamBody.max_completion_tokens; delete nonStreamBody.max_completion_tokens; }
                    else if (nonStreamBody.max_tokens) { nonStreamBody.max_output_tokens = nonStreamBody.max_tokens; delete nonStreamBody.max_tokens; }
                    // GAP-FIX: Strip sampling params for Responses API (migrated from _temp_repo)
                    if (args.temperature === undefined || args.temperature === null) delete nonStreamBody.temperature;
                    if (args.top_p === undefined || args.top_p === null) delete nonStreamBody.top_p;
                    if (args.frequency_penalty === undefined || args.frequency_penalty === null) delete nonStreamBody.frequency_penalty;
                    if (args.presence_penalty === undefined || args.presence_penalty === null) delete nonStreamBody.presence_penalty;
                    delete nonStreamBody.min_p; delete nonStreamBody.repetition_penalty;
                    // Responses API: stream_options / prompt_cache_retention 미지원
                    delete nonStreamBody.stream_options;
                    delete nonStreamBody.prompt_cache_retention;
                }
                const finalBody = sanitizeBodyJSON(safeStringify(nonStreamBody));
                // GAP-FIX: body size warning for non-streaming (migrated from _temp_repo)
                const _nonStreamBodyLen = finalBody.length;
                if (_nonStreamBodyLen > 5_000_000) {
                    console.warn(`[CPM] \u26a0\ufe0f Non-streaming body size: ${(_nonStreamBodyLen / 1_048_576).toFixed(2)} MB. Large bodies may cause 'unexpected EOF'.`);
                }
                let fetchUrl = url;
                if (useResponsesAPI) {
                    fetchUrl = url.replace(/\/chat\/completions$/i, '/responses');
                }
                if (format === 'google' && currentKey) {
                    const sep = fetchUrl.includes('?') ? '&' : '?';
                    fetchUrl += `${sep}key=${encodeURIComponent(currentKey)}`;
                }
                const res = await _executeWithRetry(
                    () => _smartFetchFn(fetchUrl, { method: 'POST', headers: reqHeaders, body: finalBody, signal: args._abortSignal }),
                    `${format} request`, 3, args._abortSignal
                );
                if (!res.ok) {
                    const errText = await res.text();
                    _logEntry.status = res.status;
                    _logEntry.response = errText.substring(0, 2000);
                    return { success: false, content: `[Custom Error ${res.status}] ${errText}`, _status: res.status };
                }
                _logEntry.status = res.status;
                const rawText = await res.text();
                let data;
                try { data = JSON.parse(rawText); } catch {
                    // GAP-FIX: return proper error on JSON parse failure (migrated from _temp_repo)
                    return { success: false, content: `[Custom API Error] Response is not JSON: ${rawText.substring(0, 1000)}`, _status: res.status };
                }
                _logEntry.response = rawText.substring(0, 4000);

                if (format === 'anthropic') {
                    return parseClaudeNonStreamingResponse(data, { showThinking: thought });
                } else if (format === 'google') {
                    return parseGeminiNonStreamingResponse(data, { showThoughtsToken: thought, useThoughtSignature: thought });
                } else if (useResponsesAPI) {
                    // C-9: Responses API 비스트리밍 (GPT-5.4+ Copilot)
                    return parseResponsesAPINonStreamingResponse(data, { showThinking: thought, _requestId: args._requestId });
                } else {
                    return parseOpenAINonStreamingResponse(data, { showThinking: thought, _requestId: args._requestId });
                }
            } catch (e) {
                return { success: false, content: `[Custom] ${e.message}` };
            }
        }
    };

    // Execute with key rotation (or single key if pool has only 1)
    if (pool.remaining > 1) {
        return pool.withRotation(doFetch);
    } else {
        return doFetch(pool.pick());
    }
}

// ==========================================
// IPC: CONTROL CHANNEL LISTENER
// ==========================================
function setupControlChannel() {
    Risu.addPluginChannelListener(CH.CONTROL, (msg) => {
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === MSG.DYNAMIC_MODELS_RESULT) {
            const pending = pendingControlRequests.get(msg.requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingControlRequests.delete(msg.requestId);
            pending.resolve({
                success: msg.success !== false,
                models: Array.isArray(msg.models) ? msg.models : [],
                error: msg.error || '',
                content: msg.error || '',
            });
            return;
        }

        if (msg.type === MSG.REGISTER_PROVIDER) {
            const { pluginName, name, settingsFields, supportsDynamicModels } = msg;
            /** @type {any[]} */
            const models = /** @type {any[]} */ (msg.models) || [];
            if (!name || !pluginName) return;
            console.log(`[CPM] Provider registration: ${name} (plugin: ${pluginName}, ${models?.length || 0} models)`);
            registeredProviders.set(name, {
                pluginName,
                models: models || [],
                settingsFields: settingsFields || [],
                supportsDynamicModels: supportsDynamicModels === true,
            });
            if (Array.isArray(models)) {
                for (const m of models) {
                    // BUG-5 FIX: 중복 체크 (late registration 시 ALL_DEFINED_MODELS에 중복 삽입 방지)
                    const uid = m.uniqueId || `${name}::${m.id || m.name}`;
                    if (!ALL_DEFINED_MODELS.some(e => (e.uniqueId || `${e.provider}::${e.id || e.name}`) === uid)) {
                        ALL_DEFINED_MODELS.push({ ...m, provider: name });
                    }
                }
            }
            // late registration → 즉시 addProvider
            if (managerReady) {
                (async () => {
                    for (const m of models || []) {
                        await registerModelWithRisu({ ...m, provider: name });
                    }
                    console.log(`[CPM] Late-registered ${name}: ${models?.length || 0} models added`);
                })();
            }
            // ACK 보내기 (3인자)
            Risu.postPluginChannelMessage(pluginName, CH.CONTROL, {
                type: MSG.REGISTER_ACK,
                success: true
            });
        }
    });
}

// ==========================================
// MODEL REGISTRATION
// ==========================================
let managerReady = false;

async function registerModelWithRisu(modelDef) {
    const key = `${modelDef.provider}::${modelDef.uniqueId || modelDef.id || modelDef.name}`;
    if (registeredModelKeys.has(key)) return;
    registeredModelKeys.add(key);

    const pLabel = modelDef.provider;
    const mLabel = modelDef.name;

    // LLMFlags enum values from RisuAI (src/ts/model/types.ts):
    //   0=hasImageInput, 6=hasFullSystemPrompt, 7=hasFirstSystemPrompt,
    //   8=hasStreaming, 9=requiresAlternateRole, 14=DeveloperRole
    //
    // BUG-Q6 FIX: provider별 플래그를 네이티브 RisuAI와 최대한 일치시켜
    // reformater 전처리 경로 차이(시스템 처리/역할 병합)로 인한 품질 편차를 줄임.
    const provider = modelDef.provider;
    const modelId = String(modelDef.id || '');
    const isClaudeFamily = provider === 'Anthropic' || provider === 'AWS' || (provider === 'VertexAI' && modelId.startsWith('claude-'));
    const isGeminiFamily = provider === 'GoogleAI' || (provider === 'VertexAI' && modelId.startsWith('gemini-'));
    const isOpenAIFamily = provider === 'OpenAI';

    const modelFlags = [0, 8]; // hasImageInput, hasStreaming (공통)
    if (isClaudeFamily) {
        // Native Claude: hasFirstSystemPrompt
        modelFlags.push(7);
    } else if (isGeminiFamily) {
        // Native Gemini: hasFirstSystemPrompt + requiresAlternateRole
        modelFlags.push(7, 9);
    } else {
        // OpenAI/OpenRouter/DeepSeek 계열: hasFullSystemPrompt
        modelFlags.push(6);
    }
    if (isOpenAIFamily && /^gpt-5/.test(modelId)) {
        // Native GPT-5 계열: DeveloperRole
        modelFlags.push(14);
    }

    // LLMTokenizer enum: 0=Unknown, 2=O200k_base, 6=Claude, 8=Llama3, 9=Gemma, 10=GoogleCloud, 13=DeepSeek
    const tokenizerMap = { 'o200k_base': 2, 'claude': 6, 'llama3': 8, 'gemma': 9, 'deepseek': 13, 'googlecloud': 10 };
    // Auto-detect tokenizer from provider name when 'tok' is not set on modelDef
    // BUG-Q7 FIX: GoogleAI/VertexAI는 Gemma(9)가 아니라 GoogleCloud(10) 토크나이저 사용
    const providerTokenizerMap = { 'OpenAI': 2, 'Anthropic': 6, 'GoogleAI': 10, 'VertexAI': 10, 'AWS': 6, 'DeepSeek': 13, 'OpenRouter': 0 };
    const tokenizer = tokenizerMap[modelDef.tok] ?? providerTokenizerMap[modelDef.provider] ?? 0;

    // Explicit parameters list — match RisuAI's default addProvider parameter list
    // (see v3.svelte.ts addProvider: parameters default includes min_p, top_a, top_k, thinking_tokens)
    const modelParams = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'top_k', 'min_p', 'top_a', 'thinking_tokens'];

    // ── V3 BRIDGE ABORT 메커니즘 ──
    // factory.ts의 ABORT_SIGNAL_REF 시스템을 통해 AbortSignal이 정상적으로 전달됨.
    // Host: AbortSignal → {__type:'ABORT_SIGNAL_REF', abortId, aborted} 변환
    // Guest: 로컬 AbortController 생성 → controller.signal 반환
    // Host가 abort 시: ABORT_SIGNAL 메시지 전송 → Guest의 controller.abort() 호출
    //
    // 중요: 이 signal을 Risu.risuFetch()/nativeFetch() 옵션에 직접 넣으면
    // guest→host postMessage에서 DataCloneError 발생 (AbortSignal은 structured-clone 불가).
    // 따라서 signal은 로컬 abort 체크와 IPC ABORT 전파에만 사용하고,
    // helpers.js의 smartFetch/streamingFetch가 자체적으로 signal을 추출 처리함.
    await Risu.addProvider(`🧁 [${pLabel}] ${mLabel}`, async (args, abortSignal) => {
        try {
            if (!_abortBridgeProbeDone) {
                _abortBridgeProbeDone = true;
                const bridgeSupported = !!(abortSignal && typeof abortSignal.aborted === 'boolean' && typeof abortSignal.addEventListener === 'function');
                if (bridgeSupported) {
                    console.log('[CPM] ✓ V3 abort bridge active (ABORT_SIGNAL_REF → AbortController.signal). IPC abort chain enabled.');
                } else {
                    console.warn('[CPM] ⚠ V3 abort bridge NOT active in this runtime (abortSignal=', typeof abortSignal, '). Older RisuAI without ABORT_SIGNAL_REF?');
                }
            }

            // Pre-flight abort check
            if (abortSignal?.aborted) {
                return { success: true, content: '' };
            }
            const result = await handleRequest(args, modelDef, abortSignal);
            // Post-flight abort check
            if (!(result?.content instanceof ReadableStream) && abortSignal?.aborted) {
                return { success: true, content: '' };
            }
            return result;
        } catch (err) {
            // Abort errors → graceful empty return (defensive)
            if (err?.name === 'AbortError' || err?.message === 'Request was aborted'
                || err?.message?.includes('aborted') || abortSignal?.aborted) {
                return { success: true, content: '' };
            }
            return { success: false, content: `[CPM Crash] ${err.message}` };
        }
    }, { model: { flags: modelFlags, tokenizer, parameters: modelParams } });
}


// ==========================================
// API REQUEST LOG
// ==========================================
function _logApiRequest(entry) {
    return storeApiRequest(entry);
}
function _getAllApiRequests() { return getAllApiRequests(); }
function _getApiRequestById(id) { return getApiRequestById(id); }

function ensureTailwindLoaded() {
    const existing = document.getElementById('cpm-tailwind');
    if (existing) return existing;

    const style = document.createElement('style');
    style.id = 'cpm-tailwind';
    style.textContent = TAILWIND_CSS;
    document.head.appendChild(style);
    return style;
}

// ==========================================
// SETTINGS UI
// ==========================================
async function openCpmSettings(initialTarget = 'tab-global') {
    Risu.showContainer('fullscreen');

    ensureTailwindLoaded();

    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#1e1e24;color:#d1d5db;font-family:-apple-system,sans-serif;height:100vh;overflow:hidden;';

    const getVal = (k) => safeGetArg(k);
    const getBoolVal = (k) => safeGetBoolArg(k);
    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const setVal = async (k, v) => {
        setArg(k, String(v));
        SettingsBackup.updateKey(k, String(v));
        if (k === 'cpm_compatibility_mode' || k === 'cpm_streaming_enabled' || k === 'cpm_copilot_nodeless_mode') {
            _resetCompatibilityModeCache();
        }
        if (k === 'cpm_copilot_nodeless_mode') {
            clearCopilotTokenCache();
        }
        // Apply Copilot emulation version overrides live
        if (k === 'cpm_copilot_vscode_version' || k === 'cpm_copilot_chat_version') {
            const chatVer = await safeGetArg('cpm_copilot_chat_version', '');
            const codeVer = await safeGetArg('cpm_copilot_vscode_version', '');
            setCopilotVersionOverrides({ chatVersion: chatVer, vscodeVersion: codeVer });
            clearCopilotTokenCache();
        }
    };
    const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const CPM_EXPORT_VERSION = 3;
    const CPM_PLUGIN_STORAGE_KEY_PATTERN = /^cpm[_-]/;
    const KNOWN_CPM_PLUGIN_STORAGE_KEYS = [
        'cpm_settings_backup',
        'cpm_last_version_check',
        'cpm_last_main_version_check',
        'cpm_pending_main_update',
        'cpm_last_boot_status',
        'cpm_last_main_update_flush',
    ];
    const parseUiBool = (value) => {
        if (value === true || value === false) return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value !== 'string') return false;
        const v = value.trim().toLowerCase();
        return ['true', '1', 'yes', 'on'].includes(v);
    };
    const normalizeManagedSettingValue = (key, value) => key === 'cpm_custom_models'
        ? serializeCustomModelsSetting(value, { includeKey: true })
        : String(value ?? '');

    async function getCpmPluginStorageKeys() {
        const keySet = new Set(KNOWN_CPM_PLUGIN_STORAGE_KEYS);
        try {
            if (typeof Risu?.pluginStorage?.keys === 'function') {
                const dynamicKeys = await Risu.pluginStorage.keys();
                for (const key of dynamicKeys || []) {
                    if (CPM_PLUGIN_STORAGE_KEY_PATTERN.test(String(key))) keySet.add(String(key));
                }
            }
        } catch (_) { /* ignore */ }
        return [...keySet];
    }

    async function exportPluginStorageSnapshot() {
        const snapshot = {};
        for (const key of await getCpmPluginStorageKeys()) {
            try {
                const value = await Risu.pluginStorage.getItem(key);
                if (value !== undefined && value !== null && value !== '') snapshot[key] = String(value);
            } catch (_) { /* ignore */ }
        }
        return snapshot;
    }

    async function importPluginStorageSnapshot(snapshot) {
        const existingKeys = await getCpmPluginStorageKeys();
        for (const key of existingKeys) {
            if (Object.prototype.hasOwnProperty.call(snapshot, key)) continue;
            try {
                if (typeof Risu?.pluginStorage?.removeItem === 'function') await Risu.pluginStorage.removeItem(key);
                else await Risu.pluginStorage.setItem(key, '');
            } catch (_) { /* ignore */ }
        }
        for (const [key, value] of Object.entries(snapshot || {})) {
            if (!CPM_PLUGIN_STORAGE_KEY_PATTERN.test(String(key))) continue;
            try { await Risu.pluginStorage.setItem(key, String(value ?? '')); } catch (_) { /* ignore */ }
        }
    }

    function normalizeImportEnvelope(importedData) {
        if (!importedData || typeof importedData !== 'object' || Array.isArray(importedData)) {
            throw new Error('설정 파일 형식이 올바르지 않습니다.');
        }
        if ('settings' in importedData || 'pluginStorage' in importedData || '_cpmExportVersion' in importedData) {
            return {
                exportVersion: Number(importedData._cpmExportVersion || 0) || 0,
                metadata: importedData.metadata && typeof importedData.metadata === 'object' ? importedData.metadata : null,
                settings: importedData.settings && typeof importedData.settings === 'object' ? importedData.settings : {},
                pluginStorage: importedData.pluginStorage && typeof importedData.pluginStorage === 'object' ? importedData.pluginStorage : {},
            };
        }
        return { exportVersion: 0, metadata: null, settings: importedData, pluginStorage: {} };
    }

    async function refreshRuntimeStatusPanels() {
        const statusEl = document.getElementById('cpm-stream-status');
        const compatStatusEl = document.getElementById('cpm-compat-status');
        if (!statusEl && !compatStatusEl) return;

        try {
            const capable = await checkStreamCapability();
            if (statusEl) {
                statusEl.innerHTML = capable
                    ? '<span class="text-emerald-400">✓ Bridge 지원됨</span> — ReadableStream 전송 가능.'
                    : '<span class="text-yellow-400">✗ Bridge 미지원</span> — 자동으로 문자열 수집 모드로 폴백됩니다.';
                statusEl.className = `mt-4 rounded-lg border p-3 text-xs ${capable ? 'border-emerald-700 bg-emerald-950/30 text-emerald-100' : 'border-yellow-800 bg-yellow-950/30 text-yellow-100'}`;
            }

            if (compatStatusEl) {
                const manualEnabled = await safeGetBoolArg('cpm_compatibility_mode', false);
                const nodelessMode = await safeGetArg('cpm_copilot_nodeless_mode', 'off');
                if (manualEnabled) {
                    compatStatusEl.innerHTML = `<span class="text-amber-400">⚡ 수동 활성화됨</span> — nativeFetch 건너뛰기 + 스트리밍 자동 비활성화.${nodelessMode !== 'off' ? ` <span class="text-cyan-300">Node-less 실험 모드: ${escHtml(nodelessMode)}</span>` : ''}`;
                    compatStatusEl.className = 'mt-3 rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-xs text-amber-100';
                } else if (!capable) {
                    compatStatusEl.innerHTML = `<span class="text-yellow-400">⚠ Bridge 미지원</span> — ReadableStream 전달이 불가능한 환경입니다. 문제가 있으면 호환성 모드를 수동으로 켜주세요.${nodelessMode !== 'off' ? ` <span class="text-cyan-300">Node-less 실험 모드: ${escHtml(nodelessMode)}</span>` : ''}`;
                    compatStatusEl.className = 'mt-3 rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-xs text-amber-100';
                } else {
                    compatStatusEl.innerHTML = nodelessMode === 'off'
                        ? '<span class="text-emerald-400">✓ 비활성</span> — Bridge 정상. 호환성 모드가 필요하지 않습니다.'
                        : `<span class="text-cyan-300">🧪 Node-less 실험 모드</span> — iPhone용 호환성은 꺼져 있지만 Copilot 헤더 전략은 ${escHtml(nodelessMode)} 로 동작합니다.`;
                    compatStatusEl.className = 'mt-3 rounded-lg border border-emerald-700 bg-emerald-950/30 p-3 text-xs text-emerald-100';
                }
            }
        } catch (e) {
            const msg = escHtml(e?.message || e);
            if (statusEl) {
                statusEl.innerHTML = `<span class="text-red-400">Bridge 확인 실패:</span> ${msg}`;
                statusEl.className = 'mt-4 rounded-lg border border-red-800 bg-red-950/30 p-3 text-xs text-red-100';
            }
            if (compatStatusEl) {
                compatStatusEl.innerHTML = `<span class="text-red-400">확인 실패:</span> ${msg}`;
                compatStatusEl.className = 'mt-3 rounded-lg border border-red-800 bg-red-950/30 p-3 text-xs text-red-100';
            }
        }
    }

    async function purgeAllCpmData() {
        let pluginStorageCleared = 0;
        let argsCleared = 0;

        for (const key of await getCpmPluginStorageKeys()) {
            try {
                if (typeof Risu?.pluginStorage?.removeItem === 'function') await Risu.pluginStorage.removeItem(key);
                else await Risu.pluginStorage.setItem(key, '');
                pluginStorageCleared++;
            } catch (_) { /* ignore */ }
        }

        const managedKeys = SettingsBackup.getAllKeys();
        for (const key of managedKeys) {
            try {
                setArg(key, '');
                argsCleared++;
            } catch (_) { /* ignore */ }
        }

        const legacyFields = ['url', 'model', 'key', 'name', 'format', 'sysfirst', 'altrole', 'mustuser', 'maxout', 'mergesys', 'decoupled', 'thought', 'reasoning', 'verbosity', 'thinking', 'tok'];
        for (let i = 1; i <= 10; i++) {
            for (const field of legacyFields) {
                try {
                    setArg(`cpm_c${i}_${field}`, '');
                    argsCleared++;
                } catch (_) { /* ignore */ }
            }
        }

        CUSTOM_MODELS_CACHE.splice(0, CUSTOM_MODELS_CACHE.length);
        for (let i = ALL_DEFINED_MODELS.length - 1; i >= 0; i--) {
            if (ALL_DEFINED_MODELS[i]?.provider === 'Custom') ALL_DEFINED_MODELS.splice(i, 1);
        }
        clearApiRequests();
        try { await SettingsBackup.load(); SettingsBackup._cache = {}; await SettingsBackup.save(); } catch (_) { /* ignore */ }

        return { pluginStorageCleared, argsCleared };
    }

    const renderInput = async (id, label, type = 'text', opts = []) => {
        let html = '<div class="mb-4">';
        if (type === 'checkbox') {
            const val = await getBoolVal(id);
            html += `<label class="flex items-center space-x-2 text-sm font-medium text-gray-300">
                <input id="${id}" type="checkbox" ${val ? 'checked' : ''} class="form-checkbox text-blue-500 rounded bg-gray-800 border-gray-600 focus:ring-blue-500">
                <span>${label}</span></label></div>`;
        } else if (type === 'select') {
            const val = await getVal(id);
            html += `<label class="block text-sm font-medium text-gray-400 mb-1">${label}</label>`;
            html += `<select id="${id}" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500">`;
            opts.forEach(o => html += `<option value="${escAttr(o.value)}" ${val === o.value ? 'selected' : ''}>${escAttr(o.text)}</option>`);
            html += '</select></div>';
        } else if (type === 'textarea') {
            const val = await getVal(id);
            html += `<label class="block text-sm font-medium text-gray-400 mb-1">${label}</label>`;
            html += `<textarea id="${id}" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 h-24" spellcheck="false">${escAttr(val)}</textarea></div>`;
        } else if (type === 'password') {
            const val = await getVal(id);
            html += `<label class="block text-sm font-medium text-gray-400 mb-1">${label}</label>`;
            html += `<div class="relative">`;
            html += `<input id="${id}" type="password" value="${escAttr(val)}" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 pr-10 text-white focus:outline-none focus:border-blue-500">`;
            html += `<button type="button" class="cpm-pw-toggle absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white focus:outline-none text-lg px-1" data-target-id="${id}" title="비밀번호 보기/숨기기">👁️</button>`;
            html += '</div></div>';
        } else {
            const val = await getVal(id);
            html += `<label class="block text-sm font-medium text-gray-400 mb-1">${label}</label>`;
            html += `<input id="${id}" type="${type}" value="${escAttr(val)}" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"></div>`;
        }
        return html;
    };

    // Select option lists
    const providersList = [{ value: '', text: '🚫 미지정 (Main UI의 모델이 처리)' }];
    for (const m of ALL_DEFINED_MODELS) {
        providersList.push({ value: m.uniqueId, text: `[${m.provider}] ${m.name}` });
    }
    const reasoningList = [
        { value: 'none', text: 'None (없음)' }, { value: 'off', text: 'Off (끄기)' },
        { value: 'low', text: 'Low (낮음)' }, { value: 'medium', text: 'Medium (중간)' }, { value: 'high', text: 'High (높음)' }
    ];
    const verbosityList = [
        { value: 'none', text: 'None (기본값)' }, { value: 'low', text: 'Low (낮음)' },
        { value: 'medium', text: 'Medium (중간)' }, { value: 'high', text: 'High (높음)' }
    ];
    const thinkingList = [
        { value: 'off', text: 'Off (끄기)' }, { value: 'none', text: 'None (없음)' },
        { value: 'MINIMAL', text: 'Minimal (최소)' }, { value: 'LOW', text: 'Low (낮음)' },
        { value: 'MEDIUM', text: 'Medium (중간)' }, { value: 'HIGH', text: 'High (높음)' }
    ];
    const effortList = [
        { value: 'none', text: '사용 안함 (Off)' }, { value: 'unspecified', text: '미지정 (Unspecified)' },
        { value: 'low', text: 'Low (낮음)' }, { value: 'medium', text: 'Medium (중간)' },
        { value: 'high', text: 'High (높음)' }, { value: 'max', text: 'Max (최대)' }
    ];

    const renderAuxParams = async (slot) => `
        <div class="mt-8 pt-6 border-t border-gray-800 space-y-2">
            <h4 class="text-xl font-bold text-gray-300 mb-2">Generation Parameters (생성 설정)</h4>
            <p class="text-xs text-blue-400 font-semibold mb-4 border-l-2 border-blue-500 pl-2">
                여기 값을 입력하면 리스AI 설정(파라미터 분리 포함) 대신 이 값이 우선 적용됩니다.<br/>
                비워두면 리스AI의 설정값이 사용됩니다.<br/>
                <span class="text-gray-500">(CPM slot override &gt; RisuAI separate params &gt; RisuAI main params &gt; default 0.7)</span>
            </p>
            ${await renderInput(`cpm_slot_${slot}_max_context`, 'Max Context Tokens (최대 컨텍스트)', 'number')}
            ${await renderInput(`cpm_slot_${slot}_max_out`, 'Max Output Tokens (최대 응답 크기)', 'number')}
            ${await renderInput(`cpm_slot_${slot}_temp`, 'Temperature (온도)', 'number')}
            ${await renderInput(`cpm_slot_${slot}_top_p`, 'Top P', 'number')}
            ${await renderInput(`cpm_slot_${slot}_top_k`, 'Top K', 'number')}
            ${await renderInput(`cpm_slot_${slot}_rep_pen`, 'Repetition Penalty (반복 페널티)', 'number')}
            ${await renderInput(`cpm_slot_${slot}_freq_pen`, 'Frequency Penalty (빈도 페널티)', 'number')}
            ${await renderInput(`cpm_slot_${slot}_pres_pen`, 'Presence Penalty (존재 페널티)', 'number')}
        </div>
    `;

    // Build dynamic provider tabs for sidebar + content
    let providerTabsHtml = '';
    let providerContentHtml = '';
    if (registeredProviders.size > 0) {
        providerTabsHtml = `<div class="px-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider mt-5 mb-2">Providers</div>`;
        for (const [name, prov] of registeredProviders) {
            providerTabsHtml += `<button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-provider-${name}">☁️ ${escAttr(name)}</button>`;
            let tabHtml = `<div id="tab-provider-${name}" class="cpm-tab-content hidden">`;
            tabHtml += `<div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6 pb-3 border-b border-gray-700">`;
            tabHtml += `<div><h3 class="text-3xl font-bold">☁️ ${escAttr(name)} Provider</h3><p class="text-xs text-gray-500 mt-2">등록 모델 ${Array.isArray(prov.models) ? prov.models.length : 0}개${prov.supportsDynamicModels ? ' · 동적 모델 조회 지원' : ''}</p></div>`;
            if (prov.supportsDynamicModels) {
                tabHtml += `<button class="cpm-refresh-models-btn bg-sky-700 hover:bg-sky-600 text-white font-semibold py-2 px-4 rounded transition-colors text-sm shadow touch-manipulation" data-provider="${escAttr(name)}">🔄 동적 모델 새로고침</button>`;
            }
            tabHtml += `</div>`;
            if (Array.isArray(prov.settingsFields) && prov.settingsFields.length > 0) {
                for (const field of prov.settingsFields) {
                    tabHtml += await renderInput(field.key, field.label, field.type || 'text', field.options || []);
                }
            } else {
                tabHtml += '<p class="text-gray-500">이 프로바이더에 설정 가능한 항목이 없습니다.</p>';
            }
            tabHtml += '</div>';
            providerContentHtml += tabHtml;
        }
    }

    // ─── SIDEBAR ───
    const container = document.createElement('div');
    container.className = 'flex flex-col md:flex-row h-full';

    const sidebar = document.createElement('div');
    sidebar.className = 'w-full md:w-64 bg-gray-900 border-b md:border-b-0 md:border-r border-gray-700 flex flex-col pt-2 shrink-0 z-50 relative';
    sidebar.innerHTML = `
        <div class="h-14 flex items-center justify-between px-6 border-b border-gray-700 md:border-none cursor-pointer md:cursor-default" id="cpm-mobile-menu-btn">
            <h2 class="text-lg font-extrabold bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text">🧁 Cupcake PM v${CPM_VERSION}</h2>
            <span class="md:hidden text-gray-400 text-xl" id="cpm-mobile-icon">▼</span>
        </div>
        <div class="hidden md:flex items-center gap-3 px-5 py-1.5 border-b border-gray-700/50">
            <span class="text-[10px] text-gray-500">⌨️ <kbd class="px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-[10px] text-gray-400">Ctrl</kbd>+<kbd class="px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-[10px] text-gray-400">Shift</kbd>+<kbd class="px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-[10px] text-gray-400">Alt</kbd>+<kbd class="px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-[10px] text-gray-400">P</kbd></span>
            <span class="text-[10px] text-gray-600">|</span>
            <span class="text-[10px] text-gray-500">📱 4손가락 터치</span>
        </div>
        <div id="cpm-mobile-dropdown" class="hidden md:flex flex-col absolute md:static top-full left-0 w-full md:w-auto bg-gray-900 border-b border-gray-700 md:border-none shadow-xl md:shadow-none z-[100] h-auto max-h-[70vh] md:max-h-none md:h-full overflow-hidden flex-1">
            <div class="flex-1 overflow-y-auto py-2 pr-2" id="cpm-tab-list">
                <div class="px-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 mt-2">Common</div>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn text-cyan-300 font-semibold" data-target="tab-global">🎛️ 글로벌 기본값</button>

                <div class="px-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2 mt-4">Aux Slots (Map Mode)</div>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-trans">🌐 번역 (Trans)</button>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-emo">😊 감정 판독 (Emotion)</button>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-mem">🧠 하이파 (Mem)</button>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-other">⚙️ 트리거/루아 (Other)</button>

                ${providerTabsHtml}

                <div class="px-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider mt-5 mb-2">Features</div>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-copilot">🔑 Copilot Token</button>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-operations">🧹 운영/복구</button>

                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-diagnostics">🔍 진단 (Diagnostics)</button>
                <button class="w-full text-left px-5 py-2 text-sm hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-apilog">📡 API 요청 로그</button>

                <div class="px-4 text-[11px] font-bold text-gray-500 uppercase tracking-wider mt-5 mb-2">Custom Providers</div>
                <button class="w-full text-left px-5 py-2 text-sm flex items-center justify-between hover:bg-gray-800 transition-colors focus:outline-none tab-btn" data-target="tab-customs">
                    <span>🛠️ Custom Models Manager</span>
                    <span class="bg-blue-600 text-xs px-2 py-0.5 rounded-full" id="cpm-cm-count">${CUSTOM_MODELS_CACHE.length}</span>
                </button>
            </div>
            <div class="p-4 border-t border-gray-800 space-y-2 shrink-0 bg-gray-900 z-10 relative" id="cpm-tab-footer">
                <button id="cpm-export-btn" class="w-full bg-blue-600/90 hover:bg-blue-500 text-white font-semibold py-2 px-4 rounded transition-colors text-sm">⬇️ 설정 내보내기</button>
                <button id="cpm-import-btn" class="w-full bg-blue-600/90 hover:bg-blue-500 text-white font-semibold py-2 px-4 rounded transition-colors text-sm">⬆️ 설정 불러오기</button>
                <button id="cpm-close-btn" class="w-full bg-red-600/90 hover:bg-red-500 text-white font-semibold py-2 px-4 rounded transition-colors text-sm shadow-[0_0_10px_rgba(239,68,68,0.5)]">✕ Close Settings</button>
            </div>
        </div>
    `;

    // ─── CONTENT ───
    const content = document.createElement('div');
    content.className = 'flex-1 bg-[#121214] overflow-y-auto p-5 md:p-10';

    content.innerHTML = `
        <div id="tab-global" class="cpm-tab-content">
            <h3 class="text-3xl font-bold text-cyan-400 mb-6 pb-3 border-b border-gray-700">🎛️ 글로벌 기본값 (Global Fallback Parameters)</h3>
            <p class="text-cyan-300 font-semibold mb-4 border-l-4 border-cyan-500 pl-4 py-1">
                리스AI가 파라미터를 보내지 않을 때 (파라미터 분리 ON + 미설정 등) 여기 값이 사용됩니다.
            </p>
            <div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-6">
                <h4 class="text-sm font-bold text-gray-300 mb-3">📋 파라미터 우선순위 (높은 순서)</h4>
                <div class="text-xs text-gray-400 space-y-1">
                    <div class="flex items-center"><span class="bg-purple-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mr-2 shrink-0">1</span> CPM 슬롯 오버라이드 (번역/감정/하이파/기타 탭에서 설정)</div>
                    <div class="flex items-center"><span class="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mr-2 shrink-0">2</span> 리스AI 파라미터 분리 값</div>
                    <div class="flex items-center"><span class="bg-green-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mr-2 shrink-0">3</span> 리스AI 메인 모델 파라미터</div>
                    <div class="flex items-center"><span class="bg-cyan-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mr-2 shrink-0">4</span> <strong class="text-cyan-300">⭐ 여기: CPM 글로벌 기본값</strong></div>
                    <div class="flex items-center"><span class="bg-gray-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mr-2 shrink-0">5</span> 하드코딩 기본값 (Temperature 0.7 / Max Tokens 4096)</div>
                </div>
            </div>
            <div class="space-y-2">
                ${await renderInput('cpm_fallback_temp', 'Default Temperature (기본 온도, 비워두면 0.7)', 'number')}
                ${await renderInput('cpm_fallback_max_tokens', 'Default Max Output Tokens (비워두면 메인모델 최대응답 설정 따름)', 'number')}
                ${await renderInput('cpm_fallback_top_p', 'Default Top P (비워두면 API 기본값)', 'number')}
                ${await renderInput('cpm_fallback_freq_pen', 'Default Frequency Penalty (비워두면 API 기본값)', 'number')}
                ${await renderInput('cpm_fallback_pres_pen', 'Default Presence Penalty (비워두면 API 기본값)', 'number')}
            </div>
            <div class="mt-10 pt-6 border-t border-gray-700">
                <h4 class="text-xl font-bold text-emerald-400 mb-4">🔄 스트리밍 설정 (Streaming)</h4>
                <div class="bg-gray-800/70 border border-emerald-900/50 rounded-lg p-4 mb-6">
                    <p class="text-xs text-emerald-300 mb-2 font-semibold">📡 실시간 스트리밍 지원</p>
                    <p class="text-xs text-gray-400 mb-2">활성화하면 API 응답을 ReadableStream으로 RisuAI에 직접 전달합니다.</p>
                    <p class="text-xs text-yellow-500">⚠️ 지원되지 않으면 자동으로 문자열 수집 모드로 폴백됩니다.</p>
                </div>
                <div class="space-y-3">
                    ${await renderInput('cpm_streaming_enabled', '스트리밍 패스스루 활성화 (Enable Streaming Pass-Through)', 'checkbox')}
                    ${await renderInput('cpm_streaming_show_thinking', 'Anthropic Thinking 토큰 표시 (Show Thinking in Stream)', 'checkbox')}
                    ${await renderInput('cpm_streaming_show_token_usage', '스트림 토큰 사용량 포함 (Include Token Usage in Stream)', 'checkbox')}
                </div>
                <div class="mt-6 pt-4 border-t border-gray-700/50">
                    <h5 class="text-sm font-bold text-amber-400 mb-3">📱 iPhone/Safari 호환성 모드 (Compatibility Mode)</h5>
                    <div class="bg-gray-800/70 border border-amber-900/50 rounded-lg p-4 mb-4">
                        <p class="text-xs text-amber-300 mb-2 font-semibold">🔧 호환성 모드란?</p>
                        <p class="text-xs text-gray-400 mb-2">ReadableStream 전달이 불안정한 환경에서 일반 프로바이더의 nativeFetch 스트리밍 경로를 건너뛰고 안전한 폴백 경로를 사용합니다.</p>
                        <p class="text-xs text-gray-400 mb-2">Copilot은 인증 제약 때문에 예외적으로 기존 nativeFetch 경로를 유지합니다.</p>
                        <p class="text-xs text-yellow-500">⚠️ 일반 프로바이더 스트리밍은 자동으로 꺼지고, Copilot만 예외적으로 유지됩니다.</p>
                    </div>
                    <div class="space-y-3">
                        ${await renderInput('cpm_compatibility_mode', '호환성 모드 활성화 (Compatibility Mode)', 'checkbox')}
                        ${await renderInput('cpm_copilot_nodeless_mode', 'Node-less용 Copilot 실험 모드', 'select', [
                            { value: 'off', text: '끄기 (기본 헤더 유지)' },
                            { value: 'nodeless-1', text: '실험 1 — 토큰 교환 헤더만 축소' },
                            { value: 'nodeless-2', text: '실험 2 — 토큰 + 실제 요청 헤더 축소' },
                        ])}
                    </div>

                    <!-- Copilot Emulation Version Overrides -->
                    <details class="mt-4 group">
                        <summary class="cursor-pointer text-sm font-semibold text-amber-400 hover:text-amber-300 transition-colors select-none">
                            ⚙️ Copilot 에뮤레이션 버전 오버라이드 (고급)
                        </summary>
                        <div class="mt-3 bg-gray-900/60 border border-amber-900/40 rounded-lg p-4 space-y-3">
                            <p class="text-xs text-gray-400 mb-2">비워두면 기본 내장값을 사용합니다. Copilot API에서 <code class="text-amber-300">model_not_supported</code> 오류가 날 때 최신 버전으로 직접 업데이트할 수 있습니다.</p>
                            ${await renderInput('cpm_copilot_vscode_version', 'VSCode 에뮤레이션 버전', 'text')}
                            <p class="text-xs text-gray-500 -mt-1">기본값: <code class="text-gray-400">${escHtml(VSCODE_VERSION)}</code></p>
                            ${await renderInput('cpm_copilot_chat_version', 'Copilot Chat 확장 버전', 'text')}
                            <p class="text-xs text-gray-500 -mt-1">기본값: <code class="text-gray-400">${escHtml(COPILOT_CHAT_VERSION)}</code></p>
                            <p class="text-xs text-amber-400/80 mt-2">⚠️ 변경 후 Copilot 토큰 캐시가 자동으로 초기화됩니다.</p>
                        </div>
                    </details>
                    <div id="cpm-stream-status" class="mt-4 rounded-lg border border-gray-700 bg-gray-900/70 p-3 text-xs text-gray-300">브리지 상태 확인 중...</div>
                    <div id="cpm-compat-status" class="mt-3 rounded-lg border border-gray-700 bg-gray-900/70 p-3 text-xs text-gray-300">호환성 상태 확인 중...</div>
                </div>
            </div>
        </div>

        <div id="tab-trans" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold mb-6 pb-3 border-b border-gray-700">번역 백그라운드 설정 (Translation)</h3>
            <p class="text-blue-300 font-semibold mb-6 border-l-4 border-blue-500 pl-4 py-1">
                메인 UI에서 선택한 프로바이더와 다르게, 번역 태스크만 자동으로 전담할 프로바이더를 선택합니다.
            </p>
            ${await renderInput('cpm_slot_translation', '번역 전담 모델 선택 (Translation Model)', 'select', providersList)}
            ${await renderAuxParams('translation')}
        </div>

        <div id="tab-emo" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold mb-6 pb-3 border-b border-gray-700">감정 판독 백그라운드 설정 (Emotion)</h3>
            <p class="text-pink-300 font-semibold mb-6 border-l-4 border-pink-500 pl-4 py-1">
                캐릭터 리액션/표정 태스크를 처리할 작고 빠른 모델을 지정하세요.
            </p>
            ${await renderInput('cpm_slot_emotion', '감정 판독 전담 모델 (Emotion/Hypa)', 'select', providersList)}
            ${await renderAuxParams('emotion')}
        </div>

        <div id="tab-mem" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold mb-6 pb-3 border-b border-gray-700">하이파 백그라운드 설정 (Memory)</h3>
            <p class="text-yellow-300 font-semibold mb-6 border-l-4 border-yellow-500 pl-4 py-1">
                채팅 메모리 요약 등 긴 텍스트 축약 역할을 전담할 모델을 지정하세요.
            </p>
            ${await renderInput('cpm_slot_memory', '하이파 전담 모델 (Memory/Summarize)', 'select', providersList)}
            ${await renderAuxParams('memory')}
        </div>

        <div id="tab-other" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold mb-6 pb-3 border-b border-gray-700">트리거/루아 백그라운드 설정 (Other)</h3>
            ${await renderInput('cpm_slot_other', 'Lua 스크립트 등 무거운 유틸 전담 모델 (Other/Trigger)', 'select', providersList)}
            ${await renderAuxParams('other')}
        </div>

        ${providerContentHtml}

        <div id="tab-copilot" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold mb-6 pb-3 border-b border-gray-700">🔑 GitHub Copilot 토큰 관리</h3>
            <p class="text-blue-300 font-semibold mb-6 border-l-4 border-blue-500 pl-4 py-1">
                GitHub Copilot OAuth 토큰을 생성·확인·제거하고, 사용 가능한 모델과 할당량을 조회합니다.
            </p>
            <div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
                <label class="block text-sm font-medium text-gray-400 mb-2">현재 저장된 토큰</label>
                <div class="flex items-center gap-2">
                    <div class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 font-mono text-sm text-gray-300 truncate" id="cpm-copilot-token-display">로딩 중...</div>
                    <button class="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded text-sm font-semibold touch-manipulation" id="cpm-copilot-copy" title="토큰 복사">📋</button>
                </div>
            </div>
            <div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
                <label class="block text-sm font-medium text-gray-400 mb-2">토큰 직접 입력</label>
                <div class="flex items-center gap-2">
                    <input type="text" id="cpm-copilot-manual" class="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500" placeholder="ghu_xxxx 또는 gho_xxxx" spellcheck="false">
                    <button class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded text-sm font-semibold touch-manipulation" id="cpm-copilot-save">💾 저장</button>
                </div>
                <p class="text-xs text-gray-500 mt-2">GitHub에서 직접 발급받은 토큰을 수동으로 입력할 수 있습니다.</p>
            </div>
            <div class="grid grid-cols-3 gap-3 mb-6">
                <button id="cpm-copilot-gen" class="flex flex-col items-center justify-center p-4 bg-gray-800 border border-gray-700 rounded-lg hover:bg-blue-700 hover:border-blue-500 text-gray-300 transition-colors text-sm font-medium touch-manipulation"><span class="text-2xl mb-1">🔑</span><span>토큰 생성</span></button>
                <button id="cpm-copilot-verify" class="flex flex-col items-center justify-center p-4 bg-gray-800 border border-gray-700 rounded-lg hover:bg-blue-700 hover:border-blue-500 text-gray-300 transition-colors text-sm font-medium touch-manipulation"><span class="text-2xl mb-1">✅</span><span>토큰 확인</span></button>
                <button id="cpm-copilot-remove" class="flex flex-col items-center justify-center p-4 bg-gray-800 border border-gray-700 rounded-lg hover:bg-red-700 hover:border-red-500 text-gray-300 transition-colors text-sm font-medium touch-manipulation"><span class="text-2xl mb-1">🗑️</span><span>토큰 제거</span></button>
                <button id="cpm-copilot-models" class="flex flex-col items-center justify-center p-4 bg-gray-800 border border-gray-700 rounded-lg hover:bg-blue-700 hover:border-blue-500 text-gray-300 transition-colors text-sm font-medium touch-manipulation"><span class="text-2xl mb-1">📋</span><span>모델 목록</span></button>
                <button id="cpm-copilot-quota" class="flex flex-col items-center justify-center p-4 bg-gray-800 border border-gray-700 rounded-lg hover:bg-blue-700 hover:border-blue-500 text-gray-300 transition-colors text-sm font-medium touch-manipulation"><span class="text-2xl mb-1">📊</span><span>할당량</span></button>
                <button id="cpm-copilot-info" class="flex flex-col items-center justify-center p-4 bg-gray-800 border border-gray-700 rounded-lg hover:bg-blue-700 hover:border-blue-500 text-gray-300 transition-colors text-sm font-medium touch-manipulation"><span class="text-2xl mb-1">ℹ️</span><span>설정 안내</span></button>
            </div>
            <div id="cpm-copilot-result" class="hidden"></div>
        </div>

        <div id="tab-operations" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold text-orange-400 mb-6 pb-3 border-b border-gray-700">🧹 운영/복구 (Operations)</h3>
            <p class="text-orange-300 font-semibold mb-6 border-l-4 border-orange-500 pl-4 py-1">
                IPC 환경에서 안전하게 수행할 수 있는 유지보수 도구만 제공합니다. eval 기반 서브플러그인 런타임은 제외하고, 설정 백업·상태 점검·운영 데이터 정리에 집중합니다.
            </p>

            <div class="space-y-5">
                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-blue-400 mb-3">📦 현재 저장 상태</h4>
                    <div id="cpm-ops-summary" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 space-y-1">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <div class="bg-gray-800/80 border border-cyan-800/60 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-cyan-400 mb-2">🧭 권장 작업 순서</h4>
                    <ol class="text-xs text-gray-300 list-decimal list-inside space-y-1">
                        <li>먼저 설정 내보내기로 현재 상태를 백업합니다.</li>
                        <li>진단 탭에서 JSON/TXT 리포트를 저장해 문제 재현 정보를 확보합니다.</li>
                        <li>그다음에도 필요할 때만 전체 정리 버튼으로 CPM 저장 데이터를 초기화합니다.</li>
                    </ol>
                    <p class="text-[11px] text-gray-500 mt-3">팁: 전체 정리는 IPC 프로바이더 번들 자체를 제거하지 않으며, CPM이 저장한 운영 데이터만 비웁니다.</p>
                </div>

                <div class="bg-red-900/20 border border-red-700/50 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-red-400 mb-2">⚠️ CPM 데이터 전체 삭제 (Danger Zone)</h4>
                    <p class="text-xs text-gray-400 mb-1">
                        Cupcake Provider Manager가 저장한 <strong class="text-red-300">관리 대상 설정 / pluginStorage / API 로그 / 커스텀 모델</strong>을 일괄 초기화합니다.
                    </p>
                    <ul class="text-xs text-gray-500 mb-3 list-disc list-inside space-y-0.5">
                        <li>모든 CPM 관리 설정 키</li>
                        <li>레거시 C1-C10 커스텀 모델 키</li>
                        <li>CPM pluginStorage 데이터</li>
                        <li>커스텀 모델 캐시 및 API 로그</li>
                    </ul>
                    <p class="text-xs text-yellow-400 font-semibold mb-3">
                        💡 IPC 등록 프로바이더 번들 자체는 제거하지 않지만, CPM이 저장한 운영 데이터는 정리됩니다.
                    </p>
                    <div class="flex flex-wrap gap-3">
                        <button id="cpm-ops-purge-btn" class="bg-red-700 hover:bg-red-600 text-white font-bold py-2 px-6 rounded transition-colors text-sm shadow-lg shadow-red-900/50">
                            🗑️ CPM 저장 데이터 모두 지우기
                        </button>
                        <button id="cpm-ops-refresh-btn" class="bg-gray-700 hover:bg-gray-600 text-white font-semibold py-2 px-6 rounded transition-colors text-sm">
                            🔄 상태 새로고침
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div id="tab-diagnostics" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold text-emerald-400 mb-6 pb-3 border-b border-gray-700">🔍 진단 정보 (Diagnostics)</h3>
            <p class="text-emerald-300 font-semibold mb-6 border-l-4 border-emerald-500 pl-4 py-1">
                Cupcake PM 런타임 상태를 한 번에 점검하고, 문제 재현·이관 검증·백업 기록에 사용할 진단 메타데이터를 내보낼 수 있습니다.
            </p>

            <div class="space-y-5">
                <!-- System overview -->
                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-blue-400 mb-3">📋 시스템 개요</h4>
                    <div id="cpm-diag-overview" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 space-y-1">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-amber-400 mb-3">🌉 브리지 / 호환성</h4>
                    <div id="cpm-diag-bridge" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 space-y-1">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-rose-400 mb-3">💾 저장소 / 백업</h4>
                    <div id="cpm-diag-storage" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 space-y-1">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-orange-400 mb-3">🩺 마지막 부트 상태</h4>
                    <div id="cpm-diag-boot" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 space-y-1">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-sky-400 mb-3">🎯 슬롯 매핑</h4>
                    <div id="cpm-diag-slots" class="bg-gray-900 rounded p-4 text-xs text-gray-300 space-y-2">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <!-- Registered providers -->
                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-purple-400 mb-3">☁️ 등록된 프로바이더</h4>
                    <div id="cpm-diag-providers" class="bg-gray-900 rounded p-4 text-xs text-gray-300 space-y-2">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <!-- All models summary -->
                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-cyan-400 mb-3">📦 모든 모델 (${ALL_DEFINED_MODELS.length}개)</h4>
                    <div id="cpm-diag-models" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 max-h-64 overflow-y-auto space-y-0.5">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <!-- Recent API log summary -->
                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-yellow-400 mb-3">📡 최근 API 요청 요약</h4>
                    <div id="cpm-diag-recent-api" class="bg-gray-900 rounded p-4 text-xs text-gray-300 space-y-1">
                        <div>로딩 중...</div>
                    </div>
                </div>

                <!-- Action buttons -->
                <div class="flex flex-wrap gap-3">
                    <button id="cpm-diag-generate" class="bg-emerald-700 hover:bg-emerald-600 text-white font-semibold py-3 px-6 rounded transition-colors text-sm shadow touch-manipulation">
                        📋 진단 JSON 내보내기
                    </button>
                    <button id="cpm-diag-generate-text" class="bg-teal-700 hover:bg-teal-600 text-white font-semibold py-3 px-6 rounded transition-colors text-sm shadow touch-manipulation">
                        📝 요약 텍스트 내보내기
                    </button>
                    <button id="cpm-diag-copy-clipboard" class="bg-gray-700 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded transition-colors text-sm shadow touch-manipulation">
                        📎 JSON 클립보드 복사
                    </button>
                </div>
            </div>
        </div>

        <div id="tab-apilog" class="cpm-tab-content hidden">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-3 border-b border-gray-700 gap-3">
                <h3 class="text-3xl font-bold text-purple-400">📡 API 요청 로그</h3>
                <div class="flex flex-wrap gap-2">
                    <button id="cpm-apilog-export" class="bg-blue-700 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded transition-colors text-sm shadow touch-manipulation">⬇️ 로그 내보내기</button>
                    <button id="cpm-apilog-clear" class="bg-red-700 hover:bg-red-600 text-white font-semibold py-2 px-4 rounded transition-colors text-sm shadow touch-manipulation">🗑️ 로그 초기화</button>
                </div>
            </div>
            <p class="text-purple-300 font-semibold mb-6 border-l-4 border-purple-500 pl-4 py-1">
                최근 50건의 API 요청·응답을 시간순으로 표시합니다. 채팅을 보내면 자동으로 기록됩니다.
            </p>
            <div class="mb-4 flex items-center gap-3">
                <select id="cpm-apilog-selector" class="flex-1 bg-gray-800 border border-gray-600 text-gray-300 text-sm rounded px-3 py-2"></select>
                <button id="cpm-apilog-refresh" class="bg-gray-700 hover:bg-gray-600 text-white font-semibold py-2 px-4 rounded transition-colors text-sm touch-manipulation">🔄</button>
            </div>
            <div id="cpm-apilog-content" class="text-sm text-gray-300">
                <div class="text-center text-gray-500 py-8 border border-dashed border-gray-700 rounded-lg">
                    아직 API 요청 기록이 없습니다.<br>
                    <span class="text-xs">채팅을 보내면 여기에 요청 정보가 표시됩니다.</span>
                </div>
            </div>
        </div>

        <div id="tab-customs" class="cpm-tab-content hidden">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-3 border-b border-gray-700 gap-3">
                <h3 class="text-3xl font-bold text-gray-400">Custom Models Manager</h3>
                <div class="flex flex-wrap gap-2">
                    <button id="cpm-import-model-btn" class="bg-green-700 hover:bg-green-600 text-white font-semibold py-2 px-4 rounded transition-colors text-sm shadow touch-manipulation">📥 Import Model</button>
                    <button id="cpm-add-custom-btn" class="bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2 px-4 rounded transition-colors text-sm shadow touch-manipulation">➕ Add Model</button>
                </div>
            </div>

            <div id="cpm-cm-list" class="space-y-3"></div>

            <div id="cpm-cm-editor" class="hidden mt-6 bg-gray-900 border border-gray-700 rounded-lg p-6 relative">
                <h4 class="text-xl font-bold text-blue-400 mb-4 border-b border-gray-700 pb-2" id="cpm-cm-editor-title">Edit Custom Model</h4>
                <input type="hidden" id="cpm-cm-id" value="">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="md:col-span-2 text-xs text-blue-300 mb-2 border-l-4 border-blue-500 pl-3">
                        고급 옵션이 필요 없는 경우, 필수 항목만 입력하고 저장하세요.
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Display Name (UI 표시 이름)</label>
                        <input type="text" id="cpm-cm-name" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Model Name (API 요청 모델명)</label>
                        <input type="text" id="cpm-cm-model" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                    </div>
                    <div class="md:col-span-2">
                        <label class="block text-sm font-medium text-gray-400 mb-1">Base URL</label>
                        <input type="text" id="cpm-cm-url" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                    </div>
                    <div class="md:col-span-2">
                        <label class="block text-sm font-medium text-gray-400 mb-1">API Key (여러 개 입력 시 공백/줄바꿈으로 구분 → 자동 키회전)</label>
                        <textarea id="cpm-cm-key" rows="2" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-blue-500" spellcheck="false" placeholder="sk-xxxx 또는 여러 키를 공백/줄바꿈으로 구분"></textarea>
                        <p class="text-xs text-gray-500 mt-1">🔄 키를 2개 이상 입력하면 자동으로 키회전이 활성화됩니다.</p>
                    </div>
                    <div class="md:col-span-2">
                        <label class="block text-sm font-medium text-gray-400 mb-1">CORS Proxy URL <span class="text-xs text-yellow-400">(선택사항 — 노드리스/CORS 우회용)</span></label>
                        <input type="text" id="cpm-cm-proxy-url" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm" placeholder="https://my-proxy.workers.dev">
                        <label class="mt-2 flex items-center space-x-2 text-xs text-gray-400 cursor-pointer">
                            <input type="checkbox" id="cpm-cm-proxy-direct" class="form-checkbox bg-gray-800">
                            <span>Direct 모드 <span class="text-yellow-400">(프록시 URL로 직접 요청, 원본 URL은 X-Target-URL 헤더로 전달)</span></span>
                        </label>
                    </div>
                    <div class="md:col-span-2 mt-4 border-t border-gray-800 pt-4">
                        <h5 class="text-sm font-bold text-gray-300 mb-3">Model Parameters (모델 매개변수)</h5>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">API Format / Spec</label>
                        <select id="cpm-cm-format" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            <option value="openai">OpenAI (기본값)</option>
                            <option value="anthropic">Anthropic Claude</option>
                            <option value="google">Google Gemini Studio</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Tokenizer Type</label>
                        <select id="cpm-cm-tok" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            <option value="o200k_base">o200k_base (OpenAI)</option>
                            <option value="llama3">Llama3</option>
                            <option value="claude">Claude</option>
                            <option value="gemma">Gemma</option>
                            <option value="deepseek">DeepSeek</option>
                            <option value="googlecloud">GoogleCloud (Gemini)</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Responses API Mode</label>
                        <select id="cpm-cm-responses-mode" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            <option value="auto">Auto</option>
                            <option value="on">On</option>
                            <option value="off">Off</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Thinking Level</label>
                        <select id="cpm-cm-thinking" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            ${thinkingList.map(o => `<option value="${o.value}">${o.text}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Thinking Budget Tokens (0=끄기)</label>
                        <input type="number" id="cpm-cm-thinking-budget" min="0" step="1024" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white" placeholder="0">
                        <p class="text-xs text-gray-500 mt-1">Anthropic: budget_tokens. Gemini 2.5: thinkingBudget.</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Max Output Tokens (0=제한없음)</label>
                        <input type="number" id="cpm-cm-max-output" min="0" step="1024" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white" placeholder="0">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Prompt Cache Retention (OpenAI)</label>
                        <select id="cpm-cm-prompt-cache-retention" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            <option value="none">None (서버 기본값)</option>
                            <option value="in_memory">In-Memory (5~10분)</option>
                            <option value="24h">24h Extended</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Reasoning Effort</label>
                        <select id="cpm-cm-reasoning" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            ${reasoningList.map(o => `<option value="${o.value}">${o.text}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Response Verbosity</label>
                        <select id="cpm-cm-verbosity" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            ${verbosityList.map(o => `<option value="${o.value}">${o.text}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-400 mb-1">Anthropic Effort (어댑티브)</label>
                        <select id="cpm-cm-effort" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white">
                            ${effortList.map(o => `<option value="${o.value}">${o.text}</option>`).join('')}
                        </select>
                        <p class="text-xs text-yellow-400 mt-1">⚡ Copilot URL인 경우, 활성화 시 자동으로 /v1/messages 엔드포인트로 전환됩니다.</p>
                    </div>
                    <div class="md:col-span-2 mt-4 border-t border-gray-800 pt-4">
                        <h5 class="text-sm font-bold text-gray-300 mb-3">Custom Formatter Flags</h5>
                        <div class="space-y-2">
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-sysfirst" class="form-checkbox bg-gray-800"> <span>hasFirstSystemPrompt</span></label>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-mergesys" class="form-checkbox bg-gray-800"> <span>mergeSystemPrompt</span></label>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-altrole" class="form-checkbox bg-gray-800"> <span>requiresAlternateRole</span></label>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-mustuser" class="form-checkbox bg-gray-800"> <span>mustStartWithUserInput</span></label>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-maxout" class="form-checkbox bg-gray-800"> <span>useMaxOutputTokensInstead</span></label>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-streaming" class="form-checkbox bg-gray-800"> <span>Use Streaming</span></label>
                            <p class="text-xs text-amber-300 ml-6">※ 글로벌 탭의 "스트리밍 패스스루 활성화"도 함께 켜야 합니다.</p>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-thought" class="form-checkbox bg-gray-800"> <span>useThoughtSignature</span></label>
                            <label class="flex items-center space-x-2 text-sm text-gray-300"><input type="checkbox" id="cpm-cm-adaptive-thinking" class="form-checkbox bg-gray-800"> <span>useAdaptiveThinking (적응형 사고)</span></label>
                        </div>
                    </div>
                    <div class="md:col-span-2 mt-4 border-t border-gray-800 pt-4">
                        <h5 class="text-sm font-bold text-gray-300 mb-3">Custom Parameters (Additional JSON)</h5>
                        <p class="text-xs text-gray-500 mb-2">API Body 최상단에 직접 병합할 JSON. 예: <code>{"top_p": 0.9}</code></p>
                        <textarea id="cpm-cm-custom-params" class="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white h-24 font-mono text-sm" spellcheck="false" placeholder="{}"></textarea>
                    </div>
                </div>
                <div class="mt-4 flex justify-end space-x-3 border-t border-gray-800 pt-4">
                    <button id="cpm-cm-cancel" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm touch-manipulation">Cancel</button>
                    <button id="cpm-cm-save" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm font-bold shadow touch-manipulation">Save Definition</button>
                </div>
            </div>
            <p class="text-xs font-bold text-gray-500 mt-4">* 모델 추가/삭제 후 F5로 새로고침해야 네이티브 드롭다운에 반영됩니다.</p>
        </div>
    `;

    container.appendChild(sidebar);
    container.appendChild(content);
    document.body.appendChild(container);

    // ─── CUSTOM MODELS LIST RENDER ───
    const cmList = document.getElementById('cpm-cm-list');
    const cmEditor = document.getElementById('cpm-cm-editor');
    const cmCount = document.getElementById('cpm-cm-count');

    const refreshCmList = () => {
        if (cmList.contains(cmEditor)) {
            document.getElementById('tab-customs').appendChild(cmEditor);
            cmEditor.classList.add('hidden');
        }
        cmCount.innerText = String(CUSTOM_MODELS_CACHE.length);
        if (CUSTOM_MODELS_CACHE.length === 0) {
            cmList.innerHTML = '<div class="text-center text-gray-500 py-4 border border-dashed border-gray-700 rounded">No custom models defined.</div>';
            return;
        }
        cmList.innerHTML = CUSTOM_MODELS_CACHE.map((m, i) => `
            <div class="bg-gray-800 border border-gray-700 rounded p-4 flex justify-between items-center group hover:border-gray-500 transition-colors">
                <div class="flex-1 pr-4 min-w-0">
                    <div class="font-bold text-white text-lg truncate">${escAttr(m.name || 'Unnamed Model')}${((m.key || '').trim().split(/\s+/).filter(k => k.length > 0).length > 1) ? ' <span class="text-xs text-blue-400 font-normal ml-2">🔄 키회전</span>' : ''}</div>
                    <div class="text-xs text-gray-400 font-mono mt-1 truncate">${escAttr(m.model || 'No model ID')} | ${escAttr(m.url || 'No URL')}</div>
                </div>
                <div class="flex space-x-2 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
                    <button class="bg-green-900/50 hover:bg-green-600 text-white px-3 py-1 rounded text-sm cpm-cm-export-btn touch-manipulation" data-idx="${i}" title="Export">📤</button>
                    <button class="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1 rounded text-sm cpm-cm-edit-btn touch-manipulation" data-idx="${i}">✏️ Edit</button>
                    <button class="bg-red-900/50 hover:bg-red-600 text-white px-3 py-1 rounded text-sm cpm-cm-del-btn touch-manipulation" data-idx="${i}">🗑️</button>
                </div>
            </div>
        `).join('');

        // Bind custom model list buttons
        cmList.querySelectorAll('.cpm-cm-export-btn').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ct = /** @type {HTMLElement} */ (e.currentTarget);
            const m = CUSTOM_MODELS_CACHE[parseInt(ct.dataset.idx, 10)];
            if (!m) return;
            const exp = serializeCustomModelExport(m);
            const url = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exp, null, 2));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(m.name || 'model').replace(/[^a-zA-Z0-9가-힣_-]/g, '_')}.cpm-model.json`;
            document.body.appendChild(a); a.click(); a.remove();
        }));

        cmList.querySelectorAll('.cpm-cm-del-btn').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ct = /** @type {HTMLElement} */ (e.currentTarget);
            const idx = parseInt(ct.dataset.idx);
            if (confirm('Delete this model?')) {
                CUSTOM_MODELS_CACHE.splice(idx, 1);
                persistCustomModels();
                refreshCmList();
            }
        }));

        cmList.querySelectorAll('.cpm-cm-edit-btn').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ct = /** @type {HTMLElement} */ (e.currentTarget);
            const idx = parseInt(ct.dataset.idx);
            openEditor(CUSTOM_MODELS_CACHE[idx]);
            const itemDiv = ct.closest('.group');
            if (itemDiv) itemDiv.after(cmEditor);
            cmEditor.classList.remove('hidden');
        }));
    };

    // ─── EDITOR ───
    const parseEditorBool = (value) => {
        if (value === true || value === false) return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value !== 'string') return false;
        const v = value.trim().toLowerCase();
        return ['true', '1', 'yes', 'on'].includes(v);
    };

    const openEditor = (existing) => {
        const m = existing || {};
        /** @returns {HTMLInputElement} */
        const el = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
        el('cpm-cm-id').value = m.uniqueId || ('custom_' + Date.now());
        el('cpm-cm-name').value = m.name || '';
        el('cpm-cm-model').value = m.model || '';
        el('cpm-cm-url').value = m.url || '';
        el('cpm-cm-key').value = m.key || '';
        el('cpm-cm-proxy-url').value = m.proxyUrl || '';
        el('cpm-cm-proxy-direct').checked = parseEditorBool(m.proxyDirect);
        el('cpm-cm-format').value = m.format || 'openai';
        el('cpm-cm-tok').value = m.tok || 'o200k_base';
        el('cpm-cm-responses-mode').value = m.responsesMode || 'auto';
        el('cpm-cm-thinking').value = m.thinking || 'off';
        el('cpm-cm-thinking-budget').value = m.thinkingBudget || 0;
        el('cpm-cm-max-output').value = m.maxOutputLimit || 0;
        el('cpm-cm-prompt-cache-retention').value = m.promptCacheRetention || 'none';
        el('cpm-cm-reasoning').value = m.reasoning || 'none';
        el('cpm-cm-verbosity').value = m.verbosity || 'none';
        el('cpm-cm-effort').value = m.effort || 'none';
        el('cpm-cm-sysfirst').checked = parseEditorBool(m.sysfirst);
        el('cpm-cm-mergesys').checked = parseEditorBool(m.mergesys);
        el('cpm-cm-altrole').checked = parseEditorBool(m.altrole);
        el('cpm-cm-mustuser').checked = parseEditorBool(m.mustuser);
        el('cpm-cm-maxout').checked = parseEditorBool(m.maxout);
        el('cpm-cm-streaming').checked = parseEditorBool(m.streaming);
        el('cpm-cm-thought').checked = parseEditorBool(m.thought);
        el('cpm-cm-adaptive-thinking').checked = parseEditorBool(m.adaptiveThinking);
        el('cpm-cm-custom-params').value = m.customParams || '';
        document.getElementById('cpm-cm-editor-title').innerText = existing ? 'Edit Custom Model' : 'Add New Model';
    };

    // ─── MOBILE MENU TOGGLE ───
    const mobileMenuBtn = document.getElementById('cpm-mobile-menu-btn');
    const mobileDropdown = document.getElementById('cpm-mobile-dropdown');
    const mobileIcon = document.getElementById('cpm-mobile-icon');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            const isHidden = mobileDropdown.classList.contains('hidden');
            if (isHidden) {
                mobileDropdown.classList.remove('hidden');
                mobileDropdown.classList.add('flex');
                mobileIcon.innerText = '▲';
            } else {
                mobileDropdown.classList.add('hidden');
                mobileDropdown.classList.remove('flex');
                mobileIcon.innerText = '▼';
            }
        });
    }

    // ─── AUTOSAVE ───
    content.querySelectorAll('input[type="text"], input[type="password"], input[type="number"], select, textarea').forEach(el => {
        el.addEventListener('change', (e) => { const t = /** @type {HTMLInputElement} */ (e.target); setVal(t.id, t.value); });
    });
    content.querySelectorAll('input[type="checkbox"]').forEach(el => {
        el.addEventListener('change', (e) => {
            const t = /** @type {HTMLInputElement} */ (e.target);
            setVal(t.id, t.checked);
            if (t.id === 'cpm_streaming_enabled' || t.id === 'cpm_compatibility_mode') {
                refreshRuntimeStatusPanels();
            }
        });
    });
    const _nodelessModeSelect = document.getElementById('cpm_copilot_nodeless_mode');
    if (_nodelessModeSelect) _nodelessModeSelect.addEventListener('change', () => refreshRuntimeStatusPanels());

    // Password toggles
    content.querySelectorAll('.cpm-pw-toggle').forEach(btn => {
        const hBtn = /** @type {HTMLElement} */ (btn);
        hBtn.addEventListener('click', () => {
            const input = /** @type {HTMLInputElement} */ (document.getElementById(hBtn.dataset.targetId));
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                hBtn.textContent = '🔒';
            } else {
                input.type = 'password';
                hBtn.textContent = '👁️';
            }
        });
    });

    // ─── TAB SWITCHING ───
    const tabs = sidebar.querySelectorAll('.tab-btn');
    tabs.forEach(t => { const ht = /** @type {HTMLElement} */ (t); ht.addEventListener('click', () => {
        tabs.forEach(x => { x.classList.remove('bg-gray-800', 'border-l-4', 'border-blue-500', 'text-blue-400'); });
        ht.classList.add('bg-gray-800', 'border-l-4', 'border-blue-500', 'text-blue-400');
        content.querySelectorAll('.cpm-tab-content').forEach(p => p.classList.add('hidden'));
        const target = document.getElementById(ht.dataset.target);
        if (target) target.classList.remove('hidden');
        // Auto collapse on mobile
        if (window.innerWidth < 768 && mobileDropdown && !mobileDropdown.classList.contains('hidden')) {
            mobileDropdown.classList.add('hidden');
            mobileDropdown.classList.remove('flex');
            mobileIcon.innerText = '▼';
        }
    }); });
    const initialTab = /** @type {HTMLElement} */ (Array.from(tabs).find((tab) => /** @type {HTMLElement} */ (tab).dataset.target === initialTarget) || tabs[0]);
    if (initialTab) initialTab.click();

    content.querySelectorAll('.cpm-refresh-models-btn').forEach((btn) => btn.addEventListener('click', async (e) => {
        const ct = /** @type {HTMLButtonElement} */ (e.currentTarget);
        const providerName = ct.dataset.provider;
        if (!providerName) return;
        const originalText = ct.textContent;
        ct.disabled = true;
        ct.textContent = '⏳ 조회 중...';
        try {
            const result = await refreshProviderDynamicModels(providerName);
            if (!result?.success) {
                alert(result?.error || result?.content || `${providerName} 동적 모델 조회 실패`);
                return;
            }
            alert(`${providerName}: ${result.fetchedCount}개 조회, 신규 ${result.newCount}개 추가`);
            await openCpmSettings(`tab-provider-${providerName}`);
        } catch (err) {
            alert(`${providerName} 동적 모델 조회 오류: ${err.message}`);
        } finally {
            if (document.body.contains(ct)) {
                ct.disabled = false;
                ct.textContent = originalText;
            }
        }
    }));

    // ─── CUSTOM MODEL HANDLERS ───
    refreshCmList();

    document.getElementById('cpm-add-custom-btn').addEventListener('click', () => {
        openEditor(null);
        cmList.prepend(cmEditor);
        cmEditor.classList.remove('hidden');
    });

    document.getElementById('cpm-cm-cancel').addEventListener('click', () => {
        document.getElementById('tab-customs').appendChild(cmEditor);
        cmEditor.classList.add('hidden');
    });

    document.getElementById('cpm-cm-save').addEventListener('click', () => {
        /** @returns {HTMLInputElement} */
        const el = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
        const uid = el('cpm-cm-id').value;
        const newModel = normalizeCustomModel({
            uniqueId: uid,
            name: el('cpm-cm-name').value,
            model: el('cpm-cm-model').value,
            url: el('cpm-cm-url').value,
            key: el('cpm-cm-key').value,
            proxyUrl: el('cpm-cm-proxy-url').value,
            proxyDirect: el('cpm-cm-proxy-direct').checked,
            format: el('cpm-cm-format').value,
            tok: el('cpm-cm-tok').value,
            responsesMode: el('cpm-cm-responses-mode').value || 'auto',
            thinking: el('cpm-cm-thinking').value,
            thinkingBudget: parseInt(el('cpm-cm-thinking-budget').value, 10) || 0,
            maxOutputLimit: parseInt(el('cpm-cm-max-output').value, 10) || 0,
            promptCacheRetention: el('cpm-cm-prompt-cache-retention').value || 'none',
            reasoning: el('cpm-cm-reasoning').value,
            verbosity: el('cpm-cm-verbosity').value,
            effort: el('cpm-cm-effort').value,
            sysfirst: el('cpm-cm-sysfirst').checked,
            mergesys: el('cpm-cm-mergesys').checked,
            altrole: el('cpm-cm-altrole').checked,
            mustuser: el('cpm-cm-mustuser').checked,
            maxout: el('cpm-cm-maxout').checked,
            streaming: el('cpm-cm-streaming').checked,
            decoupled: !el('cpm-cm-streaming').checked,
            thought: el('cpm-cm-thought').checked,
            adaptiveThinking: el('cpm-cm-adaptive-thinking').checked,
            customParams: el('cpm-cm-custom-params').value,
        });
        const existingIdx = CUSTOM_MODELS_CACHE.findIndex(x => x.uniqueId === uid);
        if (existingIdx >= 0) {
            CUSTOM_MODELS_CACHE[existingIdx] = { ...CUSTOM_MODELS_CACHE[existingIdx], ...newModel };
        } else {
            CUSTOM_MODELS_CACHE.push(newModel);
            const entry = { uniqueId: newModel.uniqueId, id: newModel.model, name: newModel.name, provider: 'Custom' };
            ALL_DEFINED_MODELS.push(entry);
            registerModelWithRisu(entry);
        }
        persistCustomModels();
        refreshCmList();
        cmEditor.classList.add('hidden');
    });

    // Import model(s) from JSON file
    document.getElementById('cpm-import-model-btn').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.multiple = true;
        input.onchange = async (e) => {
            const files = Array.from(/** @type {HTMLInputElement} */ (e.target).files);
            if (files.length === 0) return;
            let imported = 0, errors = 0;
            for (const file of files) {
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!data._cpmModelExport || !data.name) { errors++; continue; }
                    const normalized = normalizeCustomModel(data, { includeKey: true, includeUniqueId: false, includeTag: false });
                    normalized.uniqueId = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                    CUSTOM_MODELS_CACHE.push(normalized);
                    imported++;
                } catch { errors++; }
            }
            if (imported > 0) { persistCustomModels(); refreshCmList(); }
            alert(`${imported}개 모델 가져오기 완료` + (errors > 0 ? ` (${errors}개 실패)` : '') + `\n\nAPI Key는 별도로 설정해주세요.`);
        };
        input.click();
    });

    // ─── API LOG (standalone tab) ───
    const _renderApiLogEntry = (r) => {
        if (!r) return '<div class="text-gray-500 text-center py-8">선택한 요청 데이터가 없습니다.</div>';
        const redactKey = (v) => { if (!v || typeof v !== 'string' || v.length <= 8) return '***'; return v.slice(0, 4) + '...' + v.slice(-4); };
        const redactHeaders = (h) => { const c = { ...h }; for (const k of Object.keys(c)) { if (/auth|key|token|secret|bearer/i.test(k)) c[k] = redactKey(c[k]); } return c; };
        const fj = (o) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } };
        const sc = r.status >= 200 && r.status < 300 ? 'text-green-400' : 'text-red-400';
        return `<div class="space-y-3">
            <div class="flex items-center flex-wrap gap-x-4 gap-y-1 text-sm">
                <span class="text-gray-400">⏱️ ${new Date(r.timestamp).toLocaleString()}</span>
                <span class="${sc} font-bold">Status: ${r.status || 'N/A'}</span>
                <span class="text-gray-400">${r.duration ? r.duration + 'ms' : ''}</span>
                ${r.url ? `<span class="text-purple-300 font-mono text-xs break-all">${r.method || 'POST'} ${r.url}</span>` : ''}
            </div>
            ${r.requestHeaders ? `<details class="bg-gray-800 rounded p-3"><summary class="cursor-pointer text-gray-300 font-semibold text-sm">📤 Request Headers</summary><pre class="mt-2 text-xs text-gray-400 overflow-auto max-h-40 whitespace-pre-wrap">${fj(redactHeaders(r.requestHeaders))}</pre></details>` : ''}
            <details class="bg-gray-800 rounded p-3"><summary class="cursor-pointer text-gray-300 font-semibold text-sm">📤 Request Body</summary><pre class="mt-2 text-xs text-gray-400 overflow-auto max-h-60 whitespace-pre-wrap">${fj(r.requestBody || r.body || {})}</pre></details>
            <details class="bg-gray-800 rounded p-3" open><summary class="cursor-pointer text-gray-300 font-semibold text-sm">📥 Response Body</summary><pre class="mt-2 text-xs text-gray-400 overflow-auto max-h-96 whitespace-pre-wrap">${typeof r.response === 'string' ? r.response : fj(r.response || 'No response')}</pre></details>
        </div>`;
    };

    const _refreshApiLogPanel = () => {
        const c = document.getElementById('cpm-apilog-content');
        const s = /** @type {HTMLSelectElement} */ (document.getElementById('cpm-apilog-selector'));
        const all = _getAllApiRequests();
        if (all.length === 0) {
            s.innerHTML = '';
            c.innerHTML = '<div class="text-center text-gray-500 py-8 border border-dashed border-gray-700 rounded-lg">아직 API 요청 기록이 없습니다.<br><span class="text-xs">채팅을 보내면 여기에 요청 정보가 표시됩니다.</span></div>';
            return;
        }
        const cv = s.value;
        s.innerHTML = all.map((r, i) => {
            const t = new Date(r.timestamp).toLocaleTimeString();
            return `<option value="${r.id}"${i === 0 ? ' selected' : ''}>#${i + 1} [${r.status || '...'}] ${r.modelName || '?'} — ${t}</option>`;
        }).join('');
        if (cv && all.find(r => r.id === cv)) s.value = cv;
        c.innerHTML = _renderApiLogEntry(_getApiRequestById(s.value));
    };

    document.getElementById('cpm-apilog-selector').addEventListener('change', (e) => {
        document.getElementById('cpm-apilog-content').innerHTML = _renderApiLogEntry(_getApiRequestById(/** @type {HTMLSelectElement} */ (e.target).value));
    });
    document.getElementById('cpm-apilog-refresh').addEventListener('click', () => _refreshApiLogPanel());
    document.getElementById('cpm-apilog-export').addEventListener('click', () => {
        const all = _getAllApiRequests();
        if (all.length === 0) { alert('내보낼 로그가 없습니다.'); return; }
        // Redact sensitive headers before export
        const redactKey = (v) => { if (!v || typeof v !== 'string' || v.length <= 8) return '***'; return v.slice(0, 4) + '...' + v.slice(-4); };
        const redactHeaders = (h) => { const c = { ...h }; for (const k of Object.keys(c)) { if (/auth|key|token|secret|bearer/i.test(k)) c[k] = redactKey(c[k]); } return c; };
        const safe = all.map(r => ({ ...r, requestHeaders: r.requestHeaders ? redactHeaders(r.requestHeaders) : undefined }));
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(safe, null, 2));
        const a = document.createElement('a');
        a.href = dataStr; a.download = `cupcake_api_log_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
    });
    document.getElementById('cpm-apilog-clear').addEventListener('click', () => {
        if (!confirm('모든 API 요청 로그를 초기화하시겠습니까?')) return;
        clearApiRequests();
        _refreshApiLogPanel();
    });

    // Auto-refresh API log when its tab is shown
    const _apiLogTabBtn = Array.from(sidebar.querySelectorAll('.tab-btn')).find(b => /** @type {HTMLElement} */ (b).dataset.target === 'tab-apilog');
    if (_apiLogTabBtn) _apiLogTabBtn.addEventListener('click', () => setTimeout(_refreshApiLogPanel, 50));

    // ─── DIAGNOSTICS TAB ───
    const _collectRuntimeMetadata = async (kind) => {
        const pluginStorageKeys = await getCpmPluginStorageKeys();
        const streamBridgeCapable = await checkStreamCapability();
        const compatibilityMode = await safeGetBoolArg('cpm_compatibility_mode', false);
        const streamingEnabled = await safeGetBoolArg('cpm_streaming_enabled', false);
        const copilotNodelessMode = await safeGetArg('cpm_copilot_nodeless_mode', 'off');
        let timeZone = 'unknown';
        try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'; } catch (_) { /* ignore */ }
        return {
            kind,
            formatVersion: kind === 'settings-export' ? CPM_EXPORT_VERSION : 2,
            generatedAt: new Date().toISOString(),
            generatedBy: 'manager-ui',
            cpmVersion: CPM_VERSION,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent || 'N/A' : 'N/A',
            language: typeof navigator !== 'undefined' ? navigator.language || 'unknown' : 'N/A',
            platform: typeof navigator !== 'undefined' ? navigator.platform || 'unknown' : 'N/A',
            timeZone,
            streamBridgeCapable,
            compatibilityMode,
            streamingEnabled,
            copilotNodelessMode,
            managedSettingsCount: SettingsBackup.getAllKeys().length,
            pluginStorageKeyCount: pluginStorageKeys.length,
            registeredProviderCount: registeredProviders.size,
            totalModelCount: ALL_DEFINED_MODELS.length,
            customModelCount: CUSTOM_MODELS_CACHE.length,
            apiRequestLogSize: _getAllApiRequests().length,
        };
    };

    const _buildDiagnosticsData = async () => {
        const provList = [];
        for (const [name, prov] of registeredProviders) {
            provList.push({
                name,
                pluginName: prov.pluginName,
                modelCount: Array.isArray(prov.models) ? prov.models.length : 0,
                supportsDynamicModels: !!prov.supportsDynamicModels,
                settingsFieldCount: Array.isArray(prov.settingsFields) ? prov.settingsFields.length : 0,
            });
        }
        const recentLogs = _getAllApiRequests().slice(0, 10).map(r => ({
            timestamp: r.timestamp,
            model: r.modelName || '?',
            status: r.status || 'N/A',
            duration: r.duration || null,
            method: r.method || 'POST',
            url: r.url || '',
        }));
        let bootStatus = null;
        try {
            const rawBootStatus = await Risu.pluginStorage.getItem('cpm_last_boot_status');
            if (rawBootStatus) bootStatus = JSON.parse(String(rawBootStatus));
        } catch (_) { /* ignore */ }
        let backupKeys = 0;
        try {
            const backup = await SettingsBackup.load();
            backupKeys = backup && typeof backup === 'object' ? Object.keys(backup).length : 0;
        } catch (_) { /* ignore */ }
        const pluginStorageKeys = await getCpmPluginStorageKeys();
        const metadata = await _collectRuntimeMetadata('diagnostics');
        const slotAssignments = await Promise.all(CPM_SLOT_LIST.map(async (slot) => {
            const configuredId = await safeGetArg(`cpm_slot_${slot}`, '');
            const matched = ALL_DEFINED_MODELS.find((m) => m.uniqueId === configuredId);
            return {
                slot,
                configuredId,
                modelName: matched?.name || '',
                provider: matched?.provider || '',
            };
        }));
        return {
            diagnosticFormatVersion: metadata.formatVersion,
            cpmVersion: CPM_VERSION,
            timestamp: metadata.generatedAt,
            userAgent: metadata.userAgent,
            metadata,
            registeredProviders: provList,
            totalModels: ALL_DEFINED_MODELS.length,
            customModels: CUSTOM_MODELS_CACHE.length,
            ipcProviders: registeredProviders.size,
            pendingRequests: pendingRequests.size,
            pendingControlRequests: pendingControlRequests.size,
            abortBridgeProbed: _abortBridgeProbeDone,
            streamBridgeCapable: metadata.streamBridgeCapable,
            compatibilityMode: metadata.compatibilityMode,
            streamingEnabled: metadata.streamingEnabled,
            copilotNodelessMode: metadata.copilotNodelessMode,
            apiRequestLogSize: _getAllApiRequests().length,
            recentApiRequests: recentLogs,
            slotAssignments,
            pluginStorageKeys,
            backupKeys,
            bootStatus,
            allModels: ALL_DEFINED_MODELS.map(m => ({ id: m.id, name: m.name, provider: m.provider })),
        };
    };

    const _refreshDiagnosticsPanel = async () => {
        const diag = await _buildDiagnosticsData();
        // Overview
        const overviewEl = document.getElementById('cpm-diag-overview');
        if (overviewEl) {
            overviewEl.innerHTML = `
                <div><span class="text-gray-500">CPM 버전:</span> <span class="text-cyan-400">${CPM_VERSION}</span></div>
                <div><span class="text-gray-500">등록 프로바이더:</span> <span class="text-white">${diag.ipcProviders}개</span></div>
                <div><span class="text-gray-500">전체 모델:</span> <span class="text-white">${diag.totalModels}개</span></div>
                <div><span class="text-gray-500">커스텀 모델:</span> <span class="text-white">${diag.customModels}개</span></div>
                <div><span class="text-gray-500">대기 중 요청:</span> <span class="text-white">${diag.pendingRequests}개</span></div>
                <div><span class="text-gray-500">API 로그:</span> <span class="text-white">${diag.apiRequestLogSize}건</span></div>
                <div><span class="text-gray-500">진단 포맷:</span> <span class="text-white">v${diag.metadata?.formatVersion || 1} · ${escAttr(diag.metadata?.generatedBy || 'manager-ui')}</span></div>
                <div><span class="text-gray-500">언어/시간대:</span> <span class="text-white">${escAttr(diag.metadata?.language || 'unknown')} / ${escAttr(diag.metadata?.timeZone || 'unknown')}</span></div>
                <div><span class="text-gray-500">Abort 브릿지:</span> <span class="${diag.abortBridgeProbed ? 'text-green-400' : 'text-yellow-400'}">${diag.abortBridgeProbed ? '확인됨' : '대기 중'}</span></div>
                <div class="text-gray-600 mt-2">생성 시각: ${diag.timestamp}</div>
            `;
        }
        const bridgeEl = document.getElementById('cpm-diag-bridge');
        if (bridgeEl) {
            bridgeEl.innerHTML = `
                <div><span class="text-gray-500">ReadableStream 브릿지:</span> <span class="${diag.streamBridgeCapable ? 'text-green-400' : 'text-yellow-400'}">${diag.streamBridgeCapable ? '지원됨' : '미지원'}</span></div>
                <div><span class="text-gray-500">스트리밍 설정:</span> <span class="text-white">${diag.streamingEnabled ? 'ON' : 'OFF'}</span></div>
                <div><span class="text-gray-500">호환성 모드:</span> <span class="text-white">${diag.compatibilityMode ? 'ON' : 'OFF'}</span></div>
                <div><span class="text-gray-500">Copilot Node-less:</span> <span class="text-white">${escAttr(diag.copilotNodelessMode)}</span></div>
                <div><span class="text-gray-500">Abort 브릿지 확인:</span> <span class="${diag.abortBridgeProbed ? 'text-green-400' : 'text-yellow-400'}">${diag.abortBridgeProbed ? '완료' : '대기'}</span></div>
            `;
        }
        const storageEl = document.getElementById('cpm-diag-storage');
        if (storageEl) {
            storageEl.innerHTML = `
                <div><span class="text-gray-500">pluginStorage 키:</span> <span class="text-white">${diag.pluginStorageKeys.length}개</span></div>
                <div><span class="text-gray-500">설정 백업 키:</span> <span class="text-white">${diag.backupKeys}개</span></div>
                <div><span class="text-gray-500">관리 설정 키:</span> <span class="text-white">${SettingsBackup.getAllKeys().length}개</span></div>
                <div class="text-gray-600 mt-2 break-all">${diag.pluginStorageKeys.map((k) => escAttr(k)).join(', ') || '없음'}</div>
            `;
        }
        const bootEl = document.getElementById('cpm-diag-boot');
        if (bootEl) {
            if (!diag.bootStatus) {
                bootEl.innerHTML = '<div class="text-gray-500">저장된 부트 상태가 없습니다.</div>';
            } else {
                bootEl.innerHTML = `
                    <div><span class="text-gray-500">버전:</span> <span class="text-white">${escAttr(diag.bootStatus.version || '?')}</span></div>
                    <div><span class="text-gray-500">설정 등록:</span> <span class="${diag.bootStatus.settingsOk ? 'text-green-400' : 'text-red-400'}">${diag.bootStatus.settingsOk ? '정상' : '실패'}</span></div>
                    <div><span class="text-gray-500">모델 등록 수:</span> <span class="text-white">${diag.bootStatus.models ?? 0}</span></div>
                    <div><span class="text-gray-500">성공 phase:</span> <span class="text-white">${Array.isArray(diag.bootStatus.ok) ? diag.bootStatus.ok.length : 0}</span></div>
                    <div><span class="text-gray-500">실패 phase:</span> <span class="${Array.isArray(diag.bootStatus.fail) && diag.bootStatus.fail.length > 0 ? 'text-yellow-400' : 'text-green-400'}">${Array.isArray(diag.bootStatus.fail) ? diag.bootStatus.fail.length : 0}</span></div>
                    <div class="text-gray-600 mt-2 break-words">${Array.isArray(diag.bootStatus.fail) && diag.bootStatus.fail.length > 0 ? diag.bootStatus.fail.map((f) => escAttr(String(f))).join(' | ') : '실패 기록 없음'}</div>
                `;
            }
        }
        const slotsEl = document.getElementById('cpm-diag-slots');
        if (slotsEl) {
            slotsEl.innerHTML = diag.slotAssignments.map((slotInfo) => `
                <div class="bg-gray-800 rounded p-3 border border-gray-700">
                    <div class="font-bold text-white">${escAttr(slotInfo.slot)}</div>
                    <div class="text-gray-400 text-[11px]">${slotInfo.configuredId ? `${escAttr(slotInfo.provider || 'Unknown')} · ${escAttr(slotInfo.modelName || slotInfo.configuredId)}` : '미할당'}</div>
                    ${slotInfo.configuredId ? `<div class="text-gray-600 text-[10px] font-mono mt-1">${escAttr(slotInfo.configuredId)}</div>` : ''}
                </div>
            `).join('');
        }
        // Providers
        const providersEl = document.getElementById('cpm-diag-providers');
        if (providersEl) {
            if (diag.registeredProviders.length === 0) {
                providersEl.innerHTML = '<div class="text-gray-500">등록된 IPC 프로바이더가 없습니다.</div>';
            } else {
                providersEl.innerHTML = diag.registeredProviders.map(p => `
                    <div class="bg-gray-800 rounded p-3 border border-gray-700">
                        <div class="font-bold text-white">${escAttr(p.name)}</div>
                        <div class="text-gray-400 text-[11px]">플러그인: ${escAttr(p.pluginName)} · 모델 ${p.modelCount}개${p.supportsDynamicModels ? ' · <span class="text-sky-400">동적 조회 지원</span>' : ''}</div>
                    </div>
                `).join('');
            }
        }
        // Models
        const modelsEl = document.getElementById('cpm-diag-models');
        if (modelsEl) {
            if (diag.allModels.length === 0) {
                modelsEl.innerHTML = '<div class="text-gray-500">등록된 모델 없음</div>';
            } else {
                modelsEl.innerHTML = diag.allModels.map(m => `<div class="py-0.5 border-b border-gray-800"><span class="text-gray-500">[${escAttr(m.provider)}]</span> ${escAttr(m.name)} <span class="text-gray-600">(${escAttr(m.id)})</span></div>`).join('');
            }
        }
        // Recent API
        const recentEl = document.getElementById('cpm-diag-recent-api');
        if (recentEl) {
            if (diag.recentApiRequests.length === 0) {
                recentEl.innerHTML = '<div class="text-gray-500">아직 API 요청 기록이 없습니다.</div>';
            } else {
                recentEl.innerHTML = diag.recentApiRequests.map(r => {
                    const sc = (r.status >= 200 && r.status < 300) ? 'text-green-400' : (typeof r.status === 'number' ? 'text-red-400' : 'text-gray-400');
                    return `<div class="py-1 border-b border-gray-800 flex items-center gap-2 flex-wrap">
                        <span class="text-gray-500">${new Date(r.timestamp).toLocaleTimeString()}</span>
                        <span class="${sc} font-bold">${r.status}</span>
                        <span class="text-white">${escAttr(r.model)}</span>
                        ${r.duration ? `<span class="text-gray-500">${r.duration}ms</span>` : ''}
                    </div>`;
                }).join('');
            }
        }
    };

    const _refreshOperationsPanel = async () => {
        const summaryEl = document.getElementById('cpm-ops-summary');
        if (!summaryEl) return;
        const keys = await getCpmPluginStorageKeys();
        const runtimeMeta = await _collectRuntimeMetadata('operations');
        let bootStatusRaw = null;
        let bootStatus = null;
        try {
            bootStatusRaw = await Risu.pluginStorage.getItem('cpm_last_boot_status');
            if (bootStatusRaw) bootStatus = JSON.parse(String(bootStatusRaw));
        } catch (_) { /* ignore */ }
        summaryEl.innerHTML = `
            <div><span class="text-gray-500">최근 새로고침:</span> <span class="text-white">${runtimeMeta.generatedAt}</span></div>
            <div><span class="text-gray-500">관리 설정 키:</span> <span class="text-white">${SettingsBackup.getAllKeys().length}개</span></div>
            <div><span class="text-gray-500">pluginStorage 키:</span> <span class="text-white">${keys.length}개</span></div>
            <div><span class="text-gray-500">커스텀 모델:</span> <span class="text-white">${CUSTOM_MODELS_CACHE.length}개</span></div>
            <div><span class="text-gray-500">API 로그:</span> <span class="text-white">${_getAllApiRequests().length}건</span></div>
            <div><span class="text-gray-500">브릿지 경로:</span> <span class="text-white">${runtimeMeta.streamBridgeCapable ? 'ReadableStream 직통' : '호환성 fallback'}</span></div>
            <div><span class="text-gray-500">스트리밍/호환성:</span> <span class="text-white">${runtimeMeta.streamingEnabled ? 'Streaming ON' : 'Streaming OFF'} / ${runtimeMeta.compatibilityMode ? 'Compat ON' : 'Compat OFF'}</span></div>
            <div><span class="text-gray-500">마지막 부트 상태:</span> <span class="text-white">${bootStatus ? (bootStatus.settingsOk ? '정상' : '점검 필요') : (bootStatusRaw ? '기록 있음' : '기록 없음')}</span></div>
            <div><span class="text-gray-500">내보내기 포맷:</span> <span class="text-white">설정 v${CPM_EXPORT_VERSION} / 진단 v2</span></div>
            <div class="text-gray-600 mt-2">권장 순서: 설정 내보내기 → 진단 저장 → 필요 시 전체 정리</div>
        `;
    };

    // Auto-refresh diagnostics when its tab opens
    const _diagTabBtn = Array.from(sidebar.querySelectorAll('.tab-btn')).find(b => /** @type {HTMLElement} */ (b).dataset.target === 'tab-diagnostics');
    if (_diagTabBtn) _diagTabBtn.addEventListener('click', () => setTimeout(() => { _refreshDiagnosticsPanel(); }, 50));
    const _opsTabBtn = Array.from(sidebar.querySelectorAll('.tab-btn')).find(b => /** @type {HTMLElement} */ (b).dataset.target === 'tab-operations');
    if (_opsTabBtn) _opsTabBtn.addEventListener('click', () => setTimeout(() => { _refreshOperationsPanel(); }, 50));

    document.getElementById('cpm-diag-generate').addEventListener('click', async () => {
        const data = await _buildDiagnosticsData();
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
        const a = document.createElement('a');
        a.href = dataStr; a.download = `cupcake_diagnostics_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
    });

    document.getElementById('cpm-diag-generate-text').addEventListener('click', async () => {
        const d = await _buildDiagnosticsData();
        let text = `=== Cupcake PM v${d.cpmVersion} 진단 리포트 ===\n`;
        text += `생성 시각: ${d.timestamp}\n`;
        text += `User-Agent: ${d.userAgent}\n\n`;
        text += `--- 메타데이터 ---\n`;
        text += `진단 포맷: v${d.metadata?.formatVersion || 1}\n`;
        text += `생성 주체: ${d.metadata?.generatedBy || 'manager-ui'}\n`;
        text += `언어/시간대: ${d.metadata?.language || 'unknown'} / ${d.metadata?.timeZone || 'unknown'}\n`;
        text += `플랫폼: ${d.metadata?.platform || 'unknown'}\n\n`;
        text += `--- 시스템 상태 ---\n`;
        text += `등록 프로바이더: ${d.ipcProviders}개\n`;
        text += `전체 모델: ${d.totalModels}개 (커스텀 ${d.customModels}개)\n`;
        text += `대기 요청: ${d.pendingRequests}개\n`;
        text += `API 로그: ${d.apiRequestLogSize}건\n`;
        text += `Abort 브릿지: ${d.abortBridgeProbed ? 'OK' : 'Pending'}\n\n`;
        text += `ReadableStream 브릿지: ${d.streamBridgeCapable ? 'OK' : 'NO'}\n`;
        text += `호환성 모드: ${d.compatibilityMode ? 'ON' : 'OFF'}\n`;
        text += `Node-less: ${d.copilotNodelessMode}\n`;
        text += `pluginStorage 키: ${d.pluginStorageKeys.length}개\n`;
        text += `설정 백업 키: ${d.backupKeys}개\n\n`;
        text += `--- 프로바이더 ---\n`;
        d.registeredProviders.forEach(p => { text += `  ${p.name} (${p.pluginName}) — 모델 ${p.modelCount}개${p.supportsDynamicModels ? ' [동적]' : ''}\n`; });
        text += `\n--- 슬롯 매핑 ---\n`;
        d.slotAssignments.forEach((s) => { text += `  ${s.slot}: ${s.configuredId ? `[${s.provider || '?'}] ${s.modelName || s.configuredId}` : '미할당'}\n`; });
        text += `\n--- 최근 API 요청 ---\n`;
        d.recentApiRequests.forEach(r => { text += `  ${new Date(r.timestamp).toLocaleTimeString()} [${r.status}] ${r.model} ${r.duration ? r.duration + 'ms' : ''}\n`; });
        text += `\n--- 모든 모델 ---\n`;
        d.allModels.forEach(m => { text += `  [${m.provider}] ${m.name} (${m.id})\n`; });

        const dataStr = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
        const a = document.createElement('a');
        a.href = dataStr; a.download = `cupcake_diagnostics_${new Date().toISOString().slice(0, 10)}.txt`;
        document.body.appendChild(a); a.click(); a.remove();
    });

    document.getElementById('cpm-diag-copy-clipboard').addEventListener('click', async () => {
        const d = await _buildDiagnosticsData();
        const text = JSON.stringify(d, null, 2);
        try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        if (typeof globalThis.alert === 'function') globalThis.alert('진단 데이터가 클립보드에 복사되었습니다.');
    });

    document.getElementById('cpm-ops-refresh-btn')?.addEventListener('click', async () => {
        await _refreshOperationsPanel();
        await _refreshDiagnosticsPanel();
        if (typeof globalThis.alert === 'function') globalThis.alert('운영 상태를 새로고침했습니다.');
    });

    document.getElementById('cpm-ops-purge-btn')?.addEventListener('click', async () => {
        const first = confirm('Cupcake Provider Manager가 저장한 운영 데이터를 모두 삭제할까요?');
        if (!first) return;
        const second = confirm('이 작업은 되돌릴 수 없습니다. CPM 저장 데이터를 정말 모두 지울까요?');
        if (!second) return;
        try {
            await purgeAllCpmData();
            await _refreshOperationsPanel();
            await _refreshDiagnosticsPanel();
            refreshCmList();
            if (typeof globalThis.alert === 'function') globalThis.alert('CPM 저장 데이터를 모두 정리했습니다. 필요하면 설정 창을 다시 열어 상태를 확인하세요.');
        } catch (error) {
            console.warn('[CPM][ops] purge failed', error);
            if (typeof globalThis.alert === 'function') globalThis.alert(`CPM 저장 데이터 정리에 실패했습니다: ${error?.message || String(error)}`);
        }
    });

    void _refreshOperationsPanel();

    // ─── COPILOT TOKEN MANAGEMENT UI ───
    const _copilotResultEl = document.getElementById('cpm-copilot-result');
    const _copilotShowResult = (html) => { _copilotResultEl.classList.remove('hidden'); _copilotResultEl.innerHTML = html; _copilotResultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    const _copilotShowLoading = (msg = '처리 중...') => _copilotShowResult(`<div class="bg-gray-800 border border-gray-700 rounded-lg p-6 text-center"><div class="text-2xl mb-2">⏳</div><div class="text-gray-400">${msg}</div></div>`);
    const _copilotShowError = (msg) => _copilotShowResult(`<div class="bg-red-950 border border-red-800 rounded-lg p-4 text-red-300"><strong>❌ 오류:</strong> ${escAttr(msg)}</div>`);
    const _copilotShowSuccess = (html) => _copilotShowResult(`<div class="bg-green-950 border border-green-800 rounded-lg p-4 text-green-300">${html}</div>`);
    const _copilotRefreshDisplay = async () => {
        const el = document.getElementById('cpm-copilot-token-display');
        if (el) el.textContent = _maskToken(await _getCopilotToken());
    };
    const _copilotFormatResetDate = (value) => {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? escAttr(value) : date.toLocaleString('ko-KR');
    };
    const _copilotQuotaLabel = (item) => String(item?.name || item?.type || item?.key || 'quota').replace(/_/g, ' ');
    const _copilotRenderQuotaResult = (q) => {
        const planLabels = { copilot_for_individuals_subscriber: 'Copilot Individual', copilot_for_individuals_pro_subscriber: 'Copilot Pro', plus_monthly_subscriber_quota: 'Copilot Pro+ (월간)', plus_yearly_subscriber_quota: 'Copilot Pro+ (연간)' };
        let html = `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">📊 구독 플랜</h4><div class="bg-gray-900 rounded p-3 text-sm space-y-1"><div><strong>플랜:</strong> ${escAttr(planLabels[q.plan] || q.plan)}</div><div class="text-gray-500 text-xs">SKU: ${escAttr(q.plan || 'unknown')}</div></div></div>`;

        if (q.proxyCacheWarning) {
            html += `<div class="bg-yellow-950 border border-yellow-800 rounded-lg p-4 mb-3 text-yellow-200 text-sm"><div class="font-bold text-yellow-300 mb-1">⚠️ 프록시 캐시 경고</div><div>/copilot_internal/user 응답이 토큰 엔드포인트 형태로 반환되었습니다. 프록시 캐시 영향으로 할당량 정보가 누락될 수 있습니다.</div></div>`;
        }

        const snap = q.quota_snapshots;
        const hasOldQuota = !!snap;
        const hasNewQuota = !!q.limited_user_quotas;
        if (hasOldQuota) {
            if (snap.premium_interactions) {
                const pi = snap.premium_interactions;
                const rem = pi.remaining ?? 0;
                const ent = pi.entitlement ?? 0;
                const used = ent - rem;
                const pct = pi.percent_remaining ?? (ent > 0 ? rem / ent * 100 : 0);
                const clr = pct > 70 ? 'green' : pct > 30 ? 'yellow' : 'red';
                html += `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">🎯 프리미엄 요청 할당량</h4><div class="bg-gray-900 rounded p-3 text-sm text-gray-300"><div class="mb-2 flex items-baseline justify-between"><span><strong>남은 요청:</strong></span><span class="text-${clr}-400 text-xl font-bold">${rem} <span class="text-gray-500 text-xs">/ ${ent}</span></span></div><div class="bg-gray-700 rounded-full h-3 overflow-hidden mb-2"><div class="bg-${clr}-500 h-full rounded-full transition-all" style="width:${Math.min(pct, 100)}%"></div></div><div class="flex justify-between text-xs text-gray-500"><span>사용: ${used}회</span><span>${pct.toFixed(1)}% 남음</span></div>${pi.unlimited ? '<div class="text-green-400 text-xs mt-1 font-bold">♾️ 무제한</div>' : ''}<div class="text-gray-500 text-xs mt-1">초과 허용: ${pi.overage_permitted ? '허용' : '비허용'}</div>${pi.reset_date ? `<div class="text-gray-500 text-xs">리셋: ${_copilotFormatResetDate(pi.reset_date)}</div>` : ''}</div></div>`;
            }

            const otherQuotas = Object.entries(snap).filter(([key]) => key !== 'premium_interactions');
            if (otherQuotas.length > 0) {
                let itemsHtml = '';
                for (const [key, quota] of otherQuotas) {
                    const label = String(key).replace(/_/g, ' ');
                    if (quota?.unlimited) {
                        itemsHtml += `<div class="flex items-center justify-between py-2 border-b border-gray-800 last:border-0"><span class="capitalize text-xs text-gray-300">${escAttr(label)}</span><span class="text-green-400 text-xs font-bold">♾️ 무제한</span></div>`;
                    } else {
                        const rem = quota?.remaining ?? 0;
                        const ent = quota?.entitlement ?? 0;
                        const pct = quota?.percent_remaining ?? (ent > 0 ? rem / ent * 100 : 0);
                        const clr = pct > 70 ? 'green' : pct > 30 ? 'yellow' : 'red';
                        itemsHtml += `<div class="py-2 border-b border-gray-800 last:border-0"><div class="flex justify-between text-xs mb-1"><span class="capitalize text-gray-300">${escAttr(label)}</span><span class="text-${clr}-400">${rem} / ${ent}</span></div><div class="bg-gray-700 rounded-full h-1.5 overflow-hidden"><div class="bg-${clr}-500 h-full rounded-full" style="width:${Math.min(pct, 100)}%"></div></div></div>`;
                    }
                }
                html += `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">📋 기타 할당량</h4><div class="bg-gray-900 rounded p-3">${itemsHtml}</div></div>`;
            }
        } else if (hasNewQuota) {
            const resetDate = q.limited_user_reset_date;
            const luq = q.limited_user_quotas;
            const arr = Array.isArray(luq) ? luq : (typeof luq === 'object' && luq !== null ? Object.entries(luq).map(([k, v]) => ({ name: k, ...(typeof v === 'object' ? v : { value: v }) })) : []);
            if (arr.length > 0) {
                let itemsHtml = '';
                for (const it of arr) {
                    const label = _copilotQuotaLabel(it);
                    const limit = it.limit ?? it.entitlement ?? it.total ?? it.monthly ?? null;
                    const used = it.used ?? it.consumed ?? (limit != null && it.remaining != null ? limit - it.remaining : null);
                    const rem = it.remaining ?? (limit != null && used != null ? limit - used : null);
                    if (it.unlimited === true && !limit) {
                        itemsHtml += `<div class="flex items-center justify-between py-2 border-b border-gray-800 last:border-0"><span class="capitalize text-xs text-gray-300">${escAttr(label)}</span><span class="text-green-400 text-xs font-bold">♾️ 무제한</span></div>`;
                    } else if (limit != null) {
                        const pctRemain = limit > 0 ? (((rem ?? 0) / limit) * 100) : 0;
                        const clr = pctRemain > 70 ? 'green' : pctRemain > 30 ? 'yellow' : 'red';
                        itemsHtml += `<div class="py-2 border-b border-gray-800 last:border-0"><div class="flex justify-between text-xs mb-1"><span class="capitalize text-gray-300">${escAttr(label)}</span><span class="text-${clr}-400">${rem ?? (limit - (used ?? 0))} / ${limit}</span></div><div class="bg-gray-700 rounded-full h-2 overflow-hidden"><div class="bg-${clr}-500 h-full rounded-full" style="width:${Math.min(Math.max(pctRemain, 0), 100)}%"></div></div></div>`;
                    } else {
                        itemsHtml += `<div class="py-2 border-b border-gray-800 last:border-0 text-xs text-gray-400"><span class="capitalize text-gray-300">${escAttr(label)}:</span> <span class="font-mono">${escAttr(JSON.stringify(it))}</span></div>`;
                    }
                }
                html += `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">🎯 할당량 (Limited User Quotas)</h4><div class="bg-gray-900 rounded p-3">${itemsHtml}</div>${resetDate ? `<div class="text-gray-500 text-xs mt-2">리셋: ${_copilotFormatResetDate(resetDate)}</div>` : ''}</div>`;
            } else {
                html += `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">🎯 할당량 (Raw)</h4><pre class="bg-gray-900 rounded p-3 font-mono text-xs text-gray-500 max-h-64 overflow-auto whitespace-pre-wrap break-all">${escAttr(JSON.stringify(luq, null, 2))}</pre>${resetDate ? `<div class="text-gray-500 text-xs mt-2">리셋: ${_copilotFormatResetDate(resetDate)}</div>` : ''}</div>`;
            }
        } else {
            html += `<div class="bg-yellow-950 border border-yellow-800 rounded-lg p-4 mb-3 text-yellow-200 text-sm"><h4 class="font-bold text-yellow-300 mb-2">⚠️ 할당량 정보 없음</h4><p class="mb-1">Copilot 할당량 정보를 가져오지 못했습니다.</p><p class="text-yellow-400 text-xs">이 플랜에서 할당량 API를 지원하지 않거나 토큰 권한이 부족할 수 있습니다. <a href="https://github.com/settings/copilot" target="_blank" class="text-blue-400 underline">GitHub 설정</a>에서 확인하세요.</p></div>`;
        }

        if (q.token_meta && Object.keys(q.token_meta).length > 0) {
            const boolFeatures = [];
            const otherFields = {};
            for (const [k, v] of Object.entries(q.token_meta)) {
                if (typeof v === 'boolean') boolFeatures.push({ key: k, enabled: v });
                else if (k === 'expires_at') otherFields[k] = new Date(v * 1000).toLocaleString('ko-KR');
                else if (k === 'refresh_in') otherFields[k] = `${v}초`;
                else otherFields[k] = v;
            }
            let detailsHtml = '';
            if (boolFeatures.length > 0) {
                detailsHtml += `<div class="grid grid-cols-2 gap-1 mb-2">${boolFeatures.map((feature) => `<div class="text-xs"><span class="${feature.enabled ? 'text-green-400' : 'text-gray-600'}">${feature.enabled ? '✅' : '❌'}</span> ${escAttr(feature.key)}</div>`).join('')}</div>`;
            }
            if (Object.keys(otherFields).length > 0) {
                detailsHtml += `<pre class="text-xs text-gray-400 font-mono whitespace-pre-wrap mt-2">${escAttr(JSON.stringify(otherFields, null, 2))}</pre>`;
            }
            html += `<details class="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden mb-3"><summary class="cursor-pointer p-4 font-semibold text-gray-300 text-sm">🔧 토큰 기능 상세</summary><div class="px-4 pb-4">${detailsHtml}</div></details>`;
        }

        if (q.copilot_user) {
            html += `<details class="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden"><summary class="cursor-pointer p-4 font-semibold text-gray-300 text-sm">🔍 API 원본 응답</summary><pre class="px-4 pb-4 font-mono text-xs text-gray-500 max-h-64 overflow-auto whitespace-pre-wrap break-all">${escAttr(JSON.stringify(q.copilot_user, null, 2))}</pre></details>`;
        }

        return html;
    };
    _copilotRefreshDisplay();

    document.getElementById('cpm-copilot-copy').addEventListener('click', async () => {
        const t = await _getCopilotToken();
        if (!t) { alert('토큰 없음'); return; }
        try { await navigator.clipboard.writeText(t); } catch { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        alert('토큰이 복사되었습니다.');
    });
    document.getElementById('cpm-copilot-save').addEventListener('click', async () => {
        const inp = /** @type {HTMLInputElement} */ (document.getElementById('cpm-copilot-manual'));
        if (!inp || !inp.value.trim()) { alert('토큰을 입력하세요.'); return; }
        _setCopilotToken(inp.value.trim()); inp.value = '';
        await _copilotRefreshDisplay();
        _copilotShowSuccess('<strong>✅</strong> 직접 입력한 토큰이 저장되었습니다.');
    });
    document.getElementById('cpm-copilot-gen').addEventListener('click', async () => {
        try {
            _copilotShowLoading('GitHub 디바이스 코드 요청 중...');
            const dc = await _copilotRequestDeviceCode();
            _copilotResultEl.classList.add('hidden');
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 bg-black/60 flex items-center justify-center z-[10000] p-4';
            overlay.innerHTML = `<div class="bg-gray-800 border border-gray-700 rounded-xl max-w-md w-full overflow-hidden">
                <div class="flex items-center justify-between p-4 border-b border-gray-700"><h3 class="text-white font-bold text-base">🔑 GitHub Copilot 토큰 생성</h3><button class="text-gray-400 hover:text-white text-xl px-2" id="dc-close">✕</button></div>
                <div class="p-5 space-y-4">
                    <div class="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-3">
                        <div class="flex items-start gap-3"><span class="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0">1</span><span class="text-sm text-gray-300">GitHub 로그인 → <a href="https://github.com/login/device" target="_blank" class="text-blue-400 underline">https://github.com/login/device</a></span></div>
                        <div class="flex items-start gap-3"><span class="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0">2</span><div class="flex-1"><span class="text-sm text-gray-300">아래 코드 입력:</span><div class="flex items-center justify-between bg-gray-700 rounded p-3 mt-2"><span class="font-mono text-xl font-bold text-white tracking-widest">${escAttr(dc.user_code)}</span><button class="bg-gray-600 hover:bg-gray-500 text-white text-xs px-3 py-1 rounded" id="dc-copy">복사</button></div></div></div>
                        <div class="flex items-start gap-3"><span class="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0">3</span><span class="text-sm text-gray-300">GitHub 계정으로 인증</span></div>
                    </div>
                    <p class="text-gray-500 text-sm text-center">인증 완료 후 확인 버튼 클릭</p>
                    <div class="flex justify-end gap-2"><button class="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded text-sm" id="dc-cancel">취소</button><button class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded text-sm font-bold" id="dc-confirm">확인</button></div>
                </div>
            </div>`;
            document.body.appendChild(overlay);
            /** @type {HTMLElement} */ (overlay.querySelector('#dc-close')).onclick = () => overlay.remove();
            /** @type {HTMLElement} */ (overlay.querySelector('#dc-cancel')).onclick = () => overlay.remove();
            /** @type {HTMLElement} */ (overlay.querySelector('#dc-copy')).onclick = () => { try { navigator.clipboard.writeText(dc.user_code); } catch {} };
            const mConfirmBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('#dc-confirm'));
            mConfirmBtn.onclick = async function () {
                mConfirmBtn.disabled = true; mConfirmBtn.textContent = '확인 중...';
                try {
                    const at = await _copilotExchangeAccessToken(dc.device_code);
                    _setCopilotToken(at); overlay.remove(); await _copilotRefreshDisplay();
                    _copilotShowSuccess('<strong>✅ 성공!</strong> 토큰이 생성 및 저장되었습니다.');
                } catch (e) { mConfirmBtn.disabled = false; mConfirmBtn.textContent = '확인'; alert(e.message); }
            };
        } catch (e) { _copilotShowError(e.message); }
    });
    document.getElementById('cpm-copilot-verify').addEventListener('click', async () => {
        const t = await _getCopilotToken();
        if (!t) { _copilotShowError('토큰 없음. 먼저 생성하세요.'); return; }
        _copilotShowLoading('토큰 상태 확인 중...');
        try {
            const d = await _copilotCheckTokenStatus(t);
            const sku = d.sku || '알 수 없음';
            const exp = d.expires_at ? new Date(d.expires_at * 1000).toLocaleString('ko-KR') : '알 수 없음';
            const feats = Object.entries(d).filter(([, v]) => typeof v === 'boolean' && v).map(([k]) => k);
            const ci = '<span class="text-green-400">✓</span>', xi = '<span class="text-red-400">✗</span>';
            let html = `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">구독 정보</h4>
                <div class="bg-gray-900 rounded p-3 text-sm space-y-1">
                    <div>${sku.includes('subscriber') ? ci : xi} <strong>구독:</strong> ${escAttr(sku)}</div>
                    <div>${d.telemetry === 'disabled' ? ci : xi} <strong>텔레메트리:</strong> ${escAttr(d.telemetry || '?')}</div>
                    <div class="text-gray-500 text-xs mt-1">만료: ${exp}</div>
                </div></div>`;
            if (feats.length > 0) html += `<div class="bg-gray-800 border border-gray-700 rounded-lg p-4"><h4 class="font-bold text-blue-400 mb-2">활성 기능 (${feats.length})</h4><div class="bg-gray-900 rounded p-3 text-xs space-y-0.5">${feats.map(f => `<div>${ci} ${escAttr(f)}</div>`).join('')}</div></div>`;
            _copilotShowResult(html);
        } catch (e) { _copilotShowError(e.message); }
    });
    document.getElementById('cpm-copilot-remove').addEventListener('click', async () => {
        const t = await _getCopilotToken();
        if (!t) { alert('이미 토큰 없음'); return; }
        if (!confirm('토큰을 제거하시겠습니까?')) return;
        _setCopilotToken(''); await _copilotRefreshDisplay();
        _copilotShowResult(`<div class="bg-yellow-950 border border-yellow-800 rounded-lg p-4 text-yellow-300"><strong>🗑️ 토큰 제거 완료.</strong></div>`);
    });
    document.getElementById('cpm-copilot-models').addEventListener('click', async () => {
        const t = await _getCopilotToken();
        if (!t) { _copilotShowError('토큰 없음'); return; }
        _copilotShowLoading('모델 목록 조회 중...');
        try {
            const d = await _copilotFetchModelList(t);
            const ids = (d.data || []).map(m => m.id);
            _copilotShowResult(`<div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-3"><h4 class="font-bold text-blue-400 mb-2">사용 가능한 모델 (${ids.length}개)</h4>
                <div class="bg-gray-900 rounded p-3 font-mono text-xs max-h-48 overflow-y-auto space-y-0.5">${ids.map(id => `<div class="py-0.5 border-b border-gray-800">${escAttr(id)}</div>`).join('')}</div></div>
                <details class="bg-gray-800 border border-gray-700 rounded-lg"><summary class="cursor-pointer p-4 font-semibold text-gray-300 text-sm">원본 JSON</summary><pre class="px-4 pb-4 font-mono text-xs text-gray-500 max-h-64 overflow-auto whitespace-pre-wrap break-all">${escAttr(JSON.stringify(d, null, 2))}</pre></details>`);
        } catch (e) { _copilotShowError(e.message); }
    });
    document.getElementById('cpm-copilot-quota').addEventListener('click', async () => {
        const t = await _getCopilotToken();
        if (!t) { _copilotShowError('토큰 없음'); return; }
        _copilotShowLoading('할당량 조회 중...');
        try {
            const q = await _copilotCheckQuota(t);
            _copilotShowResult(_copilotRenderQuotaResult(q));
        } catch (e) { _copilotShowError(e.message); }
    });
    document.getElementById('cpm-copilot-info').addEventListener('click', () => {
        _copilotShowResult(`<div class="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <h4 class="font-bold text-blue-400 mb-3">ℹ️ Copilot 커스텀 모델 설정 안내</h4>
            <div class="bg-gray-900 rounded p-4 text-sm space-y-2 leading-relaxed">
                <p>이 탭에서 토큰을 생성한 후, <strong>Custom Models Manager</strong> 탭에서 커스텀 모델을 추가하세요:</p>
                <div class="bg-gray-800 border border-gray-600 rounded p-3 font-mono text-xs space-y-1">
                    <div><strong>이름:</strong> 🤖 Copilot GPT-4.1</div>
                    <div><strong>URL:</strong> https://api.githubcopilot.com/chat/completions</div>
                    <div><strong>모델:</strong> gpt-4.1</div>
                    <div><strong>Key:</strong> (비워두세요 — 자동 갱신)</div>
                    <div><strong>포맷:</strong> openai</div>
                </div>
                <p class="text-yellow-400 text-xs">💡 Copilot URL이 감지되면 자동으로 토큰이 교환·설정됩니다. API Key를 비워두세요.</p>
            </div>
        </div>`);
    });

    // ─── EXPORT / IMPORT / CLOSE ───
    document.getElementById('cpm-export-btn').addEventListener('click', async () => {
        const keys = SettingsBackup.getAllKeys();
        const exportSettings = {};
        for (const key of keys) {
            const val = await safeGetArg(key);
            if (val !== undefined && val !== '') exportSettings[key] = normalizeManagedSettingValue(key, val);
        }
        const pluginStorageSnapshot = await exportPluginStorageSnapshot();
        const runtimeMeta = await _collectRuntimeMetadata('settings-export');
        const exportData = {
            _cpmExportVersion: CPM_EXPORT_VERSION,
            metadata: {
                ...runtimeMeta,
                exportedSettingKeyCount: Object.keys(exportSettings).length,
                exportedPluginStorageKeyCount: Object.keys(pluginStorageSnapshot).length,
                hasCustomModels: Object.prototype.hasOwnProperty.call(exportSettings, 'cpm_custom_models'),
            },
            settings: exportSettings,
            pluginStorage: pluginStorageSnapshot,
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
        const a = document.createElement('a');
        a.href = dataStr; a.download = 'cupcake_pm_settings.json';
        document.body.appendChild(a); a.click(); a.remove();
    });

    document.getElementById('cpm-import-btn').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = e => {
            const file = /** @type {HTMLInputElement} */ (e.target).files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(/** @type {string} */ (event.target.result));
                    const envelope = normalizeImportEnvelope(data);
                    for (const [key, value] of Object.entries(envelope.settings)) {
                        const normalizedValue = normalizeManagedSettingValue(key, value);
                        setVal(key, normalizedValue);
                        const el = /** @type {HTMLInputElement} */ (document.getElementById(key));
                        if (el) { el.type === 'checkbox' ? (el.checked = parseUiBool(normalizedValue)) : (el.value = normalizedValue); }
                    }
                    await importPluginStorageSnapshot(envelope.pluginStorage);
                    await refreshRuntimeStatusPanels();
                    const importedMetaSummary = envelope.metadata?.generatedAt
                        ? `\n내보낸 시각: ${envelope.metadata.generatedAt}`
                        : '';
                    const importedVersionSummary = envelope.exportVersion
                        ? ` (포맷 v${envelope.exportVersion})`
                        : '';
                    if (typeof globalThis.alert === 'function') globalThis.alert(`설정을 성공적으로 불러왔습니다${importedVersionSummary}!${importedMetaSummary}`);
                    openCpmSettings();
                } catch (err) { if (typeof globalThis.alert === 'function') globalThis.alert('설정 파일 오류: ' + err.message); }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    document.getElementById('cpm-close-btn').addEventListener('click', () => {
        document.body.innerHTML = '';
        Risu.hideContainer();
    });

    await refreshRuntimeStatusPanels();

    // Take snapshot
    await SettingsBackup.snapshotAll();
}

function persistCustomModels() {
    try {
        const json = serializeCustomModelsSetting(CUSTOM_MODELS_CACHE, { includeKey: true });
        setArg('cpm_custom_models', json);
        SettingsBackup.updateKey('cpm_custom_models', json);
    } catch (e) { console.error('[CPM] Failed to save custom models:', e); }
}


// ==========================================
// MAIN INIT
// ==========================================
(async () => {
    /** @type {string} Boot phase tracker for diagnostics */
    let _bootPhase = 'pre-init';
    /** @type {string[]} Completed phases log */
    const _completedPhases = [];
    /** @type {string[]} Failed phases log */
    const _failedPhases = [];
    let _modelRegCount = 0;

    const _phaseStart = (/** @type {string} */ phase) => { _bootPhase = phase; };
    const _phaseDone = (/** @type {string} */ phase) => { _completedPhases.push(phase); };
    const _phaseFail = (/** @type {string} */ phase, /** @type {any} */ err) => {
        _failedPhases.push(`${phase}: ${err?.message || err}`);
        console.error(`[CPM] Phase '${phase}' failed (continuing):`, err?.message || err);
    };

    // ══════════════════════════════════════════════════════════════════
    //  CRITICAL FIRST: Register settings panel IMMEDIATELY.
    //  This MUST happen before any model registration, IPC setup,
    //  custom model loading, or anything else.
    //  If later init steps fail, the "🧁" menu entry still exists
    //  and users can still open CPM settings to diagnose/reconfigure.
    //  (Migrated from _temp_repo/init.js boot order — crash defense)
    // ══════════════════════════════════════════════════════════════════
    let _settingsRegistered = false;
    try {
        _phaseStart('register-settings');
        await Risu.registerSetting(
            `v${CPM_VERSION}`,
            openCpmSettings,
            '🧁',
            'html',
        );
        _settingsRegistered = true;
        _phaseDone('register-settings');
        console.log(`[CPM] ✓ Settings panel registered (v${CPM_VERSION})`);
    } catch (e) {
        _phaseFail('register-settings', e);
    }

    try {
        console.log(`[CPM] Cupcake Provider Manager v${CPM_VERSION} (IPC Mode) initializing...`);

        // ── Phase: Restore Settings Backup ──
        _phaseStart('settings-restore');
        try {
            await SettingsBackup.load();
            const restoredCount = await SettingsBackup.restoreIfEmpty();
            if (restoredCount > 0) console.log(`[CPM] Restored ${restoredCount} settings from backup`);
            _phaseDone('settings-restore');
        } catch (e) { _phaseFail('settings-restore', e); }

        // ── Phase: Copilot Version Overrides ──
        _phaseStart('copilot-version-overrides');
        try {
            const userChatVer = await safeGetArg('cpm_copilot_chat_version', '');
            const userCodeVer = await safeGetArg('cpm_copilot_vscode_version', '');
            setCopilotVersionOverrides({ chatVersion: userChatVer, vscodeVersion: userCodeVer });
            if (userChatVer || userCodeVer) {
                console.log(`[CPM] Copilot version overrides applied — chat: ${userChatVer || '(default)'}, vscode: ${userCodeVer || '(default)'}`);
            }
            _phaseDone('copilot-version-overrides');
        } catch (e) { _phaseFail('copilot-version-overrides', e); }

        // ── Phase: Streaming Bridge Capability Check ──
        _phaseStart('streaming-check');
        try {
            const streamCapable = await checkStreamCapability();
            const streamEnabled = await safeGetBoolArg('cpm_streaming_enabled', false);
            const compatMode = await safeGetBoolArg('cpm_compatibility_mode', false);

            if (compatMode) {
                console.log('[CPM] 🔧 Compatibility mode: ENABLED (nativeFetch skipped + streaming forced OFF).');
            } else if (!streamCapable) {
                console.log('[CPM] 🔧 Compatibility mode: AUTO-ACTIVE (bridge cannot transfer ReadableStream).');
            }

            if (streamEnabled) {
                if (compatMode || !streamCapable) {
                    console.warn('[CPM] 🔄 Streaming: enabled but OVERRIDDEN by compatibility mode.');
                } else {
                    console.log('[CPM] 🔄 Streaming: enabled AND bridge capable.');
                }
            } else {
                console.log(`[CPM] 🔄 Streaming: disabled (bridge ${streamCapable ? 'capable' : 'not capable'}).`);
            }
            _phaseDone('streaming-check');
        } catch (e) { _phaseFail('streaming-check', e); }

        // ── Phase: Custom Models Migration (includes C1-C9 backward compat) ──
        _phaseStart('custom-models');
        try {
            const raw = await safeGetArg('cpm_custom_models', '[]');
            const parsed = parseCustomModelsValue(raw);
            if (parsed.length > 0) {
                CUSTOM_MODELS_CACHE.push(...parsed.map((m) => {
                    const normalized = normalizeCustomModel(m, { includeKey: true, includeUniqueId: true });
                    if (!normalized.uniqueId) {
                        normalized.uniqueId = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                    }
                    return normalized;
                }));
            } else {
                try {
                    const single = JSON.parse(raw);
                    if (single && typeof single === 'object' && !Array.isArray(single)) {
                        const normalized = normalizeCustomModel(single, { includeKey: true, includeUniqueId: true });
                        if (!normalized.uniqueId) {
                            normalized.uniqueId = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                        }
                        CUSTOM_MODELS_CACHE.push(normalized);
                        console.warn('[CPM] cpm_custom_models was a single object; migrated to array in memory');
                    }
                } catch (_) { /* raw wasn't valid single-object JSON either */ }
            }

            // ── Backward Compatibility: Auto-Migrate from C1-C9 to JSON ──
            // (Migrated from _temp_repo/init.js — users upgrading from old CPM
            //  had individual cpm_c{1-9}_url/model/key/... settings that must be
            //  converted to the JSON cpm_custom_models array format.)
            if (CUSTOM_MODELS_CACHE.length === 0) {
                let migrated = false;
                for (let i = 1; i <= 9; i++) {
                    const legacyUrl = await safeGetArg(`cpm_c${i}_url`);
                    const legacyModel = await safeGetArg(`cpm_c${i}_model`);
                    const legacyKey = await safeGetArg(`cpm_c${i}_key`);
                    if (!legacyUrl && !legacyModel && !legacyKey) continue;
                    CUSTOM_MODELS_CACHE.push({
                        uniqueId: `custom${i}`,
                        name: await safeGetArg(`cpm_c${i}_name`) || `Custom ${i}`,
                        model: legacyModel || '',
                        url: legacyUrl || '',
                        key: legacyKey || '',
                        format: await safeGetArg(`cpm_c${i}_format`) || 'openai',
                        sysfirst: await safeGetBoolArg(`cpm_c${i}_sysfirst`),
                        altrole: await safeGetBoolArg(`cpm_c${i}_altrole`),
                        mustuser: await safeGetBoolArg(`cpm_c${i}_mustuser`),
                        maxout: await safeGetBoolArg(`cpm_c${i}_maxout`),
                        mergesys: await safeGetBoolArg(`cpm_c${i}_mergesys`),
                        decoupled: await safeGetBoolArg(`cpm_c${i}_decoupled`),
                        thought: await safeGetBoolArg(`cpm_c${i}_thought`),
                        reasoning: await safeGetArg(`cpm_c${i}_reasoning`) || 'none',
                        verbosity: await safeGetArg(`cpm_c${i}_verbosity`) || 'none',
                        thinking: await safeGetArg(`cpm_c${i}_thinking`) || 'none',
                        responsesMode: 'auto',
                        tok: await safeGetArg(`cpm_c${i}_tok`) || 'o200k_base',
                        customParams: '',
                    });
                    migrated = true;
                }
                if (migrated) {
                    try {
                        const migratedJson = JSON.stringify(CUSTOM_MODELS_CACHE);
                        await setArg('cpm_custom_models', migratedJson);
                        SettingsBackup.updateKey('cpm_custom_models', migratedJson);
                        console.log(`[CPM] ✓ Migrated ${CUSTOM_MODELS_CACHE.length} legacy C1-C9 models to JSON format`);
                    } catch (me) { console.warn('[CPM] C1-C9 migration save failed:', me); }
                }
            }

            for (const m of CUSTOM_MODELS_CACHE) {
                ALL_DEFINED_MODELS.push({ uniqueId: m.uniqueId, id: m.model, name: m.name || m.uniqueId, provider: 'Custom' });
            }

            // Diagnostic: log proxyUrl state for all custom models at boot
            if (CUSTOM_MODELS_CACHE.length > 0) {
                const proxyInfo = CUSTOM_MODELS_CACHE.map((m) =>
                    `${m.name||m.uniqueId}: proxyUrl=${m.proxyUrl ? `"${m.proxyUrl}"` : '(empty)'}`
                ).join(', ');
                console.log(`[CPM] Custom models loaded (${CUSTOM_MODELS_CACHE.length}): ${proxyInfo}`);
            }
            _phaseDone('custom-models');
        } catch (e) { _phaseFail('custom-models', e); }

        // ── Phase: IPC Channel Setup ──
        _phaseStart('ipc-setup');
        // IPC 리스너 설정 (반드시 addProvider 전에!)
        setupControlChannel();
        setupResponseListener();
        setupChannelCleanup(Risu, [CH.CONTROL, CH.RESPONSE]);

        // 서브플러그인 초기 등록 대기 (프로바이더 재시도 주기: 500ms~)
        // 대부분 1초 내 등록 완료, late registration도 지원하므로 짧게
        await new Promise(r => setTimeout(r, 1000));
        _phaseDone('ipc-setup');

        console.log(`[CPM] ${registeredProviders.size} providers registered, ${ALL_DEFINED_MODELS.length} models total`);

        ALL_DEFINED_MODELS.sort((a, b) => {
            const p = a.provider.localeCompare(b.provider);
            return p !== 0 ? p : a.name.localeCompare(b.name);
        });

        // ── Phase: Model Registration with RisuAI ──
        _phaseStart('model-registration');
        try {
            for (const modelDef of ALL_DEFINED_MODELS) {
                await registerModelWithRisu(modelDef);
                _modelRegCount++;
            }
            managerReady = true;
            _phaseDone('model-registration');
        } catch (regErr) {
            _phaseFail('model-registration', regErr);
            console.error(`[CPM] Model registration stopped at ${_modelRegCount}/${ALL_DEFINED_MODELS.length}`);
        }

        // ── Phase: Keyboard Shortcut + Touch Gesture ──
        // (Migrated from _temp_repo/init.js — includes handler cleanup on re-init)
        _phaseStart('hotkey-registration');
        try {
            const rootDoc = await Risu.getRootDocument();
            if (rootDoc) {
                // Remove previously registered handlers to prevent double-firing on re-init
                if (typeof globalThis !== 'undefined') {
                    const g = /** @type {any} */ (globalThis);
                    if (g._cpmKeydownHandler) {
                        try { await rootDoc.removeEventListener('keydown', g._cpmKeydownHandler); } catch (_) {}
                    }
                    if (g._cpmAddPointerHandler) {
                        try { await rootDoc.removeEventListener('pointerdown', g._cpmAddPointerHandler); } catch (_) {}
                        try { await rootDoc.removeEventListener('pointerup', g._cpmRemovePointerHandler); } catch (_) {}
                        try { await rootDoc.removeEventListener('pointercancel', g._cpmRemovePointerHandler); } catch (_) {}
                    }
                }

                const _keydownHandler = (/** @type {any} */ e) => {
                    if (e.ctrlKey && e.shiftKey && e.altKey && (e.key === 'p' || e.key === 'P')) openCpmSettings();
                };
                await rootDoc.addEventListener('keydown', _keydownHandler);

                // 4-finger touch gesture for mobile
                let activePointers = 0;
                /** @type {ReturnType<typeof setTimeout> | null} */
                let pointerTimer = null;
                const addPointer = () => {
                    activePointers++;
                    if (activePointers >= 4) { openCpmSettings(); activePointers = 0; }
                    if (pointerTimer) clearTimeout(pointerTimer);
                    pointerTimer = setTimeout(() => { activePointers = 0; }, 500);
                };
                const removePointer = () => { activePointers = Math.max(0, activePointers - 1); };

                await rootDoc.addEventListener('pointerdown', addPointer);
                await rootDoc.addEventListener('pointerup', removePointer);
                await rootDoc.addEventListener('pointercancel', removePointer);

                // Store handler references for cleanup on re-init
                if (typeof globalThis !== 'undefined') {
                    const g = /** @type {any} */ (globalThis);
                    g._cpmKeydownHandler = _keydownHandler;
                    g._cpmAddPointerHandler = addPointer;
                    g._cpmRemovePointerHandler = removePointer;
                }
            }
            _phaseDone('hotkey-registration');
        } catch (err) {
            _phaseFail('hotkey-registration', err);
        }

        // 초기 백업
        await SettingsBackup.snapshotAll();

        // ── Phase: Auto-updater ──
        _phaseStart('auto-updater');
        try { await AutoUpdater.retryPendingUpdateOnBoot(); } catch (e) { console.warn('[CPM] Boot retry failed:', e); }
        // Auto-updater: background version check (non-blocking)
        AutoUpdater.checkVersionsQuiet().catch(() => {});
        // JS fallback version check (10s delay to avoid fetch contention)
        setTimeout(() => { AutoUpdater.checkMainPluginVersionQuiet().catch(() => {}); }, 10000);
        _phaseDone('auto-updater');

        // ── Boot Summary ──
        if (_failedPhases.length > 0) {
            console.warn(`[CPM] Boot completed with ${_failedPhases.length} warning(s):`, _failedPhases);
        }
        console.log(`[CPM] ✓ Boot complete — ${_completedPhases.length} phases OK, ${_failedPhases.length} failed, ${_modelRegCount} models registered.`);

        // Record boot health for diagnostics (migrated from _temp_repo/init.js)
        try {
            await Risu.pluginStorage.setItem('cpm_last_boot_status', JSON.stringify({
                ts: Date.now(), version: CPM_VERSION,
                ok: _completedPhases, fail: _failedPhases,
                models: _modelRegCount, settingsOk: _settingsRegistered,
            }));
        } catch (_) { /* pluginStorage may not be available */ }

    } catch (e) {
        const _errAny = /** @type {any} */ (e);
        console.error(`[CPM] Unexpected init fail at phase '${_bootPhase}':`, e);
        console.error(`[CPM] Completed phases before crash:`, _completedPhases);

        // FALLBACK: If settings weren't registered earlier, try one more time
        if (!_settingsRegistered) {
            try {
                await Risu.registerSetting(
                    `⚠️ CPM v${CPM_VERSION} (Error)`,
                    async () => {
                        const rootDoc = await Risu.getRootDocument();
                        const body = await rootDoc.querySelector('body');
                        const errorPanel = await rootDoc.createElement('div');
                        await errorPanel.setStyleAttribute('position:fixed;top:0;left:0;right:0;bottom:0;background:#1a1a2e;color:#fff;padding:40px;font-family:sans-serif;z-index:99999;overflow:auto;');
                        const errorText = String(_errAny && _errAny.stack ? _errAny.stack : _errAny).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        await errorPanel.setInnerHTML(`
                            <h1 style="color:#ff6b6b;">🧁 Cupcake PM — Initialization Error</h1>
                            <p style="color:#ccc;margin:20px 0;">The plugin failed to initialize properly.</p>
                            <p style="color:#aaa;">Failed at phase: <code>${_bootPhase}</code></p>
                            <p style="color:#aaa;">Completed: ${_completedPhases.join(', ') || 'none'}</p>
                            <pre style="background:#0d1117;color:#ff7b72;padding:16px;border-radius:8px;overflow:auto;max-height:300px;font-size:13px;">${errorText}</pre>
                            <p style="color:#aaa;margin-top:20px;">Try: reload (Ctrl+Shift+R) or re-import the plugin.</p>
                        `);
                        await body.appendChild(errorPanel);
                    },
                    '🧁',
                    'html',
                );
            } catch { /* Last resort — settings were already registered above in most cases */ }
        }

        // Record failed boot status
        try {
            await Risu.pluginStorage.setItem('cpm_last_boot_status', JSON.stringify({
                ts: Date.now(), version: CPM_VERSION,
                ok: _completedPhases, fail: [..._failedPhases, `FATAL:${_bootPhase}: ${_errAny?.message || _errAny}`],
                models: _modelRegCount, settingsOk: _settingsRegistered,
            }));
        } catch (_) { /* ignore */ }
    }
})();
