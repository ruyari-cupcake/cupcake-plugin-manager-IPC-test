/**
 * auto-updater-toggle-toctou.test.js
 *
 * Tests for:
 *   1. _isAutoUpdateEnabled toggle logic (default OFF)
 *   2. checkVersionsQuiet / checkMainPluginVersionQuiet skip when toggle OFF
 *   3. TOCTOU re-verification in validateAndInstall
 */
import { describe, it, expect, vi } from 'vitest';
import { createAutoUpdater, compareVersions } from '../src/shared/auto-updater.js';

// ─── Helpers ───

function makeValidCode(version = '2.0.0', name = 'TestPlugin') {
    return [
        `//@api 3.0`,
        `//@name ${name}`,
        `//@version ${version}`,
        `//@display-name Test Plugin`,
        `//@arg apiKey string`,
        `console.log("v${version}");`,
        'x'.repeat(500 * 1024),
    ].join('\n');
}

function makeDeps(overrides = {}) {
    const storage = {};
    return {
        Risu: {
            pluginStorage: {
                getItem: vi.fn(async (key) => storage[key] || null),
                setItem: vi.fn(async (key, val) => { storage[key] = val; }),
                removeItem: vi.fn(async (key) => { delete storage[key]; }),
            },
            getDatabase: vi.fn(async () => ({
                plugins: [{
                    name: 'TestPlugin',
                    versionOfPlugin: '1.0.0',
                    script: 'x'.repeat(500 * 1024),
                    arguments: { apiKey: 'string' },
                    realArg: { apiKey: 'my-key' },
                    enabled: true,
                    updateURL: '',
                }],
            })),
            setDatabaseLite: vi.fn(async () => {}),
            risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
            getArgument: vi.fn(async () => ''),
            registerPlugin: vi.fn(),
            ...(overrides.Risu || {}),
        },
        currentVersion: '1.0.0',
        pluginName: 'TestPlugin',
        versionsUrl: 'https://example.com/versions.json',
        mainUpdateUrl: 'https://example.com/plugin.js',
        updateBundleUrl: 'https://example.com/bundle.json',
        toast: { showMainAutoUpdateResult: vi.fn(async () => {}) },
        validateSchema: vi.fn((v) => ({ valid: true, value: v })),
        ...overrides,
        Risu: undefined,  // re-set below
    };
}

function createUpdater(risuOverrides = {}, depsOverrides = {}) {
    const storage = {};
    const Risu = {
        pluginStorage: {
            getItem: vi.fn(async (key) => storage[key] || null),
            setItem: vi.fn(async (key, val) => { storage[key] = val; }),
            removeItem: vi.fn(async (key) => { delete storage[key]; }),
        },
        getDatabase: vi.fn(async () => ({
            plugins: [{
                name: 'TestPlugin',
                versionOfPlugin: '1.0.0',
                script: 'x'.repeat(500 * 1024),
                arguments: { apiKey: 'string' },
                realArg: { apiKey: 'my-key' },
                enabled: true,
                updateURL: '',
            }],
        })),
        setDatabaseLite: vi.fn(async () => {}),
        risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
        nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        getArgument: vi.fn(async () => ''),
        registerPlugin: vi.fn(),
        ...risuOverrides,
    };
    return {
        updater: createAutoUpdater({
            Risu,
            currentVersion: '1.0.0',
            pluginName: 'TestPlugin',
            versionsUrl: 'https://example.com/versions.json',
            mainUpdateUrl: 'https://example.com/plugin.js',
            updateBundleUrl: 'https://example.com/bundle.json',
            toast: { showMainAutoUpdateResult: vi.fn(async () => {}) },
            _autoSaveDelayMs: 0,
            ...depsOverrides,
        }),
        Risu,
        storage,
    };
}

// ─── 1. _isAutoUpdateEnabled ───

describe('auto-updater: _isAutoUpdateEnabled toggle', () => {
    it('returns false when getArgument returns empty string (default OFF)', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => '') });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('returns false when getArgument returns undefined', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => undefined) });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('returns false when getArgument returns null', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => null) });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('returns false when getArgument returns "false"', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => 'false') });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('returns false when getArgument returns "0"', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => '0') });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('returns false when getArgument returns 0', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => 0) });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('returns true when getArgument returns boolean true', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => true) });
        expect(await updater._isAutoUpdateEnabled()).toBe(true);
    });

    it('returns true when getArgument returns 1', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => 1) });
        expect(await updater._isAutoUpdateEnabled()).toBe(true);
    });

    it('returns true when getArgument returns "true"', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => 'true') });
        expect(await updater._isAutoUpdateEnabled()).toBe(true);
    });

    it('returns true when getArgument returns "1"', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => '1') });
        expect(await updater._isAutoUpdateEnabled()).toBe(true);
    });

    it('returns true when getArgument returns "yes"', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => 'yes') });
        expect(await updater._isAutoUpdateEnabled()).toBe(true);
    });

    it('returns true when getArgument returns "on"', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => 'on') });
        expect(await updater._isAutoUpdateEnabled()).toBe(true);
    });

    it('returns false when getArgument throws', async () => {
        const { updater } = createUpdater({ getArgument: vi.fn(async () => { throw new Error('no arg'); }) });
        expect(await updater._isAutoUpdateEnabled()).toBe(false);
    });

    it('exported constants include AUTO_UPDATE_ARG_KEY', () => {
        const { updater } = createUpdater();
        expect(updater._constants.AUTO_UPDATE_ARG_KEY).toBe('cpm_auto_update_enabled');
    });

    it('supports custom autoUpdateArgKey', () => {
        const { updater } = createUpdater({}, { autoUpdateArgKey: 'my_custom_toggle' });
        expect(updater._constants.AUTO_UPDATE_ARG_KEY).toBe('my_custom_toggle');
    });
});

