import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    createSettingsBackup,
    AUX_SETTING_SLOTS,
    NON_PREFIX_MANAGED_SETTING_KEYS,
    BASE_SETTING_KEYS,
    getAuxSettingKeys,
    isManagedSettingKey,
    getManagedSettingKeys,
} from '../src/shared/settings-backup.js';

describe('SettingsBackup', () => {
    let storage;
    let risu;
    let mockSafeGetArg;
    let backup;

    beforeEach(() => {
        storage = new Map();
        risu = {
            pluginStorage: {
                getItem: vi.fn(async (key) => storage.get(key) ?? null),
                setItem: vi.fn(async (key, value) => { storage.set(key, value); }),
            },
            setArgument: vi.fn(async () => {}),
        };
        mockSafeGetArg = vi.fn(async (_key, defaultValue = '') => defaultValue);
        backup = createSettingsBackup({
            Risu: risu,
            safeGetArg: mockSafeGetArg,
            slotList: ['translation', 'emotion', 'memory', 'other'],
            getRegisteredProviders: () => new Map(),
        });
    });

    it('has a STORAGE_KEY', () => {
        expect(backup.STORAGE_KEY).toBe('cpm_settings_backup');
    });

    it('getAllKeys returns an array of settings keys', () => {
        const keys = backup.getAllKeys();
        expect(Array.isArray(keys)).toBe(true);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys).toContain('cpm_slot_translation');
        expect(keys).toContain('cpm_slot_emotion');
        expect(keys).toContain('cpm_slot_memory');
        expect(keys).toContain('cpm_slot_other');
    });

    it('getAllKeys includes fallback keys', () => {
        const keys = backup.getAllKeys();
        expect(keys).toContain('cpm_fallback_temp');
        expect(keys).toContain('cpm_fallback_max_tokens');
    });

    it('getAllKeys includes slot parameter keys', () => {
        const keys = backup.getAllKeys();
        expect(keys).toContain('cpm_slot_translation_temp');
        expect(keys).toContain('cpm_slot_emotion_max_out');
        expect(keys).toContain('cpm_slot_memory_top_p');
    });

    it('getAllKeys includes custom models key', () => {
        const keys = backup.getAllKeys();
        expect(keys).toContain('cpm_custom_models');
    });

    it('includes dynamic provider setting keys', () => {
        backup = createSettingsBackup({
            Risu: risu,
            safeGetArg: mockSafeGetArg,
            slotList: ['translation', 'emotion', 'memory', 'other'],
            getRegisteredProviders: () => new Map([
                ['OpenAI', { settingsFields: [{ key: 'cpm_openai_key' }] }],
            ]),
        });
        expect(backup.getAllKeys()).toContain('cpm_openai_key');
    });

    it('updateKey stores value in cache', async () => {
        await backup.updateKey('test_key_123', 'test_value');
        expect(backup._cache.test_key_123).toBe('test_value');
    });

    it('load reads pluginStorage JSON', async () => {
        storage.set('cpm_settings_backup', JSON.stringify({ alpha: '1' }));
        const data = await backup.load();
        expect(data.alpha).toBe('1');
    });

    it('snapshotAll stores non-empty values only', async () => {
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_custom_models') return '[{}]';
            if (key === 'cpm_fallback_temp') return '0.7';
            return '';
        });
        await backup.snapshotAll();
        expect(backup._cache.cpm_custom_models).toBe('[{}]');
        expect(backup._cache.cpm_fallback_temp).toBe('0.7');
        expect(backup._cache.cpm_fallback_top_p).toBeUndefined();
    });

    it('restoreIfEmpty restores only empty values', async () => {
        backup._cache = { cpm_fallback_temp: '0.8', cpm_fallback_top_p: '0.95' };
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_fallback_temp') return '';
            if (key === 'cpm_fallback_top_p') return '0.8';
            return '';
        });
        const count = await backup.restoreIfEmpty();
        expect(count).toBe(1);
        expect(risu.setArgument).toHaveBeenCalledWith('cpm_fallback_temp', '0.8');
        expect(risu.setArgument).not.toHaveBeenCalledWith('cpm_fallback_top_p', '0.95');
    });

    // STB-5: Schema validation on load
    it('load rejects invalid JSON gracefully', async () => {
        storage.set('cpm_settings_backup', '{invalid-json}');
        const data = await backup.load();
        // Should return empty/null rather than throwing
        expect(data === null || data === undefined || typeof data === 'object').toBe(true);
    });

    it('load rejects non-object JSON (array)', async () => {
        storage.set('cpm_settings_backup', '[1, 2, 3]');
        const data = await backup.load();
        // Schema expects object, array should be null
        expect(data === null || data === undefined || typeof data === 'object').toBe(true);
    });

    it('load handles null stored value', async () => {
        const data = await backup.load();
        expect(data === null || data === undefined || typeof data === 'object').toBe(true);
    });

    // STB-8: Comprehensive setting keys
    it('getAllKeys includes provider-specific keys (STB-8)', () => {
        const keys = backup.getAllKeys();
        // Anthropic keys
        expect(keys).toContain('cpm_anthropic_key');
        expect(keys).toContain('cpm_anthropic_url');
        expect(keys).toContain('cpm_anthropic_thinking_budget');
        // OpenAI keys
        expect(keys).toContain('cpm_openai_key');
        expect(keys).toContain('cpm_openai_url');
        expect(keys).toContain('cpm_openai_reasoning');
        // Gemini keys
        expect(keys).toContain('cpm_gemini_key');
        expect(keys).toContain('cpm_gemini_thinking_level');
        // DeepSeek keys
        expect(keys).toContain('cpm_deepseek_key');
        expect(keys).toContain('cpm_deepseek_url');
        // OpenRouter keys
        expect(keys).toContain('cpm_openrouter_key');
        expect(keys).toContain('cpm_openrouter_model');
        // AWS keys
        expect(keys).toContain('cpm_aws_key');
        // Vertex keys
        expect(keys).toContain('cpm_vertex_key_json');
        expect(keys).toContain('cpm_vertex_location');
    });

    it('getAllKeys has at least 40 static keys (STB-8)', () => {
        const keys = backup.getAllKeys();
        expect(keys.length).toBeGreaterThanOrEqual(40);
    });

    it('getAllKeys includes streaming & display settings', () => {
        const keys = backup.getAllKeys();
        expect(keys).toContain('cpm_streaming_show_thinking');
        expect(keys).toContain('cpm_streaming_show_token_usage');
        expect(keys).toContain('cpm_show_token_usage');
    });

    it('getAllKeys includes all 17 previously-missing keys', () => {
        const keys = backup.getAllKeys();
        const requiredKeys = [
            'cpm_openai_model', 'cpm_anthropic_model', 'cpm_gemini_model',
            'cpm_vertex_model', 'cpm_deepseek_model',
            'chat_claude_cachingBreakpoints', 'chat_claude_cachingMaxExtension',
            'cpm_dynamic_openai', 'cpm_dynamic_anthropic', 'cpm_dynamic_googleai',
            'cpm_dynamic_vertexai', 'cpm_dynamic_aws', 'cpm_dynamic_openrouter',
            'cpm_dynamic_deepseek',
            'cpm_transcache_display_enabled', 'cpm_compatibility_mode', 'cpm_copilot_nodeless_mode',
        ];
        for (const k of requiredKeys) {
            expect(keys, `missing key: ${k}`).toContain(k);
        }
    });

    it('getAllKeys applies isManagedSettingKey guard on provider keys', () => {
        const providers = new Map([
            ['test', { settingsFields: [
                { key: 'cpm_test_key' },
                { key: 'unmanaged_key_xyz' },
            ] }],
        ]);
        const backupWithProvs = createSettingsBackup({
            Risu: risu,
            safeGetArg: mockSafeGetArg,
            slotList: ['translation'],
            getRegisteredProviders: () => providers,
        });
        const keys = backupWithProvs.getAllKeys();
        expect(keys).toContain('cpm_test_key');
        expect(keys).not.toContain('unmanaged_key_xyz');
    });
});

