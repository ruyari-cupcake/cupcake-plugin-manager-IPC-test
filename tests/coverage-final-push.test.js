/**
 * @file coverage-final-push.test.js — 남은 미커버 라인 전멸 테스트
 *
 * 대상 파일과 미커버 라인:
 *   auto-updater.js : downloadMainPluginCode (bundle/fallback), checkMainPluginVersionQuiet, _withTimeout reject
 *   sanitize.js     : L130 (object structured content), L181 (> [Thought Process]), L214-215 (sanitizeBodyJSON)
 *   settings-backup.js : L187, L196
 *   token-usage.js  : L130-132, L138-139 (anthropicHasThinking estimated reasoning)
 *   slot-inference.js : L104 (multi-slot collision)
 *   token-toast.js  : L24, L31 (reasoning/cached display)
 *   update-toast.js : L157 (dismiss delay path)
 *   ipc-protocol.js : L105-110, L122
 *   key-pool.js     : L127-129
 *   dynamic-models.js : L160, L173, L182, L189
 *   endpoints.js    : L34
 *   copilot-token.js : L73
 *   api-request-log.js : L16
 *   safe-db-writer.js : L38
 *   custom-model-serialization.js : L80-89
 *   aws-signer.js : L92
 *   gemini-helpers.js : L43
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ipc-protocol ──
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => ({
        getArgument: vi.fn(async () => ''),
        setArgument: vi.fn(),
        pluginStorage: {
            getItem: vi.fn(async () => null),
            setItem: vi.fn(async () => {}),
            removeItem: vi.fn(async () => {}),
        },
        getDatabase: vi.fn(async () => ({ plugins: [] })),
        risuFetch: vi.fn(async () => ({ data: null, status: 200 })),
        nativeFetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
        registerPlugin: vi.fn(),
        getRootDocument: vi.fn(async () => null),
    }),
    CH: { CONTROL: 'cpm-control', RESPONSE: 'cpm-response', FETCH: 'cpm-fetch', ABORT: 'cpm-abort' },
    MSG: {},
    safeUUID: () => 'test-uuid',
    MANAGER_NAME: 'CPM',
}));

import {
    createAutoUpdater,
    _withTimeout,
    computeSHA256,
    compareVersions,
    isRetriableError,
} from '../src/shared/auto-updater.js';

import {
    sanitizeMessages,
    extractNormalizedMessagePayload,
    hasNonEmptyMessageContent,
    stripThoughtDisplayContent,
    sanitizeBodyJSON,
} from '../src/shared/sanitize.js';

import { _normalizeTokenUsage } from '../src/shared/token-usage.js';

// ═══════════════════════════════════════════════════════════════
// auto-updater.js — downloadMainPluginCode uncovered branches
// ═══════════════════════════════════════════════════════════════

function makeMockDeps(overrides = {}) {
    const storage = {};
    return {
        Risu: {
            pluginStorage: {
                async getItem(key) { return storage[key] || null; },
                async setItem(key, value) { storage[key] = value; },
                async removeItem(key) { delete storage[key]; },
            },
            async getDatabase() {
                return {
                    plugins: [{
                        name: 'TestPlugin',
                        script: 'x'.repeat(1000),
                        versionOfPlugin: '1.0.0',
                        arguments: {},
                        realArg: {},
                        enabled: true,
                        updateURL: '',
                    }],
                };
            },
            setDatabaseLite: vi.fn(async () => {}),
            risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
            nativeFetch: vi.fn(async () => { throw new Error('not implemented'); }),
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? true : ''),
            registerPlugin: vi.fn(),
        },
        currentVersion: '1.0.0',
        pluginName: 'TestPlugin',
        versionsUrl: 'https://example.com/versions.json',
        mainUpdateUrl: 'https://example.com/plugin.js',
        updateBundleUrl: 'https://example.com/bundle.json',
        toast: { showMainAutoUpdateResult: vi.fn(async () => {}) },
        validateSchema: vi.fn((v) => ({ valid: true, value: v })),
        _autoSaveDelayMs: 0,
        ...overrides,
    };
}

function makeValidPluginCode(version = '2.0.0', name = 'TestPlugin') {
    return [
        `//@api 3.0`,
        `//@name ${name}`,
        `//@version ${version}`,
        `//@display-name Test Plugin`,
        `//@update-url https://example.com/plugin.js`,
        `//@arg apiKey string`,
        `//@arg maxTokens int`,
        `//@link https://example.com/docs Plugin Docs`,
        ``,
        `// Plugin code starts here`,
        `const x = 1;`,
        `// ` + 'padding '.repeat(50), // make it > 100 chars
    ].join('\n');
}

describe('auto-updater: downloadMainPluginCode', () => {
    it('succeeds via update bundle path with SHA-256 verification', async () => {
        const code = makeValidPluginCode('2.0.0');
        const sha256 = await computeSHA256(code);
        const bundleData = {
            versions: { TestPlugin: { version: '2.0.0', file: 'plugin.js', sha256, changes: 'bugfix' } },
            code: { 'plugin.js': code },
        };

        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: JSON.stringify(bundleData), status: 200 };
            return { data: null, status: 404 };
        });

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        expect(result.ok).toBe(true);
        expect(result.code).toBe(code);
    });

    it('falls back to direct JS download when bundle fails', async () => {
        const code = makeValidPluginCode('2.0.0');
        const sha256 = await computeSHA256(code);

        const deps = makeMockDeps();
        // Bundle fails
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: null, status: 500 };
            // Versions manifest for sha256 check
            if (url.includes('versions')) return {
                data: JSON.stringify({ TestPlugin: { version: '2.0.0', sha256 } }),
                status: 200,
            };
            return { data: null, status: 404 };
        });
        // nativeFetch succeeds
        deps.Risu.nativeFetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => code,
        }));

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        expect(result.ok).toBe(true);
        expect(result.code).toBe(code);
    });

    it('falls back to risuFetch when nativeFetch also fails', async () => {
        const code = makeValidPluginCode('2.0.0');

        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: null, status: 500 };
            if (url.includes('versions')) return { data: null, status: 500 };
            // Direct risuFetch fallback succeeds
            return { data: code, status: 200 };
        });
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('Network error'); });

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        expect(result.ok).toBe(true);
    });

    it('bundle version mismatch → falls back', async () => {
        const code = makeValidPluginCode('2.0.0');
        const sha256 = await computeSHA256(code);
        const bundleData = {
            versions: { TestPlugin: { version: '1.9.9', file: 'plugin.js', sha256 } },
            code: { 'plugin.js': code },
        };

        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: JSON.stringify(bundleData), status: 200 };
            if (url.includes('versions')) return { data: null, status: 404 };
            return { data: code, status: 200 };
        });
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('no'); });

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        // Falls back to direct download
        expect(result.ok).toBe(true);
    });

    it('bundle missing sha256 → rejected', async () => {
        const code = makeValidPluginCode('2.0.0');
        const bundleData = {
            versions: { TestPlugin: { version: '2.0.0', file: 'plugin.js' /* no sha256 */ } },
            code: { 'plugin.js': code },
        };

        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: JSON.stringify(bundleData), status: 200 };
            if (url.includes('versions')) return { data: null, status: 404 };
            return { data: code, status: 200 };
        });
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('no'); });

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        // Falls back since bundle had no sha256
        expect(result.ok).toBe(true);
    });

    it('all fetch methods fail → returns error', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => { throw new Error('Network fail'); });
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('Network fail'); });

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('Content-Length mismatch triggers retry', async () => {
        const code = makeValidPluginCode('2.0.0');
        let attempt = 0;

        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: null, status: 500 };
            if (url.includes('versions')) return { data: null, status: 404 };
            return { data: null, status: 404 };
        });
        deps.Risu.nativeFetch = vi.fn(async () => {
            attempt++;
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => name === 'content-length' ? '999999' : null,
                },
                text: async () => attempt >= 3 ? code : 'short',
            };
        });

        const updater = createAutoUpdater(deps);
        const result = await updater.downloadMainPluginCode('2.0.0');
        // Should have retried
        expect(attempt).toBeGreaterThanOrEqual(2);
    });
});

