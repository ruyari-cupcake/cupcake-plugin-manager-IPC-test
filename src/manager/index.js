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

import { MANAGER_NAME, CH, MSG, safeUUID, getRisu } from '../shared/ipc-protocol.js';
import { safeGetArg, safeGetBoolArg, setArg, safeStringify, smartFetch, streamingFetch, collectStream, checkStreamCapability } from '../shared/helpers.js';
import { formatToOpenAI, formatToAnthropic, formatToGemini } from '../shared/message-format.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { getGeminiSafetySettings, buildGeminiThinkingConfig, validateGeminiParams, cleanExperimentalModelParams } from '../shared/gemini-helpers.js';
import { parseClaudeNonStreamingResponse, parseGeminiNonStreamingResponse, createSSEStream, createOpenAISSEStream, createAnthropicSSEStream, createResponsesAPISSEStream, parseOpenAISSELine, parseGeminiSSELine, parseOpenAINonStreamingResponse, parseResponsesAPINonStreamingResponse, normalizeOpenAIMessageContent, saveThoughtSignatureFromStream, ThoughtSignatureCache } from '../shared/sse-parser.js';
import { KeyPool } from '../shared/key-pool.js';
import { _normalizeTokenUsage, _setTokenUsage, _takeTokenUsage } from '../shared/token-usage.js';
import { showTokenToast } from '../shared/token-toast.js';
import { supportsOpenAIReasoningEffort, needsCopilotResponsesAPI, shouldStripOpenAISamplingParams, shouldStripGPT54SamplingForReasoning, needsMaxCompletionTokens } from '../shared/model-helpers.js';
import { mergeDynamicModels } from '../shared/dynamic-models.js';
import { ensureCopilotApiToken, getCopilotApiBase } from '../shared/copilot-token.js';
import { storeApiRequest, getAllApiRequests, getApiRequestById, clearApiRequests, updateApiRequest } from '../shared/api-request-log.js';
import { createSettingsBackup } from '../shared/settings-backup.js';
import { COPILOT_CHAT_VERSION, VSCODE_VERSION, getCopilotStaticHeaders } from '../shared/copilot-headers.js';
import { VERSIONS_URL, MAIN_UPDATE_URL, UPDATE_BUNDLE_URL } from '../shared/endpoints.js';
import { createUpdateToast } from '../shared/update-toast.js';
import { createAutoUpdater } from '../shared/auto-updater.js';
import { parseCustomModelsValue, normalizeCustomModel, serializeCustomModelsSetting } from '../shared/custom-model-serialization.js';
import { TAILWIND_CSS } from '../shared/tailwind-css.generated.js';

const CPM_VERSION = '2.0.0';
const Risu = getRisu();

