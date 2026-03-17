import { parseAndValidate, schemas } from './schema.js';

// ── Standalone constants (importable independently) ──

/** Default slot names for auxiliary settings */
export const AUX_SETTING_SLOTS = ['translation', 'emotion', 'memory', 'other'];

/** Non-cpm-prefixed keys that are still managed by CPM */
export const NON_PREFIX_MANAGED_SETTING_KEYS = [
    'chat_claude_caching',
    'chat_claude_cachingBreakpoints',
    'chat_claude_cachingMaxExtension',
    'common_openai_servicetier',
    'tools_githubCopilotToken',
    'chat_gemini_preserveSystem',
    'chat_gemini_showThoughtsToken',
    'chat_gemini_useThoughtSignature',
    'chat_gemini_usePlainFetch',
    'chat_vertex_preserveSystem',
    'chat_vertex_showThoughtsToken',
    'chat_vertex_useThoughtSignature',
];

/**
 * Generate per-slot auxiliary setting keys.
 * @param {string[]} [slots]
 * @returns {string[]}
 */
export function getAuxSettingKeys(slots) {
    const s = Array.isArray(slots) && slots.length > 0 ? slots : AUX_SETTING_SLOTS;
    return s.flatMap((slot) => [
        `cpm_slot_${slot}`,
        `cpm_slot_${slot}_max_context`,
        `cpm_slot_${slot}_max_out`,
        `cpm_slot_${slot}_temp`,
        `cpm_slot_${slot}_top_p`,
        `cpm_slot_${slot}_top_k`,
        `cpm_slot_${slot}_rep_pen`,
        `cpm_slot_${slot}_freq_pen`,
        `cpm_slot_${slot}_pres_pen`,
    ]);
}

/** Full list of base setting keys (aux + provider + feature keys) */
export const BASE_SETTING_KEYS = [
    ...getAuxSettingKeys(),
    'cpm_custom_models',
    'cpm_fallback_temp',
    'cpm_fallback_max_tokens',
    'cpm_fallback_top_p',
    'cpm_fallback_freq_pen',
    'cpm_fallback_pres_pen',
    'cpm_streaming_enabled',
    'cpm_streaming_show_thinking',
    'cpm_streaming_show_token_usage',
    'cpm_show_token_usage',
    // Anthropic
    'cpm_anthropic_cache_ttl',
    'cpm_anthropic_key',
    'cpm_anthropic_url',
    'cpm_anthropic_model',
    'cpm_anthropic_thinking_budget',
    'cpm_anthropic_thinking_effort',
    'cpm_anthropic_cache_1h',
    'chat_claude_caching',
    'chat_claude_cachingBreakpoints',
    'chat_claude_cachingMaxExtension',
    // OpenAI
    'cpm_openai_key',
    'cpm_openai_url',
    'cpm_openai_model',
    'cpm_openai_reasoning',
    'cpm_openai_verbosity',
    'common_openai_servicetier',
    'cpm_openai_prompt_cache_retention',
    // Gemini
    'cpm_gemini_key',
    'cpm_gemini_model',
    'cpm_gemini_thinking_level',
    'cpm_gemini_thinking_budget',
    'chat_gemini_preserveSystem',
    'chat_gemini_showThoughtsToken',
    'chat_gemini_useThoughtSignature',
    'chat_gemini_usePlainFetch',
    // DeepSeek
    'cpm_deepseek_key',
    'cpm_deepseek_url',
    'cpm_deepseek_model',
    // OpenRouter
    'cpm_openrouter_key',
    'cpm_openrouter_url',
    'cpm_openrouter_model',
    'cpm_openrouter_provider',
    'cpm_openrouter_reasoning',
    // AWS
    'cpm_aws_key',
    'cpm_aws_secret',
    'cpm_aws_region',
    'cpm_aws_thinking_budget',
    'cpm_aws_thinking_effort',
    // Vertex
    'cpm_vertex_key_json',
    'cpm_vertex_location',
    'cpm_vertex_model',
    'cpm_vertex_thinking_level',
    'cpm_vertex_thinking_budget',
    'cpm_vertex_claude_thinking_budget',
    'cpm_vertex_claude_effort',
    'chat_vertex_preserveSystem',
    'chat_vertex_showThoughtsToken',
    'chat_vertex_useThoughtSignature',
    // Dynamic model flags (per-provider)
    'cpm_enable_dynamic_models',
    'cpm_dynamic_openai',
    'cpm_dynamic_anthropic',
    'cpm_dynamic_googleai',
    'cpm_dynamic_vertexai',
    'cpm_dynamic_aws',
    'cpm_dynamic_openrouter',
    'cpm_dynamic_deepseek',
    // Feature flags
    'cpm_enable_chat_resizer',
    'cpm_transcache_display_enabled',
    'cpm_compatibility_mode',
    'cpm_copilot_nodeless_mode',
    // Copilot
    'tools_githubCopilotToken',
];

