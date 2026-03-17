/**
 * CPM Provider — AWS Bedrock (V4 Signing, Non-streaming only)
 */
import { MANAGER_NAME, CH, MSG, getRisu, registerWithManager, setupChannelCleanup } from '../shared/ipc-protocol.js';
import { sanitizeBodyJSON } from '../shared/sanitize.js';
import { formatToAnthropic } from '../shared/message-format.js';
import { parseClaudeNonStreamingResponse } from '../shared/sse-parser.js';
import { AwsV4Signer } from '../shared/aws-signer.js';
import { formatAwsDynamicModels, normalizeAwsAnthropicModelId } from '../shared/dynamic-models.js';
import { smartFetch, safeStringify } from '../shared/helpers.js';

const PLUGIN_NAME = 'CPM Provider - AWS Bedrock';
const Risu = getRisu();

const _pendingAbortControllers = new Map();
const AWS_MAX_OUTPUT_TOKENS = 128000;

const AWS_MODELS = [
    { uniqueId: 'aws-global.anthropic.claude-opus-4-6-v1',                  id: 'global.anthropic.claude-opus-4-6-v1',                  name: '[AWS] Claude 4.6 Opus',              provider: 'AWS' },
    { uniqueId: 'aws-global.anthropic.claude-sonnet-4-6',                   id: 'global.anthropic.claude-sonnet-4-6',                   name: '[AWS] Claude 4.6 Sonnet',            provider: 'AWS' },
    { uniqueId: 'aws-global.anthropic.claude-4-5-opus-20251101-v1:0',       id: 'global.anthropic.claude-4-5-opus-20251101-v1:0',       name: '[AWS] Claude 4.5 Opus (20251101)',   provider: 'AWS' },
    { uniqueId: 'aws-global.anthropic.claude-4-5-sonnet-20250929-v1:0',     id: 'global.anthropic.claude-4-5-sonnet-20250929-v1:0',     name: '[AWS] Claude 4.5 Sonnet (20250929)', provider: 'AWS' },
    { uniqueId: 'aws-global.anthropic.claude-4-5-haiku-20251001-v1:0',      id: 'global.anthropic.claude-4-5-haiku-20251001-v1:0',      name: '[AWS] Claude 4.5 Haiku (20251001)',  provider: 'AWS' },
    { uniqueId: 'aws-us.anthropic.claude-4-1-opus-20250805-v1:0',      id: 'us.anthropic.claude-4-1-opus-20250805-v1:0',      name: '[AWS] Claude 4.1 Opus (20250805)',   provider: 'AWS' },
    { uniqueId: 'aws-us.anthropic.claude-4-opus-20250514-v1:0',        id: 'us.anthropic.claude-4-opus-20250514-v1:0',        name: '[AWS] Claude 4 Opus (20250514)',     provider: 'AWS' },
    { uniqueId: 'aws-us.anthropic.claude-4-sonnet-20250514-v1:0',      id: 'us.anthropic.claude-4-sonnet-20250514-v1:0',      name: '[AWS] Claude 4 Sonnet (20250514)',   provider: 'AWS' },
];

const settingsFields = [
    { key: 'cpm_aws_key', label: 'Access Key ID (액세스 키)', type: 'password' },
    { key: 'cpm_aws_secret', label: 'Secret Access Key (시크릿 키, 순서 매칭)', type: 'password' },
    { key: 'cpm_aws_region', label: 'Region (리전, 기본: us-east-1)', type: 'text' },
    { key: 'cpm_aws_thinking_budget', label: 'Thinking Budget Tokens (4.5 이하 모델용, 0은 끄기)', type: 'text' },
    { key: 'cpm_aws_thinking_effort', label: 'Adaptive Thinking Effort (4.6 모델용)', type: 'select',
      options: [{value:'',text:'사용 안함'},{value:'low',text:'Low (낮음)'},{value:'medium',text:'Medium (중간)'},{value:'high',text:'High (높음)'},{value:'max',text:'Max (최대)'}] },
];

function pairKeys(accessKeysRaw, secretKeysRaw) {
    const ak = (accessKeysRaw || '').trim().split(/\s+/).filter(Boolean);
    const sk = (secretKeysRaw || '').trim().split(/\s+/).filter(Boolean);
    if (ak.length === 0 || sk.length === 0) return [];
    if (ak.length !== sk.length) {
        console.warn(`[AWS] ⚠️ Access key count (${ak.length}) ≠ Secret key count (${sk.length}). Keys paired with modulo wrap — verify order.`);
    }
    return ak.map((a, i) => ({ accessKey: a, secretKey: sk[i % sk.length] }));
}

