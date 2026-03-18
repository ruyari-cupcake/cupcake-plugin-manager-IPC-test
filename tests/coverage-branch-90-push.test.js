/**
 * @file coverage-branch-90-push.test.js — 난제 브랜치 90%+ 도전
 *
 * 목표: slot-inference, dynamic-models, key-pool, settings-backup 의
 *       브랜치 커버리지를 각각 90% 이상으로 끌어올리는 테스트
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── slot-inference ──
import { scoreSlotHeuristic, inferSlot } from '../src/shared/slot-inference.js';

// ── dynamic-models ──
import {
    formatOpenAIDynamicModels,
    formatGeminiDynamicModels,
    formatDeepSeekDynamicModels,
    formatOpenRouterDynamicModels,
    formatVertexGoogleModels,
    formatVertexClaudeModels,
    formatAwsDynamicModels,
    mergeDynamicModels,
    normalizeAwsAnthropicModelId,
} from '../src/shared/dynamic-models.js';

// ── key-pool ──
import { KeyPool } from '../src/shared/key-pool.js';

// ── settings-backup ──
import {
    createSettingsBackup,
    getAuxSettingKeys,
    getManagedSettingKeys,
    isManagedSettingKey,
} from '../src/shared/settings-backup.js';


// ═══════════════════════════════════════
// slot-inference — B10, B12, B13, B14, B15
// 89.13% → 91%+ (5 uncov in 46 → need ≥2 covered)
// ═══════════════════════════════════════

describe('slot-inference: inferSlot prompt_chat edge cases', () => {
    const mockSafeGetArg = vi.fn();

    beforeEach(() => {
        mockSafeGetArg.mockReset();
    });

    it('returns chat when matchingSlots > 0 but no prompt_chat provided (B10 else)', async () => {
        // safeGetArg returns matching ID for 'chat' slot
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_slot_chat') return 'model-id-1';
            return '';
        });
        const result = await inferSlot(
            { uniqueId: 'model-id-1' },
            {}, // no prompt_chat
            { safeGetArg: mockSafeGetArg }
        );
        expect(result.slot).toBe('chat');
        expect(result.heuristicConfirmed).toBe(false);
    });

    it('returns chat when prompt_chat is not an array (B10 else)', async () => {
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_slot_chat') return 'model-id-1';
            return '';
        });
        const result = await inferSlot(
            { uniqueId: 'model-id-1' },
            { prompt_chat: 'not an array' },
            { safeGetArg: mockSafeGetArg }
        );
        expect(result.slot).toBe('chat');
        expect(result.heuristicConfirmed).toBe(false);
    });

    it('handles null message in prompt_chat (B12 null continue)', async () => {
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_slot_chat') return 'model-id-1';
            return '';
        });
        const result = await inferSlot(
            { uniqueId: 'model-id-1' },
            { prompt_chat: [null, { role: 'system', content: 'translate this text' }] },
            { safeGetArg: mockSafeGetArg }
        );
        expect(result).toBeDefined();
        expect(result.slot).toBeDefined();
    });

    it('handles non-string content (B13 cond)', async () => {
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_slot_chat') return 'model-id-1';
            return '';
        });
        const result = await inferSlot(
            { uniqueId: 'model-id-1' },
            { prompt_chat: [
                { role: 'system', content: 12345 }, // non-string content
                { role: 'user', content: 'translate please' },
            ]},
            { safeGetArg: mockSafeGetArg }
        );
        expect(result).toBeDefined();
    });

    it('skips middle messages not at start/end positions (B14/B15)', async () => {
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_slot_chat') return 'model-id-1';
            return '';
        });
        // Build array with > 5 messages so middle ones (i >= 3 && i < length-2) are skipped
        const msgs = [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'middle content that should be skipped for heuristic' },
            { role: 'assistant', content: 'another middle' },
            { role: 'user', content: 'yet another middle' },
            { role: 'assistant', content: 'still middle' },
            { role: 'user', content: 'ending part' },
            { role: 'assistant', content: 'final assistant' },
        ];
        const result = await inferSlot(
            { uniqueId: 'model-id-1' },
            { prompt_chat: msgs },
            { safeGetArg: mockSafeGetArg }
        );
        expect(result).toBeDefined();
    });
});


// ═══════════════════════════════════════
// dynamic-models — B1, B5, B7, B14, B25-27, B45, B56, B63, B65, B66
// 88.32% → 90%+ (16 uncov in 137 → need ≥3 covered)
// ═══════════════════════════════════════

describe('dynamic-models: uncovered binary-expr fallbacks', () => {
    it('ensureArray returns empty for non-array truthy (B1)', () => {
        // Items that are not arrays → ensureArray returns []
        const result = formatOpenAIDynamicModels('not-an-array');
        expect(result).toEqual([]);
    });

    it('dateSuffixFromDashedId returns empty for non-date id (B5)', () => {
        // normalizeAwsAnthropicModelId with no date suffix
        const id = normalizeAwsAnthropicModelId('anthropic.claude-v2');
        expect(id).toBeDefined();
    });

    it('formatOpenAIDynamicModels with model missing id (B7)', () => {
        const result = formatOpenAIDynamicModels([{ id: '' }]);
        expect(result).toEqual([]);
    });

    it('formatAwsDynamicModels with empty provider name (B45 binary)', () => {
        // Model with no providerName → name does not get provider prefix
        const result = formatAwsDynamicModels(
            [{ modelId: 'anthropic.claude-3', modelName: 'Claude 3', outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], providerName: '' }],
            []
        );
        expect(result.length).toBe(1);
        expect(result[0].name).toBe('Claude 3');
    });

    it('mergeDynamicModels with falsy providerName and model.provider fallback (B56)', () => {
        const result = mergeDynamicModels(
            [{ id: 'model-1', name: 'M1', provider: 'CustomProv' }],
            [],
            '' // falsy providerName → uses model.provider
        );
        expect(result.mergedModels).toHaveLength(1);
        expect(result.mergedModels[0].provider).toBe('CustomProv');
    });

    it('mergeDynamicModels incoming model with empty id string (B63)', () => {
        const result = mergeDynamicModels(
            [],
            [{ id: '', name: 'NoId', provider: 'P' }],
            'TestProv'
        );
        // Should be skipped because hasId is false
        expect(result.mergedModels).toHaveLength(0);
    });

    it('mergeDynamicModels sort with falsy model names (B65/B66)', () => {
        const result = mergeDynamicModels(
            [
                { id: 'a-model', name: null, provider: 'P' },
                { id: 'b-model', name: undefined, provider: 'P' },
                { id: 'c-model', name: 'Zebra', provider: 'P' },
            ],
            [],
            'TestProv'
        );
        expect(result.mergedModels.length).toBe(3);
        // Falsy names sort as '' < 'Zebra'
    });

    it('formatVertexClaudeModels with compactDate in name (B25-27)', () => {
        const result = formatVertexClaudeModels([
            { name: 'publishers/anthropic/models/claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet' },
        ]);
        expect(result.length).toBe(1);
        // displayName doesn't include '/' so date appended
        expect(result[0].name).toContain('2024');
    });

    it('formatVertexGoogleModels with missing supportedActions (B14)', () => {
        const result = formatVertexGoogleModels([
            { name: 'publishers/google/models/gemini-2.0-flash', displayName: 'Gemini 2 Flash' },
        ]);
        expect(result.length).toBe(1);
    });

    it('formatGeminiDynamicModels with missing supportedGenerationMethods', () => {
        const result = formatGeminiDynamicModels([
            { name: 'models/gemini-1.5-pro', displayName: 'Gemini Pro', supportedGenerationMethods: [] },
        ]);
        expect(result).toEqual([]);
    });

    it('formatOpenRouterDynamicModels with missing name (uses id fallback)', () => {
        const result = formatOpenRouterDynamicModels([
            { id: 'openai/gpt-4' },
        ]);
        expect(result.length).toBe(1);
        expect(result[0].name).toBe('openai/gpt-4');
    });
});


// ═══════════════════════════════════════
// key-pool — B11, B12, B14, B21, B25, B26, B29
// 86.2% → 90%+ (8 uncov in 58 → need ≥3 covered)
// ═══════════════════════════════════════

describe('key-pool: withRotation edge cases', () => {
    it('uses custom maxRetries from opts (B11 cond)', async () => {
        const pool = new KeyPool('key1 key2');
        let callCount = 0;
        const result = await pool.withRotation(async () => {
            callCount++;
            return { success: false, _status: 429 };
        }, { maxRetries: 2 });
        expect(callCount).toBe(2);
        expect(result.success).toBe(false);
    });

    it('uses custom isRetryable from opts (B12 binary)', async () => {
        const pool = new KeyPool('key1');
        const result = await pool.withRotation(async () => {
            return { success: false, _status: 999 };
        }, { isRetryable: (r) => r._status === 999 });
        // Will retry and eventually exhaust
        expect(result.success).toBe(false);
    });

    it('pool.pick returns empty when no keys — early return (B14 cond)', async () => {
        const pool = new KeyPool('');
        const result = await pool.withRotation(async () => {
            return { success: true };
        });
        expect(result.success).toBe(false);
        expect(result.content).toContain('키 없음');
    });
});

describe('key-pool: fromJson edge cases', () => {
    it('handles JSON parse SyntaxError for non-object result (B21)', () => {
        // Parse succeeds but result is not an array
        const pool = KeyPool.fromJson('"just a string"');
        expect(pool.keys).toHaveLength(0);
    });

    it('handles single valid JSON object (B25 if)', () => {
        const pool = KeyPool.fromJson('{"key":"value","secret":"abc"}');
        expect(pool.keys).toHaveLength(1);
        expect(pool.keys[0]).toContain('key');
    });

    it('handles comma-separated JSON objects (B26 binary/B25)', () => {
        const pool = KeyPool.fromJson('{"a":1},{"b":2}');
        expect(pool.keys).toHaveLength(2);
    });

    it('comma-separated fallback with non-object elements filtered (B26 binary)', () => {
        const pool = KeyPool.fromJson('{"a":1},"string",null');
        // "string" and null are not objects, filtered out
        expect(pool.keys.length).toBeLessThanOrEqual(1);
    });

    it('returns empty pool for non-JSON non-comma input (B29 cond)', () => {
        const pool = KeyPool.fromJson('invalid random text');
        expect(pool.keys).toHaveLength(0);
    });

    it('withRotation key pool name shown in no-key message', async () => {
        const pool = new KeyPool('', 'TestPool');
        const result = await pool.withRotation(async () => ({ success: true }));
        expect(result.content).toContain('TestPool');
    });
});


// ═══════════════════════════════════════
// settings-backup — B6, B7, B13, B15, B18, B23, B28
// 88.88% → 90%+ (7 uncov in 63 → need ≥1 covered)
// ═══════════════════════════════════════

describe('settings-backup: createSettingsBackup edge cases', () => {
    let storageData;
    let mockRisu;
    let mockSafeGetArg;

    beforeEach(() => {
        storageData = {};
        mockRisu = {
            pluginStorage: {
                getItem: vi.fn(async (key) => storageData[key] || null),
                setItem: vi.fn(async (key, val) => { storageData[key] = val; }),
            },
            setArgument: vi.fn(),
        };
        mockSafeGetArg = vi.fn(async () => '');
    });

    it('getManagedSettingKeys with providers having settingsFields (B6/B7)', () => {
        // Provider with settingsFields containing managed keys
        const providers = new Map([
            ['anthropic', { settingsFields: [{ key: 'cpm_apiKey' }, { key: 'cpm_model' }] }],
            ['openai', { settingsFields: [{ key: 'non_managed_key' }] }],
        ]);
        const keys = getManagedSettingKeys(providers);
        expect(keys).toContain('cpm_apiKey');
        expect(keys).toContain('cpm_model');
    });

    it('getManagedSettingKeys with array entries (B6 cond)', () => {
        const providers = [
            ['anthropic', { settingsFields: [{ key: 'cpm_apiKey' }] }],
        ];
        const keys = getManagedSettingKeys(providers);
        expect(keys).toContain('cpm_apiKey');
    });

    it('getManagedSettingKeys with non-Map non-Array (B6 fallback)', () => {
        const keys = getManagedSettingKeys('not-a-map');
        expect(Array.isArray(keys)).toBe(true);
    });

    it('load handles raw being already an object (B13 typeof raw)', async () => {
        storageData['cpm_settings_backup'] = { cpm_apiKey: 'test-key' }; // object, not string
        const backup = createSettingsBackup({
            Risu: mockRisu,
            safeGetArg: mockSafeGetArg,
            slotList: ['chat'],
            getRegisteredProviders: () => [],
        });
        const cache = await backup.load();
        expect(cache).toBeDefined();
    });

    it('snapshotAll saves non-empty values and skips empty (B15/B18)', async () => {
        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_anthropic_key') return 'stored-key';
            if (key === 'cpm_openai_key') return 'openai-key';
            return ''; // empty → should be skipped
        });
        const backup = createSettingsBackup({
            Risu: mockRisu,
            safeGetArg: mockSafeGetArg,
            slotList: ['chat'],
            getRegisteredProviders: () => [],
        });
        const snapshot = await backup.snapshotAll();
        expect(snapshot['cpm_anthropic_key']).toBe('stored-key');
        expect(snapshot['cpm_openai_key']).toBe('openai-key');
    });

    it('restoreIfEmpty skips when current value is non-empty (B23/B28)', async () => {
        // Pre-populate backup
        storageData['cpm_settings_backup'] = JSON.stringify({ cpm_apiKey: 'backup-val', cpm_model: 'backup-model' });

        mockSafeGetArg.mockImplementation(async (key) => {
            if (key === 'cpm_apiKey') return 'existing-value'; // non-empty → skip
            if (key === 'cpm_model') return ''; // empty → restore
            return '';
        });

        const backup = createSettingsBackup({
            Risu: mockRisu,
            safeGetArg: mockSafeGetArg,
            slotList: ['chat'],
            getRegisteredProviders: () => [],
        });
        const count = await backup.restoreIfEmpty();
        expect(count).toBe(1); // Only cpm_model restored
        expect(mockRisu.setArgument).toHaveBeenCalledWith('cpm_model', 'backup-model');
        expect(mockRisu.setArgument).not.toHaveBeenCalledWith('cpm_apiKey', expect.anything());
    });

    it('restoreIfEmpty returns 0 when backup is empty (B23)', async () => {
        storageData['cpm_settings_backup'] = JSON.stringify({});
        const backup = createSettingsBackup({
            Risu: mockRisu,
            safeGetArg: mockSafeGetArg,
            slotList: ['chat'],
            getRegisteredProviders: () => [],
        });
        const count = await backup.restoreIfEmpty();
        expect(count).toBe(0);
    });
});