/**
 * Check whether a key is managed by CPM.
 * @param {string} key
 * @returns {boolean}
 */
export function isManagedSettingKey(key) {
    if (!key || typeof key !== 'string') return false;
    return key.startsWith('cpm_') || key.startsWith('cpm-') || NON_PREFIX_MANAGED_SETTING_KEYS.includes(key);
}

/**
 * Get all managed setting keys, merging base keys with provider-registered keys.
 * @param {Map|Array} [providers] - registered providers (Map or array of [id, prov] pairs)
 * @returns {string[]}
 */
export function getManagedSettingKeys(providers) {
    const keys = new Set(BASE_SETTING_KEYS);
    const entries = providers instanceof Map ? [...providers] : (Array.isArray(providers) ? providers : []);
    for (const [, prov] of entries) {
        if (!Array.isArray(prov?.settingsFields)) continue;
        for (const f of prov.settingsFields) {
            if (f?.key && isManagedSettingKey(f.key)) keys.add(f.key);
        }
    }
    return [...keys];
}

export function createSettingsBackup({ Risu, safeGetArg, slotList, getRegisteredProviders }) {
    const safeSlots = Array.isArray(slotList) && slotList.length > 0 ? slotList : AUX_SETTING_SLOTS;

    return {
        STORAGE_KEY: 'cpm_settings_backup',
        _cache: null,
        _allKeys: null,

        getAllKeys() {
            if (this._allKeys) return this._allKeys;
            const providers = typeof getRegisteredProviders === 'function' ? getRegisteredProviders() : [];
            this._allKeys = [...new Set([
                ...BASE_SETTING_KEYS.filter((key) => !/^cpm_slot_/.test(key)),
                ...getAuxSettingKeys(safeSlots),
                ...getManagedSettingKeys(providers),
            ])];
            return this._allKeys;
        },

        async load() {
            try {
                const raw = await Risu.pluginStorage.getItem(this.STORAGE_KEY);
                if (!raw) {
                    this._cache = {};
                    return this._cache;
                }
                // STB-5: Schema validation on load (from temp_repo)
                const parsed = parseAndValidate(typeof raw === 'string' ? raw : JSON.stringify(raw), schemas.settingsBackup);
                this._cache = parsed.valid && parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
            } catch {
                this._cache = {};
            }
            return this._cache;
        },

        async save() {
            try {
                await Risu.pluginStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._cache || {}));
            } catch (e) {
                console.error('[CPM Backup] save fail', e);
            }
        },

        async updateKey(key, value) {
            if (!this._cache) await this.load();
            this._cache[key] = value;
            await this.save();
        },

        async snapshotAll() {
            this._allKeys = null;
            if (!this._cache) this._cache = {};
            const keys = [...new Set(this.getAllKeys())];
            for (const key of keys) {
                const val = await safeGetArg(key);
                if (val !== undefined && val !== '') this._cache[key] = val;
            }
            await this.save();
            console.log(`[CPM Backup] Snapshot saved (${Object.keys(this._cache).length} keys)`);
            return this._cache;
        },

        async restoreIfEmpty() {
            if (!this._cache) await this.load();
            if (!this._cache || Object.keys(this._cache).length === 0) {
                console.log('[CPM Backup] No backup found');
                return 0;
            }
            let count = 0;
            for (const [key, value] of Object.entries(this._cache)) {
                const current = await safeGetArg(key);
                if ((current === undefined || current === null || current === '') && value !== undefined && value !== '') {
                    Risu.setArgument(key, String(value));
                    count++;
                }
            }
            if (count > 0) console.log(`[CPM Backup] Restored ${count} settings from backup.`);
            return count;
        },
    };
}