async function fetchDynamicAwsModels(settings = {}) {
    const pairs = pairKeys(settings.cpm_aws_key, settings.cpm_aws_secret);
    const region = settings.cpm_aws_region || '';
    if (pairs.length === 0 || !region) return [];

    let lastError = null;
    for (const pair of pairs.slice(0, Math.min(pairs.length, 10))) {
        try {
            const foundationUrl = `https://bedrock.${region}.amazonaws.com/foundation-models`;
            const signer = new AwsV4Signer({
                method: 'GET',
                url: foundationUrl,
                accessKeyId: pair.accessKey,
                secretAccessKey: pair.secretKey,
                service: 'bedrock',
                region,
            });
            const signed = await signer.sign();
            const signedHeaders = {};
            signed.headers.forEach((v, k) => { signedHeaders[k] = v; });
            const res = await smartFetch(signed.url.toString(), { method: 'GET', headers: signedHeaders });
            if (!res.ok) throw new Error(`[AWS Dynamic ${res.status}] ${await res.text()}`);

            const data = await res.json();
            let profiles = [];
            try {
                const profileUrl = `https://bedrock.${region}.amazonaws.com/inference-profiles`;
                const profileSigner = new AwsV4Signer({
                    method: 'GET',
                    url: profileUrl,
                    accessKeyId: pair.accessKey,
                    secretAccessKey: pair.secretKey,
                    service: 'bedrock',
                    region,
                });
                const profileSigned = await profileSigner.sign();
                const profileHeaders = {};
                profileSigned.headers.forEach((v, k) => { profileHeaders[k] = v; });
                const profileRes = await smartFetch(profileSigned.url.toString(), { method: 'GET', headers: profileHeaders });
                if (profileRes.ok) {
                    const profileData = await profileRes.json();
                    profiles = profileData?.inferenceProfileSummaries || [];
                }
            } catch (e) {
                console.warn('[CPM-AWS] Inference profiles listing not available:', e.message);
            }

            return formatAwsDynamicModels(data?.modelSummaries, profiles);
        } catch (e) {
            lastError = e;
        }
    }

    if (lastError) throw lastError;
    return [];
}

