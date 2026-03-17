/**
 * CPM Provider — OpenAI (GPT)
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager, setupChannelCleanup } from '../shared/ipc-protocol.js';
import { KeyPool } from '../shared/key-pool.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToOpenAI } from '../shared/message-format.js';
import {
    parseOpenAINonStreamingResponse,
    parseResponsesAPINonStreamingResponse,
    createOpenAISSEStream,
    createResponsesAPISSEStream,
} from '../shared/sse-parser.js';
import { formatOpenAIDynamicModels } from '../shared/dynamic-models.js';
import { smartFetch, streamingFetch, safeStringify, shouldEnableStreaming } from '../shared/helpers.js';
import { needsCopilotResponsesAPI } from '../shared/model-helpers.js';
import {
    needsMaxCompletionTokens,
    shouldStripGPT54SamplingForReasoning,
    shouldStripOpenAISamplingParams,
    supportsOpenAIReasoningEffort,
    supportsOpenAIVerbosity,
} from '../shared/model-helpers.js';
import { ensureCopilotApiToken, getCopilotApiBase } from '../shared/copilot-token.js';
import { safeUUID } from '../shared/ipc-protocol.js';
import { getCopilotStaticHeaders, shouldUseLegacyCopilotRequestHeaders } from '../shared/copilot-headers.js';

const PLUGIN_NAME = 'CPM Provider - OpenAI';
const Risu = getRisu();

// ── Abort tracking ──
const _pendingAbortControllers = new Map(); // requestId → AbortController

// ── HTTP retry helpers ──
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const parseRetryAfterMs = (headers) => {
    const raw = headers?.get?.('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, Math.floor(seconds * 1000));
    const retryAt = Date.parse(raw);
    if (Number.isNaN(retryAt)) return 0;
    return Math.max(0, retryAt - Date.now());
};
const isRetriableStatus = (status) => status === 408 || status === 429 || status >= 500;

// ── Copilot session IDs ──
let _copilotMachineId = null;
let _copilotSessionId = null;

const models = [
    { uniqueId: 'openai-gpt-4.1-2025-04-14',    id: 'gpt-4.1-2025-04-14',    name: 'GPT-4.1 (2025/04/14)',    provider: 'OpenAI' },
    { uniqueId: 'openai-chatgpt-4o-latest',      id: 'chatgpt-4o-latest',      name: 'ChatGPT-4o (Latest)',     provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5-2025-08-07',       id: 'gpt-5-2025-08-07',       name: 'gpt-5 (2025/08/07)',      provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5-mini-2025-08-07',  id: 'gpt-5-mini-2025-08-07',  name: 'gpt-5-mini (2025/08/07)', provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5-nano-2025-08-07',  id: 'gpt-5-nano-2025-08-07',  name: 'gpt-5-nano (2025/08/07)', provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5-chat-latest',      id: 'gpt-5-chat-latest',      name: 'gpt-5-chat (Latest)',     provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.1-2025-11-13',     id: 'gpt-5.1-2025-11-13',     name: 'GPT-5.1 (2025/11/13)',    provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.1-chat-latest',    id: 'gpt-5.1-chat-latest',    name: 'GPT-5.1 Chat (Latest)',   provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.2-2025-12-11',     id: 'gpt-5.2-2025-12-11',     name: 'GPT-5.2 (2025/12/11)',    provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.2-chat-latest',    id: 'gpt-5.2-chat-latest',    name: 'GPT-5.2 Chat (Latest)',   provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.3-2026-01-22',     id: 'gpt-5.3-2026-01-22',     name: 'GPT-5.3 (2026/01/22)',    provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.3-chat-latest',    id: 'gpt-5.3-chat-latest',    name: 'GPT-5.3 Chat (Latest)',   provider: 'OpenAI' },
    { uniqueId: 'openai-gpt-5.4-2026-03-05',     id: 'gpt-5.4-2026-03-05',     name: 'GPT-5.4 (2026/03/05)',    provider: 'OpenAI' },
];

const settingsFields = [
    { key: 'cpm_openai_key', label: 'API Key (sk-... 여러 개 시 공백/줄바꿈 구분, 자동 키회전)', type: 'password' },
    { key: 'cpm_openai_url', label: 'Custom Base URL (비워두면 기본값)', type: 'text' },
    { key: 'cpm_openai_model', label: 'Model Override (비워두면 기본 모델 사용)', type: 'text' },
    { key: 'cpm_openai_reasoning', label: 'Reasoning Effort (o3, o1 시리즈용)', type: 'select',
      options: [{value:'none',text:'None (없음)'},{value:'off',text:'Off (끄기)'},{value:'low',text:'Low (낮음)'},{value:'medium',text:'Medium (중간)'},{value:'high',text:'High (높음)'}] },
    { key: 'cpm_openai_verbosity', label: 'Response Verbosity (응답 상세도)', type: 'select',
      options: [{value:'none',text:'None (기본값)'},{value:'low',text:'Low (낮음)'},{value:'medium',text:'Medium (중간)'},{value:'high',text:'High (높음)'}] },
    { key: 'common_openai_servicetier', label: 'Service Tier (응답 속도)', type: 'select',
      options: [{value:'',text:'Auto (자동)'},{value:'flex',text:'Flex'},{value:'default',text:'Default'}] },
    { key: 'cpm_openai_prompt_cache_retention', label: 'Prompt Cache Retention (캐시 유지)', type: 'select',
      options: [{value:'none',text:'None (서버 기본값)'},{value:'in_memory',text:'In-Memory (5~10분, 최대 1시간)'},{value:'24h',text:'24h Extended (24시간 확장)'}] },
];

async function fetchDynamicOpenAIModels(settings = {}) {
    const pool = new KeyPool(settings.cpm_openai_key);
    const apiKey = pool.pick();
    if (!apiKey) return [];

    const baseUrl = (settings.cpm_openai_url || 'https://api.openai.com').replace(/\/+$/, '');
    const res = await smartFetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
        throw new Error(`[OpenAI Dynamic ${res.status}] ${await res.text()}`);
    }
    const data = await res.json();
    return formatOpenAIDynamicModels(data?.data);
}

async function fetchOpenAI(modelDef, messages, temp, maxTokens, args, settings, abortSignal, requestId) {
    // Pre-flight abort check
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pool = new KeyPool(settings.cpm_openai_key);
    if (pool.remaining === 0) return { success: false, content: '[OpenAI] API key not configured' };

    return pool.withRotation(async (apiKey) => {
        const baseUrl = (settings.cpm_openai_url || 'https://api.openai.com').replace(/\/+$/, '');
        const modelId = (settings.cpm_openai_model || '').trim() || modelDef.id;
        const useMaxCompletionTokens = needsMaxCompletionTokens(modelId);
        const disableSampling = shouldStripOpenAISamplingParams(modelId);
        const gpt54ReasoningStrip = shouldStripGPT54SamplingForReasoning(modelId, settings.cpm_openai_reasoning);
        const showThinking = settings.cpm_streaming_show_thinking === true || settings.cpm_streaming_show_thinking === 'true';
        const validServiceTiers = new Set(['flex', 'default']);

        // Copilot detection
        const isCopilotUrl = baseUrl.includes('githubcopilot.com');
        const isManualResponsesEndpoint = /\/responses(?:\?|$)/.test(baseUrl);
        const _needsResponsesAPI = isManualResponsesEndpoint || (isCopilotUrl && needsCopilotResponsesAPI(modelId));
        const streamingEnabled = shouldEnableStreaming(settings, { isCopilot: isCopilotUrl });
        const copilotNodelessMode = settings.cpm_copilot_nodeless_mode || 'off';

        // Determine effective URL
        let effectiveUrl = `${baseUrl}/v1/chat/completions`;
        if (_needsResponsesAPI) {
            if (isCopilotUrl) {
                const copilotBase = getCopilotApiBase() || 'https://api.githubcopilot.com';
                effectiveUrl = `${copilotBase}/responses`;
            } else {
                effectiveUrl = `${baseUrl}/responses`;
            }
        }

        // GPT-5.x, o-series developer role
        const useDeveloperRole = /(?:^|\/)(?:gpt-5|o[2-9]|o1(?!-(?:preview|mini)))/i.test(modelId);
        const formatted = formatToOpenAI(messages, { developerRole: useDeveloperRole });

        /** @type {Record<string, any>} */
        const body = { model: modelId, stream: streamingEnabled };

        // Responses API vs Chat Completions
        if (_needsResponsesAPI) {
            body.input = Array.isArray(formatted) ? formatted.filter(m => m != null && typeof m === 'object').map(({ name, ...rest }) => rest) : [];
            body.max_output_tokens = maxTokens || 16384;
        } else {
            body.messages = formatted;
            if (useMaxCompletionTokens) {
                body.max_completion_tokens = maxTokens || 16384;
            } else {
                if (maxTokens) body.max_tokens = maxTokens;
            }
        }

        // Reasoning effort
        if (supportsOpenAIReasoningEffort(modelId)) {
            const effort = settings.cpm_openai_reasoning || '';
            if (effort && effort !== 'none' && effort !== 'off') {
                if (_needsResponsesAPI) {
                    body.reasoning = { effort, summary: 'auto' };
                } else {
                    body.reasoning_effort = effort;
                }
            }
        }
        const verb = settings.cpm_openai_verbosity || '';
        if (verb && verb !== 'none' && supportsOpenAIVerbosity(modelId)) body.verbosity = verb;

        // Sampling params
        if (!disableSampling && !gpt54ReasoningStrip) {
            if (temp !== undefined && temp !== null) body.temperature = temp;
            if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
            if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) body.frequency_penalty = args.frequency_penalty;
            if (args.presence_penalty !== undefined && args.presence_penalty !== null) body.presence_penalty = args.presence_penalty;
        }

        // Service tier
        const tierRaw = settings.common_openai_servicetier || '';
        const tier = String(tierRaw).trim().toLowerCase();
        if (tier && tier !== 'auto' && validServiceTiers.has(tier)) body.service_tier = tier;

        // Prompt cache retention
        const cacheRetention = settings.cpm_openai_prompt_cache_retention || '';
        if (cacheRetention && cacheRetention !== 'none' && !_needsResponsesAPI) body.prompt_cache_retention = cacheRetention;

        // Token usage tracking
        const showTokenUsage =
            settings.cpm_streaming_show_token_usage === true || settings.cpm_streaming_show_token_usage === 'true' ||
            settings.cpm_show_token_usage === true || settings.cpm_show_token_usage === 'true';
        if (streamingEnabled && showTokenUsage && !_needsResponsesAPI) {
            body.stream_options = { include_usage: true };
        }

        // Headers
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

        // Copilot header injection
        if (isCopilotUrl) {
            try {
                const copilotApiToken = await ensureCopilotApiToken();
                if (copilotApiToken) headers['Authorization'] = `Bearer ${copilotApiToken}`;
            } catch {}
            if (!_copilotMachineId) _copilotMachineId = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
            if (!_copilotSessionId) _copilotSessionId = safeUUID() + Date.now().toString();
            Object.assign(headers, getCopilotStaticHeaders(copilotNodelessMode));
            if (!shouldUseLegacyCopilotRequestHeaders(copilotNodelessMode)) {
                headers['Vscode-Machineid'] = _copilotMachineId;
                headers['Vscode-Sessionid'] = _copilotSessionId;
                headers['X-Interaction-Id'] = safeUUID();
                headers['X-Request-Id'] = safeUUID();
            }
            // Vision detection
            const _msgArr = body.messages || body.input || [];
            const hasVisionContent = _msgArr.some(m => Array.isArray(m?.content) && m.content.some(p => p.type === 'image_url'));
            if (hasVisionContent) headers['Copilot-Vision-Request'] = 'true';
        }

        // HTTP retry wrapper
        const executeRequest = async (fetchFn, label, maxAttempts = 3) => {
            let attempt = 0;
            let response;
            while (attempt < maxAttempts) {
                response = await fetchFn();
                if (response?.ok) return response;
                const status = response?.status || 0;
                if (!isRetriableStatus(status) || attempt >= maxAttempts - 1 || abortSignal?.aborted) return response;
                response?.body?.cancel?.();
                attempt++;
                const retryDelay = parseRetryAfterMs(response?.headers) || (700 * attempt);
                console.warn(`[CPM-OpenAI] ${label} retry ${attempt}/${maxAttempts - 1} after HTTP ${status}`);
                await sleep(retryDelay);
            }
            return response;
        };

        const safeBody = sanitizeBodyJSON(safeStringify(body));

        if (streamingEnabled) {
            // Streaming path
            const res = await executeRequest(
                () => streamingFetch(effectiveUrl, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                'streaming'
            );
            if (!res.ok) return { success: false, content: `[OpenAI Error ${res.status}] ${await res.text()}`, _status: res.status };

            const hasBody = !!(res.body && typeof res.body.getReader === 'function');
            if (!hasBody) {
                // Fallback: retry as non-streaming
                /** @type {Record<string, any>} */
                const fallbackBody = { ...body, stream: false };
                delete fallbackBody.stream_options;
                const fallbackRes = await executeRequest(
                    () => smartFetch(effectiveUrl, { method: 'POST', headers, body: safeStringify(fallbackBody), signal: abortSignal }),
                    'non-stream fallback'
                );
                if (!fallbackRes.ok) return { success: false, content: `[OpenAI Error ${fallbackRes.status}] ${await fallbackRes.text()}`, _status: fallbackRes.status };
                const fallbackData = await fallbackRes.json();
                if (_needsResponsesAPI) return parseResponsesAPINonStreamingResponse(fallbackData, { showThinking, _requestId: requestId });
                return parseOpenAINonStreamingResponse(fallbackData, { showThinking, _requestId: requestId });
            }

            // Create SSE stream and collect as string for IPC transfer
            let sseStream;
            if (_needsResponsesAPI) {
                sseStream = createResponsesAPISSEStream(res, abortSignal, { showThinking, _requestId: requestId });
            } else {
                sseStream = createOpenAISSEStream(res, abortSignal, { showThinking, _requestId: requestId });
            }

            // Stream chunks via IPC
            const reader = sseStream.getReader();
            let accumulated = '';
            try {
                while (true) {
                    if (abortSignal?.aborted) break;
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        accumulated += value;
                        Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                            type: MSG.STREAM_CHUNK, requestId, chunk: value
                        });
                    }
                }
            } catch (e) {
                if (e.name !== 'AbortError') console.error('[CPM-OpenAI] Stream error:', e.message);
            }
            // Send stream end
            Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                type: MSG.STREAM_END, requestId
            });
            return { success: true, content: accumulated, _streamed: true };
        }

        // Non-streaming path
        const res = await executeRequest(
            () => smartFetch(effectiveUrl, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
            'request'
        );
        if (!res.ok) {
            return { success: false, content: `[OpenAI Error ${res.status}] ${await res.text()}`, _status: res.status };
        }

        const data = await res.json();
        if (_needsResponsesAPI) return parseResponsesAPINonStreamingResponse(data, { showThinking, _requestId: requestId });
        const parsed = parseOpenAINonStreamingResponse(data, { showThinking, _requestId: requestId });
        if (parsed?.success || data?.error) return parsed;
        return { success: false, content: `[OpenAI] Unexpected response (HTTP ${res?.status || '?'})`, _status: res?.status };
    });
}

(async () => {
    try {
        const handleControlMessage = async (msg) => {
            if (!msg || msg.type !== MSG.DYNAMIC_MODELS_REQUEST || !msg.requestId) return;
            try {
                const models = await fetchDynamicOpenAIModels(msg.settings || {});
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
                    error: `[OpenAI] ${e.message}`,
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

        Risu.addPluginChannelListener(CH.FETCH, async (msg) => {
            if (!msg || msg.type !== MSG.FETCH_REQUEST) return;
            const { requestId, modelDef, messages, temperature, maxTokens, args, settings } = msg;
            const ac = new AbortController();
            _pendingAbortControllers.set(requestId, ac);
            try {
                const result = await fetchOpenAI(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal, requestId);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: result });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.ERROR, requestId, error: `[OpenAI] ${e.message}` });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'OpenAI', models, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        setupChannelCleanup(Risu, [CH.ABORT, CH.FETCH]);
        console.log(`[CPM-OpenAI] Provider initialized (registered: ${ok})`);
    } catch (e) { console.error('[CPM-OpenAI] Init failed:', e); }
})();
