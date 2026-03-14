// dynamic-models.js — Shared: dynamic model discovery formatters and merge helpers

function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}

function dateSuffixFromDashedId(id) {
    const m = String(id || '').match(/-(\d{4})-(\d{2})-(\d{2})$/);
    return m ? ` (${m[1]}/${m[2]}/${m[3]})` : '';
}

function toUniqueKey(model, providerName = '') {
    return model?.uniqueId || `${providerName}::${model?.id || model?.name || ''}`;
}

export function formatOpenAIDynamicModels(items) {
    const INCLUDE_PREFIXES = ['gpt-4', 'gpt-5', 'chatgpt-', 'o1', 'o3', 'o4'];
    const EXCLUDE_KEYWORDS = ['audio', 'realtime', 'search', 'transcribe', 'instruct', 'embedding', 'tts', 'whisper', 'dall-e'];

    return ensureArray(items)
        .filter((m) => {
            const id = String(m?.id || '');
            if (!id) return false;
            const included = INCLUDE_PREFIXES.some((pfx) => id.startsWith(pfx));
            if (!included) return false;
            return !EXCLUDE_KEYWORDS.some((kw) => id.toLowerCase().includes(kw));
        })
        .map((m) => {
            const id = String(m.id);
            let name = id;
            const dashedDate = dateSuffixFromDashedId(id);
            if (dashedDate) {
                name = id.replace(/-\d{4}-\d{2}-\d{2}$/, '') + dashedDate;
            } else if (id.endsWith('-latest')) {
                name = id.replace(/-latest$/, '') + ' (Latest)';
            }
            name = name.replace(/^gpt-/i, 'GPT-').replace(/^chatgpt-/i, 'ChatGPT-');
            return { uniqueId: `openai-${id}`, id, name, provider: 'OpenAI' };
        });
}

export function formatAnthropicDynamicModels(items) {
    return ensureArray(items)
        .filter((m) => m?.type === 'model' && typeof m?.id === 'string' && m.id)
        .map((m) => {
            const id = String(m.id);
            let name = m.display_name || id;
            const compactDate = id.match(/(\d{4})(\d{2})(\d{2})$/);
            if (compactDate) name += ` (${compactDate[1]}/${compactDate[2]}/${compactDate[3]})`;
            return { uniqueId: `anthropic-${id}`, id, name, provider: 'Anthropic' };
        });
}

export function formatGeminiDynamicModels(items) {
    return ensureArray(items)
        .filter((m) => {
            const id = String(m?.name || '').replace('models/', '');
            return !!id && id.startsWith('gemini-') && ensureArray(m?.supportedGenerationMethods).includes('generateContent');
        })
        .map((m) => {
            const id = String(m.name).replace('models/', '');
            return { uniqueId: `google-${id}`, id, name: m.displayName || id, provider: 'GoogleAI' };
        });
}

