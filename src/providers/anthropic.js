/**
 * CPM Provider — Anthropic (Claude)
 * 설정값은 매니저가 IPC fetch 메시지의 settings 객체에 포함해서 전달합니다.
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager } from '../shared/ipc-protocol.js';
import { KeyPool } from '../shared/key-pool.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToAnthropic } from '../shared/message-format.js';
import { parseClaudeNonStreamingResponse } from '../shared/sse-parser.js';
import { formatAnthropicDynamicModels } from '../shared/dynamic-models.js';
import { smartFetch, safeStringify } from '../shared/helpers.js';

const PLUGIN_NAME = 'CPM Provider - Anthropic';
const Risu = getRisu();

// ── Abort tracking ──
const _pendingAbortControllers = new Map();

const models = [
    { uniqueId: 'anthropic-claude-sonnet-4-6',          id: 'claude-sonnet-4-6',          name: 'Claude 4.6 Sonnet',              provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-opus-4-6',            id: 'claude-opus-4-6',            name: 'Claude 4.6 Opus',                provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-haiku-4-5-20251001',  id: 'claude-haiku-4-5-20251001',  name: 'Claude 4.5 Haiku (2025/10/01)',  provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-sonnet-4-20250514',   id: 'claude-sonnet-4-20250514',   name: 'Claude 4 Sonnet (2025/05/14)',   provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-sonnet-4-5-20250929', id: 'claude-sonnet-4-5-20250929', name: 'Claude 4.5 Sonnet (2025/09/29)', provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-opus-4-20250514',     id: 'claude-opus-4-20250514',     name: 'Claude 4 Opus (2025/05/14)',     provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-opus-4-1-20250805',   id: 'claude-opus-4-1-20250805',   name: 'Claude 4.1 Opus (2025/08/05)',   provider: 'Anthropic' },
    { uniqueId: 'anthropic-claude-opus-4-5-20251101',   id: 'claude-opus-4-5-20251101',   name: 'Claude 4.5 Opus (2025/11/01)',   provider: 'Anthropic' },
];

const settingsFields = [
    { key: 'cpm_anthropic_key', label: 'API Key (여러 개 시 공백/줄바꿈 구분, 자동 키회전)', type: 'password' },
    { key: 'cpm_anthropic_url', label: 'Custom Base URL (비워두면 기본값)', type: 'text' },
    { key: 'cpm_anthropic_model', label: 'Model Override (비워두면 기본 모델 사용)', type: 'text' },
    { key: 'cpm_anthropic_thinking_budget', label: 'Thinking Budget Tokens (4.5 이하 모델용, 0은 끄기)', type: 'text' },
    { key: 'cpm_anthropic_thinking_effort', label: 'Adaptive Thinking Effort (4.6 모델용)', type: 'select',
      options: [{value:'',text:'사용 안함'},{value:'low',text:'Low (낮음)'},{value:'medium',text:'Medium (중간)'},{value:'high',text:'High (높음)'},{value:'max',text:'Max (최대)'}] },
    { key: 'chat_claude_caching', label: 'Prompt Caching 사용', type: 'checkbox' },
    { key: 'cpm_anthropic_cache_1h', label: '1시간 확장 캐싱 (Extended Cache TTL)', type: 'checkbox' },
];

async function fetchDynamicAnthropicModels(settings = {}) {
    const pool = new KeyPool(settings.cpm_anthropic_key);
    const apiKey = pool.pick();
    if (!apiKey) return [];

    const baseUrl = (settings.cpm_anthropic_url || 'https://api.anthropic.com').replace(/\/+$/, '');
    let allModels = [];
    let afterId = null;
    let pageCount = 0;
    const MAX_PAGES = 50;

    while (pageCount < MAX_PAGES) {
        pageCount++;
        let url = `${baseUrl}/v1/models?limit=100`;
        if (afterId) url += `&after_id=${encodeURIComponent(afterId)}`;

        const res = await smartFetch(url, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
        });
        if (!res.ok) throw new Error(`[Anthropic Dynamic ${res.status}] ${await res.text()}`);

        const data = await res.json();
        if (Array.isArray(data?.data)) allModels = allModels.concat(data.data);
        if (!data?.has_more) break;
        afterId = data.last_id;
    }

    return formatAnthropicDynamicModels(allModels);
}

async function fetchAnthropic(modelDef, messages, temp, maxTokens, args, settings, abortSignal) {
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pool = new KeyPool(settings.cpm_anthropic_key);
    if (pool.remaining === 0) return { success: false, content: '[Anthropic] API key not configured' };

    return pool.withRotation(async (apiKey) => {
        const baseUrl = (settings.cpm_anthropic_url || 'https://api.anthropic.com').replace(/\/+$/, '');
        // FEAT-1: Model override
        const modelId = (settings.cpm_anthropic_model || '').trim() || modelDef.id;
        const useCaching = settings.chat_claude_caching === true || settings.chat_claude_caching === 'true';
        const thinkingBudget = parseInt(settings.cpm_anthropic_thinking_budget) || 0;
        const thinkingEffort = settings.cpm_anthropic_thinking_effort || '';

        // sanitizeMessages is called internally by formatToAnthropic — no need to double-sanitize
        const { messages: chatMessages, system: systemPrompt } = formatToAnthropic(messages, {});

        const body = { model: modelId, messages: chatMessages, max_tokens: maxTokens || 4096 };
        if (temp !== undefined && temp !== null) body.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
        if (systemPrompt) {
            if (useCaching) {
                body.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
            } else {
                body.system = systemPrompt;
            }
        }

        // Thinking config
        const isAdaptive = modelId === 'claude-sonnet-4-6' || modelId === 'claude-opus-4-6';
        if (thinkingEffort && isAdaptive) {
            // Claude 4.6 adaptive thinking
            body.thinking = { type: 'adaptive' };
            const effort = ['low', 'medium', 'high', 'max'].includes(thinkingEffort) ? thinkingEffort : 'high';
            body.output_config = { effort };
        } else if (thinkingBudget > 0) {
            body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
        }
        if (body.thinking) {
            // Anthropic API rejects temperature/top_k/top_p when thinking is enabled
            delete body.temperature;
            delete body.top_k;
            delete body.top_p;
            if (body.thinking.type === 'adaptive') {
                body.max_tokens = Math.max(body.max_tokens, 16000);
            } else {
                body.max_tokens = Math.max(body.max_tokens, (body.thinking.budget_tokens || 0) + 4096);
            }
        }

        // 1-hour extended caching support
        // Migration compatibility: temp_repo stored this as cpm_anthropic_cache_ttl='1h'.
        const legacyCacheTtl = String(settings.cpm_anthropic_cache_ttl || '').trim().toLowerCase();
        const use1HourCache =
            settings.cpm_anthropic_cache_1h === true ||
            settings.cpm_anthropic_cache_1h === 'true' ||
            legacyCacheTtl === '1h';

        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        };
        // Build beta headers (prompt-caching is GA — no longer needs beta header)
        const betaParts = [];
        if (body.thinking) betaParts.push('interleaved-thinking-2025-05-14');
        // output-128k beta for large output requests
        if (body.max_tokens > 8192) betaParts.push('output-128k-2025-02-19');
        // extended-cache-ttl for 1-hour caching
        if (use1HourCache) betaParts.push('extended-cache-ttl-2025-04-11');
        if (betaParts.length > 0) headers['anthropic-beta'] = betaParts.join(',');

        const res = await smartFetch(`${baseUrl}/v1/messages`, {
            method: 'POST', headers, body: sanitizeBodyJSON(safeStringify(body)), signal: abortSignal
        });
        if (!res.ok) {
            return { success: false, content: `[Anthropic Error ${res.status}] ${await res.text()}`, _status: res.status };
        }

        const data = await res.json();
        if (!data) return { success: false, content: `[Anthropic] Empty response (HTTP ${res?.status || '?'})`, _status: res?.status };
        if (data.type === 'error' || data.error) {
            return { success: false, content: `[Anthropic] ${data.error?.message || JSON.stringify(data.error || data)}`, _status: res?.status };
        }
        const showThinking = settings.cpm_streaming_show_thinking === true || settings.cpm_streaming_show_thinking === 'true';
        return parseClaudeNonStreamingResponse(data, { showThinking });
    });
}

(async () => {
    try {
        const handleControlMessage = async (msg) => {
            if (!msg || msg.type !== MSG.DYNAMIC_MODELS_REQUEST || !msg.requestId) return;
            try {
                const models = await fetchDynamicAnthropicModels(msg.settings || {});
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                    type: MSG.DYNAMIC_MODELS_RESULT,
                    requestId: msg.requestId,
                    success: true,
                    models,
                });
            } catch (e) {
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                    type: MSG.DYNAMIC_MODELS_RESULT,
                    requestId: msg.requestId,
                    success: false,
                    error: `[Anthropic] ${e.message}`,
                    models: [],
                });
            }
        };

        // ABORT channel listener
        Risu.addPluginChannelListener(CH.ABORT, (msg) => {
            if (!msg || msg.type !== MSG.ABORT || !msg.requestId) return;
            const ac = _pendingAbortControllers.get(msg.requestId);
            if (ac) { ac.abort(); _pendingAbortControllers.delete(msg.requestId); }
        });

        // Fetch 리스너 먼저 등록 (매니저보다 먼저 준비)
        Risu.addPluginChannelListener(CH.FETCH, async (msg) => {
            if (!msg || msg.type !== MSG.FETCH_REQUEST) return;
            const { requestId, modelDef, messages, temperature, maxTokens, args, settings } = msg;
            const ac = new AbortController();
            _pendingAbortControllers.set(requestId, ac);
            try {
                const result = await fetchAnthropic(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                    type: MSG.RESPONSE, requestId, data: result
                });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.ERROR, requestId, error: `[Anthropic] ${e.message}`
                    });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });

        // 매니저에 등록 (ACK 올 때까지 자동 재시도)
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'Anthropic', models, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        console.log(`[CPM-Anthropic] Provider initialized (registered: ${ok})`);
    } catch (e) {
        console.error('[CPM-Anthropic] Init failed:', e);
    }
})();
