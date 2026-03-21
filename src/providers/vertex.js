/**
 * CPM Provider — Vertex AI (Gemini + Claude on Vertex)
 * OAuth JWT flow with per-credential token caching
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager, setupChannelCleanup } from '../shared/ipc-protocol.js';
import { KeyPool } from '../shared/key-pool.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToGemini, formatToAnthropic } from '../shared/message-format.js';
import { getGeminiSafetySettings, buildGeminiThinkingConfig, validateGeminiParams, cleanExperimentalModelParams } from '../shared/gemini-helpers.js';
import { createSSEStream, parseGeminiSSELine, createAnthropicSSEStream, parseGeminiNonStreamingResponse, parseClaudeNonStreamingResponse } from '../shared/sse-parser.js';
import { formatVertexGoogleModels, formatVertexClaudeModels } from '../shared/dynamic-models.js';
import { smartFetch, streamingFetch, safeStringify, shouldEnableStreaming } from '../shared/helpers.js';
import { getVertexBearerToken, clearAllTokenCaches as clearVertexTokenCaches } from '../shared/vertex-auth.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseRetryAfterMs(headers) {
    const v = headers?.get?.('retry-after'); if (!v) return 0;
    const n = Number(v); return Number.isFinite(n) ? n * 1000 : 0;
}
function isRetriableStatus(s) { return s === 408 || s === 429 || s === 503 || s === 529 || (s >= 500 && s < 600); }

const PLUGIN_NAME = 'CPM Provider - Vertex AI';
const Risu = getRisu();

const _pendingAbortControllers = new Map();

function getGeminiMaxOutputTokensLimit(modelId) {
    return /gemini-(?:[3-9]|2\.[5-9])/i.test(String(modelId || '')) ? 65536 : 8192;
}

function clampClaudeMaxTokens(maxTokens) {
    return Number.isFinite(maxTokens) ? Math.min(maxTokens, 128000) : maxTokens;
}

const models = [
    // Gemini models
    { uniqueId: 'vertex-gemini-3-pro-preview',       id: 'gemini-3-pro-preview',       name: '[Vertex] Gemini 3 Pro Preview',       provider: 'VertexAI' },
    { uniqueId: 'vertex-gemini-3.1-pro-preview',     id: 'gemini-3.1-pro-preview',     name: '[Vertex] Gemini 3.1 Pro Preview',     provider: 'VertexAI' },
    { uniqueId: 'vertex-gemini-3-flash-preview',     id: 'gemini-3-flash-preview',     name: '[Vertex] Gemini 3 Flash Preview',     provider: 'VertexAI' },
    { uniqueId: 'vertex-gemini-2.5-pro',             id: 'gemini-2.5-pro',             name: '[Vertex] Gemini 2.5 Pro',             provider: 'VertexAI' },
    { uniqueId: 'vertex-gemini-2.5-flash',           id: 'gemini-2.5-flash',           name: '[Vertex] Gemini 2.5 Flash',           provider: 'VertexAI' },
    // Vertex-only Gemini
    { uniqueId: 'vertex-gemini-3-pro-image-preview', id: 'gemini-3-pro-image-preview', name: '[Vertex] Gemini 3 Pro Image Preview', provider: 'VertexAI' },
    // Claude on Vertex
    { uniqueId: 'vertex-claude-sonnet-4-6',  id: 'claude-sonnet-4-6@20260301',  name: '[Vertex] Claude 4.6 Sonnet (2026/03/01)', provider: 'VertexAI' },
    { uniqueId: 'vertex-claude-opus-4-6',    id: 'claude-opus-4-6@20260301',    name: '[Vertex] Claude 4.6 Opus (2026/03/01)',   provider: 'VertexAI' },
    { uniqueId: 'vertex-claude-haiku-4-5',   id: 'claude-haiku-4-5@20251001',   name: '[Vertex] Claude 4.5 Haiku (2025/10/01)',  provider: 'VertexAI' },
    { uniqueId: 'vertex-claude-sonnet-4',    id: 'claude-sonnet-4@20250514',    name: '[Vertex] Claude 4 Sonnet (2025/05/14)',   provider: 'VertexAI' },
    { uniqueId: 'vertex-claude-sonnet-4-5',  id: 'claude-sonnet-4-5@20250929',  name: '[Vertex] Claude 4.5 Sonnet (2025/09/29)', provider: 'VertexAI' },
    { uniqueId: 'vertex-claude-opus-4-1',    id: 'claude-opus-4-1@20250805',    name: '[Vertex] Claude 4.1 Opus (2025/08/05)',   provider: 'VertexAI' },
    { uniqueId: 'vertex-claude-opus-4-5',    id: 'claude-opus-4-5@20251101',    name: '[Vertex] Claude 4.5 Opus (2025/11/01)',   provider: 'VertexAI' },
];

const settingsFields = [
    { key: 'cpm_vertex_key_json', label: 'Service Account JSON Key (여러 개 시 쉼표 구분, 자동 키회전)', type: 'textarea' },
    { key: 'cpm_vertex_location', label: 'Location Endpoint (리전, 예: global, us-central1)', type: 'text' },
    { key: 'cpm_vertex_model', label: 'Model Override (비워두면 기본 모델 사용)', type: 'text' },
    { key: 'cpm_vertex_thinking_level', label: 'Gemini Thinking Level (생각 수준 — Gemini 3용)', type: 'select',
      options: [{value:'off',text:'Off (끄기)'},{value:'none',text:'None (없음)'},{value:'MINIMAL',text:'Minimal (최소)'},{value:'LOW',text:'Low (낮음)'},{value:'MEDIUM',text:'Medium (중간)'},{value:'HIGH',text:'High (높음)'}] },
    { key: 'cpm_vertex_thinking_budget', label: 'Gemini Thinking Budget Tokens (Gemini 2.5용, 0은 끄기)', type: 'text' },
    { key: 'cpm_vertex_claude_thinking_budget', label: 'Claude-on-Vertex Thinking Budget Tokens (4.5 이하용, 0은 끄기)', type: 'text' },
    { key: 'cpm_vertex_claude_effort', label: 'Claude-on-Vertex Adaptive Thinking Effort (4.6 모델용)', type: 'select',
      options: [{value:'',text:'사용 안함'},{value:'low',text:'Low (낮음)'},{value:'medium',text:'Medium (중간)'},{value:'high',text:'High (높음)'},{value:'max',text:'Max (최대)'}] },
    { key: 'chat_vertex_preserveSystem', label: 'System Instruction 유지 (시스템 프롬프트 보존)', type: 'checkbox', defaultValue: true },
    { key: 'chat_vertex_showThoughtsToken', label: 'Thinking 토큰 표시 (생각 토큰 알림)', type: 'checkbox' },
    { key: 'chat_vertex_useThoughtSignature', label: 'Thought Signature 사용 (생각 서명 추출)', type: 'checkbox' },
];

// ── OAuth Token — delegated to shared/vertex-auth.js ──
async function getVertexAccessToken(credJson) {
    const jsonStr = typeof credJson === 'string' ? credJson : JSON.stringify(credJson);
    return getVertexBearerToken(jsonStr);
}

async function fetchDynamicVertexModels(settings = {}) {
    const pool = KeyPool.fromJson(settings.cpm_vertex_key_json);
    const credJson = pool.pick();
    if (!credJson) return [];

    const location = settings.cpm_vertex_location || 'global';
    const { token, projectId } = await getVertexAccessToken(credJson);
    const baseUrl = location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;

    let allGoogleModels = [];
    let pageToken = null;
    let pageCount = 0;
    const MAX_PAGES = 50;
    while (pageCount < MAX_PAGES) {
        pageCount++;
        let url = `${baseUrl}/v1/publishers/google/models?pageSize=100`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const res = await smartFetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) break;
        const data = await res.json();
        if (Array.isArray(data?.models)) allGoogleModels = allGoogleModels.concat(data.models);
        if (!data?.nextPageToken) break;
        pageToken = data.nextPageToken;
    }

    const results = [...formatVertexGoogleModels(allGoogleModels)];

    try {
        const claudeUrl = `${baseUrl}/v1/projects/${projectId}/locations/${location}/publishers/anthropic/models`;
        const claudeRes = await smartFetch(claudeUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (claudeRes.ok) {
            const claudeData = await claudeRes.json();
            results.push(...formatVertexClaudeModels(claudeData?.models));
        }
    } catch (e) {
        console.warn('[CPM-Vertex] Claude model listing not available:', e.message);
    }

    return results;
}

async function fetchVertex(modelDef, messages, temp, maxTokens, args, settings, abortSignal, requestId) {
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pool = KeyPool.fromJson(settings.cpm_vertex_key_json);
    if (pool.remaining === 0) return { success: false, content: '[VertexAI] GCP JSON key not configured' };

    const actualModelId = (settings.cpm_vertex_model || '').trim() || modelDef.id;
    const isClaude = actualModelId.includes('claude');
    const location = settings.cpm_vertex_location || 'us-central1';
    const baseUrl = location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
    const streamingEnabled = shouldEnableStreaming(settings);

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
            console.warn(`[CPM-Vertex] ${label} retry ${attempt}/${maxAttempts - 1} after HTTP ${status}`);
            await sleep(retryDelay);
        }
        return response;
    };

    // Helper: IPC streaming read loop
    const streamViaIpc = async (sseStream) => {
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
            if (e.name !== 'AbortError') console.error('[CPM-Vertex] Stream error:', e.message);
        }
        Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.STREAM_END, requestId });
        return accumulated;
    };

    return pool.withRotation(async (credJson) => {
        const { token, projectId } = await getVertexAccessToken(credJson);
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

        if (isClaude) {
            // Claude-on-Vertex
            const { messages: chatMessages, system: systemPrompt } = formatToAnthropic(messages, {});

            const claudeModelId = actualModelId.replace(/@.*$/, '');
            const clampedMaxTokens = clampClaudeMaxTokens(maxTokens);
            if (Number.isFinite(maxTokens) && clampedMaxTokens !== maxTokens) {
                console.warn(`[Vertex] max_tokens ${maxTokens} → clamped to 128000 for Claude (API limit)`);
            }
            const body = { model: claudeModelId, messages: chatMessages, max_tokens: clampedMaxTokens || 4096, anthropic_version: 'vertex-2023-10-16', stream: streamingEnabled };
            if (temp !== undefined && temp !== null) body.temperature = temp;
            if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
            if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
            if (systemPrompt) body.system = systemPrompt;

            const thinkBudget = parseInt(settings.cpm_vertex_claude_thinking_budget) || 0;
            const claudeEffort = settings.cpm_vertex_claude_effort || '';
            const isClaudeAdaptive = claudeModelId.includes('claude-sonnet-4-6') || claudeModelId.includes('claude-opus-4-6');

            if (claudeEffort && isClaudeAdaptive) {
                body.thinking = { type: 'adaptive' };
                const effort = ['low', 'medium', 'high', 'max'].includes(claudeEffort) ? claudeEffort : 'high';
                body.output_config = { effort };
            } else if (thinkBudget > 0) {
                body.thinking = { type: 'enabled', budget_tokens: thinkBudget };
            }
            if (body.thinking) {
                delete body.temperature;
                delete body.top_k;
                delete body.top_p;
                if (body.thinking.type === 'adaptive') {
                    body.max_tokens = Math.max(body.max_tokens, 16000);
                } else {
                    body.max_tokens = Math.max(body.max_tokens, (body.thinking.budget_tokens || 0) + 4096);
                }
            }

            const betaParts = [];
            if (body.thinking) betaParts.push('interleaved-thinking-2025-05-14');
            if (body.max_tokens > 8192) betaParts.push('output-128k-2025-02-19');
            if (betaParts.length > 0) headers['anthropic-beta'] = betaParts.join(',');

            const showThinking = settings.chat_vertex_showThoughtsToken === true || settings.chat_vertex_showThoughtsToken === 'true';
            const publisher = 'anthropic';
            const url = `${baseUrl}/v1/projects/${projectId}/locations/${location}/publishers/${publisher}/models/${actualModelId}:rawPredict`;
            const safeBody = sanitizeBodyJSON(safeStringify(body));

            if (streamingEnabled) {
                const res = await executeRequest(
                    () => streamingFetch(url, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                    'claude-stream'
                );
                if (!res.ok) {
                    const status = res.status;
                    if (status === 401 || status === 403) {
                        const cacheKey = (typeof credJson === 'string' ? JSON.parse(credJson) : credJson)?.project_id || '';
                        _tokenCaches.delete(cacheKey);
                    }
                    return { success: false, content: `[Vertex Claude Error ${status}] ${await res.text()}`, _status: status };
                }
                const hasBody = !!(res.body && typeof res.body.getReader === 'function');
                if (!hasBody) {
                    const fallbackBody = { ...body, stream: false };
                    const fallbackRes = await executeRequest(
                        () => smartFetch(url, { method: 'POST', headers, body: safeStringify(fallbackBody), signal: abortSignal }),
                        'claude-non-stream fallback'
                    );
                    if (!fallbackRes.ok) return { success: false, content: `[Vertex Claude Error ${fallbackRes.status}] ${await fallbackRes.text()}`, _status: fallbackRes.status };
                    const fallbackData = await fallbackRes.json();
                    return parseClaudeNonStreamingResponse(fallbackData, { showThinking });
                }
                const sseStream = createAnthropicSSEStream(res, abortSignal, { showThinking, _requestId: requestId });
                const accumulated = await streamViaIpc(sseStream);
                return { success: true, content: accumulated, _streamed: true };
            }

            // Non-streaming Claude-on-Vertex
            body.stream = false;
            const res = await executeRequest(
                () => smartFetch(url, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                'claude-request'
            );
            if (!res.ok) {
                const status = res.status;
                if (status === 401 || status === 403) {
                    const cacheKey = (typeof credJson === 'string' ? JSON.parse(credJson) : credJson)?.project_id || '';
                    _tokenCaches.delete(cacheKey);
                }
                return { success: false, content: `[Vertex Claude Error ${status}] ${await res.text()}`, _status: status };
            }
            const data = await res.json();
            if (!data) return { success: false, content: `[VertexAI Claude] Empty response (HTTP ${res?.status || '?'})`, _status: res?.status };
            return parseClaudeNonStreamingResponse(data, { showThinking });
        } else {
            // Gemini-on-Vertex
            const preserveSystem = settings.chat_vertex_preserveSystem !== false && settings.chat_vertex_preserveSystem !== 'false';
            const showThoughts = settings.chat_vertex_showThoughtsToken === true || settings.chat_vertex_showThoughtsToken === 'true';
            const useSignature = settings.chat_vertex_useThoughtSignature === true || settings.chat_vertex_useThoughtSignature === 'true';
            const geminiMaxOutputTokens = getGeminiMaxOutputTokensLimit(actualModelId);
            const clampedMaxTokens = Number.isFinite(maxTokens)
                ? Math.min(maxTokens, geminiMaxOutputTokens)
                : maxTokens;
            if (Number.isFinite(maxTokens) && clampedMaxTokens !== maxTokens) {
                console.warn(`[Vertex] maxOutputTokens ${maxTokens} → clamped to ${geminiMaxOutputTokens} for ${actualModelId} (API limit)`);
            }
            const { contents, systemInstruction: sysArr } = formatToGemini(messages, { preserveSystem, useThoughtSignature: useSignature });

            const gc = { contents, safetySettings: getGeminiSafetySettings(actualModelId), generationConfig: {} };
            if (sysArr && sysArr.length > 0) gc.systemInstruction = { parts: sysArr.map(s => ({ text: s })) };
            if (clampedMaxTokens) gc.generationConfig.maxOutputTokens = clampedMaxTokens;
            if (temp !== undefined && temp !== null) gc.generationConfig.temperature = temp;
            if (args.top_p !== undefined && args.top_p !== null) gc.generationConfig.topP = args.top_p;
            if (args.top_k !== undefined && args.top_k !== null) gc.generationConfig.topK = args.top_k;
            if (args.frequency_penalty !== undefined && args.frequency_penalty !== null) gc.generationConfig.frequencyPenalty = args.frequency_penalty;
            if (args.presence_penalty !== undefined && args.presence_penalty !== null) gc.generationConfig.presencePenalty = args.presence_penalty;

            const thinkingLevel = settings.cpm_vertex_thinking_level || '';
            const thinkingBudget = parseInt(settings.cpm_vertex_thinking_budget) || 0;
            const thinkingConfig = buildGeminiThinkingConfig(actualModelId, thinkingLevel, thinkingBudget, true);
            if (thinkingConfig) gc.generationConfig.thinkingConfig = thinkingConfig;

            validateGeminiParams(gc.generationConfig);
            cleanExperimentalModelParams(gc.generationConfig, actualModelId);

            const isThinkingModel = actualModelId && (/gemini-2\.5|gemini-3/i.test(actualModelId));
            if (isThinkingModel && gc.contents) {
                gc.contents = gc.contents.map(content => ({
                    ...content,
                    parts: content.parts.map(part => {
                        const { thought, ...rest } = part;
                        return rest;
                    }).filter(p => Object.keys(p).length > 0),
                }));
            }

            const publisher = 'google';
            const safeBody = sanitizeBodyJSON(safeStringify(gc));

            if (streamingEnabled) {
                const streamUrl = `${baseUrl}/v1/projects/${projectId}/locations/${location}/publishers/${publisher}/models/${actualModelId}:streamGenerateContent?alt=sse`;
                const res = await executeRequest(
                    () => streamingFetch(streamUrl, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                    'gemini-stream'
                );
                if (!res.ok) {
                    const status = res.status;
                    if (status === 401 || status === 403) {
                        const cacheKey = (typeof credJson === 'string' ? JSON.parse(credJson) : credJson)?.project_id || '';
                        _tokenCaches.delete(cacheKey);
                    }
                    // Region fallback for streaming
                    if (status === 404 || status === 400) {
                        const fallbackRegions = ['us-central1', 'us-east4', 'europe-west1', 'asia-northeast1'].filter(r => r !== location);
                        for (const altRegion of fallbackRegions) {
                            try {
                                const altBaseUrl = altRegion === 'global'
                                    ? 'https://aiplatform.googleapis.com'
                                    : `https://${altRegion}-aiplatform.googleapis.com`;
                                const altStreamUrl = `${altBaseUrl}/v1/projects/${projectId}/locations/${altRegion}/publishers/${publisher}/models/${actualModelId}:streamGenerateContent?alt=sse`;
                                console.log(`[Vertex] Retrying streaming with region: ${altRegion}`);
                                const altRes = await streamingFetch(altStreamUrl, { method: 'POST', headers, body: safeBody, signal: abortSignal });
                                if (altRes.ok && altRes.body && typeof altRes.body.getReader === 'function') {
                                    const config = { showThoughtsToken: showThoughts, useThoughtSignature: useSignature, _requestId: requestId };
                                    const sseStream = createSSEStream(altRes, (line) => parseGeminiSSELine(line, config), abortSignal);
                                    const accumulated = await streamViaIpc(sseStream);
                                    return { success: true, content: accumulated, _streamed: true };
                                }
                            } catch { /* continue to next region */ }
                        }
                    }
                    return { success: false, content: `[Vertex Gemini Error ${status}] ${await res.text()}`, _status: status };
                }
                const hasBody = !!(res.body && typeof res.body.getReader === 'function');
                if (!hasBody) {
                    // Fallback to non-streaming
                    const nonStreamUrl = `${baseUrl}/v1/projects/${projectId}/locations/${location}/publishers/${publisher}/models/${actualModelId}:generateContent`;
                    const fallbackRes = await executeRequest(
                        () => smartFetch(nonStreamUrl, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                        'gemini-non-stream fallback'
                    );
                    if (!fallbackRes.ok) return { success: false, content: `[Vertex Gemini Error ${fallbackRes.status}] ${await fallbackRes.text()}`, _status: fallbackRes.status };
                    const fallbackData = await fallbackRes.json();
                    return parseGeminiNonStreamingResponse(fallbackData, { showThoughtsToken: showThoughts, useThoughtSignature: useSignature });
                }
                const config = { showThoughtsToken: showThoughts, useThoughtSignature: useSignature, _requestId: requestId };
                const sseStream = createSSEStream(res, (line) => parseGeminiSSELine(line, config), abortSignal);
                const accumulated = await streamViaIpc(sseStream);
                return { success: true, content: accumulated, _streamed: true };
            }

            // Non-streaming Gemini
            const url = `${baseUrl}/v1/projects/${projectId}/locations/${location}/publishers/${publisher}/models/${actualModelId}:generateContent`;
            const res = await executeRequest(
                () => smartFetch(url, { method: 'POST', headers, body: safeBody, signal: abortSignal }),
                'gemini-request'
            );
            if (!res.ok) {
                const errText = await res.text();
                const status = res.status;
                if (status === 401 || status === 403) {
                    const cacheKey = (typeof credJson === 'string' ? JSON.parse(credJson) : credJson)?.project_id || '';
                    _tokenCaches.delete(cacheKey);
                }
                if (status === 404 || status === 400) {
                    const fallbackRegions = ['us-central1', 'us-east4', 'europe-west1', 'asia-northeast1'].filter(r => r !== location);
                    for (const altRegion of fallbackRegions) {
                        try {
                            const altBaseUrl = altRegion === 'global'
                                ? 'https://aiplatform.googleapis.com'
                                : `https://${altRegion}-aiplatform.googleapis.com`;
                            const altUrl = `${altBaseUrl}/v1/projects/${projectId}/locations/${altRegion}/publishers/${publisher}/models/${actualModelId}:generateContent`;
                            console.log(`[Vertex] Retrying with region: ${altRegion}`);
                            const altRes = await smartFetch(altUrl, { method: 'POST', headers, body: safeBody, signal: abortSignal });
                            if (altRes.ok) {
                                const altData = await altRes.json();
                                if (altData) return parseGeminiNonStreamingResponse(altData, { showThoughtsToken: showThoughts, useThoughtSignature: useSignature });
                            }
                        } catch { /* continue to next region */ }
                    }
                    const suggestions = fallbackRegions.slice(0, 3).join(', ');
                    return {
                        success: false,
                        content: `[Vertex Gemini Error ${status}] 모델/리전 조합을 찾지 못했습니다. location='${location}', model='${actualModelId}'. 다른 리전을 시도해보세요: ${suggestions}\n\n${errText}`,
                        _status: status
                    };
                }
                return { success: false, content: `[Vertex Gemini Error ${status}] ${errText}`, _status: status };
            }
            const data = await res.json();
            if (!data) return { success: false, content: `[VertexAI Gemini] Empty response (HTTP ${res?.status || '?'})`, _status: res?.status };
            return parseGeminiNonStreamingResponse(data, { showThoughtsToken: showThoughts, useThoughtSignature: useSignature });
        }
    });
}

(async () => {
    try {
        const handleControlMessage = async (msg) => {
            if (!msg || msg.type !== MSG.DYNAMIC_MODELS_REQUEST || !msg.requestId) return;
            try {
                const models = await fetchDynamicVertexModels(msg.settings || {});
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
                    error: `[VertexAI] ${e.message}`,
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
                const result = await fetchVertex(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal, requestId);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: result });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.ERROR, requestId, error: `[VertexAI] ${e.message}` });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'VertexAI', models, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        setupChannelCleanup(Risu, [CH.ABORT, CH.FETCH]);
        console.log(`[CPM-Vertex] Provider initialized (registered: ${ok})`);
    } catch (e) { console.error('[CPM-Vertex] Init failed:', e); }
})();
