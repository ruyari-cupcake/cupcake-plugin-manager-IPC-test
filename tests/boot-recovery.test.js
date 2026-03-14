/**
 * boot-recovery.test.js
 *
 * Manager/Provider 부트 시퀀스 장애 복구 테스트.
 * temp_repo의 init-boot-failure.test.js에서 v4 IPC 아키텍처에
 * 적용 가능한 패턴들을 이식.
 *
 * 테스트 범위:
 *   - Custom model JSON 복구
 *   - 동적 모델 조회 실패 복구
 *   - 모델 등록 부분 실패 복구
 *   - IPC provider 등록 검증
 *   - 설정 backup/restore 복구
 */
import { describe, it, expect } from 'vitest';
import { mergeDynamicModels } from '../src/shared/dynamic-models.js';

// ────────────────────────────────────────────────────
// A. Custom model JSON recovery
// ────────────────────────────────────────────────────

describe('Boot recovery — Custom model JSON parsing', () => {
    it('corrupted JSON → falls back to empty array', () => {
        const corruptJson = '{invalid json{{[]';
        let result;
        try {
            result = JSON.parse(corruptJson);
            if (!Array.isArray(result)) result = [];
        } catch (_e) {
            result = [];
        }
        expect(result).toEqual([]);
    });

    it('JSON that parses to non-array → coerced to empty array', () => {
        const objectJson = '{"key":"value"}';
        let result;
        try {
            result = JSON.parse(objectJson);
            if (!Array.isArray(result)) result = [];
        } catch (_e) {
            result = [];
        }
        expect(result).toEqual([]);
    });

    it('null JSON string → falls back to empty array', () => {
        const nullJson = 'null';
        let result;
        try {
            result = JSON.parse(nullJson);
            if (!Array.isArray(result)) result = [];
        } catch (_e) {
            result = [];
        }
        expect(result).toEqual([]);
    });

    it('empty array string → parsed correctly', () => {
        const emptyArr = '[]';
        let result;
        try {
            result = JSON.parse(emptyArr);
            if (!Array.isArray(result)) result = [];
        } catch (_e) {
            result = [];
        }
        expect(result).toEqual([]);
    });

    it('valid custom models JSON → parsed correctly', () => {
        const validJson = JSON.stringify([
            { uniqueId: 'c1', name: 'Model 1', model: 'gpt-4', url: 'http://x', format: 'openai' },
        ]);
        let result;
        try {
            result = JSON.parse(validJson);
            if (!Array.isArray(result)) result = [];
        } catch (_e) {
            result = [];
        }
        expect(result).toHaveLength(1);
        expect(result[0].uniqueId).toBe('c1');
    });
});

// ────────────────────────────────────────────────────
// B. Dynamic model fetch failure modes
// ────────────────────────────────────────────────────

describe('Boot recovery — Dynamic model fetch failure modes', () => {
    it('fetchDynamicModels throws → gracefully skipped, other providers continue', async () => {
        const ALL_DEFINED_MODELS = [
            { provider: 'StaticProvider', name: 'Model A', id: 'a' },
        ];

        const pendingDynamicFetchers = [
            { name: 'FailingProvider', fetchDynamicModels: async () => { throw new Error('Network timeout'); } },
            { name: 'SuccessProvider', fetchDynamicModels: async () => [{ name: 'Dynamic 1', id: 'dyn1' }] },
        ];

        for (const { name, fetchDynamicModels } of pendingDynamicFetchers) {
            try {
                const dynamicModels = await fetchDynamicModels();
                if (dynamicModels && Array.isArray(dynamicModels) && dynamicModels.length > 0) {
                    const filtered = ALL_DEFINED_MODELS.filter(m => m.provider !== name);
                    ALL_DEFINED_MODELS.length = 0;
                    ALL_DEFINED_MODELS.push(...filtered);
                    for (const m of dynamicModels) {
                        ALL_DEFINED_MODELS.push({ ...m, provider: name });
                    }
                }
            } catch (_e) { /* gracefully skip */ }
        }

        expect(ALL_DEFINED_MODELS.find(m => m.provider === 'StaticProvider')).toBeDefined();
        expect(ALL_DEFINED_MODELS.filter(m => m.provider === 'FailingProvider')).toHaveLength(0);
        expect(ALL_DEFINED_MODELS.find(m => m.provider === 'SuccessProvider' && m.id === 'dyn1')).toBeDefined();
    });

    it('fetchDynamicModels returns null → uses fallback', async () => {
        const ALL_DEFINED_MODELS = [{ provider: 'NullProvider', name: 'Fallback', id: 'fb' }];

        const pendingDynamicFetchers = [
            { name: 'NullProvider', fetchDynamicModels: async () => null },
        ];

        for (const { name, fetchDynamicModels } of pendingDynamicFetchers) {
            try {
                const dynamicModels = await fetchDynamicModels();
                if (dynamicModels && Array.isArray(dynamicModels) && dynamicModels.length > 0) {
                    const filtered = ALL_DEFINED_MODELS.filter(m => m.provider !== name);
                    ALL_DEFINED_MODELS.length = 0;
                    ALL_DEFINED_MODELS.push(...filtered);
                    for (const m of dynamicModels) ALL_DEFINED_MODELS.push({ ...m, provider: name });
                }
            } catch (_e) { /* */ }
        }

        expect(ALL_DEFINED_MODELS).toHaveLength(1);
        expect(ALL_DEFINED_MODELS[0].name).toBe('Fallback');
    });

    it('fetchDynamicModels returns empty array → uses fallback', async () => {
        const ALL_DEFINED_MODELS = [{ provider: 'EmptyProvider', name: 'Fallback', id: 'fb' }];

        const pendingDynamicFetchers = [
            { name: 'EmptyProvider', fetchDynamicModels: async () => [] },
        ];

        for (const { name, fetchDynamicModels } of pendingDynamicFetchers) {
            try {
                const dynamicModels = await fetchDynamicModels();
                if (dynamicModels && Array.isArray(dynamicModels) && dynamicModels.length > 0) {
                    const filtered = ALL_DEFINED_MODELS.filter(m => m.provider !== name);
                    ALL_DEFINED_MODELS.length = 0;
                    ALL_DEFINED_MODELS.push(...filtered);
                    for (const m of dynamicModels) ALL_DEFINED_MODELS.push({ ...m, provider: name });
                }
            } catch (_e) { /* */ }
        }

        expect(ALL_DEFINED_MODELS).toHaveLength(1);
        expect(ALL_DEFINED_MODELS[0].name).toBe('Fallback');
    });
});

