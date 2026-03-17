/**
 * CPM Provider — Gemini (Google AI Studio)
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager, setupChannelCleanup } from '../shared/ipc-protocol.js';
import { KeyPool } from '../shared/key-pool.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToGemini } from '../shared/message-format.js';
import { getGeminiSafetySettings, buildGeminiThinkingConfig, validateGeminiParams, cleanExperimentalModelParams } from '../shared/gemini-helpers.js';
import { createSSEStream, parseGeminiSSELine, parseGeminiNonStreamingResponse } from '../shared/sse-parser.js';
import { formatGeminiDynamicModels } from '../shared/dynamic-models.js';
import { smartFetch, streamingFetch, safeStringify, shouldEnableStreaming } from '../shared/helpers.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseRetryAfterMs(headers) {
    const v = headers?.get?.('retry-after'); if (!v) return 0;
    const n = Number(v); return Number.isFinite(n) ? n * 1000 : 0;
}
function isRetriableStatus(s) { return s === 408 || s === 429 || s === 503 || s === 529 || (s >= 500 && s < 600); }

const PLUGIN_NAME = 'CPM Provider - Gemini';
const Risu = getRisu();

const _pendingAbortControllers = new Map();

function getGeminiMaxOutputTokensLimit(modelId) {
    return /gemini-(?:[3-9]|2\.[5-9])/i.test(String(modelId || '')) ? 65536 : 8192;
}

const models = [
    { uniqueId: 'google-gemini-3-pro-preview',     id: 'gemini-3-pro-preview',     name: 'Gemini 3 Pro Preview',     provider: 'GoogleAI' },
    { uniqueId: 'google-gemini-3.1-pro-preview',   id: 'gemini-3.1-pro-preview',   name: 'Gemini 3.1 Pro Preview',   provider: 'GoogleAI' },
    { uniqueId: 'google-gemini-3-flash-preview',   id: 'gemini-3-flash-preview',   name: 'Gemini 3 Flash Preview',   provider: 'GoogleAI' },
    { uniqueId: 'google-gemini-2.5-pro',           id: 'gemini-2.5-pro',           name: 'Gemini 2.5 Pro',           provider: 'GoogleAI' },
    { uniqueId: 'google-gemini-2.5-flash',         id: 'gemini-2.5-flash',         name: 'Gemini 2.5 Flash',         provider: 'GoogleAI' },
];

const settingsFields = [
    { key: 'cpm_gemini_key', label: 'API Key (여러 개 시 공백/줄바꿈 구분, 자동 키회전)', type: 'password' },
    { key: 'cpm_gemini_model', label: 'Model Override (비워두면 기본 모델 사용)', type: 'text' },
    { key: 'cpm_gemini_thinking_level', label: 'Thinking Level (생각 수준 — Gemini 3용)', type: 'select',
      options: [{value:'off',text:'Off (끄기)'},{value:'none',text:'None (없음)'},{value:'MINIMAL',text:'Minimal (최소)'},{value:'LOW',text:'Low (낮음)'},{value:'MEDIUM',text:'Medium (중간)'},{value:'HIGH',text:'High (높음)'}] },
    { key: 'cpm_gemini_thinking_budget', label: 'Thinking Budget Tokens (Gemini 2.5용, 0은 끄기)', type: 'text' },
    { key: 'chat_gemini_preserveSystem', label: 'System Instruction 유지 (시스템 프롬프트 보존)', type: 'checkbox', defaultValue: true },
    { key: 'chat_gemini_showThoughtsToken', label: 'Thinking 토큰 표시 (생각 토큰 알림)', type: 'checkbox' },
    { key: 'chat_gemini_useThoughtSignature', label: 'Thought Signature 사용 (생각 서명 추출)', type: 'checkbox' },
    { key: 'chat_gemini_usePlainFetch', label: 'Use Plain Fetch (직접 요청 — 프록시 우회)', type: 'checkbox' },
];

async function fetchDynamicGeminiModels(settings = {}) {
    const pool = new KeyPool(settings.cpm_gemini_key);
    const apiKey = pool.pick();
    if (!apiKey) return [];

    let allModels = [];
    let pageToken = null;
    let pageCount = 0;
    const MAX_PAGES = 50;

    while (pageCount < MAX_PAGES) {
        pageCount++;
        let url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

        const res = await smartFetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`[Gemini Dynamic ${res.status}] ${await res.text()}`);
        const data = await res.json();
        if (Array.isArray(data?.models)) allModels = allModels.concat(data.models);
        if (!data?.nextPageToken) break;
        pageToken = data.nextPageToken;
    }

    return formatGeminiDynamicModels(allModels);
}

async function fetchGemini(modelDef, messages, temp, maxTokens, args, settings, abortSignal, requestId) {
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pool = new KeyPool(settings.cpm_gemini_key);
    if (pool.remaining === 0) return { success: false, content: '[Gemini] API key not configured' };

    return pool.withRotation(async (apiKey) => {
        const modelId = (settings.cpm_gemini_model || '').trim() || modelDef.id;
        const geminiMaxOutputTokens = getGeminiMaxOutputTokensLimit(modelId);
        const clampedMaxTokens = Number.isFinite(maxTokens)
            ? Math.min(maxTokens, geminiMaxOutputTokens)
            : maxTokens;
        if (Number.isFinite(maxTokens) && clampedMaxTokens !== maxTokens) {
            console.warn(`[Gemini] maxOutputTokens ${maxTokens} → clamped to ${geminiMaxOutputTokens} for ${modelId} (API limit)`);
        }
        const preserveSystem = settings.chat_gemini_preserveSystem !== false && settings.chat_gemini_preserveSystem !== 'false';
        const showThoughts = settings.chat_gemini_showThoughtsToken === true || settings.chat_gemini_showThoughtsToken === 'true';
        const useSignature = settings.chat_gemini_useThoughtSignature === true || settings.chat_gemini_useThoughtSignature === 'true';
        const streamingEnabled = shouldEnableStreaming(settings);

        const { contents, systemInstruction: sysArr } = formatToGemini(messages, { preserveSystem, useThoughtSignature: useSignature });

        const gc = {
            contents,
            safetySettings: getGeminiSafetySettings(modelId),
            generationConfig: {}
        };
        if (sysArr && sysArr.length > 0) gc.systemInstruction = { parts: sysArr.map(s => ({ text: s })) };
        if (clampedMaxTokens) gc.generationConfig.maxOutputTokens = clampedMaxTokens;
        if (temp !== undefined && temp !== null) gc.generationConfig.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) gc.generationConfig.topP = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) gc.generationConfig.topK = args.top_k;
        if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) gc.generationConfig.frequencyPenalty = args.frequency_penalty;
        if (args.presence_penalty !== undefined && args.presence_penalty !== null) gc.generationConfig.presencePenalty = args.presence_penalty;

        const thinkingLevel = settings.cpm_gemini_thinking_level || '';
        const thinkingBudget = parseInt(settings.cpm_gemini_thinking_budget) || 0;
        const thinkingConfig = buildGeminiThinkingConfig(modelId, thinkingLevel, thinkingBudget, false);
        if (thinkingConfig) gc.generationConfig.thinkingConfig = thinkingConfig;

        validateGeminiParams(gc.generationConfig);
        cleanExperimentalModelParams(gc.generationConfig, modelId);

        // Strip thought:true from historical parts for thinking models
        const isThinkingModel = modelId && (/gemini-2\.5|gemini-3/i.test(modelId));
        if (isThinkingModel && gc.contents) {
            gc.contents = gc.contents.map(content => ({
                ...content,
                parts: content.parts.map(part => {
                    const { thought, ...rest } = part;
                    return rest;
                }),
            }));
        }

        const baseModelUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}`;
        const usePlainFetch = settings.chat_gemini_usePlainFetch === true || settings.chat_gemini_usePlainFetch === 'true';
        const safeBody = sanitizeBodyJSON(safeStringify(gc));
        const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };

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
                console.warn(`[CPM-Gemini] ${label} retry ${attempt}/${maxAttempts - 1} after HTTP ${status}`);
                await sleep(retryDelay);
            }
            return response;
        };

        if (streamingEnabled) {
            const streamUrl = `${baseModelUrl}:streamGenerateContent?alt=sse`;
            const fetchOpts = { method: 'POST', headers, body: safeBody, signal: abortSignal };
            if (usePlainFetch) fetchOpts.plainFetchForce = true;

            const res = await executeRequest(
                () => streamingFetch(streamUrl, fetchOpts),
                'streaming'
            );
            if (!res.ok) return { success: false, content: `[Gemini Error ${res.status}] ${await res.text()}`, _status: res.status };

            const hasBody = !!(res.body && typeof res.body.getReader === 'function');
            if (!hasBody) {
                // Fallback to non-streaming
                const nonStreamUrl = `${baseModelUrl}:generateContent`;
                const fallbackOpts = { method: 'POST', headers, body: safeBody, signal: abortSignal };
                if (usePlainFetch) fallbackOpts.plainFetchForce = true;
                const fallbackRes = await executeRequest(
                    () => smartFetch(nonStreamUrl, fallbackOpts),
                    'non-stream fallback'
                );
                if (!fallbackRes.ok) return { success: false, content: `[Gemini Error ${fallbackRes.status}] ${await fallbackRes.text()}`, _status: fallbackRes.status };
                const fallbackData = await fallbackRes.json();
                return parseGeminiNonStreamingResponse(fallbackData, { showThoughtsToken: showThoughts, useThoughtSignature: useSignature });
            }

            const config = { showThoughtsToken: showThoughts, useThoughtSignature: useSignature, _requestId: requestId };
            const sseStream = createSSEStream(res, (line) => parseGeminiSSELine(line, config), abortSignal);
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
                if (e.name !== 'AbortError') console.error('[CPM-Gemini] Stream error:', e.message);
            }
            Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.STREAM_END, requestId });
            return { success: true, content: accumulated, _streamed: true };
        }

        // Non-streaming
        const url = `${baseModelUrl}:generateContent`;
        const fetchOptions = { method: 'POST', headers, body: safeBody, signal: abortSignal };
        if (usePlainFetch) fetchOptions.plainFetchForce = true;

        const res = await executeRequest(
            () => smartFetch(url, fetchOptions),
            'request'
        );

        if (!res.ok) {
            return { success: false, content: `[Gemini Error ${res.status}] ${await res.text()}`, _status: res.status };
        }
        const data = await res.json();
        if (!data) return { success: false, content: `[Gemini] Empty response (HTTP ${res?.status || '?'})`, _status: res?.status };
        return parseGeminiNonStreamingResponse(data, { showThoughtsToken: showThoughts, useThoughtSignature: useSignature });
    });
}

(async () => {
    try {
        const handleControlMessage = async (msg) => {
            if (!msg || msg.type !== MSG.DYNAMIC_MODELS_REQUEST || !msg.requestId) return;
            try {
                const models = await fetchDynamicGeminiModels(msg.settings || {});
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
                    error: `[Gemini] ${e.message}`,
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
                const result = await fetchGemini(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal, requestId);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: result });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.ERROR, requestId, error: `[Gemini] ${e.message}` });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'GoogleAI', models, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        setupChannelCleanup(Risu, [CH.ABORT, CH.FETCH]);
        console.log(`[CPM-Gemini] Provider initialized (registered: ${ok})`);
    } catch (e) { console.error('[CPM-Gemini] Init failed:', e); }
})();