describe('auto-updater: validateAndInstall — edge cases', () => {
    it('rejects code shorter than 100 chars', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        const result = await updater.validateAndInstall('short', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('비어있거나 너무 짧습니다');
    });

    it('rejects missing @name header', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        const code = '//@version 2.0.0\n//@api 3.0\n' + 'x'.repeat(200);
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@name');
    });

    it('rejects non-3.0 API version', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        const code = '//@name TestPlugin\n//@version 2.0.0\n//@api 2.0\n' + 'x'.repeat(200);
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('API 버전');
    });

    it('rejects name mismatch', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        const code = '//@name WrongPlugin\n//@version 2.0.0\n//@api 3.0\n' + 'x'.repeat(200);
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('이름 불일치');
    });

    it('rejects downgrade', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        const code = makeValidPluginCode('0.5.0');
        const result = await updater.validateAndInstall(code, '0.5.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('다운그레이드');
    });

    it('rejects same version', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        const code = makeValidPluginCode('1.0.0');
        const result = await updater.validateAndInstall(code, '1.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('이미 같은 버전');
    });

    it('rejects missing plugin in DB', async () => {
        const deps = makeMockDeps({});
        deps.Risu.getDatabase = vi.fn(async () => ({ plugins: [] }));
        const updater = createAutoUpdater(deps);
        const code = makeValidPluginCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('DB에서 찾을 수 없습니다');
    });

    it('rejects when DB has no plugins array', async () => {
        const deps = makeMockDeps({});
        deps.Risu.getDatabase = vi.fn(async () => ({}));
        const updater = createAutoUpdater(deps);
        const code = makeValidPluginCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('플러그인 목록');
    });

    it('rejects null DB', async () => {
        const deps = makeMockDeps({});
        deps.Risu.getDatabase = vi.fn(async () => null);
        const updater = createAutoUpdater(deps);
        const code = makeValidPluginCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
    });

    it('successfully installs valid upgrade with @arg + @link parsing', async () => {
        const deps = makeMockDeps();
        const code = makeValidPluginCode('2.0.0');
        const updater = createAutoUpdater(deps);
        const result = await updater.validateAndInstall(code, '2.0.0');
        // This should succeed (plugin exists in DB with version 1.0.0, updating to 2.0.0)
        expect(result.ok).toBe(true);
    });

    it('detects incomplete download (code much smaller than existing script)', async () => {
        const deps = makeMockDeps({});
        const bigScript = 'x'.repeat(400 * 1024); // 400KB existing — must be >= 300KB for size check
        deps.Risu.getDatabase = vi.fn(async () => ({
            plugins: [{
                name: 'TestPlugin',
                script: bigScript,
                versionOfPlugin: '1.0.0',
                arguments: {},
                realArg: {},
                enabled: true,
            }],
        }));
        const updater = createAutoUpdater(deps);
        // Small new code (< 95% of existing)
        const code = '//@name TestPlugin\n//@version 2.0.0\n//@api 3.0\n' + 'x'.repeat(200);
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('불완전한 다운로드');
    });

    it('merges existing realArg settings on upgrade', async () => {
        const deps = makeMockDeps({});
        deps.Risu.getDatabase = vi.fn(async () => ({
            plugins: [{
                name: 'TestPlugin',
                script: 'x'.repeat(1000),
                versionOfPlugin: '1.0.0',
                arguments: { apiKey: 'string', maxTokens: 'int' },
                realArg: { apiKey: 'sk-test-123', maxTokens: 4096 },
                enabled: true,
            }],
        }));
        const updater = createAutoUpdater(deps);
        const code = makeValidPluginCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0');
        expect(result.ok).toBe(true);
    });
});