export function formatDeepSeekDynamicModels(items) {
    return ensureArray(items)
        .filter((m) => typeof m?.id === 'string' && m.id)
        .map((m) => {
            const id = String(m.id);
            let name = id.split('-').map((w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ');
            name = name.replace(/^Deepseek/i, 'DeepSeek');
            return { uniqueId: `deepseek-${id}`, id, name, provider: 'DeepSeek' };
        });
}

export function formatOpenRouterDynamicModels(items) {
    return ensureArray(items)
        .filter((m) => typeof m?.id === 'string' && m.id)
        .map((m) => ({
            uniqueId: `openrouter-${m.id}`,
            id: String(m.id),
            name: m.name || m.id,
            provider: 'OpenRouter',
        }));
}

export function formatVertexGoogleModels(items) {
    return ensureArray(items)
        .map((m) => {
            const id = String(m?.name || '').split('/').pop() || '';
            return { id, raw: m };
        })
        .filter(({ id, raw }) => id.startsWith('gemini-') && (!raw.supportedActions || raw.supportedActions.includes('generateContent')))
        .map(({ id, raw }) => ({ uniqueId: `vertex-${id}`, id, name: raw.displayName || id, provider: 'VertexAI' }));
}

export function formatVertexClaudeModels(items) {
    return ensureArray(items)
        .map((m) => {
            const id = String(m?.name || '').split('/').pop() || '';
            return { id, raw: m };
        })
        .filter(({ id }) => id.startsWith('claude-'))
        .map(({ id, raw }) => {
            let name = raw.displayName || id;
            const compactDate = id.match(/(\d{4})(\d{2})(\d{2})/);
            if (compactDate && !name.includes('/')) name += ` (${compactDate[1]}/${compactDate[2]}/${compactDate[3]})`;
            return { uniqueId: `vertex-${id}`, id, name, provider: 'VertexAI' };
        });
}

export function normalizeAwsAnthropicModelId(rawId) {
    const id = String(rawId || '').trim();
    if (!id) return id;
    if (/^(global|us|eu)\./i.test(id)) return id;
    if (!/anthropic\.claude/i.test(id)) return id;

    let useGlobal = false;
    const datePart = Number((id.match(/(\d{8})/) || [])[0]);
    const versionMatch = id.match(/claude-(?:opus-|sonnet-|haiku-)?(\d+)-(\d+)/i);

    if (Number.isFinite(datePart) && datePart > 0) {
        useGlobal = datePart >= 20250929;
    } else if (versionMatch) {
        const majorVersion = Number(versionMatch[1]);
        const minorVersion = Number(versionMatch[2]);
        useGlobal = (majorVersion > 4) || (majorVersion === 4 && minorVersion >= 5);
    }

    return `${useGlobal ? 'global' : 'us'}.${id}`;
}

export function formatAwsDynamicModels(modelSummaries, inferenceProfiles = []) {
    const results = [];

    for (const m of ensureArray(modelSummaries)) {
        const id = m?.modelId;
        if (!id) continue;
        const outputModes = ensureArray(m?.outputModalities);
        if (!outputModes.includes('TEXT')) continue;
        const inferenceModes = ensureArray(m?.inferenceTypesSupported);
        if (!inferenceModes.includes('ON_DEMAND') && !inferenceModes.includes('INFERENCE_PROFILE')) continue;

        let name = m.modelName || id;
        const provider = m.providerName || '';
        if (provider && !name.toLowerCase().startsWith(provider.toLowerCase())) {
            name = `${provider} ${name}`;
        }

        const normalizedId = normalizeAwsAnthropicModelId(id);
        results.push({ uniqueId: `aws-${normalizedId}`, id: normalizedId, name, provider: 'AWS' });
    }

    for (const p of ensureArray(inferenceProfiles)) {
        const profileId = p?.inferenceProfileId || p?.inferenceProfileArn;
        if (!profileId) continue;
        if (results.some((r) => r.id === profileId)) continue;
        if (!String(profileId).match(/anthropic|claude/i)) continue;
        const name = p.inferenceProfileName || profileId;
        results.push({ uniqueId: `aws-${profileId}`, id: profileId, name: `${name} (Cross-Region)`, provider: 'AWS' });
    }

    return results;
}

export function mergeDynamicModels(existingModels, incomingModels, providerName) {
    const mergedMap = new Map();
    const addedModels = [];

    for (const model of ensureArray(existingModels)) {
        if (!model || typeof model !== 'object') continue;
        const normalized = { ...model, provider: providerName || model.provider };
        mergedMap.set(toUniqueKey(normalized, providerName), normalized);
    }

    for (const model of ensureArray(incomingModels)) {
        if (!model || typeof model !== 'object') continue;
        const hasId = typeof model.id === 'string' && model.id;
        const hasName = typeof model.name === 'string' && model.name;
        if (!hasId || !hasName) continue;
        const normalized = { ...model, provider: providerName || model.provider };
        const key = toUniqueKey(normalized, providerName);
        const exists = mergedMap.has(key);
        mergedMap.set(key, normalized);
        if (!exists) addedModels.push(normalized);
    }

    const mergedModels = Array.from(mergedMap.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return { mergedModels, addedModels };
}
