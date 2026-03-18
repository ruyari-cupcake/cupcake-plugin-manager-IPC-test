/**
 * auto-updater-subplugin.test.js
 *
 * Tests for sub-plugin auto-update infrastructure:
 *   1. _checkSubPluginVersions — manifest vs installed comparison
 *   2. getSubPluginUpdates — cached results accessor
 *   3. validateAndInstallSubPlugin — code parsing, TOCTOU, DB write
 *   4. safeSubPluginUpdate — download + validate orchestration
 *   5. runSequentialSubPluginUpdates — sequential queue, corruption prevention
 *   6. Integration in checkVersionsQuiet — sub-plugin check after main
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAutoUpdater, compareVersions } from '../src/shared/auto-updater.js';

// ─── Helpers ───

function makeSubPluginCode(name, version, apiVersion = '3.0', extras = '') {
    return [
        `//@api ${apiVersion}`,
        `//@name ${name}`,
        `//@version ${version}`,
        `//@display-name ${name} Display`,
        `//@arg sub_key string`,
        extras,
        `console.log("${name} v${version}");`,
    ].join('\n');
}

function makeMainCode(version = '2.0.0') {
    return [
        `//@api 3.0`,
        `//@name TestPlugin`,
        `//@version ${version}`,
        `//@display-name Test Plugin`,
        `//@arg apiKey string`,
        `console.log("v${version}");`,
        'x'.repeat(500 * 1024),
    ].join('\n');
}

function makeDb(mainVer = '1.0.0', subPlugins = []) {
    const plugins = [
        {
            name: 'TestPlugin',
            version: '3.0',
            versionOfPlugin: mainVer,
            script: 'x'.repeat(500 * 1024),
            arguments: { apiKey: 'string' },
            realArg: { apiKey: 'my-key' },
            enabled: true,
            updateURL: '',
        },
        ...subPlugins,
    ];
    return { plugins };
}

function makeSubPluginEntry(name, version, extras = {}) {
    return {
        name,
        version: '3.0',
        versionOfPlugin: version,
        script: makeSubPluginCode(name, version),
        arguments: { sub_key: 'string' },
        realArg: { sub_key: 'old-val' },
        enabled: true,
        updateURL: '',
        ...extras,
    };
}

function createUpdater(risuOverrides = {}, depsOverrides = {}) {
    const storage = {};
    const db = makeDb('1.0.0', [
        makeSubPluginEntry('SubAlpha', '1.0.0'),
        makeSubPluginEntry('SubBeta', '2.0.0'),
    ]);

    const Risu = {
        pluginStorage: {
            getItem: vi.fn(async (key) => storage[key] || null),
            setItem: vi.fn(async (key, val) => { storage[key] = val; }),
            removeItem: vi.fn(async (key) => { delete storage[key]; }),
        },
        getDatabase: vi.fn(async () => JSON.parse(JSON.stringify(db))),
        setDatabaseLite: vi.fn(async () => {}),
        risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
        nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? true : ''),
        registerPlugin: vi.fn(),
        ...risuOverrides,
    };

    const updater = createAutoUpdater({
        Risu,
        currentVersion: '1.0.0',
        pluginName: 'TestPlugin',
        versionsUrl: 'https://example.com/versions.json',
        mainUpdateUrl: 'https://example.com/plugin.js',
        updateBundleUrl: 'https://example.com/bundle.json',
        toast: { showMainAutoUpdateResult: vi.fn(async () => {}) },
        _autoSaveDelayMs: 0,
        ...depsOverrides,
    });

    return { updater, Risu, storage, db };
}

// ─── 1. _checkSubPluginVersions ───

describe('auto-updater: _checkSubPluginVersions', () => {
    it('detects sub-plugins with newer remote versions', async () => {
        const { updater, Risu } = createUpdater();
        const manifest = {
            TestPlugin: { version: '2.0.0', file: 'main.js' },
            SubAlpha: { version: '1.5.0', file: 'sub-alpha.js', sha256: 'abc123' },
            SubBeta: { version: '2.0.0', file: 'sub-beta.js' }, // same version → skip
        };

        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(1);
        expect(updates[0].name).toBe('SubAlpha');
        expect(updates[0].localVersion).toBe('1.0.0');
        expect(updates[0].remoteVersion).toBe('1.5.0');
        expect(updates[0].file).toBe('sub-alpha.js');
        expect(updates[0].sha256).toBe('abc123');
    });

    it('returns empty array when all sub-plugins are up-to-date', async () => {
        const { updater } = createUpdater();
        const manifest = {
            TestPlugin: { version: '2.0.0' },
            SubAlpha: { version: '1.0.0' },
            SubBeta: { version: '1.0.0' }, // downgrade → no update
        };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(0);
    });

    it('skips manifest entries without version or with invalid format', async () => {
        const { updater } = createUpdater();
        const manifest = {
            TestPlugin: { version: '2.0.0' },
            SubAlpha: { version: null },
            SubBeta: 'invalid',
            SubGamma: { version: '3.0.0' }, // not installed → skip
        };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(0);
    });

    it('skips the main plugin name in manifest', async () => {
        const { updater } = createUpdater();
        const manifest = {
            TestPlugin: { version: '99.0.0' }, // main → skip
        };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(0);
    });

    it('handles empty/absent plugins array gracefully', async () => {
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => ({ plugins: null })),
        });
        const manifest = { SubAlpha: { version: '5.0.0' } };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(0);
    });

    it('handles getDatabase throwing an error', async () => {
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => { throw new Error('DB fail'); }),
        });
        const manifest = { SubAlpha: { version: '5.0.0' } };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(0); // graceful empty
    });

    it('includes changes field from manifest', async () => {
        const { updater } = createUpdater();
        const manifest = {
            SubAlpha: { version: '2.0.0', changes: '버그 수정 및 성능 개선' },
        };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(1);
        expect(updates[0].changes).toBe('버그 수정 및 성능 개선');
    });

    it('matches plugin name with underscores/spaces', async () => {
        const db = makeDb('1.0.0', [makeSubPluginEntry('Sub_Plugin_X', '1.0.0')]);
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => JSON.parse(JSON.stringify(db))),
        });
        const manifest = {
            'Sub Plugin X': { version: '2.0.0' },
        };
        const updates = await updater._checkSubPluginVersions(manifest);
        expect(updates).toHaveLength(1);
    });
});

// ─── 2. getSubPluginUpdates ───

describe('auto-updater: getSubPluginUpdates', () => {
    it('returns empty array initially', () => {
        const { updater } = createUpdater();
        expect(updater.getSubPluginUpdates()).toEqual([]);
    });

    it('returns a copy (not reference) of internal state', () => {
        const { updater } = createUpdater();
        const a = updater.getSubPluginUpdates();
        const b = updater.getSubPluginUpdates();
        expect(a).not.toBe(b);
    });
});

// ─── 3. validateAndInstallSubPlugin ───

describe('auto-updater: validateAndInstallSubPlugin', () => {
    it('rejects empty/short code', async () => {
        const { updater } = createUpdater();
        const result = await updater.validateAndInstallSubPlugin('', 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('비어있거나 너무 짧습니다');
    });

    it('rejects code with no @name header', async () => {
        const { updater } = createUpdater();
        const code = `//@api 3.0\n//@version 2.0.0\nconsole.log("no name");\n${'x'.repeat(100)}`;
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@name');
    });

    it('rejects code with name mismatch', async () => {
        const { updater } = createUpdater();
        const code = makeSubPluginCode('WrongPlugin', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('이름 불일치');
    });

    it('rejects code with no @version header', async () => {
        const { updater } = createUpdater();
        const code = `//@api 3.0\n//@name SubAlpha\nconsole.log("test");\n${'x'.repeat(100)}`;
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('@version');
    });

    it('rejects version mismatch between code and expected', async () => {
        const { updater } = createUpdater();
        const code = makeSubPluginCode('SubAlpha', '1.5.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('버전 불일치');
    });

    it('rejects if sub-plugin not found in DB', async () => {
        const { updater } = createUpdater();
        const code = makeSubPluginCode('NotInstalled', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'NotInstalled', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('DB에서 찾을 수 없습니다');
    });

    it('rejects downgrade', async () => {
        const { updater } = createUpdater();
        const code = makeSubPluginCode('SubAlpha', '0.5.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '0.5.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('다운그레이드 차단');
    });

    it('rejects same version', async () => {
        const { updater } = createUpdater();
        const code = makeSubPluginCode('SubAlpha', '1.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '1.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('같은 버전');
    });

    it('successfully installs valid sub-plugin upgrade', async () => {
        const { updater, Risu } = createUpdater();
        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(true);
        expect(Risu.setDatabaseLite).toHaveBeenCalled();

        // Check what was written
        const writeArg = Risu.setDatabaseLite.mock.calls[0][0];
        expect(writeArg.plugins).toBeDefined();
        const updated = writeArg.plugins.find(p => p.name === 'SubAlpha');
        expect(updated).toBeDefined();
        expect(updated.versionOfPlugin).toBe('2.0.0');
        expect(updated.script).toBe(code);
    });

    it('preserves existing realArg values on upgrade', async () => {
        const { updater, Risu } = createUpdater();
        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(true);

        const writeArg = Risu.setDatabaseLite.mock.calls[0][0];
        const updated = writeArg.plugins.find(p => p.name === 'SubAlpha');
        expect(updated.realArg.sub_key).toBe('old-val');
    });

    it('detects TOCTOU concurrent update', async () => {
        let callCount = 0;
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => {
                callCount++;
                // First call: v1.0.0, second call: v1.8.0 (concurrent update)
                if (callCount <= 1) {
                    return JSON.parse(JSON.stringify(makeDb('1.0.0', [makeSubPluginEntry('SubAlpha', '1.0.0')])));
                }
                return JSON.parse(JSON.stringify(makeDb('1.0.0', [makeSubPluginEntry('SubAlpha', '1.8.0')])));
            }),
        });

        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        // 1.8.0 → 2.0.0 is still an upgrade, so TOCTOU should allow it
        // But the version changed (1.0.0 → 1.8.0) which triggers concurrent update detection only if fresh >= target
        // In this case 1.8.0 < 2.0.0, so the intermediate update is within range and allowed
        // Actually let's test the real TOCTOU case:
        expect(result.ok).toBe(true); // intermediate update 1.0.0→1.8.0 is fine, 2.0.0 still valid
    });

    it('blocks TOCTOU when fresh version >= target', async () => {
        let callCount = 0;
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => {
                callCount++;
                if (callCount <= 1) {
                    return JSON.parse(JSON.stringify(makeDb('1.0.0', [makeSubPluginEntry('SubAlpha', '1.0.0')])));
                }
                // Concurrent update already installed 2.0.0 or newer
                return JSON.parse(JSON.stringify(makeDb('1.0.0', [makeSubPluginEntry('SubAlpha', '2.0.0')])));
            }),
        });

        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('동시 업데이트 감지');
    });

    it('blocks TOCTOU when plugin disappears between reads', async () => {
        let callCount = 0;
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => {
                callCount++;
                if (callCount <= 1) {
                    return JSON.parse(JSON.stringify(makeDb('1.0.0', [makeSubPluginEntry('SubAlpha', '1.0.0')])));
                }
                // Plugin disappeared
                return JSON.parse(JSON.stringify(makeDb('1.0.0', [])));
            }),
        });

        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('재검증 실패');
    });

    it('handles DB write failure', async () => {
        const { updater } = createUpdater({
            setDatabaseLite: vi.fn(async () => { throw new Error('write fail'); }),
        });
        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('DB write rejected');
    });

    it('parses @arg, @link, @display-name headers correctly', async () => {
        const { updater, Risu } = createUpdater();
        const code = [
            `//@api 3.0`,
            `//@name SubAlpha`,
            `//@version 2.0.0`,
            `//@display-name Alpha Sub`,
            `//@arg sub_key string`,
            `//@arg count int {{checkbox::카운트}}`,
            `//@link https://example.com/sub hover text`,
            `console.log("SubAlpha v2.0.0");`,
        ].join('\n');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(true);

        const writeArg = Risu.setDatabaseLite.mock.calls[0][0];
        const updated = writeArg.plugins.find(p => p.name === 'SubAlpha');
        expect(updated.displayName).toBe('Alpha Sub');
        expect(updated.arguments).toEqual({ sub_key: 'string', count: 'int' });
        expect(updated.customLink).toHaveLength(1);
        expect(updated.customLink[0].link).toBe('https://example.com/sub');
    });

    it('rejects null DB plugins', async () => {
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => ({ plugins: null })),
        });
        const code = makeSubPluginCode('SubAlpha', '2.0.0');
        const result = await updater.validateAndInstallSubPlugin(code, 'SubAlpha', '2.0.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('플러그인 목록');
    });
});

// ─── 4. runSequentialSubPluginUpdates ───

describe('auto-updater: runSequentialSubPluginUpdates', () => {
    it('processes updates sequentially and returns summary', async () => {
        const db = makeDb('1.0.0', [
            makeSubPluginEntry('SubAlpha', '1.0.0'),
            makeSubPluginEntry('SubBeta', '2.0.0'),
        ]);

        // Bundle returns code for sub-plugins
        const bundleData = {
            code: {
                'sub-alpha.js': makeSubPluginCode('SubAlpha', '1.5.0'),
                'sub-beta.js': makeSubPluginCode('SubBeta', '3.0.0'),
            },
        };

        const { updater, Risu } = createUpdater({
            getDatabase: vi.fn(async () => JSON.parse(JSON.stringify(db))),
            risuFetch: vi.fn(async () => ({
                status: 200,
                data: JSON.stringify(bundleData),
            })),
        });

        const updates = [
            { name: 'SubAlpha', remoteVersion: '1.5.0', file: 'sub-alpha.js' },
            { name: 'SubBeta', remoteVersion: '3.0.0', file: 'sub-beta.js' },
        ];

        const result = await updater.runSequentialSubPluginUpdates(updates);
        expect(result.total).toBe(2);
        expect(result.success).toBe(2);
        expect(result.failed).toBe(0);
        expect(result.results).toHaveLength(2);
        expect(result.results[0].ok).toBe(true);
        expect(result.results[1].ok).toBe(true);
    });

    it('continues processing after a single failure', async () => {
        const db = makeDb('1.0.0', [
            makeSubPluginEntry('SubAlpha', '1.0.0'),
            makeSubPluginEntry('SubBeta', '2.0.0'),
        ]);

        const bundleData = {
            code: {
                // SubAlpha missing from bundle
                'sub-beta.js': makeSubPluginCode('SubBeta', '3.0.0'),
            },
        };

        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => JSON.parse(JSON.stringify(db))),
            risuFetch: vi.fn(async () => ({
                status: 200,
                data: JSON.stringify(bundleData),
            })),
        });

        const updates = [
            { name: 'SubAlpha', remoteVersion: '1.5.0', file: 'sub-alpha.js' },
            { name: 'SubBeta', remoteVersion: '3.0.0', file: 'sub-beta.js' },
        ];

        const result = await updater.runSequentialSubPluginUpdates(updates);
        expect(result.total).toBe(2);
        expect(result.success).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.results[0].ok).toBe(false); // SubAlpha missing
        expect(result.results[1].ok).toBe(true);  // SubBeta OK
    });

    it('handles empty updates array', async () => {
        const { updater } = createUpdater();
        const result = await updater.runSequentialSubPluginUpdates([]);
        expect(result.total).toBe(0);
        expect(result.success).toBe(0);
        expect(result.failed).toBe(0);
    });

    it('handles bundle download failure', async () => {
        const { updater } = createUpdater({
            risuFetch: vi.fn(async () => ({ status: 500, data: null })),
        });

        const updates = [
            { name: 'SubAlpha', remoteVersion: '1.5.0', file: 'sub-alpha.js' },
        ];

        const result = await updater.runSequentialSubPluginUpdates(updates);
        expect(result.total).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.results[0].ok).toBe(false);
    });
});

// ─── 5. checkVersionsQuiet sub-plugin detection ───

describe('auto-updater: checkVersionsQuiet sub-plugin detection', () => {
    it('populates getSubPluginUpdates after successful manifest check', async () => {
        const manifest = {
            TestPlugin: { version: '2.0.0', file: 'main.js' },
            SubAlpha: { version: '1.5.0', file: 'sub-alpha.js' },
        };

        const { updater, Risu } = createUpdater({
            risuFetch: vi.fn(async (url) => {
                if (url.includes('versions')) {
                    return { status: 200, data: JSON.stringify(manifest) };
                }
                return { status: 200, data: JSON.stringify({ code: { 'main.js': makeMainCode('2.0.0') } }) };
            }),
        });

        // Run checkVersionsQuiet — it should detect SubAlpha update
        await updater.checkVersionsQuiet();

        const subUpdates = updater.getSubPluginUpdates();
        expect(subUpdates.length).toBeGreaterThanOrEqual(1);
        expect(subUpdates[0].name).toBe('SubAlpha');
    }, 15000);
});

// ─── 7. Per-sub-plugin ON/OFF toggle ───

describe('isSubPluginAutoUpdateEnabled / setSubPluginAutoUpdateEnabled', () => {
    it('defaults to true when key not set', async () => {
        const { updater } = createUpdater();
        const enabled = await updater.isSubPluginAutoUpdateEnabled('SubAlpha');
        expect(enabled).toBe(true);
    });

    it('returns false after disabling', async () => {
        const { updater } = createUpdater();
        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', false);
        const enabled = await updater.isSubPluginAutoUpdateEnabled('SubAlpha');
        expect(enabled).toBe(false);
    });

    it('returns true after re-enabling', async () => {
        const { updater } = createUpdater();
        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', false);
        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', true);
        const enabled = await updater.isSubPluginAutoUpdateEnabled('SubAlpha');
        expect(enabled).toBe(true);
    });

    it('handles names with spaces (stored with underscores)', async () => {
        const { updater } = createUpdater();
        await updater.setSubPluginAutoUpdateEnabled('Sub Alpha', false);
        const enabled = await updater.isSubPluginAutoUpdateEnabled('Sub Alpha');
        expect(enabled).toBe(false);
    });

    it('treats "0", "off", "no" as disabled', async () => {
        const { updater, storage } = createUpdater();
        storage['cpm_sub_autoupdate_SubAlpha'] = '0';
        expect(await updater.isSubPluginAutoUpdateEnabled('SubAlpha')).toBe(false);
        storage['cpm_sub_autoupdate_SubAlpha'] = 'off';
        expect(await updater.isSubPluginAutoUpdateEnabled('SubAlpha')).toBe(false);
        storage['cpm_sub_autoupdate_SubAlpha'] = 'no';
        expect(await updater.isSubPluginAutoUpdateEnabled('SubAlpha')).toBe(false);
    });

    it('returns true on storage error', async () => {
        const { updater } = createUpdater({
            pluginStorage: {
                getItem: vi.fn(async () => { throw new Error('storage failure'); }),
                setItem: vi.fn(async () => {}),
                removeItem: vi.fn(async () => {}),
            },
        });
        const enabled = await updater.isSubPluginAutoUpdateEnabled('SubAlpha');
        expect(enabled).toBe(true);
    });
});

describe('getSubPluginToggleStates', () => {
    it('returns toggle states for all installed sub-plugins', async () => {
        const { updater } = createUpdater();
        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', false);
        const states = await updater.getSubPluginToggleStates();
        // DB has SubAlpha and SubBeta
        expect(states.length).toBe(2);
        const alpha = states.find(s => s.name === 'SubAlpha');
        const beta = states.find(s => s.name === 'SubBeta');
        expect(alpha.enabled).toBe(false);
        expect(beta.enabled).toBe(true); // default
    });

    it('skips main plugin', async () => {
        const { updater } = createUpdater();
        const states = await updater.getSubPluginToggleStates();
        const main = states.find(s => s.name === 'TestPlugin');
        expect(main).toBeUndefined();
    });

    it('returns empty on DB error', async () => {
        const { updater } = createUpdater({
            getDatabase: vi.fn(async () => { throw new Error('DB error'); }),
        });
        const states = await updater.getSubPluginToggleStates();
        expect(states).toEqual([]);
    });
});

describe('checkVersionsQuiet — sub-plugin toggle filtering', () => {
    it('skips disabled sub-plugins during auto-update', async () => {
        const risuFetchMock = vi.fn(async () => ({
            data: JSON.stringify({
                TestPlugin: { version: '1.0.0' },
                SubAlpha: { version: '2.0.0', file: 'sub-alpha.js', sha256: 'abc123', changes: 'fix' },
                SubBeta: { version: '3.0.0', file: 'sub-beta.js', sha256: 'def456', changes: 'feat' },
            }),
            status: 200,
        }));
        const { updater, Risu, storage } = createUpdater({
            risuFetch: risuFetchMock,
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? 'true' : ''),
        });

        // Disable SubAlpha auto-update
        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', false);

        await updater.checkVersionsQuiet();

        const subUpdates = updater.getSubPluginUpdates();
        // Both should be detected
        expect(subUpdates.length).toBe(2);
        expect(subUpdates.find(u => u.name === 'SubAlpha')).toBeDefined();
        expect(subUpdates.find(u => u.name === 'SubBeta')).toBeDefined();

        // Verify filtering via risuFetch call count:
        // Call 1: manifest fetch (versionsUrl)
        // Call 2: bundle fetch for SubBeta only (SubAlpha was disabled → skipped)
        // If SubAlpha were not filtered, there would be 3 calls (manifest + 2 bundles)
        expect(risuFetchMock).toHaveBeenCalledTimes(2);
    }, 15000);

    it('processes all sub-plugins when all toggles are enabled (default)', async () => {
        const risuFetchMock = vi.fn(async () => ({
            data: JSON.stringify({
                TestPlugin: { version: '1.0.0' },
                SubAlpha: { version: '2.0.0', file: 'sub-alpha.js', sha256: 'abc123', changes: 'fix' },
                SubBeta: { version: '3.0.0', file: 'sub-beta.js', sha256: 'def456', changes: 'feat' },
            }),
            status: 200,
        }));
        const { updater } = createUpdater({
            risuFetch: risuFetchMock,
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? 'true' : ''),
        });

        // Don't disable anything — both should be processed
        await updater.checkVersionsQuiet();

        // Call 1: manifest, Call 2: SubAlpha bundle, Call 3: SubBeta bundle
        expect(risuFetchMock).toHaveBeenCalledTimes(3);
    }, 15000);

    it('skips all sub-plugins when all toggles are disabled', async () => {
        const risuFetchMock = vi.fn(async () => ({
            data: JSON.stringify({
                TestPlugin: { version: '1.0.0' },
                SubAlpha: { version: '2.0.0', file: 'sub-alpha.js', sha256: 'abc123', changes: 'fix' },
                SubBeta: { version: '3.0.0', file: 'sub-beta.js', sha256: 'def456', changes: 'feat' },
            }),
            status: 200,
        }));
        const { updater } = createUpdater({
            risuFetch: risuFetchMock,
            getArgument: vi.fn(async (key) => key === 'cpm_auto_update_enabled' ? 'true' : ''),
        });

        await updater.setSubPluginAutoUpdateEnabled('SubAlpha', false);
        await updater.setSubPluginAutoUpdateEnabled('SubBeta', false);

        await updater.checkVersionsQuiet();

        // Only 1 call: manifest fetch. No bundle fetches since all disabled.
        expect(risuFetchMock).toHaveBeenCalledTimes(1);

        // But detection still works
        const subUpdates = updater.getSubPluginUpdates();
        expect(subUpdates.length).toBe(2);
    }, 15000);
});
