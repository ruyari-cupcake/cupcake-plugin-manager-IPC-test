/**
 * CPM Provider — OpenRouter
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager } from '../shared/ipc-protocol.js';
import { KeyPool } from '../shared/key-pool.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToOpenAI } from '../shared/message-format.js';
import { createOpenAISSEStream, parseOpenAINonStreamingResponse } from '../shared/sse-parser.js';
import { formatOpenRouterDynamicModels } from '../shared/dynamic-models.js';
import { smartFetch, safeStringify } from '../shared/helpers.js';

const PLUGIN_NAME = 'CPM Provider - OpenRouter';
const Risu = getRisu();

const _pendingAbortControllers = new Map();

const models = [
    { uniqueId: 'cpm-openrouter-dynamic', id: 'openrouter/auto', name: 'OpenRouter (설정 모델)', provider: 'OpenRouter' },
];

const settingsFields = [
    { key: 'cpm_openrouter_key', label: 'API Key (여러 개 시 공백/줄바꿈 구분, 자동 키회전)', type: 'password' },
    { key: 'cpm_openrouter_url', label: 'Custom Base URL (비워두면 기본값)', type: 'text' },
    { key: 'cpm_openrouter_model', label: 'Model ID (예: anthropic/claude-sonnet-4)', type: 'text' },
    { key: 'cpm_openrouter_provider', label: 'Provider Routing (프로바이더 문자열, 예: Hyperbolic)', type: 'text' },
    { key: 'cpm_openrouter_reasoning', label: 'Reasoning Effort (추론 수준)', type: 'select',
      options: [{value:'none',text:'None (없음)'},{value:'off',text:'Off (끄기)'},{value:'low',text:'Low (낮음)'},{value:'medium',text:'Medium (중간)'},{value:'high',text:'High (높음)'}] },
];

async function fetchDynamicOpenRouterModels(settings = {}) {
    const baseUrl = (settings.cpm_openrouter_url || 'https://openrouter.ai/api').replace(/\/+$/, '');
    const pool = new KeyPool(settings.cpm_openrouter_key);
    const apiKey = pool.pick();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await smartFetch(`${baseUrl}/v1/models`, { method: 'GET', headers });
    if (!res.ok) throw new Error(`[OpenRouter Dynamic ${res.status}] ${await res.text()}`);
    const data = await res.json();
    return formatOpenRouterDynamicModels(data?.data || data?.models || []);
}

async function fetchOpenRouter(modelDef, messages, temp, maxTokens, args, settings, abortSignal, requestId) {
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pool = new KeyPool(settings.cpm_openrouter_key);
    if (pool.remaining === 0) return { success: false, content: '[OpenRouter] API key not configured' };

    const actualModel = settings.cpm_openrouter_model || modelDef.id;
    if (!actualModel || actualModel === 'openrouter/auto') {
        return { success: false, content: '[OpenRouter] 모델 ID를 설정에서 지정해주세요.' };
    }

    return pool.withRotation(async (apiKey) => {
        const baseUrl = (settings.cpm_openrouter_url || 'https://openrouter.ai/api').replace(/\/+$/, '');
        const streamingEnabled = settings.cpm_streaming_enabled === true || settings.cpm_streaming_enabled === 'true';

        // Developer role for o-series and GPT-5
        const useDeveloperRole = /(?:^|\/)(?:gpt-5|o(?:[2-9]|1(?!-(?:preview|mini))))/.test(actualModel);
        const formatted = formatToOpenAI(messages, { developerRole: useDeveloperRole });

        const showThinking = settings.cpm_streaming_show_thinking === true || settings.cpm_streaming_show_thinking === 'true';
        const showTokenUsage =
            settings.cpm_streaming_show_token_usage === true || settings.cpm_streaming_show_token_usage === 'true' ||
            settings.cpm_show_token_usage === true || settings.cpm_show_token_usage === 'true';

        const body = { model: actualModel, messages: formatted };
        if (streamingEnabled) body.stream = true;

        // max_completion_tokens for GPT-4.5/5, o-series
        const needsMaxCompletion = /(?:^|\/)(?:gpt-(?:4\.5|5)|o[1-9])/.test(actualModel);
        if (needsMaxCompletion) {
            body.max_completion_tokens = maxTokens || 16384;
        } else {
            if (maxTokens) body.max_tokens = maxTokens;
        }

        // Strip sampling for o3/o4 reasoning models
        const stripSampling = /(?:^|\/)o(?:3(?:-mini|-pro)?|4-mini)/.test(actualModel);
        if (!stripSampling) {
            if (temp !== undefined && temp !== null) body.temperature = temp;
            if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
            if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) body.frequency_penalty = args.frequency_penalty;
            if (args.presence_penalty !== undefined && args.presence_penalty !== null) body.presence_penalty = args.presence_penalty;
        }
        if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
        if (args.repetition_penalty !== undefined && args.repetition_penalty !== null) body.repetition_penalty = args.repetition_penalty;
        if (args.min_p !== undefined && args.min_p !== null) body.min_p = args.min_p;

        const providerRouting = settings.cpm_openrouter_provider || '';
        if (providerRouting) {
            body.provider = { order: providerRouting.split(',').map(p => p.trim()).filter(Boolean) };
        }
        const reasoning = settings.cpm_openrouter_reasoning || '';
        if (reasoning && reasoning !== 'none' && reasoning !== 'off') {
            // FEAT-6: reasoning with max_tokens (from temp_repo)
            body.reasoning = { effort: reasoning };
            if (maxTokens) body.reasoning.max_tokens = maxTokens;
        }
        if (streamingEnabled && showTokenUsage) {
            body.stream_options = { include_usage: true };
        }

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://risuai.xyz',
            'X-Title': 'RisuAI Cupcake PM'
        };

        const res = await smartFetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST', headers, body: sanitizeBodyJSON(safeStringify(body)), signal: abortSignal
        });

        if (!res.ok) {
            return { success: false, content: `[OpenRouter Error ${res.status}] ${await res.text()}`, _status: res.status };
        }
        if (streamingEnabled) {
            return { success: true, content: createOpenAISSEStream(res, abortSignal, { showThinking, _requestId: requestId }) };
        }
        const data = await res.json();
        return parseOpenAINonStreamingResponse(data, { showThinking, _requestId: requestId });
    });
}

(async () => {
    try {
        const handleControlMessage = async (msg) => {
            if (!msg || msg.type !== MSG.DYNAMIC_MODELS_REQUEST || !msg.requestId) return;
            try {
                const models = await fetchDynamicOpenRouterModels(msg.settings || {});
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
                    error: `[OpenRouter] ${e.message}`,
                    models: [],
                });
            }
        };

        Risu.addPluginChannelListener(CH.ABORT, (msg) => {
            if (!msg || msg.type !== MSG.ABORT || !msg.requestId) return;
            const ac = _pendingAbortControllers.get(msg.requestId);
            if (ac) { ac.abort(); _pendingAbortControllers.delete(msg.requestId); }
        });

        Risu.addPluginChannelListener(CH.FETCH, async (msg) => {
            if (!msg || msg.type !== MSG.FETCH_REQUEST) return;
            const { requestId, modelDef, messages, temperature, maxTokens, args, settings } = msg;
            const ac = new AbortController();
            _pendingAbortControllers.set(requestId, ac);
            try {
                const result = await fetchOpenRouter(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal, requestId);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: result });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.ERROR, requestId, error: `[OpenRouter] ${e.message}` });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'OpenRouter', models, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        console.log(`[CPM-OpenRouter] Provider initialized (registered: ${ok})`);
    } catch (e) { console.error('[CPM-OpenRouter] Init failed:', e); }
})();