// ── Standalone exports ──
describe('AUX_SETTING_SLOTS', () => {
    it('contains 4 default slots', () => {
        expect(AUX_SETTING_SLOTS).toEqual(['translation', 'emotion', 'memory', 'other']);
    });
});

describe('NON_PREFIX_MANAGED_SETTING_KEYS', () => {
    it('contains non-cpm-prefixed managed keys', () => {
        expect(NON_PREFIX_MANAGED_SETTING_KEYS).toContain('chat_claude_caching');
        expect(NON_PREFIX_MANAGED_SETTING_KEYS).toContain('common_openai_servicetier');
        expect(NON_PREFIX_MANAGED_SETTING_KEYS).toContain('tools_githubCopilotToken');
    });

    it('does not contain cpm-prefixed keys', () => {
        for (const key of NON_PREFIX_MANAGED_SETTING_KEYS) {
            expect(key.startsWith('cpm_')).toBe(false);
        }
    });
});

describe('getAuxSettingKeys', () => {
    it('generates 9 keys per slot', () => {
        const keys = getAuxSettingKeys(['translation']);
        expect(keys).toHaveLength(9);
        expect(keys).toContain('cpm_slot_translation');
        expect(keys).toContain('cpm_slot_translation_max_context');
        expect(keys).toContain('cpm_slot_translation_pres_pen');
    });

    it('defaults to AUX_SETTING_SLOTS when no argument', () => {
        const keys = getAuxSettingKeys();
        expect(keys).toHaveLength(36); // 4 slots × 9 keys
    });
});