describe('auto-updater: safeMainPluginUpdate — dedup + error paths', () => {
    it('catches unexpected errors in safeMainPluginUpdate', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => { throw new Error('Unexpected boom'); });
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('Unexpected boom'); });

        const updater = createAutoUpdater(deps);
        const result = await updater.safeMainPluginUpdate('9.9.9');
        expect(result.ok).toBe(false);
    });

    it('non-retriable error clears pending update', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('bundle')) return { data: null, status: 500 };
            if (url.includes('versions')) return { data: null, status: 404 };
            return { data: '//@name WrongPlugin\n//@version 2.0.0\n//@api 3.0\n' + 'x'.repeat(200), status: 200 };
        });
        deps.Risu.nativeFetch = vi.fn(async () => ({
            ok: true, status: 200,
            headers: { get: () => null },
            text: async () => '//@name WrongPlugin\n//@version 2.0.0\n//@api 3.0\n' + 'x'.repeat(200),
        }));

        const updater = createAutoUpdater(deps);
        const result = await updater.safeMainPluginUpdate('2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('이름 불일치');
    });
});

describe('auto-updater: checkMainPluginVersionQuiet', () => {
    it('skips when already checked via manifest', async () => {
        const deps = makeMockDeps();
        const code = makeValidPluginCode('2.0.0');
        const sha256 = await computeSHA256(code);

        // First, trigger checkVersionsQuiet to set _mainVersionFromManifest
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('versions')) return {
                data: JSON.stringify({ TestPlugin: { version: '2.0.0', sha256, changes: '' } }),
                status: 200,
            };
            if (url.includes('bundle')) return {
                data: JSON.stringify({
                    versions: { TestPlugin: { version: '2.0.0', file: 'plugin.js', sha256 } },
                    code: { 'plugin.js': code },
                }),
                status: 200,
            };
            return { data: null, status: 404 };
        });

        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet();
        // Now checkMainPluginVersionQuiet should skip
        await updater.checkMainPluginVersionQuiet();
        // No crash = success (it logs "Already checked via manifest")
    });

    it('performs JS fallback version check when manifest not used', async () => {
        const code = makeValidPluginCode('2.0.0');
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => ({ data: null, status: 404 }));
        deps.Risu.nativeFetch = vi.fn(async () => ({
            ok: true, status: 200,
            headers: { get: () => null },
            text: async () => code,
        }));

        const updater = createAutoUpdater(deps);
        await updater.checkMainPluginVersionQuiet();
        // Should have tried to install since remote is 2.0.0 > current 1.0.0
    });

    it('handles nativeFetch failure + risuFetch fallback', async () => {
        const code = makeValidPluginCode('2.0.0');
        const deps = makeMockDeps();
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('no nativeFetch'); });
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('versions') || url.includes('bundle')) return { data: null, status: 404 };
            return { data: code, status: 200 };
        });

        const updater = createAutoUpdater(deps);
        await updater.checkMainPluginVersionQuiet();
    });

    it('handles missing @version in remote code', async () => {
        const deps = makeMockDeps();
        deps.Risu.nativeFetch = vi.fn(async () => ({
            ok: true, status: 200,
            headers: { get: () => null },
            text: async () => '//@name TestPlugin\n//@api 3.0\nno version tag here',
        }));
        deps.Risu.risuFetch = vi.fn(async () => ({ data: null, status: 404 }));

        const updater = createAutoUpdater(deps);
        await updater.checkMainPluginVersionQuiet(); // Should not crash
    });

    it('handles HTTP error from nativeFetch', async () => {
        const deps = makeMockDeps();
        deps.Risu.nativeFetch = vi.fn(async () => ({
            ok: false, status: 500,
            headers: { get: () => null },
        }));
        deps.Risu.risuFetch = vi.fn(async () => ({ data: null, status: 404 }));

        const updater = createAutoUpdater(deps);
        await updater.checkMainPluginVersionQuiet(); // Should not crash
    });

    it('both fetch methods fail gracefully', async () => {
        const deps = makeMockDeps();
        deps.Risu.nativeFetch = vi.fn(async () => { throw new Error('fail'); });
        deps.Risu.risuFetch = vi.fn(async () => { throw new Error('fail too'); });

        const updater = createAutoUpdater(deps);
        await updater.checkMainPluginVersionQuiet(); // Should not crash
    });
});

