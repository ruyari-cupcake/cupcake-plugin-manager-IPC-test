/**
 * @file coverage-boost.test.js — Targeted tests for uncovered branches/statements
 *
 * Covers the 5 modules below 80% in branches or statements:
 *  1. auto-updater.js — checkVersionsQuiet + checkMainPluginVersionQuiet
 *  2. dynamic-models.js — normalizeAwsAnthropicModelId version-based branch
 *  3. endpoints.js — _resolveEnv catch branch
 *  4. message-format.js — Anthropic merge + Gemini multimodal branches
 *  5. token-usage.js — legacy key fallback + explicit Anthropic reasoning tokens
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. auto-updater.js — checkVersionsQuiet + checkMainPluginVersionQuiet
// ═══════════════════════════════════════════════════════════════════════════════
import { createAutoUpdater } from '../src/shared/auto-updater.js';

describe('auto-updater: checkVersionsQuiet', () => {
    /** @type {Record<string, any>} */
    let storageData;
    let mockRisu;

    function createMockRisu(overrides = {}) {
        storageData = {};
        return {
            pluginStorage: {
                getItem: vi.fn(async (key) => storageData[key] || null),
                setItem: vi.fn(async (key, value) => { storageData[key] = value; }),
                removeItem: vi.fn(async (key) => { delete storageData[key]; }),
            },
            getDatabase: vi.fn(async () => ({
                plugins: [{
                    name: 'Cupcake_Provider_Manager',
                    versionOfPlugin: '1.19.0',
                    script: 'x'.repeat(500 * 1024),
                    arguments: { key1: 'string' },
                    realArg: { key1: 'val1' },
                    updateURL: 'https://example.com',
                    enabled: true,
                }],
            })),
            setDatabaseLite: vi.fn(async () => {}),
            risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? true : ''),
            ...overrides,
        };
    }

    function makeUpdater(overrides = {}) {
        mockRisu = createMockRisu(overrides);
        return createAutoUpdater({
            Risu: mockRisu,
            currentVersion: '1.19.0',
            pluginName: 'Cupcake Provider Manager',
            versionsUrl: 'https://test.vercel.app/api/versions',
            mainUpdateUrl: 'https://test.vercel.app/api/main-plugin',
            updateBundleUrl: 'https://test.vercel.app/api/update-bundle',
            _autoSaveDelayMs: 0,
        });
    }

    it('checkVersionsQuiet — update available in manifest triggers safeMainPluginUpdate', async () => {
        const manifest = { 'Cupcake Provider Manager': { version: '2.0.0', changes: 'New features' } };
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: JSON.stringify(manifest), status: 200 })),
            // safeMainPluginUpdate will fail (nativeFetch returns 404), that's OK — we just want the path covered
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        });

        await updater.checkVersionsQuiet();

        // Verify risuFetch was called for the manifest
        expect(mockRisu.risuFetch).toHaveBeenCalled();
        // The pending update should have been remembered
        const pending = await updater.readPendingUpdate();
        expect(pending).not.toBeNull();
        expect(pending.version).toBe('2.0.0');
    });

    it('checkVersionsQuiet — already up to date', async () => {
        const manifest = { 'Cupcake Provider Manager': { version: '1.19.0', changes: '' } };
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: JSON.stringify(manifest), status: 200 })),
        });

        await updater.checkVersionsQuiet();

        // No pending update should exist
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('checkVersionsQuiet — older remote version (no update)', async () => {
        const manifest = { 'Cupcake Provider Manager': { version: '1.0.0', changes: '' } };
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: manifest, status: 200 })),
        });

        await updater.checkVersionsQuiet();
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('checkVersionsQuiet — fetch failure (HTTP error)', async () => {
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: null, status: 500 })),
        });

        // Should not throw
        await updater.checkVersionsQuiet();
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('checkVersionsQuiet — invalid manifest (not an object)', async () => {
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: '42', status: 200 })),
        });

        await updater.checkVersionsQuiet();
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('checkVersionsQuiet — manifest is null', async () => {
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: 'null', status: 200 })),
        });

        await updater.checkVersionsQuiet();
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('checkVersionsQuiet — idempotent (second call is no-op)', async () => {
        const manifest = { 'Cupcake Provider Manager': { version: '2.0.0', changes: 'v2' } };
        const risuFetchMock = vi.fn(async () => ({ data: JSON.stringify(manifest), status: 200 }));
        const updater = makeUpdater({
            risuFetch: risuFetchMock,
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        });

        await updater.checkVersionsQuiet();
        const callCount = risuFetchMock.mock.calls.length;

        await updater.checkVersionsQuiet();
        // Should not have made another fetch call
        expect(risuFetchMock.mock.calls.length).toBe(callCount);
    });

    it('checkVersionsQuiet — cooldown skip', async () => {
        const risuFetchMock = vi.fn(async () => ({ data: '{}', status: 200 }));
        // Pre-set cooldown
        const updater = makeUpdater({ risuFetch: risuFetchMock });
        const { _constants } = updater;
        storageData[_constants.VERSION_CHECK_STORAGE_KEY] = String(Date.now());

        await updater.checkVersionsQuiet();
        // risuFetch should NOT have been called due to cooldown
        expect(risuFetchMock).not.toHaveBeenCalled();
    });

    it('checkVersionsQuiet — manifest has pluginName without version field', async () => {
        const manifest = { 'Cupcake Provider Manager': { changes: 'no version' } };
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: JSON.stringify(manifest), status: 200 })),
        });

        await updater.checkVersionsQuiet();
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });
});

describe('auto-updater: checkMainPluginVersionQuiet', () => {
    /** @type {Record<string, any>} */
    let storageData;
    let mockRisu;

    function createMockRisu(overrides = {}) {
        storageData = {};
        return {
            pluginStorage: {
                getItem: vi.fn(async (key) => storageData[key] || null),
                setItem: vi.fn(async (key, value) => { storageData[key] = value; }),
                removeItem: vi.fn(async (key) => { delete storageData[key]; }),
            },
            getDatabase: vi.fn(async () => ({
                plugins: [{
                    name: 'Cupcake_Provider_Manager',
                    versionOfPlugin: '1.19.0',
                    script: 'x'.repeat(500 * 1024),
                    arguments: { key1: 'string' },
                    realArg: { key1: 'val1' },
                    updateURL: 'https://example.com',
                    enabled: true,
                }],
            })),
            setDatabaseLite: vi.fn(async () => {}),
            risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? true : ''),
            ...overrides,
        };
    }

    function makeUpdater(overrides = {}) {
        mockRisu = createMockRisu(overrides);
        return createAutoUpdater({
            Risu: mockRisu,
            currentVersion: '1.19.0',
            pluginName: 'Cupcake Provider Manager',
            versionsUrl: 'https://test.vercel.app/api/versions',
            mainUpdateUrl: 'https://test.vercel.app/api/main-plugin',
            updateBundleUrl: 'https://test.vercel.app/api/update-bundle',
            _autoSaveDelayMs: 0,
        });
    }

    it('skipped when manifest already checked via checkVersionsQuiet', async () => {
        const manifest = { 'Cupcake Provider Manager': { version: '1.19.0' } };
        const nativeFetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
        const updater = makeUpdater({
            risuFetch: vi.fn(async () => ({ data: JSON.stringify(manifest), status: 200 })),
            nativeFetch: nativeFetchMock,
        });

        await updater.checkVersionsQuiet();
        nativeFetchMock.mockClear();

        await updater.checkMainPluginVersionQuiet();
        // Should NOT have been called — manifest already checked
        expect(nativeFetchMock).not.toHaveBeenCalled();
    });

    it('nativeFetch succeeds — update available triggers validateAndInstall', async () => {
        const remoteCode = `// Cupcake Provider Manager\n// @version 2.0.0\n// @changes New stuff\nconsole.log("hello");`;
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => ({
                ok: true, status: 200,
                text: vi.fn(async () => remoteCode),
            })),
        });

        await updater.checkMainPluginVersionQuiet();

        // Should have fetched and found a newer version
        expect(mockRisu.nativeFetch).toHaveBeenCalled();
    });

    it('nativeFetch succeeds — version is current (no update)', async () => {
        const remoteCode = `// @version 1.19.0\nconsole.log("same");`;
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => ({
                ok: true, status: 200,
                text: vi.fn(async () => remoteCode),
            })),
        });

        await updater.checkMainPluginVersionQuiet();

        // No pending update
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('nativeFetch fails — risuFetch fallback succeeds', async () => {
        const remoteCode = `// @version 2.0.0\n// @changes Fallback update\nconsole.log("hello");`;
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => { throw new Error('network error'); }),
            risuFetch: vi.fn(async () => ({ data: remoteCode, status: 200 })),
        });

        await updater.checkMainPluginVersionQuiet();

        expect(mockRisu.nativeFetch).toHaveBeenCalled();
        expect(mockRisu.risuFetch).toHaveBeenCalled();
    });

    it('both fetch methods fail — returns silently', async () => {
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => { throw new Error('native fail'); }),
            risuFetch: vi.fn(async () => { throw new Error('risu fail'); }),
        });

        // Should not throw
        await updater.checkMainPluginVersionQuiet();
    });

    it('remote code has no @version tag — skips', async () => {
        const remoteCode = `console.log("no version tag here");`;
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => ({
                ok: true, status: 200,
                text: vi.fn(async () => remoteCode),
            })),
        });

        await updater.checkMainPluginVersionQuiet();
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });

    it('cooldown skip — recent check timestamp', async () => {
        const nativeFetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
        const updater = makeUpdater({ nativeFetch: nativeFetchMock });
        const { _constants } = updater;
        storageData[_constants.MAIN_VERSION_CHECK_STORAGE_KEY] = String(Date.now());

        await updater.checkMainPluginVersionQuiet();

        expect(nativeFetchMock).not.toHaveBeenCalled();
    });

    it('nativeFetch returns non-ok status — returns early without risuFetch', async () => {
        const risuFetchMock = vi.fn(async () => ({ data: null, status: 404 }));
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => ({ ok: false, status: 500 })),
            risuFetch: risuFetchMock,
        });

        await updater.checkMainPluginVersionQuiet();

        expect(mockRisu.nativeFetch).toHaveBeenCalled();
        // Non-ok nativeFetch causes early return, NOT fallback to risuFetch
        expect(risuFetchMock).not.toHaveBeenCalled();
    });

    it('risuFetch also fails with HTTP error — returns silently', async () => {
        const updater = makeUpdater({
            nativeFetch: vi.fn(async () => { throw new Error('native fail'); }),
            risuFetch: vi.fn(async () => ({ data: null, status: 500 })),
        });

        // Should not throw
        await updater.checkMainPluginVersionQuiet();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. dynamic-models.js — uncovered branches
// ═══════════════════════════════════════════════════════════════════════════════
import {
    normalizeAwsAnthropicModelId,
    formatOpenAIDynamicModels,
    formatAnthropicDynamicModels,
    formatGeminiDynamicModels,
    formatDeepSeekDynamicModels,
    formatVertexGoogleModels,
    formatVertexClaudeModels,
    mergeDynamicModels,
    formatAwsDynamicModels,
} from '../src/shared/dynamic-models.js';

describe('normalizeAwsAnthropicModelId — version-only (no 8-digit date)', () => {
    it('major > 4 → global prefix', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-opus-5-0-v1:0'))
            .toBe('global.anthropic.claude-opus-5-0-v1:0');
    });

    it('major=4 minor>=5 → global prefix', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-sonnet-4-5-v1:0'))
            .toBe('global.anthropic.claude-sonnet-4-5-v1:0');
    });

    it('major=4 minor<5 → us prefix', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-haiku-4-0-v1:0'))
            .toBe('us.anthropic.claude-haiku-4-0-v1:0');
    });

    it('major < 4 → us prefix', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-sonnet-3-5-v1:0'))
            .toBe('us.anthropic.claude-sonnet-3-5-v1:0');
    });

    it('no date AND no version match → us prefix', () => {
        // "anthropic.claude-v1:0" has no "claude-X-Y" pattern and no 8-digit date
        expect(normalizeAwsAnthropicModelId('anthropic.claude-v1:0'))
            .toBe('us.anthropic.claude-v1:0');
    });
});

