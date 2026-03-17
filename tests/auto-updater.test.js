import { describe, it, expect, vi } from 'vitest';
import {
    computeSHA256,
    compareVersions,
    isRetriableError,
    createAutoUpdater,
} from '../src/shared/auto-updater.js';

// ── computeSHA256 ──
describe('computeSHA256', () => {
    it('computes SHA-256 hex digest of a string', async () => {
        const hash = await computeSHA256('hello');
        // Known SHA-256 of "hello"
        expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('returns empty string for empty input', async () => {
        const hash = await computeSHA256('');
        // SHA-256 of empty string
        expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles unicode strings', async () => {
        const hash = await computeSHA256('안녕하세요');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hash.length).toBe(64);
    });

    it('returns different hashes for different inputs', async () => {
        const h1 = await computeSHA256('test1');
        const h2 = await computeSHA256('test2');
        expect(h1).not.toBe(h2);
    });
});

// ── compareVersions ──
describe('compareVersions', () => {
    it('returns positive when remote > local', () => {
        expect(compareVersions('1.0.0', '2.0.0')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '1.1.0')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '1.0.1')).toBeGreaterThan(0);
    });

    it('returns 0 for equal versions', () => {
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
        expect(compareVersions('2.5.3', '2.5.3')).toBe(0);
    });

    it('returns negative when remote < local', () => {
        expect(compareVersions('2.0.0', '1.0.0')).toBeLessThan(0);
        expect(compareVersions('1.20.0', '1.19.0')).toBeLessThan(0);
    });

    it('handles missing versions', () => {
        expect(compareVersions('', '1.0.0')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '')).toBeLessThan(0);
    });

    it('handles different length versions', () => {
        expect(compareVersions('1.0', '1.0.1')).toBeGreaterThan(0);
        expect(compareVersions('1.0.1', '1.0')).toBeLessThan(0);
    });
});

// ── isRetriableError ──
describe('isRetriableError', () => {
    it('returns true for general network errors', () => {
        expect(isRetriableError('Network timeout')).toBe(true);
        expect(isRetriableError('fetch failed')).toBe(true);
        expect(isRetriableError('HTTP 500')).toBe(true);
    });

    it('returns false for name mismatch errors', () => {
        expect(isRetriableError('이름 불일치: "X" ≠ "Y"')).toBe(false);
    });

    it('returns false for version mismatch errors', () => {
        expect(isRetriableError('버전 불일치: 기대 1.0, 실제 2.0')).toBe(false);
    });

    it('returns false for API version errors', () => {
        expect(isRetriableError('API 버전이 3.0이 아닙니다: 2.0')).toBe(false);
    });

    it('returns false for downgrade block errors', () => {
        expect(isRetriableError('다운그레이드 차단: 현재 2.0 > 다운로드 1.0')).toBe(false);
    });

    it('returns false for same-version errors', () => {
        expect(isRetriableError('이미 같은 버전입니다: 1.0')).toBe(false);
    });

    it('returns false for plugin-not-found errors', () => {
        expect(isRetriableError('플러그인을 db에서 찾을 수 없습니다')).toBe(false);
        expect(isRetriableError('플러그인 목록을 찾을 수 없습니다')).toBe(false);
    });

    it('returns true for empty/null error', () => {
        expect(isRetriableError('')).toBe(true);
        expect(isRetriableError(null)).toBe(true);
    });
});