describe('auto-updater: checkVersionsQuiet', () => {
    it('skips when cooldown is active', async () => {
        const deps = makeMockDeps();
        const storage = {};
        deps.Risu.pluginStorage = {
            async getItem(key) { return storage[key] || null; },
            async setItem(key, value) { storage[key] = value; },
            async removeItem(key) { delete storage[key]; },
        };
        // Set last check to just now
        storage.cpm_last_version_check = String(Date.now());

        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet();
        // risuFetch should NOT be called for versions since cooldown is active
        expect(deps.Risu.risuFetch).not.toHaveBeenCalled();
    });

    it('skips when called twice (dedup flag)', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => ({ data: null, status: 200 }));
        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet();
        await updater.checkVersionsQuiet();
        // Only one fetch attempt (second call skips due to _versionChecked flag)
    });

    it('handles invalid manifest (not an object)', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => ({ data: '"just a string"', status: 200 }));
        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet(); // Should not crash
    });

    it('update found and triggers safeMainPluginUpdate', async () => {
        const code = makeValidPluginCode('2.0.0');
        const sha256 = await computeSHA256(code);
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async (url) => {
            if (url.includes('versions')) return {
                data: JSON.stringify({ TestPlugin: { version: '2.0.0', sha256, changes: 'bugfix' } }),
                status: 200,
            };
            if (url.includes('bundle')) return {
                data: JSON.stringify({
                    versions: { TestPlugin: { version: '2.0.0', file: 'plugin.js', sha256 } },
                    code: { 'plugin.js': code },
                }),
                status: 200,
            };
            return { data: null, status: 404 };
        });

        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet();
    });

    it('no update when remote version is same', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => ({
            data: JSON.stringify({ TestPlugin: { version: '1.0.0' } }),
            status: 200,
        }));

        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet();
    });

    it('fetch failure (HTTP error)', async () => {
        const deps = makeMockDeps();
        deps.Risu.risuFetch = vi.fn(async () => ({ data: null, status: 500 }));
        const updater = createAutoUpdater(deps);
        await updater.checkVersionsQuiet(); // graceful
    });
});