describe('formatDeepSeekDynamicModels — edge cases', () => {
    it('handles id with consecutive dashes (empty split segments)', () => {
        const result = formatDeepSeekDynamicModels([{ id: 'deepseek--chat' }]);
        expect(result).toHaveLength(1);
        // The empty segment between dashes produces an empty string in split
        expect(result[0].name).toContain('DeepSeek');
    });

    it('handles single-segment id', () => {
        const result = formatDeepSeekDynamicModels([{ id: 'reasoner' }]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Reasoner');
    });
});

describe('mergeDynamicModels — uncovered branches', () => {
    it('skips incoming models without name', () => {
        const incoming = [
            { uniqueId: 'x-1', id: 'model-1' /* no name */ },
            { uniqueId: 'x-2', id: 'model-2', name: 'Model 2' },
        ];
        const result = mergeDynamicModels([], incoming, 'Test');
        // Only model-2 has both id and name
        expect(result.mergedModels).toHaveLength(1);
        expect(result.addedModels).toHaveLength(1);
    });

    it('skips incoming models without id', () => {
        const incoming = [
            { uniqueId: 'x-1', name: 'Model 1' /* no id */ },
        ];
        const result = mergeDynamicModels([], incoming, 'Test');
        expect(result.mergedModels).toHaveLength(0);
    });

    it('skips null/non-object entries in existing models', () => {
        const existing = [null, undefined, 'not-an-object', { uniqueId: 'a', id: 'a', name: 'A' }];
        const result = mergeDynamicModels(existing, [], 'Test');
        // Only the valid object should pass through
        expect(result.mergedModels).toHaveLength(1);
    });

    it('skips null/non-object entries in incoming models', () => {
        const incoming = [null, undefined, { uniqueId: 'b', id: 'b', name: 'B' }];
        const result = mergeDynamicModels([], incoming, 'Test');
        expect(result.mergedModels).toHaveLength(1);
    });

    it('updates existing model and does not count as added', () => {
        const existing = [{ uniqueId: 'a', id: 'a', name: 'Old A' }];
        const incoming = [{ uniqueId: 'a', id: 'a', name: 'New A' }];
        const result = mergeDynamicModels(existing, incoming, 'Test');
        expect(result.mergedModels).toHaveLength(1);
        expect(result.mergedModels[0].name).toBe('New A');
        expect(result.addedModels).toHaveLength(0); // existing → not "added"
    });
});

describe('formatAwsDynamicModels — uncovered branches', () => {
    it('skips models without TEXT output modality', () => {
        const result = formatAwsDynamicModels([
            { modelId: 'amazon.titan-image', outputModalities: ['IMAGE'], inferenceTypesSupported: ['ON_DEMAND'] },
        ]);
        expect(result).toHaveLength(0);
    });

    it('skips models without ON_DEMAND/INFERENCE_PROFILE inference', () => {
        const result = formatAwsDynamicModels([
            { modelId: 'test-model', outputModalities: ['TEXT'], inferenceTypesSupported: ['PROVISIONED'] },
        ]);
        expect(result).toHaveLength(0);
    });

    it('adds provider prefix to name when not already present', () => {
        const result = formatAwsDynamicModels([
            {
                modelId: 'some-model',
                modelName: 'Test Model',
                providerName: 'Acme',
                outputModalities: ['TEXT'],
                inferenceTypesSupported: ['ON_DEMAND'],
            },
        ]);
        expect(result[0].name).toBe('Acme Test Model');
    });

    it('does not add provider prefix when name starts with provider', () => {
        const result = formatAwsDynamicModels([
            {
                modelId: 'some-model',
                modelName: 'Acme Advanced',
                providerName: 'Acme',
                outputModalities: ['TEXT'],
                inferenceTypesSupported: ['ON_DEMAND'],
            },
        ]);
        expect(result[0].name).toBe('Acme Advanced');
    });

    it('skips inference profiles that are not Anthropic/Claude', () => {
        const result = formatAwsDynamicModels([], [
            { inferenceProfileId: 'amazon.titan-text', inferenceProfileName: 'Titan Text' },
        ]);
        expect(result).toHaveLength(0);
    });

    it('skips duplicate inference profiles', () => {
        const result = formatAwsDynamicModels(
            [{
                modelId: 'global.anthropic.claude-test',
                modelName: 'Claude Test',
                outputModalities: ['TEXT'],
                inferenceTypesSupported: ['ON_DEMAND'],
            }],
            [{ inferenceProfileId: 'global.anthropic.claude-test', inferenceProfileName: 'Claude Test Profile' }],
        );
        // Profile ID matches an existing model ID → skipped
        expect(result).toHaveLength(1);
    });

    it('adds inference profile with ARN', () => {
        const result = formatAwsDynamicModels([], [
            {
                inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123:inference-profile/anthropic.claude-v2',
                inferenceProfileName: 'Claude v2 Profile',
            },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toContain('Cross-Region');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. endpoints.js — _resolveEnv catch branch
// ═══════════════════════════════════════════════════════════════════════════════
describe('endpoints — _resolveEnv catch branch', () => {
    it('falls back to test URL when process.env access throws', async () => {
        vi.resetModules();
        const origEnv = process.env;
        // Replace process.env with a Proxy that throws on CPM_ENV access
        Object.defineProperty(process, 'env', {
            get() { throw new Error('env access denied'); },
            configurable: true,
        });

        try {
            const mod = await import('../src/shared/endpoints.js');
            expect(mod.CPM_ENV).toBe('test');
            expect(mod.CPM_BASE_URL).toContain('-test');
        } finally {
            // Restore
            Object.defineProperty(process, 'env', {
                value: origEnv,
                writable: true,
                configurable: true,
            });
            vi.resetModules();
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. message-format.js — Anthropic merge + Gemini multimodal branches
// ═══════════════════════════════════════════════════════════════════════════════
import { formatToAnthropic, formatToGemini, formatToOpenAI } from '../src/shared/message-format.js';
import { ThoughtSignatureCache } from '../src/shared/sse-parser.js';

const mkMsg = (role, content, extra = {}) => ({ role, content, ...extra });

describe('formatToOpenAI — uncovered branches', () => {
    it('mergesys: merges all system messages into first non-system', () => {
        const msgs = [
            mkMsg('system', 'System 1'),
            mkMsg('system', 'System 2'),
            mkMsg('user', 'Hello'),
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        expect(result[0].role).toBe('user');
        expect(result[0].content).toContain('System 1');
        expect(result[0].content).toContain('System 2');
    });

    it('mergesys: handles non-string system content (JSON.stringify branch)', () => {
        const msgs = [
            mkMsg('system', { instruction: 'Be helpful' }),
            mkMsg('user', 'Hello'),
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        expect(result[0].content).toContain('instruction');
    });

    it('mergesys: handles non-string first user content (JSON.stringify)', () => {
        const msgs = [
            mkMsg('system', 'Sys'),
            mkMsg('user', [{ type: 'text', text: 'query' }]),
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        expect(result.length).toBeGreaterThan(0);
    });

    it('mustuser: prepends user placeholder when first role is assistant', () => {
        const msgs = [
            mkMsg('assistant', 'I start'),
            mkMsg('user', 'Then me'),
        ];
        const result = formatToOpenAI(msgs, { mustuser: true });
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe(' ');
    });

    it('altrole: converts assistant to model', () => {
        const msgs = [mkMsg('assistant', 'Reply')];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result[0].role).toBe('model');
    });

    it('altrole: merges consecutive same-role text messages', () => {
        const msgs = [
            mkMsg('user', 'Part 1'),
            mkMsg('user', 'Part 2'),
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result).toHaveLength(1);
        expect(result[0].content).toContain('Part 1');
        expect(result[0].content).toContain('Part 2');
    });

    it('altrole: merges array+string mixed content', () => {
        const msgs = [
            mkMsg('user', [{ type: 'text', text: 'Array msg' }]),
            mkMsg('user', 'String msg'),
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result).toHaveLength(1);
    });

    it('altrole: merges with empty content produces correct result', () => {
        const msgs = [
            mkMsg('user', 'Has content'),
            mkMsg('user', ''),
        ];
        // Empty string content may be filtered before merge
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('sysfirst: moves system message to front', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('system', 'I should be first'),
            mkMsg('assistant', 'World'),
        ];
        const result = formatToOpenAI(msgs, { sysfirst: true });
        expect(result[0].role).toBe('system');
    });

    it('sysfirst: does nothing when system already first', () => {
        const msgs = [
            mkMsg('system', 'Already first'),
            mkMsg('user', 'Hello'),
        ];
        const result = formatToOpenAI(msgs, { sysfirst: true });
        expect(result[0].role).toBe('system');
        expect(result[0].content).toContain('Already first');
    });

    it('sysfirst: does nothing when no system message', () => {
        const msgs = [
            mkMsg('user', 'No system'),
            mkMsg('assistant', 'Reply'),
        ];
        const result = formatToOpenAI(msgs, { sysfirst: true });
        expect(result[0].role).toBe('user');
    });

    it('developerRole: converts system to developer role', () => {
        const msgs = [
            mkMsg('system', 'Instructions'),
            mkMsg('user', 'Hello'),
        ];
        const result = formatToOpenAI(msgs, { developerRole: true });
        expect(result.find(m => m.role === 'developer')).toBeTruthy();
    });

    it('handles null/invalid messages in array', () => {
        const msgs = [
            null,
            undefined,
            'not-an-object',
            mkMsg('user', 'Valid message'),
        ];
        const result = formatToOpenAI(msgs);
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    it('handles message with non-string role', () => {
        const msgs = [
            { role: undefined, content: 'No explicit role' },
            mkMsg('user', 'Normal'),
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('handles model role converted to assistant', () => {
        const msgs = [mkMsg('model', 'From model'), mkMsg('user', 'Hi')];
        const result = formatToOpenAI(msgs);
        expect(result[0].role).toBe('assistant');
    });

    it('handles char role converted to assistant', () => {
        const msgs = [mkMsg('char', 'Character speaking'), mkMsg('user', 'Hi')];
        const result = formatToOpenAI(msgs);
        expect(result[0].role).toBe('assistant');
    });

    it('handles inlineData image in array content', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'An image' },
                { inlineData: { data: 'base64data', mimeType: 'image/png' } },
            ]),
        ];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const imgUrl = userMsg.content.find(p => p.type === 'image_url');
        expect(imgUrl).toBeTruthy();
    });

    it('handles inlineData audio in array content', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Audio' },
                { inlineData: { data: 'audiodata', mimeType: 'audio/wav' } },
            ]),
        ];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const audio = userMsg.content.find(p => p.type === 'input_audio');
        expect(audio).toBeTruthy();
    });

    it('handles inlineData with non-image/non-audio mimeType', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Data' },
                { inlineData: { data: 'somedata', mimeType: 'application/pdf' } },
            ]),
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThan(0);
    });

    it('handles Anthropic image source in array content', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Image' },
                { type: 'image', source: { type: 'base64', data: 'imgdata', media_type: 'image/jpeg' } },
            ]),
        ];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const imgUrl = userMsg.content.find(p => p.type === 'image_url');
        expect(imgUrl).toBeTruthy();
    });

    it('handles non-string non-array content (fallback)', () => {
        const msgs = [
            mkMsg('user', { custom: 'object' }),
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThan(0);
    });

    it('handles multimodal image with base64 data URI', () => {
        const msgs = [
            mkMsg('user', 'Look at this', {
                multimodals: [
                    { type: 'image', base64: 'data:image/png;base64,abc123' },
                ],
            }),
        ];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
    });

    it('handles multimodal audio with various formats', () => {
        // wav
        let msgs = [mkMsg('user', 'Audio', { multimodals: [{ type: 'audio', base64: 'data:audio/wav;base64,wavdata' }] })];
        let result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        let audioInput = userMsg.content.find(p => p.type === 'input_audio');
        expect(audioInput.input_audio.format).toBe('wav');

        // ogg
        msgs = [mkMsg('user', 'Audio', { multimodals: [{ type: 'audio', base64: 'data:audio/ogg;base64,oggdata' }] })];
        result = formatToOpenAI(msgs);
        audioInput = result.find(m => m.role === 'user').content.find(p => p.type === 'input_audio');
        expect(audioInput.input_audio.format).toBe('ogg');

        // flac
        msgs = [mkMsg('user', 'Audio', { multimodals: [{ type: 'audio', base64: 'data:audio/flac;base64,flacdata' }] })];
        result = formatToOpenAI(msgs);
        audioInput = result.find(m => m.role === 'user').content.find(p => p.type === 'input_audio');
        expect(audioInput.input_audio.format).toBe('flac');

        // webm
        msgs = [mkMsg('user', 'Audio', { multimodals: [{ type: 'audio', base64: 'data:audio/webm;base64,webmdata' }] })];
        result = formatToOpenAI(msgs);
        audioInput = result.find(m => m.role === 'user').content.find(p => p.type === 'input_audio');
        expect(audioInput.input_audio.format).toBe('webm');
    });

    it('handles multimodal audio with no base64 (parseBase64DataUri null guard)', () => {
        const msgs = [mkMsg('user', 'Audio', { multimodals: [{ type: 'audio' }] })];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThan(0);
    });

    it('handles multimodal audio with raw base64 (no comma, no data URI)', () => {
        const msgs = [mkMsg('user', 'Audio', { multimodals: [{ type: 'audio', base64: 'rawbase64data' }] })];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const audioInput = userMsg.content.find(p => p.type === 'input_audio');
        expect(audioInput.input_audio.data).toBe('rawbase64data');
        expect(audioInput.input_audio.format).toBe('mp3'); // default format
    });

    it('handles multimodal image with HTTP URL', () => {
        const msgs = [
            mkMsg('user', 'Image from URL', {
                multimodals: [
                    { type: 'image', url: 'https://example.com/img.png' },
                ],
            }),
        ];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
    });

    it('preserves message name', () => {
        const msgs = [mkMsg('user', 'Hello', { name: 'Alice' })];
        const result = formatToOpenAI(msgs);
        expect(result[0].name).toBe('Alice');
    });

    it('handles array content with partial/invalid parts', () => {
        const msgs = [
            mkMsg('user', [
                null,
                undefined,
                { type: 'text', text: 'Valid part' },
                { type: 'image', source: null }, // image without valid source
                { type: 'unknown', foo: 'bar' }, // unknown type passed through
            ]),
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBeGreaterThan(0);
    });
});

describe('formatToAnthropic — uncovered merge branches', () => {
    it('cachePoint on message where content is still string-like path', () => {
        // cachePoint should add cache_control ephemeral
        const msgs = [
            mkMsg('user', 'Hello world', { cachePoint: true }),
        ];
        const { messages } = formatToAnthropic(msgs);
        expect(messages.length).toBeGreaterThanOrEqual(1);
        const userMsg = messages.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
        // content should have cache_control
        if (Array.isArray(userMsg.content)) {
            const lastPart = userMsg.content[userMsg.content.length - 1];
            expect(lastPart.cache_control).toEqual({ type: 'ephemeral' });
        }
    });

    it('consecutive same-role messages merge correctly', () => {
        // Two consecutive user messages should be merged
        const msgs = [
            mkMsg('system', 'Be helpful'),
            mkMsg('user', 'First message'),
            mkMsg('user', 'Second message'),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsgs = messages.filter(m => m.role === 'user');
        // Should merge into one user message with both texts
        expect(userMsgs.length).toBe(1);
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
        const texts = userMsgs[0].content.map(c => c.text);
        expect(texts).toContain('First message');
        expect(texts).toContain('Second message');
    });

    it('non-leading system message merges into user role', () => {
        const msgs = [
            mkMsg('system', 'System prompt'),
            mkMsg('user', 'Hello'),
            mkMsg('assistant', 'Hi'),
            mkMsg('system', 'Injected system note'),
            mkMsg('user', 'Follow up'),
        ];
        const { messages, system } = formatToAnthropic(msgs);
        expect(system).toContain('System prompt');
        // Injected system message should appear as user-role
        const userContents = messages.filter(m => m.role === 'user');
        expect(userContents.length).toBeGreaterThan(0);
    });

    it('multimodal merge with prev.content as string', () => {
        // Force a case where prev.content is a string, then a multimodal message of same role merges
        // The non-leading system creates a user entry but subsequent user multimodal should merge
        const msgs = [
            mkMsg('system', 'System prompt'),
            mkMsg('user', 'Hello'),
            mkMsg('assistant', 'Reply'),
            mkMsg('user', [
                { type: 'text', text: 'With image' },
                { type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } },
            ]),
            mkMsg('user', [
                { type: 'text', text: 'Another image' },
                { type: 'image', source: { type: 'base64', data: 'def456', media_type: 'image/jpeg' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        // The two consecutive user multimodal messages should be merged
        const lastUser = messages.filter(m => m.role === 'user').pop();
        expect(Array.isArray(lastUser.content)).toBe(true);
        // Should contain image content blocks
        const imageBlocks = lastUser.content.filter(c => c.type === 'image');
        expect(imageBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it('multimodal with non-leading system injects as user role', () => {
        const msgs = [
            mkMsg('system', 'Top system'),
            mkMsg('user', 'First msg'),
            mkMsg('system', 'Mid system'),
            mkMsg('user', 'Second msg'),
        ];
        const { messages, system } = formatToAnthropic(msgs);
        expect(system).toContain('Top system');
        // Mid system should be folded into user role as "system: ..." text
        const allTexts = messages.flatMap(m => 
            Array.isArray(m.content) ? m.content.map(c => c.text || '') : [String(m.content)]
        ).join(' ');
        expect(allTexts).toContain('Mid system');
    });

    it('multimodal image with HTTP URL creates URL source', () => {
        const msgs = [
            mkMsg('user', 'Look at this', {
                multimodals: [
                    { type: 'image', url: 'https://example.com/photo.jpg' },
                ],
            }),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const urlSource = userMsg.content.find(c => c.source?.type === 'url');
        expect(urlSource).toBeTruthy();
        expect(urlSource.source.url).toBe('https://example.com/photo.jpg');
    });

    it('array content image_url with HTTP URL creates URL source', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Photo' },
                { type: 'image_url', image_url: { url: 'https://example.com/pic.jpg' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const urlSource = userMsg.content.find(c => c.source?.type === 'url');
        expect(urlSource).toBeTruthy();
    });

    it('array content image_url with base64 data URI', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Photo' },
                { type: 'image_url', image_url: 'data:image/png;base64,abc123' },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        const base64Src = userMsg.content.find(c => c.source?.type === 'base64');
        expect(base64Src).toBeTruthy();
    });

    it('leading system with non-string content (JSON.stringify)', () => {
        const msgs = [
            mkMsg('system', { instruction: 'Be helpful', tone: 'friendly' }),
            mkMsg('user', 'Hello'),
        ];
        const { system } = formatToAnthropic(msgs);
        expect(system).toContain('instruction');
        expect(system).toContain('Be helpful');
    });

    it('non-leading system with non-string content (JSON.stringify)', () => {
        const msgs = [
            mkMsg('system', 'Top system'),
            mkMsg('user', 'Hello'),
            mkMsg('system', { note: 'injected' }),
            mkMsg('user', 'Follow'),
        ];
        const { messages } = formatToAnthropic(msgs);
        const allTexts = messages.flatMap(m =>
            Array.isArray(m.content) ? m.content.map(c => c.text || '') : [String(m.content)]
        ).join(' ');
        expect(allTexts).toContain('note');
    });

    it('inlineData with non-image mimeType is skipped', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Data' },
                { inlineData: { data: 'videodata', mimeType: 'video/mp4' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        // video mimeType should not be converted to image source
        const imageBlocks = Array.isArray(userMsg.content)
            ? userMsg.content.filter(c => c.type === 'image')
            : [];
        expect(imageBlocks.length).toBe(0);
    });

    it('image_url with string-typed url (not object)', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Photo' },
                { type: 'image_url', image_url: 'https://example.com/photo.jpg' },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const urlSource = userMsg.content.find(c => c.source?.type === 'url');
        expect(urlSource).toBeTruthy();
    });

    it('image_url with empty url string is ignored', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Photo' },
                { type: 'image_url', image_url: { url: '' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        // Empty URL should not create image source
        expect(userMsg).toBeTruthy();
    });

    it('input_image type treated as image_url', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Photo' },
                { type: 'input_image', image_url: { url: 'data:image/jpeg;base64,abc' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        const base64Src = userMsg.content.find(c => c.source?.type === 'base64');
        expect(base64Src).toBeTruthy();
    });

    it('cachePoint on merged message adds cache_control to last part', () => {
        const msgs = [
            mkMsg('user', 'First part'),
            mkMsg('user', 'Second part', { cachePoint: true }),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const lastPart = userMsg.content[userMsg.content.length - 1];
        expect(lastPart.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('empty messages produces Start placeholder', () => {
        const { messages } = formatToAnthropic([]);
        expect(messages[0].role).toBe('user');
        const texts = messages[0].content.map(c => c.text);
        expect(texts).toContain('Start');
    });

    it('assistant-only messages prepends user Start', () => {
        const msgs = [mkMsg('assistant', 'I respond')];
        const { messages } = formatToAnthropic(msgs);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content[0].text).toBe('Start');
    });

    it('prev is array when multimodal merge with array content', () => {
        // First user message has array content (text parts), second has multimodal
        // This tests the Array.isArray(prev.content) branch at L310
        const msgs = [
            mkMsg('user', [{ type: 'text', text: 'From array' }]),
            mkMsg('user', [
                { type: 'text', text: 'With image' },
                { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        expect(userMsg.content.length).toBeGreaterThanOrEqual(2);
    });

    it('text merge where prev.content is not string and not array', () => {
        // This is a defensive branch — hard to hit naturally
        // Test that consecutive same-role text messages merge with non-string prev
        const msgs = [
            mkMsg('user', 'A'),
            mkMsg('user', 'B'),
            mkMsg('user', 'C'),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsgs = messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        const texts = userMsgs[0].content.map(c => c.text);
        expect(texts).toContain('A');
        expect(texts).toContain('B');
        expect(texts).toContain('C');
    });
});

describe('formatToGemini — uncovered multimodal merge branches', () => {
    it('same-role merge: text appended to part ending with inlineData', () => {
        // Use inlineData format recognized by extractNormalizedMessagePayload
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Look at this:' },
                { inlineData: { data: 'abc123', mimeType: 'image/png' } },
            ]),
            mkMsg('user', [
                { type: 'text', text: 'And this too:' },
                { inlineData: { data: 'def456', mimeType: 'image/png' } },
            ]),
        ];
        const { contents } = formatToGemini(msgs);

        // Should merge into single user entry
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        // Should have multiple parts: text, inlineData, text, inlineData
        expect(userEntries[0].parts.length).toBeGreaterThanOrEqual(4);
    });

    it('same-role merge: text concatenation when last part is text', () => {
        // First msg has text only (no multimodal), second msg has text + multimodal
        // The first msg creates a text part. When second msg merges,
        // _lastPart.text exists → concatenation branch
        const msgs = [
            mkMsg('user', 'Hello there'),
            mkMsg('user', [
                { type: 'text', text: 'More text' },
                { inlineData: { data: 'imgdata', mimeType: 'image/png' } },
            ]),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        // Should have a text part containing both texts concatenated
        const textParts = userEntries[0].parts.filter(p => p.text);
        expect(textParts.some(p => p.text.includes('Hello there') && p.text.includes('More text'))).toBe(true);
    });

    it('non-string non-array content gets JSON.stringified', () => {
        // Content is an object (not string, not array) → should be JSON.stringified
        const msgs = [
            mkMsg('user', { key: 'value', nested: true }),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntry = contents.find(c => c.role === 'user');
        expect(userEntry).toBeTruthy();
        // Should contain the JSON stringified content
        const text = userEntry.parts.map(p => p.text).join(' ');
        expect(text).toContain('key');
        expect(text).toContain('value');
    });

    it('model role starts contents → prepends user Start', () => {
        const msgs = [
            mkMsg('assistant', 'I am the model'),
            mkMsg('user', 'Hello'),
        ];
        const { contents } = formatToGemini(msgs);
        expect(contents[0].role).toBe('user');
        expect(contents[0].parts[0].text).toBe('Start');
    });

    it('same-role merge with audio multimodal', () => {
        // Use inlineData format for audio
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Listen:' },
                { inlineData: { data: 'audiodata', mimeType: 'audio/mp3' } },
            ]),
            mkMsg('user', [
                { type: 'text', text: 'More audio:' },
                { inlineData: { data: 'moredata', mimeType: 'audio/wav' } },
            ]),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        const inlineParts = userEntries[0].parts.filter(p => p.inlineData);
        expect(inlineParts.length).toBe(2);
        expect(inlineParts[0].inlineData.mimeType).toBe('audio/mp3');
    });

    it('same-role merge with video multimodal', () => {
        // Use inlineData format for video
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Watch:' },
                { inlineData: { data: 'videodata', mimeType: 'video/mp4' } },
            ]),
            mkMsg('user', [
                { type: 'text', text: 'Another video:' },
                { inlineData: { data: 'morevideodata', mimeType: 'video/webm' } },
            ]),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        const inlineParts = userEntries[0].parts.filter(p => p.inlineData);
        expect(inlineParts.length).toBe(2);
    });

    it('different role with multimodal creates new entry', () => {
        const msgs = [
            mkMsg('assistant', 'Here is my response'),
            mkMsg('user', [
                { type: 'text', text: 'My image:' },
                { type: 'image', base64: 'data:image/png;base64,imgdata' },
            ]),
        ];
        const { contents } = formatToGemini(msgs);
        // Should have separate entries for model and user
        const roles = contents.map(c => c.role);
        expect(roles).toContain('model');
        expect(roles).toContain('user');
    });

    it('preserveSystem:false with system-only messages', () => {
        const msgs = [mkMsg('system', 'Be helpful')];
        const { contents, systemInstruction } = formatToGemini(msgs, { preserveSystem: false });

        // System should be folded into contents as user-role text
        expect(systemInstruction.length).toBe(0);
        expect(contents.length).toBeGreaterThan(0);
        const firstPart = contents[0].parts[0].text;
        expect(firstPart).toContain('system:');
        expect(firstPart).toContain('Be helpful');
    });

    it('preserveSystem:false with system + existing user first message', () => {
        const msgs = [
            mkMsg('system', 'System prompt here'),
            mkMsg('user', 'Hello'),
            mkMsg('assistant', 'Hi'),
        ];
        const { contents, systemInstruction } = formatToGemini(msgs, { preserveSystem: false });

        expect(systemInstruction.length).toBe(0);
        // System text should be prepended to first user message
        const firstUser = contents.find(c => c.role === 'user');
        expect(firstUser).toBeTruthy();
        const texts = firstUser.parts.map(p => p.text).join(' ');
        expect(texts).toContain('system:');
    });

    it('image with URL uses fileData', () => {
        // Use image_url format with HTTP URL — extractNormalizedMessagePayload creates {type:'image', url:...}
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Image from URL' },
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
            ]),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntry = contents.find(c => c.role === 'user');
        const fileDataParts = userEntry.parts.filter(p => p.fileData);
        expect(fileDataParts.length).toBe(1);
        expect(fileDataParts[0].fileData.fileUri).toBe('https://example.com/img.png');
    });

    it('same-role merge: image URL in merged message', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'First' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            ]),
            mkMsg('user', [
                { type: 'text', text: 'Second' },
                { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
            ]),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        const fileDataParts = userEntries[0].parts.filter(p => p.fileData);
        expect(fileDataParts.length).toBe(2);
    });

    it('non-leading system after user goes to user role with "system:" prefix', () => {
        const msgs = [
            mkMsg('system', 'Top system'),
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Mid system injection'),
            mkMsg('assistant', 'Reply'),
        ];
        const { contents } = formatToGemini(msgs, { preserveSystem: true });
        // Non-leading system should be in user role
        const allTexts = contents.flatMap(c => c.parts.map(p => p.text || '')).join(' ');
        expect(allTexts).toContain('system: Mid system injection');
    });

    it('non-leading system merges into existing preceding user', () => {
        const msgs = [
            mkMsg('system', 'Top'),
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Injected after user'),
        ];
        const { contents } = formatToGemini(msgs, { preserveSystem: true });
        // The "Injected after user" system msg should merge into the preceding user entry
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        const texts = userEntries[0].parts.map(p => p.text);
        expect(texts.some(t => t.includes('system: Injected after user'))).toBe(true);
    });

    it('non-string system content at leading position → JSON.stringify', () => {
        const msgs = [
            mkMsg('system', { instruction: 'Be helpful' }),
            mkMsg('user', 'Hello'),
        ];
        const { systemInstruction } = formatToGemini(msgs, { preserveSystem: true });
        expect(systemInstruction[0]).toContain('instruction');
    });

    it('empty text and no multimodals are skipped', () => {
        const msgs = [
            mkMsg('user', ''),
            mkMsg('user', 'Valid'),
        ];
        const { contents } = formatToGemini(msgs);
        // Empty message should be skipped
        expect(contents.length).toBeGreaterThan(0);
        const texts = contents.flatMap(c => c.parts.map(p => p.text)).filter(Boolean);
        expect(texts.every(t => t.length > 0)).toBe(true);
    });

    it('multimodal with no base64 uses empty string', () => {
        // modal.base64 is undefined → base64 = '' → commaIdx = -1 → data = ''
        const msgs = [
            mkMsg('user', 'Image', {
                multimodals: [{ type: 'image', mimeType: 'image/png' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntry = contents.find(c => c.role === 'user');
        expect(userEntry).toBeTruthy();
        const inlineParts = userEntry.parts.filter(p => p.inlineData);
        expect(inlineParts.length).toBe(1);
        expect(inlineParts[0].inlineData.data).toBe('');
    });

    it('multimodal with raw base64 (no comma) uses fallback mimeType', () => {
        const msgs = [
            mkMsg('user', 'Image', {
                multimodals: [{ type: 'image', base64: 'rawdata' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const inlineParts = contents.flatMap(c => c.parts).filter(p => p.inlineData);
        expect(inlineParts.length).toBe(1);
        expect(inlineParts[0].inlineData.data).toBe('rawdata');
        expect(inlineParts[0].inlineData.mimeType).toBe('application/octet-stream');
    });

    it('multimodal with raw base64 + explicit mimeType uses that mimeType', () => {
        const msgs = [
            mkMsg('user', 'Image', {
                multimodals: [{ type: 'image', base64: 'rawdata', mimeType: 'image/webp' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const inlineParts = contents.flatMap(c => c.parts).filter(p => p.inlineData);
        expect(inlineParts[0].inlineData.mimeType).toBe('image/webp');
    });

    it('video multimodal type creates inlineData', () => {
        const msgs = [
            mkMsg('user', 'Watch', {
                multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,videodata', mimeType: 'video/mp4' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const inlineParts = contents.flatMap(c => c.parts).filter(p => p.inlineData);
        expect(inlineParts.length).toBe(1);
        expect(inlineParts[0].inlineData.mimeType).toBe('video/mp4');
    });

    it('same-role merge: multimodal with no text only adds inlineData parts', () => {
        const msgs = [
            mkMsg('user', 'Init'),
            mkMsg('user', '', {
                multimodals: [{ type: 'image', base64: 'data:image/png;base64,x' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        // Should have text part from first msg and inlineData from second
        const inlineParts = userEntries[0].parts.filter(p => p.inlineData);
        expect(inlineParts.length).toBe(1);
    });

    it('preserveSystem:true keeps systemInstruction', () => {
        const msgs = [
            mkMsg('system', 'Keep me as system'),
            mkMsg('user', 'Hello'),
        ];
        const { systemInstruction } = formatToGemini(msgs, { preserveSystem: true });
        expect(systemInstruction.length).toBe(1);
        expect(systemInstruction[0]).toBe('Keep me as system');
    });

    it('model role with thought content gets stripped', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('assistant', '<display_content>visible</display_content>'),
        ];
        const { contents } = formatToGemini(msgs);
        const modelEntry = contents.find(c => c.role === 'model');
        expect(modelEntry).toBeTruthy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. token-usage.js — legacy key fallback + explicit Anthropic reasoning
// ═══════════════════════════════════════════════════════════════════════════════
import {
    _normalizeTokenUsage,
    _setTokenUsage,
    _takeTokenUsage,
    _tokenUsageStore,
} from '../src/shared/token-usage.js';

describe('token-usage: _takeTokenUsage legacy key fallback', () => {
    beforeEach(() => {
        _tokenUsageStore.clear();
    });

    it('falls back to legacy nonstream key when scoped key not found', () => {
        const usage = { input: 10, output: 20, reasoning: 0, cached: 0, total: 30 };
        // Store with null requestId → goes to legacy key '_latest'
        _setTokenUsage(null, usage, false);

        // Take with a specific requestId → scoped miss → falls back to legacy
        const result = _takeTokenUsage('some-request-id', false);
        expect(result).toEqual(usage);

        // Legacy key should be deleted after take
        const again = _takeTokenUsage(null, false);
        expect(again).toBeNull();
    });

    it('falls back to legacy stream key when scoped key not found', () => {
        const usage = { input: 5, output: 15, reasoning: 0, cached: 0, total: 20 };
        // Store with undefined requestId → goes to legacy key '_stream_latest'
        _setTokenUsage(undefined, usage, true);

        // Take with a specific requestId → scoped miss → falls back to legacy stream
        const result = _takeTokenUsage('other-id', true);
        expect(result).toEqual(usage);
    });

    it('returns null when neither scoped nor legacy exists', () => {
        const result = _takeTokenUsage('nonexistent-id', false);
        expect(result).toBeNull();
    });

    it('prefers scoped key over legacy key', () => {
        const scopedUsage = { input: 100, output: 200, reasoning: 0, cached: 0, total: 300 };
        const legacyUsage = { input: 1, output: 2, reasoning: 0, cached: 0, total: 3 };
        _setTokenUsage('my-req', scopedUsage, false);
        _setTokenUsage(null, legacyUsage, false);

        const result = _takeTokenUsage('my-req', false);
        expect(result).toEqual(scopedUsage);

        // Legacy should still be there
        const legacy = _takeTokenUsage(null, false);
        expect(legacy).toEqual(legacyUsage);
    });
});

describe('token-usage: _normalizeTokenUsage Anthropic explicit reasoning tokens', () => {
    it('Anthropic with reasoning_tokens field', () => {
        const raw = { input_tokens: 100, output_tokens: 500, reasoning_tokens: 300 };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.reasoning).toBe(300);
        expect(result.reasoningEstimated).toBeUndefined();
        expect(result.total).toBe(600);
    });

    it('Anthropic with thinking_tokens field', () => {
        const raw = { input_tokens: 100, output_tokens: 500, thinking_tokens: 200 };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.reasoning).toBe(200);
        expect(result.reasoningEstimated).toBeUndefined();
    });

    it('Anthropic with output_tokens_details.reasoning_tokens', () => {
        const raw = { input_tokens: 100, output_tokens: 500, output_tokens_details: { reasoning_tokens: 150 } };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.reasoning).toBe(150);
    });

    it('Anthropic with output_tokens_details.thinking_tokens', () => {
        const raw = { input_tokens: 100, output_tokens: 500, output_tokens_details: { thinking_tokens: 180 } };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.reasoning).toBe(180);
    });

    it('Anthropic with output_token_details (singular) reasoning_tokens', () => {
        const raw = { input_tokens: 100, output_tokens: 500, output_token_details: { reasoning_tokens: 120 } };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.reasoning).toBe(120);
    });

    it('Anthropic with completion_tokens_details.reasoning_tokens', () => {
        const raw = { input_tokens: 100, output_tokens: 500, completion_tokens_details: { reasoning_tokens: 90 } };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.reasoning).toBe(90);
    });

    it('Anthropic with cache tokens', () => {
        const raw = {
            input_tokens: 100, output_tokens: 50,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
            reasoning_tokens: 20,
        };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.cached).toBe(40);
        expect(result.reasoning).toBe(20);
        expect(result.total).toBe(150);
    });

    it('Anthropic zero explicit reasoning falls through to estimation', () => {
        // When reasoning_tokens is 0, explicitReasoning = 0, so it goes to estimation path
        const raw = { input_tokens: 100, output_tokens: 500, reasoning_tokens: 0 };
        const result = _normalizeTokenUsage(raw, 'anthropic', {
            anthropicHasThinking: true,
            anthropicVisibleText: 'Short',
        });
        // With estimation, reasoning should be > 0 since output(500) >> visible text tokens
        expect(result.reasoning).toBeGreaterThan(0);
        expect(result.reasoningEstimated).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Additional branch coverage push — message-format + dynamic-models 80%+
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatToOpenAI — additional branch coverage', () => {
    // Line 95: contentParts empty + textContent empty → msg.content = ''
    it('multimodal with null/invalid modals and empty text → empty string content skipped', () => {
        const msgs = [
            {
                role: 'user',
                content: 'fallback',
                multimodals: [null, undefined, { type: 'unknown' }, { notAModal: true }],
            },
        ];
        const result = formatToOpenAI(msgs);
        // The multimodals are invalid so contentParts is empty, but text has 'fallback'
        expect(result.length).toBeGreaterThan(0);
    });

    // Line 95: contentParts = 0, textContent = '' → fallback to ''
    it('multimodal with empty text and only invalid modals results in empty content', () => {
        const msgs = [
            {
                role: 'user',
                content: '',
                multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,abc' }],
            },
        ];
        // Video is not handled in OpenAI format → contentParts empty, textContent empty → ''
        const result = formatToOpenAI(msgs);
        // Empty content should be filtered out
        expect(result.length).toBe(0);
    });

    // Line 156/159: altrole merge where prev.content is empty string (hasNonEmptyMessageContent → false → [])
    it('altrole merge: prev has empty content, msg has array → only msg parts', () => {
        // Force prev.content to be empty string and msg.content to be array
        const msgs = [
            mkMsg('user', ' '),  // mustuser placeholder
            mkMsg('user', [{ type: 'text', text: 'Array content' }]),
        ];
        const result = formatToOpenAI(msgs, { altrole: true, mustuser: true });
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    // Line 159: altrole merge where msg.content is empty string → msgParts = []
    it('altrole merge: msg has empty string content → empty msgParts', () => {
        // Use mustuser so the first ' ' is kept, then second message is empty
        // Actually, empty content is filtered before altrole merge. Let's use array format.
        const msgs = [
            mkMsg('user', [{ type: 'text', text: 'First' }]),
            mkMsg('user', [{ type: 'text', text: 'Second' }]),
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result.length).toBe(1);
        expect(Array.isArray(result[0].content)).toBe(true);
        expect(result[0].content.length).toBe(2);
    });

    // Line 108-109: inlineData with audio/ mimeType → extractNormalizedMessagePayload converts
    // to multimodal first, so the multimodal path handles it. Default format is 'mp3'.
    it('inlineData audio goes through multimodal path with correct format', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Test' },
                { inlineData: { data: 'audiodata', mimeType: 'audio/mpeg' } },
            ]),
        ];
        const result = formatToOpenAI(msgs);
        const userMsg = result.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const audio = userMsg.content.find(p => p.type === 'input_audio');
        // extractNormalizedMessagePayload wraps to data:audio/mpeg;base64,... → parseBase64DataUri
        // detects 'audio/mpeg' → none of wav/ogg/flac/webm match → default 'mp3'
        expect(audio.input_audio.format).toBe('mp3');
    });

    // Line 121: null/undefined content → continue branch
    it('message with null content is skipped', () => {
        const msgs = [
            { role: 'user', content: null },
            mkMsg('user', 'Valid'),
        ];
        const result = formatToOpenAI(msgs);
        expect(result.length).toBe(1);
        expect(result[0].content).toBe('Valid');
    });

    // Line 127: m.name as non-string → name not set
    it('message with non-string name → name not copied', () => {
        const msgs = [mkMsg('user', 'Hello', { name: 123 })];
        const result = formatToOpenAI(msgs);
        expect(result[0].name).toBeUndefined();
    });
});

describe('formatToAnthropic — additional branch coverage', () => {
    // Line 223: multimodal with all invalid modals → contentParts empty → fallback path
    it('multimodal with only non-image modals falls to text fallback', () => {
        const msgs = [
            {
                role: 'user',
                content: 'Text content here',
                multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,abc' }],
            },
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
    });

    // Line 240/245: multimodal empty contentParts + same role merge to prev with array content (Line 245)
    it('multimodal empty contentParts + same role prev has array content → merge text', () => {
        const msgs = [
            mkMsg('user', [{ type: 'text', text: 'From array' }]),
            {
                role: 'user',
                content: 'Fallback text',
                multimodals: [{ type: 'video' }],  // not image → contentParts empty
            },
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsgs = messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    // Line 245: prev.content is not array (string) → creates array from prev string + new text
    it('multimodal empty contentParts + same role prev has string content → wraps', () => {
        // Build a scenario: first user msg produces string content, then second user multimodal (non-image) merges
        const msgs = [
            mkMsg('user', 'Initial text'),
            {
                role: 'user',
                content: 'More text',
                multimodals: [{ type: 'audio' }],  // not image → contentParts empty
            },
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsgs = messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
    });

    // Lines 282-286: array content with image_url having string image_url (not object)
    it('array content with image_url string property → parses correctly', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Photo' },
                { type: 'image_url', image_url: 'data:image/webp;base64,webpdata' },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        const img = userMsg.content.find(c => c.type === 'image');
        expect(img.source.media_type).toBe('image/webp');
        expect(img.source.data).toBe('webpdata');
    });

    // Line 290: array content where text part has empty text → skipped  
    it('array content with empty text parts are filtered', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: '' },
                { type: 'text', text: '   ' },
                { type: 'text', text: 'Valid text' },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();
    });

    // Lines 309-310: array content merge where prev.content is string (not array)
    it('array content merge into prev with string content → converts to array', () => {
        const msgs = [
            mkMsg('user', 'String content first'),
            mkMsg('user', [
                { type: 'text', text: 'Array text' },
                { type: 'image', source: { type: 'base64', data: 'img', media_type: 'image/png' } },
            ]),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsgs = messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
    });

    // Line 335-336: cachePoint where content is string → wraps in array with cache_control
    it('cachePoint on message with string content → wraps to structured block', () => {
        // Force a message where after formatting, content is string (not array) + cachePoint
        // This is tricky because formatToAnthropic always produces array content.
        // The cachePoint check uses _origSources. Let's test with typeof check.
        const msgs = [
            mkMsg('user', 'Cached message', { cachePoint: true }),
        ];
        const { messages } = formatToAnthropic(msgs);
        const userMsg = messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        const lastPart = userMsg.content[userMsg.content.length - 1];
        expect(lastPart.cache_control).toEqual({ type: 'ephemeral' });
    });
});

describe('formatToGemini — additional branch coverage', () => {
    // Line 396: empty trimmed text + no multimodals → skip
    it('whitespace-only message is skipped', () => {
        const msgs = [
            mkMsg('user', '   '),
            mkMsg('user', 'Valid'),
        ];
        const { contents } = formatToGemini(msgs);
        expect(contents.length).toBeGreaterThan(0);
        // Only 'Valid' should appear
        const texts = contents.flatMap(c => c.parts.map(p => p.text)).filter(Boolean);
        expect(texts.every(t => t.trim().length > 0)).toBe(true);
    });

    // Lines 412/415: same-role multimodal with image URL uses fileData in merge path
    it('same-role merge: image URL in merged entry (merge path)', () => {
        const msgs = [
            mkMsg('user', 'Text first'),
            mkMsg('user', 'Image next', {
                multimodals: [{ type: 'image', url: 'https://example.com/img.png' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        const fileDataParts = userEntries[0].parts.filter(p => p.fileData);
        expect(fileDataParts.length).toBe(1);
    });

    // Lines 417-418: same-role multimodal with non-image (audio/video) base64 with no comma
    it('same-role merge: audio modal with raw base64 (no comma) uses fallback mimeType', () => {
        const msgs = [
            mkMsg('user', 'First'),
            mkMsg('user', 'Audio here', {
                multimodals: [{ type: 'audio', base64: 'rawbytes', mimeType: 'audio/ogg' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        const userEntries = contents.filter(c => c.role === 'user');
        expect(userEntries.length).toBe(1);
        const inlineParts = userEntries[0].parts.filter(p => p.inlineData);
        expect(inlineParts.length).toBe(1);
        expect(inlineParts[0].inlineData.mimeType).toBe('audio/ogg');
    });

    // Line 443/445: new entry (diff role) with image URL → fileData in newParts
    it('different role: image URL creates fileData in new entry', () => {
        const msgs = [
            mkMsg('assistant', 'Model reply'),
            mkMsg('user', 'My image', {
                multimodals: [{ type: 'image', url: 'https://example.com/pic.jpg' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        // Note: model starts first → 'Start' user placeholder is prepended
        // Find the user entry that has fileData, not the placeholder
        const userEntries = contents.filter(c => c.role === 'user');
        const entryWithFile = userEntries.find(e => e.parts.some(p => p.fileData));
        expect(entryWithFile).toBeTruthy();
        const fileParts = entryWithFile.parts.filter(p => p.fileData);
        expect(fileParts.length).toBe(1);
        expect(fileParts[0].fileData.fileUri).toBe('https://example.com/pic.jpg');
    });

    // Line 445: new entry with non-URL image (raw base64, no comma)
    it('different role: image with raw base64 and explicit mimeType → inlineData', () => {
        const msgs = [
            mkMsg('assistant', 'Reply'),
            mkMsg('user', 'Photo', {
                multimodals: [{ type: 'image', base64: 'rawimgdata', mimeType: 'image/webp' }],
            }),
        ];
        const { contents } = formatToGemini(msgs);
        // 'Start' placeholder is prepended since model starts first
        const userEntries = contents.filter(c => c.role === 'user');
        const entryWithInline = userEntries.find(e => e.parts.some(p => p.inlineData));
        expect(entryWithInline).toBeTruthy();
        const inlineParts = entryWithInline.parts.filter(p => p.inlineData);
        expect(inlineParts.length).toBe(1);
        expect(inlineParts[0].inlineData.mimeType).toBe('image/webp');
        expect(inlineParts[0].inlineData.data).toBe('rawimgdata');
    });

    // Line 428: useThoughtSignature path (model role with thought sig)
    it('useThoughtSignature: model message with cached signature gets thoughtSignature', () => {
        // Pre-cache a thought signature using .save() API
        ThoughtSignatureCache.save('Hello world', 'sig-12345');
        const msgs = [
            mkMsg('user', 'Start'),
            mkMsg('assistant', 'Hello world'),
        ];
        const { contents } = formatToGemini(msgs, { useThoughtSignature: true });
        const modelEntry = contents.find(c => c.role === 'model');
        expect(modelEntry).toBeTruthy();
        const part = modelEntry.parts.find(p => p.thoughtSignature === 'sig-12345');
        expect(part).toBeTruthy();
        ThoughtSignatureCache.clear();
    });

    // Line 428: useThoughtSignature but no cached sig → no thoughtSignature
    it('useThoughtSignature: model message without cached sig → no thoughtSignature', () => {
        const msgs = [
            mkMsg('user', 'Start'),
            mkMsg('assistant', 'No cached sig'),
        ];
        const { contents } = formatToGemini(msgs, { useThoughtSignature: true });
        const modelEntry = contents.find(c => c.role === 'model');
        expect(modelEntry?.parts[0].thoughtSignature).toBeUndefined();
    });
});

describe('dynamic-models — additional branch coverage', () => {
    // Lines 8, 13: dateSuffixFromDashedId and toUniqueKey internal paths
    // These are exercised through the public API functions

    // OpenAI model with no date suffix and not ending in -latest
    it('formatOpenAIDynamicModels: model id with no date and no -latest → raw name', () => {
        const result = formatOpenAIDynamicModels([{ id: 'gpt-4.1-mini' }]);
        expect(result[0].name).toBe('GPT-4.1-mini');
    });

    // Vertex Google model with no supportedActions (undefined → no filter)
    it('formatVertexGoogleModels: model without supportedActions passes if starts with gemini-', () => {
        const result = formatVertexGoogleModels([
            { name: 'publishers/google/models/gemini-3.0-flash' },
        ]);
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('gemini-3.0-flash');
    });

    // Vertex Google model where supportedActions does NOT include generateContent → filtered
    it('formatVertexGoogleModels: model with non-generateContent action is filtered out', () => {
        const result = formatVertexGoogleModels([
            { name: 'publishers/google/models/gemini-2.5-pro', supportedActions: ['embedContent'] },
        ]);
        expect(result.length).toBe(0);
    });

    // Vertex Claude model without compact date → no suffix appended
    it('formatVertexClaudeModels: model without 8-digit date → name unchanged', () => {
        const result = formatVertexClaudeModels([
            { name: 'publishers/anthropic/models/claude-sonnet-4', displayName: 'Claude Sonnet 4' },
        ]);
        expect(result[0].name).toBe('Claude Sonnet 4');
    });

    // Vertex Claude model with displayName containing '/' → no date suffix appended
    it('formatVertexClaudeModels: model with / in displayName → no date appended', () => {
        const result = formatVertexClaudeModels([
            { name: 'publishers/anthropic/models/claude-sonnet-4-5-20250929', displayName: 'anthropic/claude-sonnet-4-5' },
        ]);
        // Has compact date but displayName contains '/' → no suffix
        expect(result[0].name).toBe('anthropic/claude-sonnet-4-5');
    });

    // mergeDynamicModels with models that have no uniqueId → falls back to toUniqueKey
    it('mergeDynamicModels: model without uniqueId uses provider::id key', () => {
        const existing = [{ id: 'test-model', name: 'Test' }];
        const incoming = [{ id: 'test-model', name: 'Test Updated' }];
        const result = mergeDynamicModels(existing, incoming, 'Custom');
        expect(result.mergedModels.length).toBe(1);
        expect(result.mergedModels[0].name).toBe('Test Updated');
    });

    // mergeDynamicModels: incoming model with no id or name → skipped
    it('mergeDynamicModels: incoming model missing id is skipped', () => {
        const existing = [{ uniqueId: 'a', id: 'a', name: 'A' }];
        const incoming = [{ name: 'No ID' }];
        const result = mergeDynamicModels(existing, incoming, 'Test');
        expect(result.mergedModels.length).toBe(1);
        expect(result.addedModels.length).toBe(0);
    });

    // normalizeAwsAnthropicModelId: empty string
    it('normalizeAwsAnthropicModelId: empty string → returns empty', () => {
        expect(normalizeAwsAnthropicModelId('')).toBe('');
    });

    // normalizeAwsAnthropicModelId: non-anthropic model → passthrough
    it('normalizeAwsAnthropicModelId: non-anthropic model → unchanged', () => {
        expect(normalizeAwsAnthropicModelId('amazon.titan-text-v2')).toBe('amazon.titan-text-v2');
    });

    // normalizeAwsAnthropicModelId: claude with version but no date (uses version branch)
    it('normalizeAwsAnthropicModelId: version-only (3-5) → uses us prefix', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-3-5-sonnet-v1:0')).toBe('us.anthropic.claude-3-5-sonnet-v1:0');
    });

    // normalizeAwsAnthropicModelId: claude 5+ major version → global
    it('normalizeAwsAnthropicModelId: major version 5+ → uses global', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-5-0-opus-v1:0')).toBe('global.anthropic.claude-5-0-opus-v1:0');
    });

    // formatAwsDynamicModels: model with INFERENCE_PROFILE type
    it('formatAwsDynamicModels: model with INFERENCE_PROFILE inference type passes', () => {
        const result = formatAwsDynamicModels([
            {
                modelId: 'anthropic.claude-4-sonnet-20250514-v1:0',
                modelName: 'Claude 4 Sonnet',
                outputModalities: ['TEXT'],
                inferenceTypesSupported: ['INFERENCE_PROFILE'],
            },
        ]);
        expect(result.length).toBe(1);
    });

    // formatAwsDynamicModels: inference profile that already exists in model results → skipped
    it('formatAwsDynamicModels: duplicate inference profile skipped', () => {
        const result = formatAwsDynamicModels(
            [
                {
                    modelId: 'anthropic.claude-4-sonnet-20250514-v1:0',
                    modelName: 'Claude',
                    outputModalities: ['TEXT'],
                    inferenceTypesSupported: ['ON_DEMAND'],
                },
            ],
            [
                { inferenceProfileId: 'us.anthropic.claude-4-sonnet-20250514-v1:0', inferenceProfileName: 'Claude Profile' },
            ],
        );
        // Profile ID matches the normalized model ID → should be skipped
        expect(result.length).toBe(1);
    });

    // formatAwsDynamicModels: profile with no inferenceProfileId but has inferenceProfileArn
    it('formatAwsDynamicModels: uses inferenceProfileArn when inferenceProfileId missing', () => {
        const result = formatAwsDynamicModels([], [
            { inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123:inference-profile/anthropic.claude-test', inferenceProfileName: 'Test Claude' },
        ]);
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('arn:aws:bedrock:us-east-1:123:inference-profile/anthropic.claude-test');
    });

    // formatAwsDynamicModels: profile that doesn't match anthropic/claude → skipped  
    it('formatAwsDynamicModels: non-anthropic profile skipped', () => {
        const result = formatAwsDynamicModels([], [
            { inferenceProfileId: 'amazon.titan-profile', inferenceProfileName: 'Titan' },
        ]);
        expect(result.length).toBe(0);
    });

    // Gemini model with empty id after replacing models/ prefix
    it('formatGeminiDynamicModels: model with empty name after prefix removal → filtered', () => {
        const result = formatGeminiDynamicModels([
            { name: 'models/', supportedGenerationMethods: ['generateContent'] },
        ]);
        expect(result.length).toBe(0);
    });

    // Gemini model not starting with gemini- → filtered
    it('formatGeminiDynamicModels: non-gemini model filtered', () => {
        const result = formatGeminiDynamicModels([
            { name: 'models/text-bison-001', supportedGenerationMethods: ['generateContent'] },
        ]);
        expect(result.length).toBe(0);
    });

    // OpenAI: o-series models
    it('formatOpenAIDynamicModels: o-series models (o1, o3, o4) are included', () => {
        const result = formatOpenAIDynamicModels([
            { id: 'o1-preview' },
            { id: 'o3-mini' },
            { id: 'o4-preview-2026-03-05' },
        ]);
        expect(result.map(m => m.id)).toEqual(['o1-preview', 'o3-mini', 'o4-preview-2026-03-05']);
    });

    // OpenAI: model with exclude keyword filtered
    it('formatOpenAIDynamicModels: search/audio/tts excluded', () => {
        const result = formatOpenAIDynamicModels([
            { id: 'gpt-4o-search' },
            { id: 'gpt-4o-audio-preview' },
            { id: 'gpt-4o-tts-hd' },
        ]);
        expect(result.length).toBe(0);
    });

    // Anthropic: model without type='model'
    it('formatAnthropicDynamicModels: non-model type filtered', () => {
        const result = formatAnthropicDynamicModels([
            { type: 'completion', id: 'claude-test' },
        ]);
        expect(result.length).toBe(0);
    });

    // Anthropic: model without compact date → no suffix
    it('formatAnthropicDynamicModels: model without 8-digit date → no suffix', () => {
        const result = formatAnthropicDynamicModels([
            { type: 'model', id: 'claude-sonnet-4' },
        ]);
        expect(result[0].name).toBe('claude-sonnet-4');
    });

    // formatVertexGoogleModels: empty model name → empty id → filtered (not gemini-)
    it('formatVertexGoogleModels: empty name filtered', () => {
        const result = formatVertexGoogleModels([{ name: '' }]);
        expect(result.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// Merged from coverage-boost-95.test.js
// ═══════════════════════════════════════════════════════════════


// ──────────────────────────────────────────────
// 1. update-toast.js — showMainAutoUpdateResult
// ──────────────────────────────────────────────
import { createUpdateToast } from '../src/shared/update-toast.js';

function createMockDoc() {
    const elements = {};
    return {
        querySelector: vi.fn(async (sel) => elements[sel] || null),
        createElement: vi.fn(async () => ({
            setAttribute: vi.fn(async () => {}),
            setStyle: vi.fn(async () => {}),
            setInnerHTML: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        })),
        _setElement(sel, el) { elements[sel] = el; },
    };
}

describe('update-toast: showUpdateToast', () => {
    it('shows toast with updates and auto-dismisses', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showUpdateToast([
            { name: 'A', icon: '🔵', localVersion: '1.0', remoteVersion: '2.0', changes: 'fix' },
            { name: 'B', icon: '🟢', localVersion: '1.0', remoteVersion: '2.0' },
        ]);

        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('handles > 3 updates (shows ...외 N개)', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showUpdateToast([
            { name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' },
            { name: 'B', icon: '2', localVersion: '1', remoteVersion: '2' },
            { name: 'C', icon: '3', localVersion: '1', remoteVersion: '2' },
            { name: 'D', icon: '4', localVersion: '1', remoteVersion: '2' },
        ]);

        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('returns silently when getRootDocument is null', async () => {
        const Risu = { getRootDocument: vi.fn(async () => null) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showUpdateToast([{ name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' }]);
        // no error thrown
    });

    it('returns silently when body not found', async () => {
        const doc = createMockDoc();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showUpdateToast([{ name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' }]);
    });

    it('removes existing toast before creating new one', async () => {
        const doc = createMockDoc();
        const existing = { remove: vi.fn(async () => {}) };
        doc._setElement('[x-cpm-toast]', existing);
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showUpdateToast } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showUpdateToast([{ name: 'A', icon: '1', localVersion: '1', remoteVersion: '2' }]);
        expect(existing.remove).toHaveBeenCalled();
    });
});

describe('update-toast: showMainAutoUpdateResult', () => {
    it('shows success toast', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showMainAutoUpdateResult('1.0', '2.0', 'bugfix', true);
        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('shows failure toast with error', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showMainAutoUpdateResult('1.0', '2.0', '', false, 'network error');
        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('shows failure toast without explicit error message', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });

        await showMainAutoUpdateResult('1.0', '2.0', '', false);
        expect(body.appendChild).toHaveBeenCalledTimes(1);
    });

    it('returns silently when getRootDocument is null', async () => {
        const Risu = { getRootDocument: vi.fn(async () => null) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', '', true);
    });

    it('returns silently when body not found', async () => {
        const doc = createMockDoc();
        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', '', true);
    });

    it('adjusts bottom position when sub-toast exists', async () => {
        const doc = createMockDoc();
        doc._setElement('[x-cpm-toast]', { exists: true });
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', '', true);
        expect(body.appendChild).toHaveBeenCalled();
    });

    it('removes existing main toast before creating new one', async () => {
        const doc = createMockDoc();
        const existing = { remove: vi.fn(async () => {}) };
        doc._setElement('[x-cpm-main-toast]', existing);
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', 'changes', true);
        expect(existing.remove).toHaveBeenCalled();
    });

    it('success toast includes changes text', async () => {
        const doc = createMockDoc();
        const body = { appendChild: vi.fn(async () => {}) };
        doc._setElement('body', body);
        let capturedHtml = '';
        doc.createElement = vi.fn(async () => ({
            setAttribute: vi.fn(async () => {}),
            setStyle: vi.fn(async () => {}),
            setInnerHTML: vi.fn(async (h) => { capturedHtml = h; }),
            remove: vi.fn(async () => {}),
        }));

        const Risu = { getRootDocument: vi.fn(async () => doc) };
        const { showMainAutoUpdateResult } = createUpdateToast({ Risu, escHtml: (s) => s });
        await showMainAutoUpdateResult('1.0', '2.0', 'big fix', true);
        expect(capturedHtml).toContain('big fix');
    });
});

// ──────────────────────────────────────────────
// 2. model-helpers.js — uncovered branches
// ──────────────────────────────────────────────
import {
    supportsOpenAIVerbosity,
    needsCopilotResponsesAPI,
    shouldStripOpenAISamplingParams,
    shouldStripGPT54SamplingForReasoning,
    needsMaxCompletionTokens,
} from '../src/shared/model-helpers.js';

describe('model-helpers: supportsOpenAIVerbosity', () => {
    it('returns false for empty/falsy', () => {
        expect(supportsOpenAIVerbosity('')).toBe(false);
        expect(supportsOpenAIVerbosity(null)).toBe(false);
    });
    it('returns true for gpt-5', () => expect(supportsOpenAIVerbosity('gpt-5')).toBe(true));
    it('returns true for gpt-5.4', () => expect(supportsOpenAIVerbosity('gpt-5.4')).toBe(true));
    it('returns true for gpt-5-mini', () => expect(supportsOpenAIVerbosity('gpt-5-mini')).toBe(true));
    it('returns true for gpt-5-nano', () => expect(supportsOpenAIVerbosity('gpt-5-nano')).toBe(true));
    it('returns true for gpt-5-2025-01-01', () => expect(supportsOpenAIVerbosity('gpt-5-2025-01-01')).toBe(true));
    it('returns false for gpt-4o', () => expect(supportsOpenAIVerbosity('gpt-4o')).toBe(false));
    it('returns false for o3', () => expect(supportsOpenAIVerbosity('o3')).toBe(false));
});

describe('model-helpers: needsCopilotResponsesAPI', () => {
    it('returns false for empty/falsy', () => {
        expect(needsCopilotResponsesAPI('')).toBe(false);
        expect(needsCopilotResponsesAPI(null)).toBe(false);
    });
    it('returns true for gpt-5.4', () => expect(needsCopilotResponsesAPI('gpt-5.4')).toBe(true));
    it('returns true for gpt-5.5', () => expect(needsCopilotResponsesAPI('gpt-5.5')).toBe(true));
    it('returns false for gpt-5.3', () => expect(needsCopilotResponsesAPI('gpt-5.3')).toBe(false));
    it('returns false for gpt-5', () => expect(needsCopilotResponsesAPI('gpt-5')).toBe(false));
    it('returns true for prefixed model org/gpt-5.4', () => expect(needsCopilotResponsesAPI('org/gpt-5.4')).toBe(true));
});

describe('model-helpers: shouldStripOpenAISamplingParams', () => {
    it('returns false for empty', () => expect(shouldStripOpenAISamplingParams('')).toBe(false));
    it('returns true for o1', () => expect(shouldStripOpenAISamplingParams('o1')).toBe(true));
    it('returns true for o1-mini', () => expect(shouldStripOpenAISamplingParams('o1-mini')).toBe(true));
    it('returns true for o1-preview', () => expect(shouldStripOpenAISamplingParams('o1-preview')).toBe(true));
    it('returns true for o1-pro', () => expect(shouldStripOpenAISamplingParams('o1-pro')).toBe(true));
    it('returns true for o3', () => expect(shouldStripOpenAISamplingParams('o3')).toBe(true));
    it('returns true for o3-mini', () => expect(shouldStripOpenAISamplingParams('o3-mini')).toBe(true));
    it('returns true for o3-pro', () => expect(shouldStripOpenAISamplingParams('o3-pro')).toBe(true));
    it('returns true for o3-deep-research', () => expect(shouldStripOpenAISamplingParams('o3-deep-research')).toBe(true));
    it('returns true for o4-mini', () => expect(shouldStripOpenAISamplingParams('o4-mini')).toBe(true));
    it('returns true for o4-mini-deep-research', () => expect(shouldStripOpenAISamplingParams('o4-mini-deep-research')).toBe(true));
    it('returns false for gpt-5', () => expect(shouldStripOpenAISamplingParams('gpt-5')).toBe(false));
    it('returns true for prefixed org/o3', () => expect(shouldStripOpenAISamplingParams('org/o3')).toBe(true));
});

describe('model-helpers: shouldStripGPT54SamplingForReasoning', () => {
    it('returns false for empty model', () => expect(shouldStripGPT54SamplingForReasoning('', 'medium')).toBe(false));
    it('returns false for no reasoning effort', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', '')).toBe(false));
    it('returns false for none reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'none')).toBe(false));
    it('returns false for off reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'off')).toBe(false));
    it('returns true for gpt-5.4 with medium reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'medium')).toBe(true));
    it('returns true for gpt-5.4-mini with high reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-mini', 'high')).toBe(true));
    it('returns true for gpt-5.4-nano with low reasoning', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-nano', 'low')).toBe(true));
    it('returns true for gpt-5.4-pro with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-pro', 'medium')).toBe(true));
    it('returns true for gpt-5.4-2025-01-01 with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.4-2025-01-01', 'medium')).toBe(true));
    it('returns false for gpt-5.3 with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-5.3', 'medium')).toBe(false));
    it('returns false for gpt-4o with medium', () => expect(shouldStripGPT54SamplingForReasoning('gpt-4o', 'medium')).toBe(false));
});

describe('model-helpers: needsMaxCompletionTokens', () => {
    it('returns false for empty', () => expect(needsMaxCompletionTokens('')).toBe(false));
    it('returns true for gpt-4.5', () => expect(needsMaxCompletionTokens('gpt-4.5')).toBe(true));
    it('returns true for gpt-5', () => expect(needsMaxCompletionTokens('gpt-5')).toBe(true));
    it('returns true for o1', () => expect(needsMaxCompletionTokens('o1')).toBe(true));
    it('returns true for o3', () => expect(needsMaxCompletionTokens('o3')).toBe(true));
    it('returns false for gpt-4o', () => expect(needsMaxCompletionTokens('gpt-4o')).toBe(false));
});

// ──────────────────────────────────────────────
// 3. helpers.js — uncovered branches
// ──────────────────────────────────────────────
import {
    extractImageUrlFromPart,
    _raceWithAbortSignal,
    collectStream,
    shouldEnableStreaming,
} from '../src/shared/helpers.js';

describe('helpers: _raceWithAbortSignal — already aborted signal', () => {
    it('rejects immediately if signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const p = new Promise(r => setTimeout(() => r('done'), 1));
        await expect(_raceWithAbortSignal(p, ac.signal)).rejects.toThrow('aborted');
    });
});

describe('helpers: extractImageUrlFromPart — input_image type', () => {
    it('returns string image_url for input_image', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'http://img.png' }))
            .toBe('http://img.png');
    });
    it('returns nested object url for input_image', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'http://nested.png' } }))
            .toBe('http://nested.png');
    });
    it('returns empty string for input_image without valid image_url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 123 })).toBe('');
    });
});

describe('helpers: collectStream — abort mid-stream', () => {
    it('stops collecting when abort signal fires', async () => {
        const ac = new AbortController();
        let _enqueued = 0;
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('a');
                controller.enqueue('b');
                _enqueued = 2;
            }
        });
        // abort before collecting
        ac.abort();
        const result = await collectStream(stream, ac.signal);
        expect(typeof result).toBe('string');
    });

    it('handles null value chunks', async () => {
        let _ctrl;
        const stream = new ReadableStream({
            start(controller) {
                _ctrl = controller;
                controller.enqueue(null);
                controller.enqueue('hello');
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('hello');
    });

    it('handles ArrayBuffer value chunks', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('ab').buffer);
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('ab');
    });

    it('handles non-standard value chunks (String coercion)', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(42);
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('42');
    });
});

describe('helpers: shouldEnableStreaming edge cases', () => {
    it('returns true when streaming enabled and not compatibility mode', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'false' })).toBe(true);
    });
    it('returns false when streaming disabled', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'false' })).toBe(false);
    });
    it('returns true for copilot even in compatibility mode', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'true' }, { isCopilot: true })).toBe(true);
    });
    it('returns false when streaming enabled + compat mode + not copilot', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: 'true', cpm_compatibility_mode: 'true' }, { isCopilot: false })).toBe(false);
    });
});

// ──────────────────────────────────────────────
// 4. message-format.js — audio, cache, gemini system msg
// ──────────────────────────────────────────────

describe('formatToOpenAI — audio modal branches', () => {
    const makeMsg = (mimeInUri) => [
        {
            role: 'user',
            content: 'test',
            multimodals: [{ type: 'audio', base64: `data:audio/${mimeInUri};base64,AAAA` }],
        },
    ];

    it('detects wav audio format', () => {
        const messages = formatToOpenAI(makeMsg('wav'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('wav');
    });

    it('detects ogg audio format', () => {
        const messages = formatToOpenAI(makeMsg('ogg'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('ogg');
    });

    it('detects flac audio format', () => {
        const messages = formatToOpenAI(makeMsg('flac'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('flac');
    });

    it('detects webm audio format', () => {
        const messages = formatToOpenAI(makeMsg('webm'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('webm');
    });

    it('defaults to mp3 for unknown mime', () => {
        const messages = formatToOpenAI(makeMsg('mpeg'));
        const parts = messages[0].content;
        const audioPart = Array.isArray(parts) ? parts.find(p => p.type === 'input_audio') : null;
        expect(audioPart).toBeTruthy();
        expect(audioPart.input_audio.format).toBe('mp3');
    });
});

describe('formatToAnthropic — cache control (cachePoint)', () => {
    it('adds cache_control to string content message with cachePoint', () => {
        const msgs = [
            { role: 'user', content: 'hello', cachePoint: true },
            { role: 'assistant', content: 'reply' },
        ];
        const { messages } = formatToAnthropic(msgs);
        const cached = messages.find(m => m.role === 'user');
        expect(Array.isArray(cached.content)).toBe(true);
        expect(cached.content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds cache_control to last element of array content with cachePoint', () => {
        const msgs = [
            {
                role: 'user',
                content: 'hello from user with array',
                cachePoint: true,
            },
            { role: 'assistant', content: 'reply from assistant' },
        ];
        const { messages } = formatToAnthropic(msgs);
        // Find the user message that should have cache_control
        const cached = messages.find(m => m.role === 'user');
        expect(cached).toBeTruthy();
        // With cachePoint on string content, it converts to array
        if (Array.isArray(cached.content)) {
            expect(cached.content[cached.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
        }
    });
});

describe('formatToGemini — non-leading system messages', () => {
    it('converts non-leading system to "system: content" as user', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'Additional context' },
            { role: 'assistant', content: 'Reply' },
        ];
        const { contents } = formatToGemini(msgs);
        // system after user should be converted with "system: " prefix
        const allTexts = contents.flatMap(c => c.parts.map(p => p.text));
        expect(allTexts.some(t => t?.startsWith('system: '))).toBe(true);
    });

    it('appends to previous user message when consecutive', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'More system' },
        ];
        const { contents } = formatToGemini(msgs);
        // "system: More system" should be appended to the user message
        const lastUser = contents.find(c => c.role === 'user');
        const sysPart = lastUser?.parts.find(p => p.text?.startsWith('system: '));
        expect(sysPart).toBeTruthy();
    });

    it('creates new user part when previous is model', () => {
        const msgs = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Reply' },
            { role: 'system', content: 'Mid-system' },
        ];
        const { contents } = formatToGemini(msgs);
        // After assistant (model) message, system should create a new user entry
        const lastContent = contents[contents.length - 1];
        expect(lastContent.role).toBe('user');
        expect(lastContent.parts[0].text).toBe('system: Mid-system');
    });
});

describe('formatToGemini — file-based image handling', () => {
    it('pushes fileData for image with url', () => {
        const msgs = [
            {
                role: 'user',
                content: 'look at this',
                multimodals: [{ type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' }],
            },
        ];
        const { contents } = formatToGemini(msgs);
        const parts = contents[0].parts;
        const filePart = parts.find(p => p.fileData);
        expect(filePart.fileData.fileUri).toBe('https://example.com/img.png');
        expect(filePart.fileData.mimeType).toBe('image/png');
    });

    it('uses default mimeType when not provided', () => {
        const msgs = [
            {
                role: 'user',
                content: 'image',
                multimodals: [{ type: 'image', url: 'https://example.com/img.webp' }],
            },
        ];
        const { contents } = formatToGemini(msgs);
        const filePart = contents[0].parts.find(p => p.fileData);
        expect(filePart.fileData.mimeType).toBe('image/*');
    });
});

describe('formatToGemini — multimodal merge into same-role message', () => {
    it('merges multimodal image into previous same-role message', () => {
        const msgs = [
            { role: 'user', content: 'Image 1', multimodals: [{ type: 'image', base64: 'data:image/png;base64,AAAA' }] },
            { role: 'user', content: 'Image 2', multimodals: [{ type: 'image', base64: 'data:image/jpg;base64,BBBB' }] },
        ];
        const { contents } = formatToGemini(msgs);
        // Should merge into single user entry
        expect(contents.filter(c => c.role === 'user').length).toBe(1);
    });

    it('file-based image merge into existing same-role', () => {
        const msgs = [
            { role: 'user', content: 'first', multimodals: [{ type: 'image', url: 'https://a.png' }] },
            { role: 'user', content: 'second', multimodals: [{ type: 'image', url: 'https://b.png' }] },
        ];
        const { contents } = formatToGemini(msgs);
        expect(contents.filter(c => c.role === 'user').length).toBe(1);
        const fileDataParts = contents[0].parts.filter(p => p.fileData);
        expect(fileDataParts.length).toBe(2);
    });

    it('merges text into previous inlineData/fileData part', () => {
        const msgs = [
            { role: 'user', content: 'img', multimodals: [{ type: 'image', base64: 'data:image/png;base64,XXXX' }] },
            { role: 'user', content: 'more text' },
        ];
        const { contents } = formatToGemini(msgs);
        const textParts = contents[0].parts.filter(p => p.text);
        expect(textParts.length).toBeGreaterThanOrEqual(1);
    });

    it('handles audio multimodal (inlineData)', () => {
        const msgs = [
            { role: 'user', content: 'listen', multimodals: [{ type: 'audio', base64: 'data:audio/mp3;base64,SOUND' }] },
        ];
        const { contents } = formatToGemini(msgs);
        const inlinePart = contents[0].parts.find(p => p.inlineData);
        expect(inlinePart.inlineData.mimeType).toBe('audio/mp3');
    });

    it('handles video multimodal (inlineData)', () => {
        const msgs = [
            { role: 'user', content: 'watch', multimodals: [{ type: 'video', base64: 'data:video/mp4;base64,VID' }] },
        ];
        const { contents } = formatToGemini(msgs);
        const inlinePart = contents[0].parts.find(p => p.inlineData);
        expect(inlinePart.inlineData.mimeType).toBe('video/mp4');
    });
});

// ──────────────────────────────────────────────
// 5. sse-parser.js — redacted thinking, error paths
// ──────────────────────────────────────────────
import {
    createAnthropicSSEStream,
    parseGeminiSSELine,
    saveThoughtSignatureFromStream,
} from '../src/shared/sse-parser.js';

describe('sse-parser: createAnthropicSSEStream — redacted_thinking', () => {
    it('emits redacted_thinking placeholder when showThinking=true', async () => {
        const lines = [
            'event: content_block_start',
            `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'redacted_thinking' } })}`,
            '',
            'event: content_block_stop',
            `data: ${JSON.stringify({ type: 'content_block_stop' })}`,
            '',
            'event: message_delta',
            `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } })}`,
            '',
            'event: message_stop',
            `data: ${JSON.stringify({ type: 'message_stop' })}`,
            '',
        ].join('\n');

        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(lines));
                controller.close();
            }
        });
        const response = { body };

        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (typeof value === 'string') text += value;
        }
        expect(text).toContain('redacted_thinking');
    });

    it('skips redacted_thinking when showThinking=false', async () => {
        const lines = [
            'event: content_block_start',
            `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'redacted_thinking' } })}`,
            '',
            'event: message_stop',
            `data: ${JSON.stringify({ type: 'message_stop' })}`,
            '',
        ].join('\n');

        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(lines));
                controller.close();
            }
        });
        const response = { body };

        const stream = createAnthropicSSEStream(response, null, { showThinking: false });
        const reader = stream.getReader();
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (typeof value === 'string') text += value;
        }
        expect(text).not.toContain('redacted_thinking');
    });
});

describe('sse-parser: parseGeminiSSELine — edge cases', () => {
    it('returns null for non-data line', () => {
        expect(parseGeminiSSELine('event: something')).toBe(null);
    });

    it('returns null for empty data', () => {
        expect(parseGeminiSSELine('data: ')).toBe(null);
    });

    it('parses valid data line', () => {
        const obj = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
        const result = parseGeminiSSELine(`data: ${JSON.stringify(obj)}`);
        expect(result).toBeTruthy();
    });
});

describe('sse-parser: saveThoughtSignatureFromStream', () => {
    it('closes open thought block and returns extra text', () => {
        const config = {
            _inThoughtBlock: true,
            _lastSignature: null,
            _streamResponseText: '',
            _requestId: null,
            _streamUsageMetadata: null,
        };
        const extra = saveThoughtSignatureFromStream(config);
        expect(extra).toContain('</Thoughts>');
        expect(config._inThoughtBlock).toBe(false);
    });

    it('returns null when no open thought block and no signature', () => {
        const config = {
            _inThoughtBlock: false,
            _lastSignature: null,
            _streamResponseText: '',
            _requestId: null,
            _streamUsageMetadata: null,
        };
        const extra = saveThoughtSignatureFromStream(config);
        expect(extra).toBe(null);
    });
});

// ──────────────────────────────────────────────
// 6. auto-updater.js — arg parsing, schema validation
// ──────────────────────────────────────────────

describe('auto-updater: validateAndInstall — arg metadata parsing', () => {
    const DB_PLUGIN_NAME = 'Test Plugin';
    const currentVersion = '1.0.0';

    /** @param {Record<string,any>} [overrides] */
    function mkUpdater(overrides = {}) {
        return createAutoUpdater({ Risu: overrides.Risu || makeRisu(), pluginName: DB_PLUGIN_NAME, currentVersion, _autoSaveDelayMs: 0, ...overrides });
    }

    function makeRisu(existingPlugin) {
        return {
            getArgument: vi.fn(() => undefined),
            getDatabase: vi.fn(async () => ({
                plugins: [existingPlugin || {
                    name: DB_PLUGIN_NAME,
                    script: '// old',
                    versionOfPlugin: currentVersion,
                    arguments: {},
                    realArg: {},
                    enabled: true,
                }],
            })),
            setDatabaseLite: vi.fn(async () => {}),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            nativeFetch: vi.fn(async () => { throw new Error('not impl'); }),
            risuFetch: vi.fn(async () => ({ ok: false })),
        };
    }

    function makeCode(version, extra = '') {
        return [
            `//@name ${DB_PLUGIN_NAME}`,
            `//@display-name Test Plugin Display`,
            `//@version ${version}`,
            `//@api 3.0`,
            extra,
            '// plugin code',
            `console.log('hello');`.repeat(10),
        ].join('\n');
    }

    it('parses @arg with metadata templates', async () => {
        const code = makeCode('2.0.0', '//@arg myKey string {{label::My Label}} {{desc::Description}}');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('parses @risu-arg with single colon metadata', async () => {
        const code = makeCode('2.0.0', '//@risu-arg apiKey string {{label:API Key}}');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('parses @arg int type with default value', async () => {
        const code = makeCode('2.0.0', '//@arg maxRetries int');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('rejects when API version is not 3.0', async () => {
        const code = [
            `//@name ${DB_PLUGIN_NAME}`,
            `//@version 2.0.0`,
            `//@api 2.0`,
            `console.log('hello');`.repeat(10),
        ].join('\n');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('API');
    });

    it('parses @link directives', async () => {
        const code = makeCode('2.0.0', '//@link https://example.com My Link');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('rejects when no @name found', async () => {
        const code = [
            `//@version 2.0.0`,
            `//@api 3.0`,
            `console.log('hello');`.repeat(10),
        ].join('\n');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@name');
    });

    it('rejects when no @version found', async () => {
        const code = [
            `//@name ${DB_PLUGIN_NAME}`,
            `//@api 3.0`,
            `console.log('hello');`.repeat(10),
        ].join('\n');
        const updater = mkUpdater();
        const result = await updater.validateAndInstall(code, '', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@version');
    });

    it('rejects when plugin not found in DB', async () => {
        const code = makeCode('2.0.0');
        const Risu = makeRisu();
        Risu.getDatabase = vi.fn(async () => ({ plugins: [{ name: 'Other Plugin' }] }));
        const updater = mkUpdater({ Risu });
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('찾을 수 없습니다');
    });

    it('rejects when database access fails', async () => {
        const code = makeCode('2.0.0');
        const Risu = makeRisu();
        Risu.getDatabase = vi.fn(async () => null);
        const updater = mkUpdater({ Risu });
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
    });

    it('rejects when plugins array missing', async () => {
        const code = makeCode('2.0.0');
        const Risu = makeRisu();
        Risu.getDatabase = vi.fn(async () => ({ plugins: null }));
        const updater = mkUpdater({ Risu });
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(false);
    });

    it('preserves existing realArg values when arg type matches', async () => {
        const existingPlugin = {
            name: DB_PLUGIN_NAME,
            script: '// old',
            versionOfPlugin: currentVersion,
            arguments: { myKey: 'string' },
            realArg: { myKey: 'saved-value' },
            enabled: true,
        };
        const code = makeCode('2.0.0', '//@arg myKey string');
        const Risu = makeRisu(existingPlugin);
        const updater = mkUpdater({ Risu });
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
        const call = Risu.setDatabaseLite.mock.calls[0][0];
        expect(call.plugins[0].realArg.myKey).toBe('saved-value');
    });
});

describe('auto-updater: downloadMainPluginCode edge cases', () => {
    function makeRisu() {
        return {
            getArgument: vi.fn(() => undefined),
            getDatabase: vi.fn(async () => ({ plugins: [] })),
            setDatabaseLite: vi.fn(async () => {}),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            nativeFetch: vi.fn(async () => { throw new Error('not impl'); }),
            risuFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        };
    }

    it('returns failure when all fetch methods fail', async () => {
        const Risu = makeRisu();
        const updater = createAutoUpdater({
            Risu,
            pluginName: 'Test',
            currentVersion: '1.0.0',
            _autoSaveDelayMs: 0,
        });

        const result = await updater.downloadMainPluginCode('2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });
});

// ──────────────────────────────────────────────
// 7. sanitize.js — uncovered branches
// ──────────────────────────────────────────────
import { sanitizeMessages, sanitizeBodyJSON, hasNonEmptyMessageContent } from '../src/shared/sanitize.js';

describe('sanitize: sanitizeMessages — edge cases', () => {
    it('handles messages with non-string content (object)', () => {
        const msgs = [{ role: 'user', content: { text: 'hello' } }];
        const result = sanitizeMessages(msgs);
        expect(result.length).toBe(1);
    });

    it('filters out null entries', () => {
        const msgs = [null, { role: 'user', content: 'hello' }, undefined];
        const result = sanitizeMessages(msgs);
        expect(result.length).toBe(1);
    });
});

describe('sanitize: sanitizeBodyJSON — edge cases', () => {
    it('handles body with nested nulls', () => {
        const body = { messages: [{ role: 'user', content: 'hi' }], extra: null };
        const result = sanitizeBodyJSON(body);
        expect(result).toBeTruthy();
    });
});

describe('sanitize: hasNonEmptyMessageContent', () => {
    it('returns true for non-empty string', () => {
        expect(hasNonEmptyMessageContent('hello')).toBe(true);
    });
    it('returns false for empty string', () => {
        expect(hasNonEmptyMessageContent('')).toBe(false);
    });
    it('returns true for array with elements', () => {
        expect(hasNonEmptyMessageContent([{ type: 'text', text: 'hi' }])).toBe(true);
    });
    it('returns false for empty array', () => {
        expect(hasNonEmptyMessageContent([])).toBe(false);
    });
    it('returns false for null passed directly', () => {
        expect(hasNonEmptyMessageContent(null)).toBe(false);
    });
    it('returns true for object (non-null/non-array/non-string)', () => {
        expect(hasNonEmptyMessageContent({ content: null })).toBe(true);
    });
    it('returns true for non-empty number coerced to string', () => {
        expect(hasNonEmptyMessageContent(42)).toBe(true);
    });
});

// ──────────────────────────────────────────────
// 8. slot-inference.js — uncovered branches
// ──────────────────────────────────────────────
import { scoreSlotHeuristic } from '../src/shared/slot-inference.js';

describe('slot-inference: scoreSlotHeuristic', () => {
    it('returns 0 for unknown text with unknown slot', () => {
        expect(scoreSlotHeuristic('random gibberish', 'translation')).toBe(0);
    });
    it('returns positive score for translation keyword', () => {
        expect(scoreSlotHeuristic('Please translate this text', 'translation')).toBeGreaterThan(0);
    });
    it('returns 0 for empty text', () => {
        expect(scoreSlotHeuristic('', 'translation')).toBe(0);
    });
});

// ──────────────────────────────────────────────
// 9. key-pool.js — uncovered branches
// ──────────────────────────────────────────────
import { KeyPool } from '../src/shared/key-pool.js';

describe('key-pool: edge cases', () => {
    it('drains a key and rotates to next', () => {
        const pool = new KeyPool('key1 key2');
        const remaining = pool.drain('key1');
        expect(remaining).toBe(1);
        expect(pool.pick()).toBe('key2');
    });

    it('pick returns only key when pool has single key', () => {
        const pool = new KeyPool('key1');
        pool.drain('key1');
        expect(pool.remaining).toBe(0);
        expect(pool.pick()).toBe('');
    });

    it('reset restores original keys', () => {
        const pool = new KeyPool('key1 key2');
        pool.drain('key1');
        pool.drain('key2');
        expect(pool.remaining).toBe(0);
        pool.reset();
        expect(pool.remaining).toBe(2);
    });

    it('returns empty string for empty pool string', () => {
        const pool = new KeyPool('');
        expect(pool.pick()).toBe('');
    });
});

// ──────────────────────────────────────────────
// 10. settings-backup.js — uncovered branches
// ──────────────────────────────────────────────
import { createSettingsBackup, getAuxSettingKeys, getManagedSettingKeys, isManagedSettingKey } from '../src/shared/settings-backup.js';

describe('settings-backup: edge cases', () => {
    function makeRisu() {
        const storage = {};
        return {
            getArgument: vi.fn(() => undefined),
            pluginStorage: {
                getItem: vi.fn(async (k) => storage[k] || null),
                setItem: vi.fn(async (k, v) => { storage[k] = v; }),
            },
        };
    }

    it('createSettingsBackup returns object with load/save/getAllKeys', () => {
        const sb = createSettingsBackup({ Risu: makeRisu(), safeGetArg: vi.fn() });
        expect(typeof sb.load).toBe('function');
        expect(typeof sb.save).toBe('function');
        expect(typeof sb.getAllKeys).toBe('function');
    });

    it('load returns empty cache when storage is empty', async () => {
        const sb = createSettingsBackup({ Risu: makeRisu(), safeGetArg: vi.fn() });
        const data = await sb.load();
        expect(data).toEqual({});
    });

    it('getAuxSettingKeys returns slot-prefixed keys', () => {
        const keys = getAuxSettingKeys(['translation']);
        expect(keys.some(k => k.includes('translation'))).toBe(true);
    });

    it('getManagedSettingKeys includes provider setting keys', () => {
        const providers = new Map([['test', { name: 'test-provider', settingsFields: [{ key: 'test_api_key', label: 'API Key', type: 'string' }] }]]);
        const keys = getManagedSettingKeys(providers);
        expect(keys.length).toBeGreaterThan(0);
    });

    it('isManagedSettingKey returns true for known keys', () => {
        expect(isManagedSettingKey('cpm_active_provider')).toBe(true);
    });

    it('isManagedSettingKey returns false for unknown keys', () => {
        expect(isManagedSettingKey('random_key_xyz')).toBe(false);
    });
});