// ==========================================
// STATE
// ==========================================
const registeredProviders = new Map();  // providerName → { pluginName, models, settingsFields }
const ALL_DEFINED_MODELS = [];
const CUSTOM_MODELS_CACHE = [];
const pendingRequests = new Map();      // requestId → { resolve, timer }
const pendingControlRequests = new Map(); // requestId → { resolve, timer }
const registeredModelKeys = new Set();
const CPM_SLOT_LIST = ['translation', 'emotion', 'memory', 'other'];
let _abortBridgeProbeDone = false;

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
function setupResponseListener() {
    Risu.addPluginChannelListener(CH.RESPONSE, (msg) => {
        if (!msg || !msg.requestId) return;
        const pending = pendingRequests.get(msg.requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        pendingRequests.delete(msg.requestId);

        switch (msg.type) {
            case MSG.RESPONSE:
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
                } catch (_) { /* plugin may already be unloaded */ }
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
                const _chunks = [];
                result.content = result.content.pipeThrough(new TransformStream({
                    transform(chunk, controller) {
                        _chunks.push(chunk);
                        controller.enqueue(chunk);
                    },
                    flush() {
                        const full = _chunks.join('');
                        console.log(`[CPM] ✓ Streamed: ${full.length} chars`);
                        // C-11: 스트림 완료 후 토큰 사용량 토스트 표시
                        if (_requestId) {
                            const usage = _takeTokenUsage(_requestId);
                            if (usage) {
                                try { showTokenToast(usage, activeModelDef.name || activeModelDef.model || ''); } catch {}
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
                try { showTokenToast(usage, activeModelDef.name || activeModelDef.model || ''); } catch {}
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
async function handleCustomModel(modelDef, messages, temp, maxTokens, args) {
    const cDef = CUSTOM_MODELS_CACHE.find(m => m.uniqueId === modelDef.uniqueId);
    if (!cDef) return { success: false, content: '[CPM] Custom model config not found.' };

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
            preserveSystem: sysfirst,
            useThoughtSignature: thought
        });
        formattedMessages = gContents;
        systemPrompt = gSys.length > 0 ? gSys.join('\n\n') : '';
    } else {
        formattedMessages = formatToOpenAI(messages, {
            sysfirst, altrole,
            mustuser, mergesys
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
                if (typeof m.role !== 'string' || !m.role) return false;
                if (m.content === null || m.content === undefined) return false;
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
    const body = {};
    if (format === 'anthropic') {
        body.model = cDef.model;
        body.messages = formattedMessages;
        body.max_tokens = maxTokens || 4096;
        if (temp !== undefined) body.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
        if (systemPrompt) body.system = systemPrompt;

        // Anthropic adaptive effort (4.6) or thinking budget (4.5-)
        // BUG-Q12 FIX: 네이티브 RisuAI의 requestClaude(직접 API)는
        //   thinking 모드에서도 temperature를 삭제하지 않음.
        //   (Bedrock만 temperature=1.0 강제 + top_k/top_p 삭제)
        //   handleCustomModel은 직접 API 경로이므로 temperature 유지.
        const effortRaw = String(cDef.effort || '').trim().toLowerCase();
        const thinkingMode = String(cDef.thinking || '').trim().toLowerCase();
        const useAdaptiveThinking = (effortRaw && effortRaw !== 'none') || thinkingMode === 'adaptive';

        if (useAdaptiveThinking) {
            body.thinking = { type: 'adaptive' };
            let adaptiveEffort = '';
            if (['low', 'medium', 'high', 'max'].includes(effortRaw)) {
                adaptiveEffort = effortRaw;
            } else if (thinkingMode === 'adaptive') {
                adaptiveEffort = 'high';
            }
            if (adaptiveEffort) {
                body.output_config = { effort: adaptiveEffort };
            }
            body.max_tokens = Math.max(body.max_tokens, 16000);
        } else if (thinkingBudget > 0) {
            body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
            body.max_tokens = Math.max(body.max_tokens, thinkingBudget + 4096);
        }
    } else if (format === 'google') {
        body.contents = formattedMessages;
        body.safetySettings = getGeminiSafetySettings();
        const gc = {};
        if (maxTokens) gc.maxOutputTokens = maxTokens;
        if (temp !== undefined) gc.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) gc.topP = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) gc.topK = args.top_k;
        if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) gc.frequencyPenalty = args.frequency_penalty;
        if (args.presence_penalty !== undefined && args.presence_penalty !== null) gc.presencePenalty = args.presence_penalty;

        // Gemini thinking config
        const thinkingLevel = cDef.thinking || '';
        const thinkingConfig = buildGeminiThinkingConfig(cDef.model, thinkingLevel, thinkingBudget, false);
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
            else if (maxout) { body.max_output_tokens = maxTokens; }
            else { body.max_tokens = maxTokens; }
        }
        if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
        if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) body.frequency_penalty = args.frequency_penalty;
        if (args.presence_penalty !== undefined && args.presence_penalty !== null) body.presence_penalty = args.presence_penalty;
        if (args.repetition_penalty !== undefined && args.repetition_penalty !== null) body.repetition_penalty = args.repetition_penalty;
        if (args.min_p !== undefined && args.min_p !== null) body.min_p = args.min_p;

        // Reasoning effort (o3/o1/gpt-5 등) — model-helpers 사용
        const reasoning = cDef.reasoning || '';
        if (reasoning && reasoning !== 'none' && reasoning !== 'off') {
            if (supportsOpenAIReasoningEffort(cDef.model)) {
                body.reasoning_effort = reasoning;
            }
        }

        // GPT-5.4+ reasoning 모델: sampling 파라미터 제거
        if (shouldStripGPT54SamplingForReasoning(cDef.model, reasoning)) {
            delete body.temperature;
            delete body.top_p;
        } else if (shouldStripOpenAISamplingParams(cDef.model)) {
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

    // Custom parameters (추가 JSON) — messages/contents/stream은 오버라이드 불가
    if (cDef.customParams) {
        try {
            const extra = JSON.parse(cDef.customParams);
            if (extra && typeof extra === 'object') {
                delete extra.messages; delete extra.contents; delete extra.stream;
                Object.assign(body, extra);
            }
        } catch { /* ignore malformed JSON */ }
    }

    // URL: 완전한 엔드포인트면 그대로 사용, 불완전하면 포맷별 기본 경로 자동 보완
    let url = buildCustomEndpointUrl(cDef.url, format, cDef.model);

    // Copilot + Anthropic: force canonical endpoint (buildCustomEndpointUrl appends /v1/messages
    // to the user's URL path, but Copilot needs a completely different path)
    if (url.includes('githubcopilot.com') && format === 'anthropic') {
        url = `${_copilotApiBase}/v1/messages`;
    }
    const apiKey = cDef.key || '';

    // Google API key is added to URL inside doFetch (per-key for rotation support)

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && format !== 'google') headers['Authorization'] = `Bearer ${apiKey}`;

    // Copilot auto-detection: if URL is githubcopilot.com, auto-fetch API token + attach Copilot headers
    const isCopilotUrl = url.includes('githubcopilot.com');

    if (format === 'anthropic') {
        if (apiKey) headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        // anthropic-dangerous-direct-browser-access only needed for direct Anthropic API, not Copilot proxy
        if (!isCopilotUrl) {
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
        }
        delete headers['Authorization'];
        const anthropicBetas = [];
        const hasPromptCaching = Array.isArray(body.messages) && body.messages.some(msg =>
            Array.isArray(msg?.content) && msg.content.some(part => part?.cache_control?.type === 'ephemeral')
        );
        if (hasPromptCaching) anthropicBetas.push('prompt-caching-2024-07-31');
        if (body.thinking) anthropicBetas.push('interleaved-thinking-2025-05-14');
        if (anthropicBetas.length > 0) headers['anthropic-beta'] = anthropicBetas.join(',');
    }

    if (isCopilotUrl) {
        const copilotApiToken = await _ensureCopilotApiToken();
        if (copilotApiToken) {
            headers['Authorization'] = `Bearer ${copilotApiToken}`;
        } else {
            console.warn('[CPM] Copilot: No API token available. Request may fail auth. Set token via Copilot Manager.');
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

        // Required Copilot headers (aligned with VS Code Copilot extension)
        headers['Copilot-Integration-Id'] = 'vscode-chat';
        headers['Editor-Plugin-Version'] = 'copilot-chat/0.37.4';
        headers['Editor-Version'] = 'vscode/1.109.2';
        headers['User-Agent'] = 'GitHubCopilotChat/0.37.4';
        headers['Vscode-Machineid'] = _copilotMachineId;
        headers['Vscode-Sessionid'] = _copilotSessionId;
        headers['X-Github-Api-Version'] = '2025-10-01';
        headers['X-Initiator'] = 'user';
        headers['X-Interaction-Id'] = safeUUID();
        headers['X-Interaction-Type'] = 'conversation-panel';
        headers['X-Request-Id'] = safeUUID();
        headers['X-Vscode-User-Agent-Library-Version'] = 'electron-fetch';

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
    const useStreaming = streamingEnabled && perModelStreamingEnabled;

    if (!useStreaming && isCopilotUrl) {
        console.warn('[CPM] Copilot request in non-stream mode. Long responses may return 524 via proxy.');
    }

    // --- Key rotation wrapper ---
    const pool = new KeyPool(apiKey);
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
                        ? streamBody.messages.filter(m => m != null && typeof m === 'object').map(({ name, ...rest }) => rest)
                        : [];
                    delete streamBody.messages;
                }
                // C-5: reasoning_effort → reasoning object
                if (streamBody.reasoning_effort) {
                    streamBody.reasoning = { effort: streamBody.reasoning_effort, summary: 'auto' };
                    delete streamBody.reasoning_effort;
                }
                // Responses API: stream_options / prompt_cache_retention 미지원
                delete streamBody.stream_options;
                delete streamBody.prompt_cache_retention;
            } else {
                // OpenAI-compatible
                streamBody.stream = true;
            }

            const finalBody = sanitizeBodyJSON(safeStringify(streamBody));

            try {
                const res = await streamingFetch(streamUrl, {
                    method: 'POST', headers: reqHeaders, body: finalBody, signal: args._abortSignal
                });

                _logEntry.status = res.status;

                if (!res.ok) {
                    const errText = await res.text();
                    _logEntry.response = errText.substring(0, 2000);
                    return { success: false, content: `[Custom Error ${res.status}] ${errText}`, _status: res.status };
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
                            ? nonStreamBody.messages.filter(m => m != null && typeof m === 'object').map(({ name, ...rest }) => rest)
                            : [];
                        delete nonStreamBody.messages;
                    }
                    // C-5: reasoning_effort → reasoning object
                    if (nonStreamBody.reasoning_effort) {
                        nonStreamBody.reasoning = { effort: nonStreamBody.reasoning_effort, summary: 'auto' };
                        delete nonStreamBody.reasoning_effort;
                    }
                    // Responses API: stream_options / prompt_cache_retention 미지원
                    delete nonStreamBody.stream_options;
                    delete nonStreamBody.prompt_cache_retention;
                }
                const finalBody = sanitizeBodyJSON(safeStringify(nonStreamBody));
                let fetchUrl = url;
                if (useResponsesAPI) {
                    fetchUrl = url.replace(/\/chat\/completions$/i, '/responses');
                }
                if (format === 'google' && currentKey) {
                    const sep = fetchUrl.includes('?') ? '&' : '?';
                    fetchUrl += `${sep}key=${encodeURIComponent(currentKey)}`;
                }
                const res = await smartFetch(fetchUrl, {
                    method: 'POST', headers: reqHeaders, body: finalBody, signal: args._abortSignal
                });
                if (!res.ok) {
                    const errText = await res.text();
                    _logEntry.status = res.status;
                    _logEntry.response = errText.substring(0, 2000);
                    return { success: false, content: `[Custom Error ${res.status}] ${errText}`, _status: res.status };
                }
                _logEntry.status = res.status;
                const rawText = await res.text();
                let data;
                try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }
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
            const { pluginName, name, models, settingsFields, supportsDynamicModels } = msg;
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
    const setVal = (k, v) => { setArg(k, String(v)); SettingsBackup.updateKey(k, String(v)); };
    const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parseUiBool = (value) => {
        if (value === true || value === false) return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value !== 'string') return false;
        const v = value.trim().toLowerCase();
        return ['true', '1', 'yes', 'on'].includes(v);
    };

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

        <div id="tab-diagnostics" class="cpm-tab-content hidden">
            <h3 class="text-3xl font-bold text-emerald-400 mb-6 pb-3 border-b border-gray-700">🔍 진단 정보 (Diagnostics)</h3>
            <p class="text-emerald-300 font-semibold mb-6 border-l-4 border-emerald-500 pl-4 py-1">
                Cupcake PM 런타임 상태를 확인하고 버그 리포트용 진단 데이터를 내보낼 수 있습니다.
            </p>

            <div class="space-y-5">
                <!-- System overview -->
                <div class="bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <h4 class="text-lg font-bold text-blue-400 mb-3">📋 시스템 개요</h4>
                    <div id="cpm-diag-overview" class="bg-gray-900 rounded p-4 font-mono text-xs text-gray-300 space-y-1">
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
                        📋 버그 리포트 생성 (JSON)
                    </button>
                    <button id="cpm-diag-generate-text" class="bg-teal-700 hover:bg-teal-600 text-white font-semibold py-3 px-6 rounded transition-colors text-sm shadow touch-manipulation">
                        📝 버그 리포트 생성 (Text)
                    </button>
                    <button id="cpm-diag-copy-clipboard" class="bg-gray-700 hover:bg-gray-600 text-white font-semibold py-3 px-6 rounded transition-colors text-sm shadow touch-manipulation">
                        📎 클립보드 복사
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
        cmCount.innerText = CUSTOM_MODELS_CACHE.length;
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
            const m = CUSTOM_MODELS_CACHE[parseInt(e.currentTarget.dataset.idx)];
            if (!m) return;
            const exp = { ...m, _cpmModelExport: true };
            delete exp.key;
            const url = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exp, null, 2));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(m.name || 'model').replace(/[^a-zA-Z0-9가-힣_-]/g, '_')}.cpm-model.json`;
            document.body.appendChild(a); a.click(); a.remove();
        }));

        cmList.querySelectorAll('.cpm-cm-del-btn').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(e.currentTarget.dataset.idx);
            if (confirm('Delete this model?')) {
                CUSTOM_MODELS_CACHE.splice(idx, 1);
                persistCustomModels();
                refreshCmList();
            }
        }));

        cmList.querySelectorAll('.cpm-cm-edit-btn').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(e.currentTarget.dataset.idx);
            openEditor(CUSTOM_MODELS_CACHE[idx]);
            const itemDiv = e.currentTarget.closest('.group');
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
        document.getElementById('cpm-cm-id').value = m.uniqueId || ('custom_' + Date.now());
        document.getElementById('cpm-cm-name').value = m.name || '';
        document.getElementById('cpm-cm-model').value = m.model || '';
        document.getElementById('cpm-cm-url').value = m.url || '';
        document.getElementById('cpm-cm-key').value = m.key || '';
        document.getElementById('cpm-cm-format').value = m.format || 'openai';
        document.getElementById('cpm-cm-tok').value = m.tok || 'o200k_base';
        document.getElementById('cpm-cm-responses-mode').value = m.responsesMode || 'auto';
        document.getElementById('cpm-cm-thinking').value = m.thinking || 'off';
        document.getElementById('cpm-cm-thinking-budget').value = m.thinkingBudget || 0;
        document.getElementById('cpm-cm-prompt-cache-retention').value = m.promptCacheRetention || 'none';
        document.getElementById('cpm-cm-reasoning').value = m.reasoning || 'none';
        document.getElementById('cpm-cm-verbosity').value = m.verbosity || 'none';
        document.getElementById('cpm-cm-effort').value = m.effort || 'none';
        document.getElementById('cpm-cm-sysfirst').checked = parseEditorBool(m.sysfirst);
        document.getElementById('cpm-cm-mergesys').checked = parseEditorBool(m.mergesys);
        document.getElementById('cpm-cm-altrole').checked = parseEditorBool(m.altrole);
        document.getElementById('cpm-cm-mustuser').checked = parseEditorBool(m.mustuser);
        document.getElementById('cpm-cm-maxout').checked = parseEditorBool(m.maxout);
        document.getElementById('cpm-cm-streaming').checked = parseEditorBool(m.streaming);
        document.getElementById('cpm-cm-thought').checked = parseEditorBool(m.thought);
        document.getElementById('cpm-cm-custom-params').value = m.customParams || '';
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
        el.addEventListener('change', (e) => setVal(e.target.id, e.target.value));
    });
    content.querySelectorAll('input[type="checkbox"]').forEach(el => {
        el.addEventListener('change', (e) => setVal(e.target.id, e.target.checked));
    });

    // Password toggles
    content.querySelectorAll('.cpm-pw-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.targetId);
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = '🔒';
            } else {
                input.type = 'password';
                btn.textContent = '👁️';
            }
        });
    });

    // ─── TAB SWITCHING ───
    const tabs = sidebar.querySelectorAll('.tab-btn');
    tabs.forEach(t => t.addEventListener('click', () => {
        tabs.forEach(x => { x.classList.remove('bg-gray-800', 'border-l-4', 'border-blue-500', 'text-blue-400'); });
        t.classList.add('bg-gray-800', 'border-l-4', 'border-blue-500', 'text-blue-400');
        content.querySelectorAll('.cpm-tab-content').forEach(p => p.classList.add('hidden'));
        const target = document.getElementById(t.dataset.target);
        if (target) target.classList.remove('hidden');
        // Auto collapse on mobile
        if (window.innerWidth < 768 && mobileDropdown && !mobileDropdown.classList.contains('hidden')) {
            mobileDropdown.classList.add('hidden');
            mobileDropdown.classList.remove('flex');
            mobileIcon.innerText = '▼';
        }
    }));
    const initialTab = Array.from(tabs).find((tab) => tab.dataset.target === initialTarget) || tabs[0];
    if (initialTab) initialTab.click();

    content.querySelectorAll('.cpm-refresh-models-btn').forEach((btn) => btn.addEventListener('click', async (e) => {
        const providerName = e.currentTarget.dataset.provider;
        if (!providerName) return;
        const originalText = e.currentTarget.textContent;
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = '⏳ 조회 중...';
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
            if (document.body.contains(e.currentTarget)) {
                e.currentTarget.disabled = false;
                e.currentTarget.textContent = originalText;
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
        const uid = document.getElementById('cpm-cm-id').value;
        const newModel = {
            uniqueId: uid,
            name: document.getElementById('cpm-cm-name').value,
            model: document.getElementById('cpm-cm-model').value,
            url: document.getElementById('cpm-cm-url').value,
            key: document.getElementById('cpm-cm-key').value,
            format: document.getElementById('cpm-cm-format').value,
            tok: document.getElementById('cpm-cm-tok').value,
            responsesMode: document.getElementById('cpm-cm-responses-mode').value || 'auto',
            thinking: document.getElementById('cpm-cm-thinking').value,
            thinkingBudget: parseInt(document.getElementById('cpm-cm-thinking-budget').value) || 0,
            promptCacheRetention: document.getElementById('cpm-cm-prompt-cache-retention').value || 'none',
            reasoning: document.getElementById('cpm-cm-reasoning').value,
            verbosity: document.getElementById('cpm-cm-verbosity').value,
            effort: document.getElementById('cpm-cm-effort').value,
            sysfirst: document.getElementById('cpm-cm-sysfirst').checked,
            mergesys: document.getElementById('cpm-cm-mergesys').checked,
            altrole: document.getElementById('cpm-cm-altrole').checked,
            mustuser: document.getElementById('cpm-cm-mustuser').checked,
            maxout: document.getElementById('cpm-cm-maxout').checked,
            streaming: document.getElementById('cpm-cm-streaming').checked,
            decoupled: !document.getElementById('cpm-cm-streaming').checked,
            thought: document.getElementById('cpm-cm-thought').checked,
            customParams: document.getElementById('cpm-cm-custom-params').value,
        };
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
            const files = Array.from(e.target.files);
            if (files.length === 0) return;
            let imported = 0, errors = 0;
            for (const file of files) {
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!data._cpmModelExport || !data.name) { errors++; continue; }
                    data.uniqueId = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                    delete data._cpmModelExport;
                    if (!data.key) data.key = '';
                    CUSTOM_MODELS_CACHE.push(data);
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
        const s = document.getElementById('cpm-apilog-selector');
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
        document.getElementById('cpm-apilog-content').innerHTML = _renderApiLogEntry(_getApiRequestById(e.target.value));
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
    const _apiLogTabBtn = Array.from(sidebar.querySelectorAll('.tab-btn')).find(b => b.dataset.target === 'tab-apilog');
    if (_apiLogTabBtn) _apiLogTabBtn.addEventListener('click', () => setTimeout(_refreshApiLogPanel, 50));

    // ─── DIAGNOSTICS TAB ───
    const _buildDiagnosticsData = () => {
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
        return {
            cpmVersion: CPM_VERSION,
            timestamp: new Date().toISOString(),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
            registeredProviders: provList,
            totalModels: ALL_DEFINED_MODELS.length,
            customModels: CUSTOM_MODELS_CACHE.length,
            ipcProviders: registeredProviders.size,
            pendingRequests: pendingRequests.size,
            pendingControlRequests: pendingControlRequests.size,
            abortBridgeProbed: _abortBridgeProbeDone,
            apiRequestLogSize: _getAllApiRequests().length,
            recentApiRequests: recentLogs,
            allModels: ALL_DEFINED_MODELS.map(m => ({ id: m.id, name: m.name, provider: m.provider })),
        };
    };

    const _refreshDiagnosticsPanel = () => {
        const diag = _buildDiagnosticsData();
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
                <div><span class="text-gray-500">Abort 브릿지:</span> <span class="${diag.abortBridgeProbed ? 'text-green-400' : 'text-yellow-400'}">${diag.abortBridgeProbed ? '확인됨' : '대기 중'}</span></div>
                <div class="text-gray-600 mt-2">생성 시각: ${diag.timestamp}</div>
            `;
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

    // Auto-refresh diagnostics when its tab opens
    const _diagTabBtn = Array.from(sidebar.querySelectorAll('.tab-btn')).find(b => b.dataset.target === 'tab-diagnostics');
    if (_diagTabBtn) _diagTabBtn.addEventListener('click', () => setTimeout(_refreshDiagnosticsPanel, 50));

    document.getElementById('cpm-diag-generate').addEventListener('click', () => {
        const data = _buildDiagnosticsData();
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
        const a = document.createElement('a');
        a.href = dataStr; a.download = `cupcake_diagnostics_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
    });

    document.getElementById('cpm-diag-generate-text').addEventListener('click', () => {
        const d = _buildDiagnosticsData();
        let text = `=== Cupcake PM v${d.cpmVersion} 진단 리포트 ===\n`;
        text += `생성 시각: ${d.timestamp}\n`;
        text += `User-Agent: ${d.userAgent}\n\n`;
        text += `--- 시스템 상태 ---\n`;
        text += `등록 프로바이더: ${d.ipcProviders}개\n`;
        text += `전체 모델: ${d.totalModels}개 (커스텀 ${d.customModels}개)\n`;
        text += `대기 요청: ${d.pendingRequests}개\n`;
        text += `API 로그: ${d.apiRequestLogSize}건\n`;
        text += `Abort 브릿지: ${d.abortBridgeProbed ? 'OK' : 'Pending'}\n\n`;
        text += `--- 프로바이더 ---\n`;
        d.registeredProviders.forEach(p => { text += `  ${p.name} (${p.pluginName}) — 모델 ${p.modelCount}개${p.supportsDynamicModels ? ' [동적]' : ''}\n`; });
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
        const d = _buildDiagnosticsData();
        const text = JSON.stringify(d, null, 2);
        try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        alert('진단 데이터가 클립보드에 복사되었습니다.');
    });

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
        const inp = document.getElementById('cpm-copilot-manual');
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
            overlay.querySelector('#dc-close').onclick = () => overlay.remove();
            overlay.querySelector('#dc-cancel').onclick = () => overlay.remove();
            overlay.querySelector('#dc-copy').onclick = () => { try { navigator.clipboard.writeText(dc.user_code); } catch {} };
            overlay.querySelector('#dc-confirm').onclick = async function () {
                this.disabled = true; this.textContent = '확인 중...';
                try {
                    const at = await _copilotExchangeAccessToken(dc.device_code);
                    _setCopilotToken(at); overlay.remove(); await _copilotRefreshDisplay();
                    _copilotShowSuccess('<strong>✅ 성공!</strong> 토큰이 생성 및 저장되었습니다.');
                } catch (e) { this.disabled = false; this.textContent = '확인'; alert(e.message); }
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
        const exportData = {};
        for (const key of keys) {
            const val = await safeGetArg(key);
            if (val !== undefined && val !== '') exportData[key] = val;
        }
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
        const a = document.createElement('a');
        a.href = dataStr; a.download = 'cupcake_pm_settings.json';
        document.body.appendChild(a); a.click(); a.remove();
    });

    document.getElementById('cpm-import-btn').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    for (const [key, value] of Object.entries(data)) {
                        setVal(key, value);
                        const el = document.getElementById(key);
                        if (el) { el.type === 'checkbox' ? (el.checked = parseUiBool(value)) : (el.value = value); }
                    }
                    alert('설정을 성공적으로 불러왔습니다!');
                    openCpmSettings();
                } catch (err) { alert('설정 파일 오류: ' + err.message); }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    document.getElementById('cpm-close-btn').addEventListener('click', () => {
        document.body.innerHTML = '';
        Risu.hideContainer();
    });

    // Take snapshot
    await SettingsBackup.snapshotAll();
}

function persistCustomModels() {
    try {
        const json = JSON.stringify(CUSTOM_MODELS_CACHE);
        setArg('cpm_custom_models', json);
        SettingsBackup.updateKey('cpm_custom_models', json);
    } catch (e) { console.error('[CPM] Failed to save custom models:', e); }
}


// ==========================================
// MAIN INIT
// ==========================================
(async () => {
    try {
        console.log(`[CPM] Cupcake Provider Manager v${CPM_VERSION} (IPC Mode) initializing...`);

        await SettingsBackup.load();
        const restoredCount = await SettingsBackup.restoreIfEmpty();
        if (restoredCount > 0) console.log(`[CPM] Restored ${restoredCount} settings from backup`);

        // Load custom models
        try {
            const raw = await safeGetArg('cpm_custom_models', '[]');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                CUSTOM_MODELS_CACHE.push(...parsed.filter(m => m && typeof m === 'object'));
            } else if (parsed && typeof parsed === 'object') {
                CUSTOM_MODELS_CACHE.push(parsed);
                console.warn('[CPM] cpm_custom_models was a single object; migrated to array in memory');
            }
        } catch (e) { console.warn('[CPM] Failed to parse custom models', e); }
        for (const m of CUSTOM_MODELS_CACHE) {
            ALL_DEFINED_MODELS.push({ uniqueId: m.uniqueId, id: m.model, name: m.name || m.uniqueId, provider: 'Custom' });
        }

        // IPC 리스너 설정 (반드시 addProvider 전에!)
        setupControlChannel();
        setupResponseListener();

        // 서브플러그인 초기 등록 대기 (프로바이더 재시도 주기: 500ms~)
        // 대부분 1초 내 등록 완료, late registration도 지원하므로 짧게
        await new Promise(r => setTimeout(r, 1000));

        console.log(`[CPM] ${registeredProviders.size} providers registered, ${ALL_DEFINED_MODELS.length} models total`);

        ALL_DEFINED_MODELS.sort((a, b) => {
            const p = a.provider.localeCompare(b.provider);
            return p !== 0 ? p : a.name.localeCompare(b.name);
        });

        // 모든 모델 등록
        for (const modelDef of ALL_DEFINED_MODELS) {
            await registerModelWithRisu(modelDef);
        }
        managerReady = true;

        // 설정 UI 등록
        await Risu.registerSetting(`v${CPM_VERSION}`, openCpmSettings, '🧁', 'html');

        // 키보드 단축키 + 터치 제스처
        try {
            const rootDoc = await Risu.getRootDocument();
            await rootDoc.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.shiftKey && e.altKey && (e.key === 'p' || e.key === 'P')) openCpmSettings();
            });
            let activePointers = 0, pointerTimer = null;
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
        } catch (err) { console.error('[CPM] Hotkey registration failed:', err); }

        // 초기 백업
        await SettingsBackup.snapshotAll();

        // Auto-updater: retry pending updates from previous boot
        try { await AutoUpdater.retryPendingUpdateOnBoot(); } catch (e) { console.warn('[CPM] Boot retry failed:', e); }

        // Auto-updater: background version check (non-blocking)
        AutoUpdater.checkVersionsQuiet().catch(() => {});
        // JS fallback version check (10s delay to avoid fetch contention)
        setTimeout(() => { AutoUpdater.checkMainPluginVersionQuiet().catch(() => {}); }, 10000);

        console.log(`[CPM] ✓ Initialization complete. ${ALL_DEFINED_MODELS.length} models available.`);
    } catch (e) {
        console.error('[CPM] Init failed:', e);
        // CRITICAL FALLBACK: Ensure settings panel is still accessible for error diagnosis
        try {
            await Risu.registerSetting(
                `⚠️ CPM v${CPM_VERSION} (Error)`,
                async () => {
                    const rootDoc = await Risu.getRootDocument();
                    const body = await rootDoc.querySelector('body');
                    const errorPanel = await rootDoc.createElement('div');
                    await errorPanel.setStyleAttribute('position:fixed;top:0;left:0;right:0;bottom:0;background:#1a1a2e;color:#fff;padding:40px;font-family:sans-serif;z-index:99999;overflow:auto;');
                    const errorText = String(e && e.stack ? e.stack : e).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    await errorPanel.setInnerHTML(`
                        <h1 style="color:#ff6b6b;">🧁 Cupcake PM — Initialization Error</h1>
                        <p style="color:#ccc;margin:20px 0;">The plugin failed to initialize properly.</p>
                        <pre style="background:#0d1117;color:#ff7b72;padding:16px;border-radius:8px;overflow:auto;max-height:300px;font-size:13px;">${errorText}</pre>
                        <p style="color:#aaa;margin-top:20px;">Try: reload (Ctrl+Shift+R) or re-import the plugin.</p>
                    `);
                    await body.appendChild(errorPanel);
                },
                '🧁',
                'html',
            );
        } catch (_) { /* Last resort */ }
    }
})();