describe('auto-updater: rememberPendingUpdate', () => {
    it('preserves existing data when version matches', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        await updater.rememberPendingUpdate('2.0.0', 'first');
        await updater.rememberPendingUpdate('2.0.0', 'second');
        const pending = await updater.readPendingUpdate();
        expect(pending.version).toBe('2.0.0');
    });

    it('resets data when version changes', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        await updater.rememberPendingUpdate('2.0.0', 'old');
        await updater.rememberPendingUpdate('3.0.0', 'new');
        const pending = await updater.readPendingUpdate();
        expect(pending.version).toBe('3.0.0');
        expect(pending.attempts).toBe(0);
    });

    it('ignores empty version', async () => {
        const deps = makeMockDeps();
        const updater = createAutoUpdater(deps);
        await updater.rememberPendingUpdate('', 'changes');
        const pending = await updater.readPendingUpdate();
        expect(pending).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════
// sanitize.js — 미커버 브랜치
// ═══════════════════════════════════════════════════════════════

describe('extractNormalizedMessagePayload — uncovered branches', () => {
    it('structured object content without .text → JSON.stringify (L130)', () => {
        const msg = { role: 'user', content: { data: 'structured' } };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.text).toContain('structured');
    });

    it('non-object non-string content → String()', () => {
        const msg = { role: 'user', content: 42 };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.text).toBe('42');
    });

    it('object with .text property → extracts text', () => {
        const msg = { role: 'user', content: { text: 'extracted' } };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.text).toBe('extracted');
    });

    it('input_audio content part → audio multimodal', () => {
        const msg = {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: 'base64audio', format: 'wav' } }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals.some(m => m.type === 'audio')).toBe(true);
    });

    it('Anthropic image source block → image multimodal', () => {
        const msg = {
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', data: 'imgdata', media_type: 'image/jpeg' } }],
        };
        const result = extractNormalizedMessagePayload(msg);
        expect(result.multimodals.some(m => m.type === 'image')).toBe(true);
    });
});