// ── createAutoUpdater ──
describe('createAutoUpdater', () => {
    /** @type {Record<string, any>} */
    let storageData;
    let mockRisu;

    function createMockRisu() {
        storageData = {};
        return {
            pluginStorage: {
                getItem: vi.fn(async (key) => storageData[key] || null),
                setItem: vi.fn(async (key, value) => { storageData[key] = value; }),
                removeItem: vi.fn(async (key) => { delete storageData[key]; }),
            },
            getDatabase: vi.fn(async () => ({
                plugins: [
                    {
                        name: 'Cupcake_Provider_Manager',
                        versionOfPlugin: '1.19.0',
                        script: 'x'.repeat(500 * 1024),
                        arguments: { key1: 'string' },
                        realArg: { key1: 'val1' },
                        updateURL: 'https://example.com',
                        enabled: true,
                    },
                ],
            })),
            setDatabaseLite: vi.fn(async () => {}),
            risuFetch: vi.fn(async () => ({ data: null, status: 404 })),
            nativeFetch: vi.fn(async () => ({ ok: false, status: 404 })),
        };
    }

    function makeUpdater(overrides = {}) {
        mockRisu = createMockRisu();
        return createAutoUpdater({
            Risu: mockRisu,
            currentVersion: '1.19.0',
            pluginName: 'Cupcake Provider Manager',
            versionsUrl: 'https://test.vercel.app/api/versions',
            mainUpdateUrl: 'https://test.vercel.app/api/main-plugin',
            updateBundleUrl: 'https://test.vercel.app/api/update-bundle',
            ...overrides,
        });
    }

    // ── Pending update persistence ──
    describe('pending update persistence', () => {
        it('readPendingUpdate returns null when no marker exists', async () => {
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('writePendingUpdate stores data', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '2.0.0', changes: 'test', createdAt: 1000, attempts: 0, lastAttemptTs: 0, lastError: '' });
            const result = await updater.readPendingUpdate();
            expect(result).not.toBeNull();
            expect(result.version).toBe('2.0.0');
            expect(result.changes).toBe('test');
        });

        it('clearPendingUpdate removes marker', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '2.0.0' });
            await updater.clearPendingUpdate();
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('rememberPendingUpdate creates new marker', async () => {
            const updater = makeUpdater();
            await updater.rememberPendingUpdate('2.0.0', 'init');
            const result = await updater.readPendingUpdate();
            expect(result.version).toBe('2.0.0');
            expect(result.changes).toBe('init');
            expect(result.attempts).toBe(0);
        });

        it('rememberPendingUpdate preserves existing data for same version', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '2.0.0', changes: 'old', createdAt: 1000, attempts: 1, lastAttemptTs: 500, lastError: 'err' });
            await updater.rememberPendingUpdate('2.0.0', 'new-changes');
            const result = await updater.readPendingUpdate();
            expect(result.version).toBe('2.0.0');
            expect(result.changes).toBe('new-changes');
            expect(result.createdAt).toBe(1000); // preserved
            expect(result.attempts).toBe(1); // preserved
        });

        it('rememberPendingUpdate resets for new version', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '2.0.0', changes: 'old', createdAt: 1000, attempts: 3, lastAttemptTs: 500, lastError: 'err' });
            await updater.rememberPendingUpdate('3.0.0', 'new');
            const result = await updater.readPendingUpdate();
            expect(result.version).toBe('3.0.0');
            expect(result.attempts).toBe(0); // reset
        });

        it('readPendingUpdate handles corrupt data gracefully', async () => {
            const updater = makeUpdater();
            storageData['cpm_pending_main_update'] = 'not-json';
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('readPendingUpdate handles empty version', async () => {
            const updater = makeUpdater();
            storageData['cpm_pending_main_update'] = JSON.stringify({ version: '' });
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('rememberPendingUpdate ignores empty version', async () => {
            const updater = makeUpdater();
            await updater.rememberPendingUpdate('', 'test');
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });
    });

    // ── getInstalledVersion ──
    describe('getInstalledVersion', () => {
        it('returns version from DB plugin', async () => {
            const updater = makeUpdater();
            const version = await updater.getInstalledVersion();
            expect(version).toBe('1.19.0');
        });

        it('falls back to currentVersion on DB error', async () => {
            mockRisu = createMockRisu();
            mockRisu.getDatabase = vi.fn(async () => { throw new Error('DB error'); });
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.18.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: '',
            });
            const version = await updater.getInstalledVersion();
            expect(version).toBe('1.18.0');
        });
    });

    // ── validateAndInstall ──
    describe('validateAndInstall', () => {
        const validCode = [
            '//@api 3.0',
            '//@name Cupcake_Provider_Manager',
            '//@display-name Cupcake Provider Manager',
            '//@version 1.20.0',
            '//@update-url https://example.com/update',
            '//@arg key1 string {{desc::Key 1}}',
            '//@link https://example.com Docs',
            '',
            '// plugin code here',
            'console.log("hello");',
        ].join('\n').padEnd(200, '\n// padding');

        it('rejects empty code', async () => {
            const updater = makeUpdater();
            const result = await updater.validateAndInstall('', '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('비어있거나 너무 짧습니다');
        });

        it('rejects code without @name', async () => {
            const updater = makeUpdater();
            const result = await updater.validateAndInstall('//@api 3.0\n//@version 1.0\n' + 'x'.repeat(200), '1.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('@name');
        });

        it('rejects name mismatch', async () => {
            const updater = makeUpdater();
            const code = '//@api 3.0\n//@name Wrong_Name\n//@version 1.20.0\n' + 'x'.repeat(200);
            const result = await updater.validateAndInstall(code, '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('이름 불일치');
        });

        it('rejects non-3.0 API version', async () => {
            const updater = makeUpdater();
            const code = '//@api 2.0\n//@name Cupcake_Provider_Manager\n//@version 1.20.0\n' + 'x'.repeat(200);
            const result = await updater.validateAndInstall(code, '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('API 버전이 3.0이 아닙니다');
        });

        it('rejects version mismatch', async () => {
            const updater = makeUpdater();
            const code = '//@api 3.0\n//@name Cupcake_Provider_Manager\n//@version 1.19.5\n' + 'x'.repeat(200);
            const result = await updater.validateAndInstall(code, '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('버전 불일치');
        });

        it('rejects same version (no update needed)', async () => {
            const updater = makeUpdater();
            const code = '//@api 3.0\n//@name Cupcake_Provider_Manager\n//@version 1.19.0\n' + 'x'.repeat(200);
            const result = await updater.validateAndInstall(code, '1.19.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('이미 같은 버전');
        });

        it('rejects downgrade', async () => {
            const updater = makeUpdater();
            const code = '//@api 3.0\n//@name Cupcake_Provider_Manager\n//@version 1.18.0\n' + 'x'.repeat(200);
            const result = await updater.validateAndInstall(code, '1.18.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('다운그레이드 차단');
        });

        it('accepts valid upgrade code', async () => {
            const updater = makeUpdater();
            // Need to ensure code is long enough (>95% of existing 500KB)
            const longCode = validCode.padEnd(490 * 1024, '\n// code');
            const result = await updater.validateAndInstall(longCode, '1.20.0');
            expect(result.ok).toBe(true);
            expect(mockRisu.setDatabaseLite).toHaveBeenCalled();
        });

        it('preserves existing settings on upgrade', async () => {
            const updater = makeUpdater();
            const longCode = validCode.padEnd(490 * 1024, '\n// code');
            await updater.validateAndInstall(longCode, '1.20.0');
            const call = mockRisu.setDatabaseLite.mock.calls[0][0];
            const updated = call.plugins[0];
            expect(updated.realArg.key1).toBe('val1'); // preserved from existing
        });

        it('rejects suspiciously small download (<95% of existing)', async () => {
            const updater = makeUpdater();
            // Existing is 500KB, new is only 200 bytes → too small
            const result = await updater.validateAndInstall(validCode, '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('불완전한 다운로드');
        });

        it('calls toast on success', async () => {
            const mockToast = { showMainAutoUpdateResult: vi.fn(async () => {}) };
            mockRisu = createMockRisu();
            // Make existing script small enough that size check passes
            mockRisu.getDatabase = vi.fn(async () => ({
                plugins: [{
                    name: 'Cupcake_Provider_Manager',
                    versionOfPlugin: '1.19.0',
                    script: 'x'.repeat(100),
                    arguments: {},
                    realArg: {},
                    enabled: true,
                }],
            }));
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.19.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: '',
                toast: mockToast,
            });
            const result = await updater.validateAndInstall(validCode, '1.20.0');
            expect(result.ok).toBe(true);
            expect(mockToast.showMainAutoUpdateResult).toHaveBeenCalledWith('1.19.0', '1.20.0', '', true);
        });

        it('handles DB access failure', async () => {
            mockRisu = createMockRisu();
            mockRisu.getDatabase = vi.fn(async () => null);
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.19.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: '',
            });
            const result = await updater.validateAndInstall(validCode, '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('데이터베이스 접근 실패');
        });

        it('handles plugin not found in DB', async () => {
            mockRisu = createMockRisu();
            mockRisu.getDatabase = vi.fn(async () => ({ plugins: [{ name: 'OtherPlugin' }] }));
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.19.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: '',
            });
            const result = await updater.validateAndInstall(validCode, '1.20.0');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('DB에서 찾을 수 없습니다');
        });
    });

    // ── Boot retry ──
    describe('retryPendingUpdateOnBoot', () => {
        it('returns false when no pending update exists', async () => {
            const updater = makeUpdater();
            const result = await updater.retryPendingUpdateOnBoot();
            expect(result).toBe(false);
        });

        it('clears marker when installed version is already satisfied', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '1.19.0', changes: '', createdAt: 1000, attempts: 0, lastAttemptTs: 0, lastError: '' });
            const result = await updater.retryPendingUpdateOnBoot();
            expect(result).toBe(true);
            expect(await updater.readPendingUpdate()).toBeNull();
        });

        it('clears marker when max attempts exceeded', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '2.0.0', changes: '', createdAt: 1000, attempts: 3, lastAttemptTs: 0, lastError: '' });
            const result = await updater.retryPendingUpdateOnBoot();
            expect(result).toBe(false);
            expect(await updater.readPendingUpdate()).toBeNull();
        });

        it('respects cooldown period', async () => {
            const updater = makeUpdater();
            await updater.writePendingUpdate({ version: '2.0.0', changes: '', createdAt: 1000, attempts: 0, lastAttemptTs: Date.now(), lastError: '' });
            const result = await updater.retryPendingUpdateOnBoot();
            expect(result).toBe(false);
        });
    });

    // ── downloadMainPluginCode ──
    describe('downloadMainPluginCode', () => {
        it('attempts bundle download first', async () => {
            const updater = makeUpdater();
            // Both fetches fail → returns error
            const result = await updater.downloadMainPluginCode('2.0.0');
            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('returns downloaded code on success via risuFetch', async () => {
            mockRisu = createMockRisu();
            const testCode = '//@api 3.0\n//@name Test\n//@version 1.0\n// code';
            const testHash = await computeSHA256(testCode);
            mockRisu.risuFetch = vi.fn(async (url) => {
                if (url.includes('update-bundle')) {
                    return {
                        data: JSON.stringify({
                            versions: { 'Cupcake Provider Manager': { version: '2.0.0', file: 'main.js', sha256: testHash } },
                            code: { 'main.js': testCode },
                        }),
                        status: 200,
                    };
                }
                return { data: null, status: 404 };
            });
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.0.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: 'https://test/api/update-bundle',
            });
            const result = await updater.downloadMainPluginCode('2.0.0');
            expect(result.ok).toBe(true);
            expect(result.code).toBe(testCode);
        });

        it('rejects bundle with SHA mismatch', async () => {
            mockRisu = createMockRisu();
            mockRisu.risuFetch = vi.fn(async (url) => {
                if (url.includes('update-bundle')) {
                    return {
                        data: JSON.stringify({
                            versions: { 'Cupcake Provider Manager': { version: '2.0.0', file: 'main.js', sha256: 'wronghash' } },
                            code: { 'main.js': 'some code' },
                        }),
                        status: 200,
                    };
                }
                return { data: null, status: 404 };
            });
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.0.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: 'https://test/api/update-bundle',
            });
            const result = await updater.downloadMainPluginCode('2.0.0');
            // Bundle path fails, falls back to direct download which also fails
            expect(result.ok).toBe(false);
        });

        it('rejects bundle without SHA hash', async () => {
            mockRisu = createMockRisu();
            mockRisu.risuFetch = vi.fn(async (url) => {
                if (url.includes('update-bundle')) {
                    return {
                        data: JSON.stringify({
                            versions: { 'Cupcake Provider Manager': { version: '2.0.0', file: 'main.js' } },
                            code: { 'main.js': 'some code' },
                        }),
                        status: 200,
                    };
                }
                return { data: null, status: 404 };
            });
            const updater = createAutoUpdater({
                Risu: mockRisu,
                currentVersion: '1.0.0',
                pluginName: 'Cupcake Provider Manager',
                versionsUrl: '', mainUpdateUrl: '', updateBundleUrl: 'https://test/api/update-bundle',
            });
            const result = await updater.downloadMainPluginCode('2.0.0');
            expect(result.ok).toBe(false);
        });
    });

    // ── safeMainPluginUpdate ──
    describe('safeMainPluginUpdate', () => {
        it('returns error when download fails', async () => {
            const updater = makeUpdater();
            const result = await updater.safeMainPluginUpdate('2.0.0', 'changes');
            expect(result.ok).toBe(false);
        });

        it('deduplicates concurrent calls', async () => {
            const updater = makeUpdater();
            const [r1, r2] = await Promise.all([
                updater.safeMainPluginUpdate('2.0.0'),
                updater.safeMainPluginUpdate('2.0.0'),
            ]);
            expect(r1).toBe(r2); // Same promise result
        });
    });

    // ── Constants ──
    describe('exported constants', () => {
        it('exposes tuning constants', () => {
            const updater = makeUpdater();
            expect(updater._constants.VERSION_CHECK_COOLDOWN).toBe(600000);
            expect(updater._constants.MAIN_UPDATE_RETRY_COOLDOWN).toBe(300000);
            expect(updater._constants.MAIN_UPDATE_RETRY_MAX_ATTEMPTS).toBe(2);
        });
    });
});