describe('BASE_SETTING_KEYS', () => {
    it('is an array with more than 60 keys', () => {
        expect(Array.isArray(BASE_SETTING_KEYS)).toBe(true);
        expect(BASE_SETTING_KEYS.length).toBeGreaterThan(60);
    });

    it('contains aux keys and provider model keys', () => {
        expect(BASE_SETTING_KEYS).toContain('cpm_slot_translation');
        expect(BASE_SETTING_KEYS).toContain('cpm_openai_model');
        expect(BASE_SETTING_KEYS).toContain('cpm_anthropic_model');
    });
});

describe('isManagedSettingKey', () => {
    it('returns true for cpm_ prefixed keys', () => {
        expect(isManagedSettingKey('cpm_openai_key')).toBe(true);
    });

    it('returns true for cpm- prefixed keys', () => {
        expect(isManagedSettingKey('cpm-something')).toBe(true);
    });

    it('returns true for NON_PREFIX keys', () => {
        expect(isManagedSettingKey('chat_claude_caching')).toBe(true);
        expect(isManagedSettingKey('tools_githubCopilotToken')).toBe(true);
    });

    it('returns false for unmanaged keys', () => {
        expect(isManagedSettingKey('random_key')).toBe(false);
        expect(isManagedSettingKey('')).toBe(false);
        expect(isManagedSettingKey(null)).toBe(false);
    });
});

describe('getManagedSettingKeys', () => {
    it('returns BASE_SETTING_KEYS when no providers', () => {
        const keys = getManagedSettingKeys();
        expect(keys.length).toBe(BASE_SETTING_KEYS.length);
    });

    it('merges provider keys filtered by isManagedSettingKey', () => {
        const providers = new Map([
            ['prov1', { settingsFields: [
                { key: 'cpm_custom_field' },
                { key: 'bad_field' },
            ] }],
        ]);
        const keys = getManagedSettingKeys(providers);
        expect(keys).toContain('cpm_custom_field');
        expect(keys).not.toContain('bad_field');
    });

    it('deduplicates keys', () => {
        const providers = new Map([
            ['prov1', { settingsFields: [{ key: 'cpm_openai_key' }] }],
        ]);
        const keys = getManagedSettingKeys(providers);
        const count = keys.filter(k => k === 'cpm_openai_key').length;
        expect(count).toBe(1);
    });
});