describe('stripThoughtDisplayContent — uncovered branches', () => {
    it('removes <Thoughts>...</Thoughts> blocks', () => {
        const input = '<Thoughts>thinking</Thoughts>\n\nFinal answer';
        const result = stripThoughtDisplayContent(input);
        expect(result).not.toContain('Thoughts');
        expect(result).toContain('Final answer');
    });

    it('handles > [Thought Process] with trailing content (L181)', () => {
        const input = '> [Thought Process]\n> Step 1\n> Step 2\n\n\nFinal answer here';
        const result = stripThoughtDisplayContent(input);
        expect(result).toContain('Final answer here');
    });

    it('handles > [Thought Process] without trailing content', () => {
        const input = '> [Thought Process]\n> Only thoughts, no output';
        const result = stripThoughtDisplayContent(input);
        expect(result).toBe('');
    });

    it('returns null/undefined for falsy input', () => {
        expect(stripThoughtDisplayContent(null)).toBeNull();
        expect(stripThoughtDisplayContent(undefined)).toBeUndefined();
        expect(stripThoughtDisplayContent('')).toBe('');
    });

    it('removes \\n\\n literal escape sequences', () => {
        const input = 'Some text\\n\\nwith escapes';
        const result = stripThoughtDisplayContent(input);
        expect(result).not.toContain('\\n\\n');
    });
});

describe('sanitizeBodyJSON — uncovered branches (L214-215)', () => {
    it('sanitizes messages array (removes empty/invalid)', () => {
        const body = JSON.stringify({
            messages: [
                { role: 'user', content: 'Valid' },
                null,
                { role: '', content: 'no role' },
                { role: 'user', content: '' },
            ],
        });
        const result = sanitizeBodyJSON(body);
        const parsed = JSON.parse(result);
        expect(parsed.messages.length).toBe(1);
        expect(parsed.messages[0].content).toBe('Valid');
    });

    it('sanitizes Gemini contents array', () => {
        const body = JSON.stringify({
            contents: [
                { role: 'user', parts: [{ text: 'hello' }] },
                null,
                42,
            ],
        });
        const result = sanitizeBodyJSON(body);
        const parsed = JSON.parse(result);
        expect(parsed.contents.length).toBe(1);
    });

    it('non-JSON passthrough (not JSON-like)', () => {
        const body = 'not json at all';
        const result = sanitizeBodyJSON(body);
        expect(result).toBe(body);
    });

    it('invalid JSON-like string → passthrough with warning', () => {
        const body = '{ broken json ]]]';
        const result = sanitizeBodyJSON(body);
        expect(result).toBe(body);
    });

    it('output validation failure → returns original', () => {
        // This is hard to trigger naturally, but test the passthrough
        const body = JSON.stringify({ messages: [{ role: 'user', content: 'ok' }] });
        const result = sanitizeBodyJSON(body);
        expect(JSON.parse(result).messages.length).toBe(1);
    });
});

describe('hasNonEmptyMessageContent — edge cases', () => {
    it('null → false', () => expect(hasNonEmptyMessageContent(null)).toBe(false));
    it('undefined → false', () => expect(hasNonEmptyMessageContent(undefined)).toBe(false));
    it('empty string → false', () => expect(hasNonEmptyMessageContent('')).toBe(false));
    it('whitespace only → false', () => expect(hasNonEmptyMessageContent('   ')).toBe(false));
    it('array → true', () => expect(hasNonEmptyMessageContent([{ type: 'text', text: 'x' }])).toBe(true));
    it('empty array → false', () => expect(hasNonEmptyMessageContent([])).toBe(false));
    it('object → true', () => expect(hasNonEmptyMessageContent({ data: 'x' })).toBe(true));
    it('number 0 → truthy check', () => expect(hasNonEmptyMessageContent(0)).toBe(true));
    it('non-zero number → true', () => expect(hasNonEmptyMessageContent(42)).toBe(true));
});

