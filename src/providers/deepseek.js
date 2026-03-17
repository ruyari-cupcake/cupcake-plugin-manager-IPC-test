/**
 * CPM Provider — DeepSeek
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager, setupChannelCleanup } from '../shared/ipc-protocol.js';
import { KeyPool } from '../shared/key-pool.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToOpenAI } from '../shared/message-format.js';
import { createOpenAISSEStream, parseOpenAINonStreamingResponse } from '../shared/sse-parser.js';
import { formatDeepSeekDynamicModels } from '../shared/dynamic-models.js';
import { smartFetch, streamingFetch, safeStringify, shouldEnableStreaming } from '../shared/helpers.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseRetryAfterMs(headers) {
    const v = headers?.get?.('retry-after'); if (!v) return 0;
    const n = Number(v); return Number.isFinite(n) ? n * 1000 : 0;
}
function isRetriableStatus(s) { return s === 408 || s === 429 || s === 503 || s === 529 || (s >= 500 && s < 600); }

const PLUGIN_NAME = 'CPM Provider - DeepSeek';
const Risu = getRisu();

const _pendingAbortControllers = new Map();

const models = [
    { uniqueId: 'cpm-deepseek-chat',     id: 'deepseek-chat',     name: 'DeepSeek Chat',     provider: 'DeepSeek' },
    { uniqueId: 'cpm-deepseek-reasoner', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'DeepSeek' },
];

const settingsFields = [
    { key: 'cpm_deepseek_key', label: 'API Key (여러 개 시 공백/줄바꿈 구분, 자동 키회전)', type: 'password' },
    { key: 'cpm_deepseek_url', label: 'Custom Base URL (비워두면 기본값)', type: 'text' },
    { key: 'cpm_deepseek_model', label: 'Model Override (비워두면 기본 모델 사용)', type: 'text' },
];

async function fetchDynamicDeepSeekModels(settings = {}) {
    const pool = new KeyPool(settings.cpm_deepseek_key);
    const apiKey = pool.pick();
    if (!apiKey) return [];

    const baseUrl = (settings.cpm_deepseek_url || 'https://api.deepseek.com').replace(/\/+$/, '');
    const res = await smartFetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`[DeepSeek Dynamic ${res.status}] ${await res.text()}`);
    const data = await res.json();
    return formatDeepSeekDynamicModels(data?.data);
}

async function fetchDeepSeek(modelDef, messages, temp, maxTokens, args, settings, abortSignal, requestId) {
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pool = new KeyPool(settings.cpm_deepseek_key);
    if (pool.remaining === 0) return { success: false, content: '[DeepSeek] API key not configured' };

    return pool.withRotation(async (apiKey) => {
        const baseUrl = (settings.cpm_deepseek_url || 'https://api.deepseek.com').replace(/\/+$/, '');
        const actualModelId = (settings.cpm_deepseek_model || '').trim() || modelDef.id;
        const formatted = formatToOpenAI(messages, {});
        const showThinking = settings.cpm_streaming_show_thinking === true || settings.cpm_streaming_show_thinking === 'true';
        const streamingEnabled = shouldEnableStreaming(settings);
        const isReasoner = /deepseek-reasoner/i.test(actualModelId);

        /** @type {Record<string, any>} */
        const body = { model: actualModelId, messages: formatted };
        if (streamingEnabled) body.stream = true;

        const maxTokensLimit = isReasoner ? 65536 : 8192;
        const clampedMaxTokens = maxTokens ? Math.min(maxTokens, maxTokensLimit) : undefined;
        if (clampedMaxTokens) body.max_tokens = clampedMaxTokens;

        if (!isReasoner) {
            if (temp !== undefined && temp !== null) body.temperature = temp;
            if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
            if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) body.frequency_penalty = args.frequency_penalty;
            if (args.presence_penalty !== undefined && args.presence_penalty !== null) body.presence_penalty = args.presence_penalty;
        }

        const showTokenUsage =
            settings.cpm_streaming_show_token_usage === true || settings.cpm_streaming_show_token_usage === 'true' ||
            settings.cpm_show_token_usage === true || settings.cpm_show_token_usage === 'true';
        if (streamingEnabled && showTokenUsage) body.stream_options = { include_usage: true };

        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        const safeBody = sanitizeBodyJSON(safeStringify(body));

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
                console.warn(`[CPM-DeepSeek] ${label} retry ${attempt}/${maxAttempts - 1} after HTTP ${status}`);
                await sleep(retryDelay);
            }
            return response;
        };

        if (streamingEnabled) {
            const res = await executeRequest(
                () => streamingFetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                'streaming'
            );
            if (!res.ok) return { success: false, content: `[DeepSeek Error ${res.status}] ${await res.text()}`, _status: res.status };

            const hasBody = !!(res.body && typeof res.body.getReader === 'function');
            if (!hasBody) {
                /** @type {Record<string, any>} */
                const fallbackBody = { ...body, stream: false };
                delete fallbackBody.stream_options;
                const fallbackRes = await executeRequest(
                    () => smartFetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: safeStringify(fallbackBody), signal: abortSignal }),
                    'non-stream fallback'
                );
                if (!fallbackRes.ok) return { success: false, content: `[DeepSeek Error ${fallbackRes.status}] ${await fallbackRes.text()}`, _status: fallbackRes.status };
                const fallbackData = await fallbackRes.json();
                return parseOpenAINonStreamingResponse(fallbackData, { showThinking, _requestId: requestId });
            }

            const sseStream = createOpenAISSEStream(res, abortSignal, { showThinking, _requestId: requestId });
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
                if (e.name !== 'AbortError') console.error('[CPM-DeepSeek] Stream error:', e.message);
            }
            Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.STREAM_END, requestId });
            return { success: true, content: accumulated, _streamed: true };
        }

        // Non-streaming
        const res = await executeRequest(
            () => smartFetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
            'request'
        );
        if (!res.ok) {
            return { success: false, content: `[DeepSeek Error ${res.status}] ${await res.text()}`, _status: res.status };
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
                const models = await fetchDynamicDeepSeekModels(msg.settings || {});
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
                    error: `[DeepSeek] ${e.message}`,
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
                const result = await fetchDeepSeek(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal, requestId);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: result });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.ERROR, requestId, error: `[DeepSeek] ${e.message}` });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'DeepSeek', models, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        setupChannelCleanup(Risu, [CH.ABORT, CH.FETCH]);
        console.log(`[CPM-DeepSeek] Provider initialized (registered: ${ok})`);
    } catch (e) { console.error('[CPM-DeepSeek] Init failed:', e); }
})();