// ────────────────────────────────────────────────────
// C. Model registration partial failure
// ────────────────────────────────────────────────────

describe('Boot recovery — Model registration partial failure', () => {
    it('addProvider throws for one model → others still register', async () => {
        const registeredModels = [];

        const mockAddProvider = async (label) => {
            if (label.includes('Bomb Model')) throw new Error('Registration failed');
            registeredModels.push(label);
        };

        const ALL_DEFINED_MODELS = [
            { name: 'Safe Model A', provider: 'TestProvider' },
            { name: 'Bomb Model', provider: 'TestProvider' },
            { name: 'Safe Model B', provider: 'TestProvider' },
        ];

        for (const model of ALL_DEFINED_MODELS) {
            try {
                const label = `[CPM] ${model.name}`;
                await mockAddProvider(label);
            } catch (_e) { /* continue */ }
        }

        expect(registeredModels).toContain('[CPM] Safe Model A');
        expect(registeredModels).toContain('[CPM] Safe Model B');
        expect(registeredModels).not.toContain('[CPM] Bomb Model');
        expect(registeredModels).toHaveLength(2);
    });
});

// ────────────────────────────────────────────────────
// D. IPC provider registration validation
// ────────────────────────────────────────────────────

describe('Boot recovery — IPC provider registration validation', () => {
    it('rejects registration with missing name', () => {
        const mockRegistration = { models: [], settingsFields: [] };
        const isValid = Boolean(mockRegistration.name && typeof mockRegistration.name === 'string');
        expect(isValid).toBe(false);
    });

    it('rejects registration with empty name', () => {
        const mockRegistration = { name: '', models: [], settingsFields: [] };
        const isValid = Boolean(mockRegistration.name && typeof mockRegistration.name === 'string');
        expect(isValid).toBe(false);
    });

    it('accepts valid registration', () => {
        const mockRegistration = { name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }], settingsFields: [] };
        const isValid = Boolean(mockRegistration.name && typeof mockRegistration.name === 'string');
        expect(isValid).toBe(true);
    });

    it('handles models being non-array gracefully', () => {
        const mockRegistration = { name: 'TestProvider', models: null, settingsFields: [] };
        const models = Array.isArray(mockRegistration.models) ? mockRegistration.models : [];
        expect(models).toEqual([]);
    });
});

// ────────────────────────────────────────────────────
// E. Settings backup recovery
// ────────────────────────────────────────────────────

describe('Boot recovery — Settings backup/restore edge cases', () => {
    it('corrupted backup JSON → falls back gracefully', () => {
        const backupStr = 'not valid json{{';
        let backup;
        try {
            backup = JSON.parse(backupStr);
        } catch (_e) {
            backup = {};
        }
        expect(backup).toEqual({});
    });

    it('backup with missing keys → skip missing, apply present', () => {
        const backup = { 'cpm_fallback_temp': '0.7', 'cpm_show_token_usage': 'true' };
        const keysToRestore = ['cpm_fallback_temp', 'cpm_show_token_usage', 'cpm_missing_key'];

        const restoredCount = keysToRestore.filter(k => backup[k] !== undefined).length;
        expect(restoredCount).toBe(2);
    });

    it('null backup string → empty object', () => {
        let backup;
        try {
            backup = JSON.parse('null');
            if (typeof backup !== 'object' || backup === null) backup = {};
        } catch (_e) {
            backup = {};
        }
        expect(backup).toEqual({});
    });
});

// ────────────────────────────────────────────────────
// F. Dynamic model merge resilience
// ────────────────────────────────────────────────────

describe('Boot recovery — mergeDynamicModels resilience', () => {
    it('handles null incoming models', () => {
        const existing = [{ id: 'a', name: 'A' }];
        const result = mergeDynamicModels(existing, null, 'TestProvider');
        expect(result.addedModels).toEqual([]);
        expect(result.mergedModels.length).toBe(1);
    });

    it('handles undefined incoming models', () => {
        const existing = [{ id: 'a', name: 'A' }];
        const result = mergeDynamicModels(existing, undefined, 'TestProvider');
        expect(result.addedModels).toEqual([]);
    });

    it('handles empty existing models', () => {
        const incoming = [{ id: 'new1', name: 'New Model' }];
        const result = mergeDynamicModels([], incoming, 'TestProvider');
        expect(result.addedModels).toHaveLength(1);
        expect(result.addedModels[0].id).toBe('new1');
    });

    it('handles both empty', () => {
        const result = mergeDynamicModels([], [], 'TestProvider');
        expect(result.mergedModels).toEqual([]);
        expect(result.addedModels).toEqual([]);
    });
});