async function fetchAws(modelDef, messages, temp, maxTokens, args, settings, abortSignal, requestId) {
    if (abortSignal?.aborted) return { success: true, content: '' };

    const pairs = pairKeys(settings.cpm_aws_key, settings.cpm_aws_secret);
    if (pairs.length === 0) return { success: false, content: '[AWS] Access/Secret key not configured' };

    const region = settings.cpm_aws_region || 'us-east-1';
    const thinkingBudget = parseInt(settings.cpm_aws_thinking_budget) || 0;
    const thinkingEffort = settings.cpm_aws_thinking_effort || '';
    const showThinking = settings.cpm_streaming_show_thinking === true || settings.cpm_streaming_show_thinking === 'true';
    const clampedMaxTokens = Number.isFinite(maxTokens)
        ? Math.min(maxTokens, AWS_MAX_OUTPUT_TOKENS)
        : maxTokens;
    if (Number.isFinite(maxTokens) && clampedMaxTokens !== maxTokens) {
        console.warn(`[AWS] max_tokens ${maxTokens} → clamped to ${AWS_MAX_OUTPUT_TOKENS} (API limit)`);
    }

    // STB-4: AWS model ID normalization (cross-region prefix auto-detect)
    const modelId = normalizeAwsAnthropicModelId(modelDef.id);
    if (modelId !== modelDef.id) {
        console.log(`[AWS] Normalized model ID: ${modelId}`);
    }

    // Key rotation: shuffle and try each key pair once (up to 10 attempts)
    const maxAttempts = Math.min(pairs.length, 10);
    // Shuffle pairs for fairness (Fisher-Yates)
    for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const pair = pairs[attempt];

        const { messages: chatMessages, system: systemPrompt } = formatToAnthropic(messages, {});

        const body = {
            anthropic_version: 'bedrock-2023-05-31',
            messages: chatMessages,
            max_tokens: clampedMaxTokens || 4096,
        };
        if (temp !== undefined && temp !== null) body.temperature = temp;
        if (args.top_p !== undefined && args.top_p !== null) body.top_p = args.top_p;
        if (args.top_k !== undefined && args.top_k !== null) body.top_k = args.top_k;
        if (systemPrompt) {
            body.system = systemPrompt;
        }

        // Thinking config
        const isAdaptive = modelId.includes('claude-opus-4-6') || modelId.includes('claude-sonnet-4-6');
        if (thinkingEffort && isAdaptive) {
            // Claude 4.6 adaptive thinking: type: 'adaptive' + output_config.effort
            body.thinking = { type: 'adaptive' };
            const effort = ['low', 'medium', 'high', 'max'].includes(thinkingEffort) ? thinkingEffort : 'high';
            body.output_config = { effort };
        } else if (thinkingBudget > 0) {
            body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
            body.max_tokens = Math.max(body.max_tokens, thinkingBudget + 4096);
        }
        if (body.thinking) {
            // Native RisuAI Bedrock path parity:
            // thinking enabled/adaptive 시 temperature=1.0 고정, top_k/top_p 제거
            body.temperature = 1.0;
            delete body.top_k;
            delete body.top_p;
            // Adaptive thinking needs generous max_tokens for thinking + response
            if (body.thinking.type === 'adaptive') {
                body.max_tokens = Math.max(body.max_tokens, 16000);
            }
        }

        // Non-streaming invoke (binary event-stream not parseable in V3 sandbox)
        const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;
        const bodyStr = sanitizeBodyJSON(safeStringify(body));

        // AwsV4Signer expects a single options object; sign() returns { method, url, headers, body }
        const signer = new AwsV4Signer({
            method: 'POST',
            url: url,
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr,
            accessKeyId: pair.accessKey,
            secretAccessKey: pair.secretKey,
            region: region,
            service: 'bedrock',
        });
        const signed = await signer.sign();
        // signed.headers is a Headers instance — convert to plain object for smartFetch
        const signedHeaders = {};
        signed.headers.forEach((v, k) => { signedHeaders[k] = v; });
        signedHeaders['Content-Type'] = 'application/json';

        try {
            const res = await smartFetch(signed.url.toString(), {
                method: 'POST', headers: signedHeaders, body: bodyStr, signal: abortSignal
            });
            if (!res.ok) {
                const errText = await res.text();
                if (res.status === 429 || res.status === 529 || res.status === 503) {
                    console.warn(`[AWS] 🔄 Key pair #${attempt} HTTP ${res.status}, trying next`);
                    if (attempt >= maxAttempts - 1) {
                        return { success: false, content: `[AWS Error ${res.status}] ${errText}`, _status: res.status };
                    }
                    continue;
                }
                return { success: false, content: `[AWS Error ${res.status}] ${errText}`, _status: res.status };
            }
            const data = await res.json();
            if (data?.type === 'error' || data?.error) {
                const status = data?.error?.type === 'throttling' ? 429 : (res?.status || 500);
                if (status === 429 || status === 529 || status === 503) {
                    console.warn(`[AWS] 🔄 Key pair #${attempt} throttled (${status}), trying next`);
                    if (attempt >= maxAttempts - 1) return { success: false, content: `[AWS] ${data.error?.message || JSON.stringify(data.error)}`, _status: status };
                    continue;
                }
                return { success: false, content: `[AWS] ${data.error?.message || JSON.stringify(data.error)}`, _status: status };
            }
            return parseClaudeNonStreamingResponse(data, { showThinking, _requestId: requestId });
        } catch (e) {
            if (abortSignal?.aborted) return { success: true, content: '' };
            const msg = String(e?.message || '');
            const retryable = /timeout|network|fetch|temporar|econn|enotfound|socket|503|529|429/i.test(msg);
            if (retryable && attempt < maxAttempts - 1) {
                console.warn(`[AWS] 🔄 Key pair #${attempt} network error, trying next: ${msg}`);
                continue;
            }
            return { success: false, content: `[AWS] ${msg}` };
        }
    }
    return { success: false, content: '[AWS] All key pairs exhausted' };
}

(async () => {
    try {
        const handleControlMessage = async (msg) => {
            if (!msg || msg.type !== MSG.DYNAMIC_MODELS_REQUEST || !msg.requestId) return;
            try {
                const models = await fetchDynamicAwsModels(msg.settings || {});
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
                    error: `[AWS] ${e.message}`,
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
                const result = await fetchAws(modelDef, messages, temperature, maxTokens, args || {}, settings || {}, ac.signal, requestId);
                Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: result });
            } catch (e) {
                if (ac.signal.aborted) {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE, requestId, data: { success: true, content: '' } });
                } else {
                    Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, { type: MSG.ERROR, requestId, error: `[AWS] ${e.message}` });
                }
            } finally {
                _pendingAbortControllers.delete(requestId);
            }
        });
        const ok = await registerWithManager(Risu, PLUGIN_NAME, { name: 'AWS', models: AWS_MODELS, settingsFields, supportsDynamicModels: true }, { onControlMessage: handleControlMessage });
        setupChannelCleanup(Risu, [CH.ABORT, CH.FETCH]);
        console.log(`[CPM-AWS] Provider initialized (registered: ${ok})`);
    } catch (e) { console.error('[CPM-AWS] Init failed:', e); }
})();
