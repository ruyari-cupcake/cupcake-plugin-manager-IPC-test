// @ts-check
/**
 * custom-model-serialization.js — Custom endpoint model parsing/normalization.
 *
 * Migrated from temp_repo (custom-model-serialization.js).
 * Used for import/export and settings persistence of custom model definitions.
 */

const CUSTOM_MODEL_DEFAULTS = {
    streaming: false,
};

/** @param {any} value */
function toText(value) {
    return value == null ? '' : String(value);
}

/** @param {any} value */
function toInteger(value) {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** @param {any} value */
function toBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
}

/**
 * Parse a raw custom models value (JSON string or array) into an array of objects.
 * @param {any} value
 * @returns {Array<Record<string, any>>}
 */
export function parseCustomModelsValue(value) {
    if (Array.isArray(value)) return value.filter(entry => entry && typeof entry === 'object');
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry === 'object') : [];
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * Normalize a single custom model entry into a canonical shape.
 * @param {Record<string, any>} raw
 * @param {{ includeKey?: boolean, includeUniqueId?: boolean, includeTag?: boolean, includeExportMarker?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function normalizeCustomModel(raw, options = {}) {
    const {
        includeKey = true,
        includeUniqueId = true,
        includeTag = true,
        includeExportMarker = false,
    } = options;

    const hasStreaming = raw && Object.prototype.hasOwnProperty.call(raw, 'streaming');
    const hasDecoupled = raw && Object.prototype.hasOwnProperty.call(raw, 'decoupled');
    const streaming = hasStreaming ? toBool(raw.streaming) : (hasDecoupled ? !toBool(raw.decoupled) : CUSTOM_MODEL_DEFAULTS.streaming);
    const decoupled = hasDecoupled ? toBool(raw.decoupled) : !streaming;

    /** @type {Record<string, any>} */
    const normalized = {
        name: toText(raw?.name),
        model: toText(raw?.model),
        url: toText(raw?.url),
        proxyUrl: toText(raw?.proxyUrl).trim(),
        format: toText(raw?.format || 'openai') || 'openai',
        tok: toText(raw?.tok || 'o200k_base') || 'o200k_base',
        responsesMode: toText(raw?.responsesMode || 'auto') || 'auto',
        thinking: toText(raw?.thinking || 'none') || 'none',
        thinkingBudget: toInteger(raw?.thinkingBudget),
        maxOutputLimit: toInteger(raw?.maxOutputLimit),
        promptCacheRetention: toText(raw?.promptCacheRetention || 'none') || 'none',
        reasoning: toText(raw?.reasoning || 'none') || 'none',
        verbosity: toText(raw?.verbosity || 'none') || 'none',
        effort: toText(raw?.effort || 'none') || 'none',
        sysfirst: toBool(raw?.sysfirst),
        mergesys: toBool(raw?.mergesys),
        altrole: toBool(raw?.altrole),
        mustuser: toBool(raw?.mustuser),
        maxout: toBool(raw?.maxout),
        streaming,
        decoupled,
        thought: toBool(raw?.thought),
        adaptiveThinking: toBool(raw?.adaptiveThinking),
        customParams: toText(raw?.customParams),
    };

    if (includeKey) normalized.key = toText(raw?.key);
    if (includeUniqueId && raw?.uniqueId) normalized.uniqueId = toText(raw.uniqueId);
    if (includeTag && raw?._tag) normalized._tag = raw._tag;
    if (includeExportMarker) normalized._cpmModelExport = true;

    return normalized;
}

/**
 * Serialize a custom model for export (strip internal fields, add export marker).
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
export function serializeCustomModelExport(raw) {
    return normalizeCustomModel(raw, {
        includeKey: false,
        includeUniqueId: false,
        includeTag: false,
        includeExportMarker: true,
    });
}

/**
 * Serialize a full custom models setting for persistence.
 * @param {any} value
 * @param {{ includeKey?: boolean }} [options]
 * @returns {string}
 */
export function serializeCustomModelsSetting(value, options = {}) {
    const { includeKey = false } = options;
    return JSON.stringify(parseCustomModelsValue(value).map(model => normalizeCustomModel(model, { includeKey })));
}