// ─── 2. checkVersionsQuiet / checkMainPluginVersionQuiet skip when toggle OFF ───

describe('auto-updater: checkVersionsQuiet — auto-update toggle', () => {
    it('skips fetch when toggle is OFF (default)', async () => {
        const risuFetch = vi.fn(async () => ({ data: '{}', status: 200 }));
        const { updater } = createUpdater({
            getArgument: vi.fn(async () => ''),
            risuFetch,
        });

        await updater.checkVersionsQuiet();
        expect(risuFetch).not.toHaveBeenCalled();
    });

    it('proceeds when toggle is ON', async () => {
        const manifest = { TestPlugin: { version: '1.0.0' } };
        const risuFetch = vi.fn(async () => ({ data: JSON.stringify(manifest), status: 200 }));
        const { updater } = createUpdater({
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? true : ''),
            risuFetch,
        });

        await updater.checkVersionsQuiet();
        expect(risuFetch).toHaveBeenCalled();
    });
});

describe('auto-updater: checkMainPluginVersionQuiet — auto-update toggle', () => {
    it('skips fetch when toggle is OFF', async () => {
        const nativeFetch = vi.fn(async () => ({ ok: true, status: 200, text: vi.fn(async () => '') }));
        const { updater } = createUpdater({
            getArgument: vi.fn(async () => ''),
            nativeFetch,
        });

        await updater.checkMainPluginVersionQuiet();
        expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('proceeds when toggle is ON', async () => {
        const remoteCode = `//@version 2.0.0\nconsole.log("hello");`;
        const nativeFetch = vi.fn(async () => ({
            ok: true, status: 200, text: vi.fn(async () => remoteCode),
        }));
        const { updater } = createUpdater({
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? true : ''),
            nativeFetch,
        });

        await updater.checkMainPluginVersionQuiet();
        expect(nativeFetch).toHaveBeenCalled();
    });
});

// ─── 3. TOCTOU re-verification in validateAndInstall ───

describe('auto-updater: validateAndInstall — TOCTOU protection', () => {
    it('detects concurrent update when DB version changed mid-install', async () => {
        let callCount = 0;
        const getDatabase = vi.fn(async () => {
            callCount++;
            return {
                plugins: [{
                    name: 'TestPlugin',
                    // First call: version 1.0.0, second call (TOCTOU re-read): version 2.0.0
                    versionOfPlugin: callCount <= 1 ? '1.0.0' : '2.0.0',
                    script: 'x'.repeat(500 * 1024),
                    arguments: { apiKey: 'string' },
                    realArg: { apiKey: 'old' },
                    enabled: true,
                    updateURL: '',
                }],
            };
        });

        const { updater } = createUpdater({ getDatabase });
        const code = makeValidCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0', '');

        // Should detect concurrent update: trying to install 2.0.0 but DB already at 2.0.0
        expect(result.ok).toBe(false);
        expect(result.error).toContain('동시 업데이트 감지');
    });

    it('proceeds when DB version unchanged between reads', async () => {
        const { updater, Risu } = createUpdater({
            getDatabase: vi.fn(async () => ({
                plugins: [{
                    name: 'TestPlugin',
                    versionOfPlugin: '1.0.0',
                    script: 'x'.repeat(500 * 1024),
                    arguments: { apiKey: 'string' },
                    realArg: { apiKey: 'old' },
                    enabled: true,
                    updateURL: '',
                }],
            })),
        });

        const code = makeValidCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0', '');
        expect(result.ok).toBe(true);
    });

    it('detects when plugin disappeared from DB during TOCTOU re-read', async () => {
        let callCount = 0;
        const getDatabase = vi.fn(async () => {
            callCount++;
            if (callCount <= 1) {
                return {
                    plugins: [{
                        name: 'TestPlugin',
                        versionOfPlugin: '1.0.0',
                        script: 'x'.repeat(500 * 1024),
                        arguments: { apiKey: 'string' },
                        realArg: { apiKey: 'old' },
                        enabled: true,
                    }],
                };
            }
            // Plugin gone in second read
            return { plugins: [] };
        });

        const { updater } = createUpdater({ getDatabase });
        const code = makeValidCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0', '');

        expect(result.ok).toBe(false);
        expect(result.error).toContain('재검증 실패');
    });

    it('allows update when concurrent version is lower than target', async () => {
        let callCount = 0;
        const getDatabase = vi.fn(async () => {
            callCount++;
            return {
                plugins: [{
                    name: 'TestPlugin',
                    // First read: 1.0.0, second read: 1.5.0 (intermediate update)
                    versionOfPlugin: callCount <= 1 ? '1.0.0' : '1.5.0',
                    script: 'x'.repeat(500 * 1024),
                    arguments: { apiKey: 'string' },
                    realArg: { apiKey: 'old' },
                    enabled: true,
                    updateURL: '',
                }],
            };
        });

        const { updater } = createUpdater({ getDatabase });
        const code = makeValidCode('2.0.0');
        const result = await updater.validateAndInstall(code, '2.0.0', '');

        // Target 2.0.0 > intermediate 1.5.0, so update should proceed
        expect(result.ok).toBe(true);
    });
});