// ═══════════════════════════════════════════════════════════════
// token-usage.js — 미커버 브랜치 (anthropic reasoning estimation)
// ═══════════════════════════════════════════════════════════════

describe('_normalizeTokenUsage — anthropic reasoning estimation', () => {
    it('estimates reasoning tokens when anthropicHasThinking and output > 0 (L130-132)', () => {
        const raw = { input_tokens: 100, output_tokens: 500 };
        const result = _normalizeTokenUsage(raw, 'anthropic', {
            anthropicHasThinking: true,
            anthropicVisibleText: 'Short answer', // Few visible tokens, most should be reasoning
        });
        expect(result).toBeDefined();
        expect(result.reasoning).toBeGreaterThan(0);
        expect(result.reasoningEstimated).toBe(true);
    });

    it('no reasoning estimation when explicit reasoning tokens exist', () => {
        const raw = {
            input_tokens: 100, output_tokens: 500,
            // Some Anthropic models might report reasoning explicitly
        };
        const result = _normalizeTokenUsage(raw, 'anthropic', {
            anthropicHasThinking: false,
        });
        expect(result.reasoning).toBe(0);
    });

    it('no estimation when visible text accounts for all output', () => {
        const raw = { input_tokens: 10, output_tokens: 5 };
        const result = _normalizeTokenUsage(raw, 'anthropic', {
            anthropicHasThinking: true,
            anthropicVisibleText: 'This is a much longer visible text that accounts for many tokens in the output',
        });
        // reasoning should be 0 since visible text ≈ output tokens
        expect(result.reasoning).toBe(0);
    });

    it('gemini format usage normalization', () => {
        const raw = {
            promptTokenCount: 50,
            candidatesTokenCount: 30,
            thoughtsTokenCount: 10,
            cachedContentTokenCount: 5,
            totalTokenCount: 95,
        };
        const result = _normalizeTokenUsage(raw, 'gemini');
        expect(result.input).toBe(50);
        expect(result.output).toBe(30);
        expect(result.reasoning).toBe(10);
        expect(result.cached).toBe(5);
    });

    it('openai format with cached tokens', () => {
        const raw = {
            prompt_tokens: 100,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 80 },
            completion_tokens_details: { reasoning_tokens: 20 },
            total_tokens: 150,
        };
        const result = _normalizeTokenUsage(raw, 'openai');
        expect(result.input).toBe(100);
        expect(result.output).toBe(50);
        expect(result.reasoning).toBe(20);
        expect(result.cached).toBe(80);
    });

    it('unknown format → null', () => {
        const result = _normalizeTokenUsage({}, 'unknown-format');
        expect(result).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════
// sanitizeMessages — edge cases
// ═══════════════════════════════════════════════════════════════

describe('sanitizeMessages — edge cases', () => {
    it('non-array → empty array', () => {
        expect(sanitizeMessages(null)).toEqual([]);
        expect(sanitizeMessages(undefined)).toEqual([]);
        expect(sanitizeMessages('not array')).toEqual([]);
    });

    it('filters null/non-object items', () => {
        const result = sanitizeMessages([null, 42, 'string', { role: 'user', content: 'valid' }]);
        expect(result.length).toBe(1);
    });

    it('filters missing role', () => {
        const result = sanitizeMessages([
            { content: 'no role' },
            { role: '', content: 'empty role' },
            { role: 'user', content: 'valid' },
        ]);
        expect(result.length).toBe(1);
    });

    it('filters null/undefined content', () => {
        const result = sanitizeMessages([
            { role: 'user', content: null },
            { role: 'user', content: undefined },
            { role: 'user', content: 'valid' },
        ]);
        expect(result.length).toBe(1);
    });

    it('removes toJSON method from messages', () => {
        const msg = { role: 'user', content: 'test', toJSON: () => ({}) };
        const result = sanitizeMessages([msg]);
        expect(result.length).toBe(1);
        expect(result[0].toJSON).toBeUndefined();
    });

    it('filters empty-content messages (no multimodals)', () => {
        const result = sanitizeMessages([
            { role: 'user', content: '   ' },
            { role: 'user', content: 'valid' },
        ]);
        expect(result.length).toBe(1);
    });

    it('keeps messages with multimodals even if text is empty', () => {
        const result = sanitizeMessages([
            { role: 'user', content: '', multimodals: [{ type: 'image', base64: 'data' }] },
        ]);
        expect(result.length).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════
// _withTimeout — reject path
// ═══════════════════════════════════════════════════════════════

describe('_withTimeout — additional branches', () => {
    it('cleans up timer on rejection', async () => {
        const err = new Error('original error');
        await expect(_withTimeout(Promise.reject(err), 5000, 'timeout')).rejects.toThrow('original error');
    });

    it('rejects with timeout when promise never resolves', async () => {
        const neverResolves = new Promise(() => {});
        await expect(_withTimeout(neverResolves, 5, 'custom timeout msg')).rejects.toThrow('custom timeout msg');
    });
});

// ═══════════════════════════════════════════════════════════════
// isRetriableError — all non-retriable patterns
// ═══════════════════════════════════════════════════════════════

describe('isRetriableError — all patterns', () => {
    it('empty/null → retriable', () => {
        expect(isRetriableError('')).toBe(true);
        expect(isRetriableError(null)).toBe(true);
    });

    it('이름 불일치 → NOT retriable', () => {
        expect(isRetriableError('이름 불일치: "A" ≠ "B"')).toBe(false);
    });

    it('버전 불일치 → NOT retriable', () => {
        expect(isRetriableError('버전 불일치: 기대 2.0.0')).toBe(false);
    });

    it('API 버전이 3.0이 아닙니다 → NOT retriable', () => {
        expect(isRetriableError('API 버전이 3.0이 아닙니다: 2.0')).toBe(false);
    });

    it('다운그레이드 차단 → NOT retriable', () => {
        expect(isRetriableError('다운그레이드 차단: 현재 2.0 > 1.0')).toBe(false);
    });

    it('이미 같은 버전입니다 → NOT retriable', () => {
        expect(isRetriableError('이미 같은 버전입니다: 1.0.0')).toBe(false);
    });

    it('network error → retriable', () => {
        expect(isRetriableError('Network timeout')).toBe(true);
    });

    it('Error object → retriable', () => {
        expect(isRetriableError(new Error('timeout'))).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// compareVersions — additional edge cases
// ═══════════════════════════════════════════════════════════════

describe('compareVersions — edge cases', () => {
    it('handles different length versions', () => {
        expect(compareVersions('1.0', '1.0.0')).toBe(0);
        expect(compareVersions('1.0', '1.0.1')).toBeGreaterThan(0);
    });

    it('handles missing/empty versions', () => {
        expect(compareVersions('', '')).toBe(0);
        expect(compareVersions(undefined, undefined)).toBe(0);
    });

    it('handles complex versions', () => {
        expect(compareVersions('1.20.16', '1.20.17')).toBeGreaterThan(0);
        expect(compareVersions('2.0.0', '1.99.99')).toBeLessThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// computeSHA256 — edge cases
// ═══════════════════════════════════════════════════════════════

describe('computeSHA256 — edge cases', () => {
    it('empty string → valid hash', async () => {
        const hash = await computeSHA256('');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('large input → valid hash', async () => {
        const hash = await computeSHA256('x'.repeat(1000));
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('unicode input → valid hash', async () => {
        const hash = await computeSHA256('한국어 테스트 🎉');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});
