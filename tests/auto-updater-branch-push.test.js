/**
 * auto-updater-branch-push.test.js
 *
 * Targeted branch coverage for auto-updater.js (81.53% → target 87%+)
 * Focuses on: pending marker edge cases, clearPendingUpdate fallback,
 * validateAndInstall size check & TOCTOU, safeMainPluginUpdate error classification,
 * checkVersionsQuiet manifest parse
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAutoUpdater, computeSHA256 } from '../src/shared/auto-updater.js';

describe('auto-updater branch coverage push', () => {
    /** @type {Record<string, any>} */
    let storageData;
    let mockRisu;
    let SHA_HELLO;

    beforeEach(async () => {
        storageData = {};
        SHA_HELLO = await computeSHA256('hello');
        mockRisu = createMockRisu();
    });

    function createMockRisu(overrides = {}) {
        return {
            pluginStorage: {
                getItem: vi.fn(async (key) => storageData[key] ?? null),
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
            ...overrides,
        };
    }

    function makeUpdater(overrides = {}) {
        return createAutoUpdater({
            Risu: mockRisu,
            currentVersion: '1.19.0',
            pluginName: 'Cupcake Provider Manager',
            versionsUrl: 'https://test.vercel.app/api/versions',
            mainUpdateUrl: 'https://test.vercel.app/api/main-plugin',
            updateBundleUrl: 'https://test.vercel.app/api/update-bundle',
            _autoSaveDelayMs: 0,
            ...overrides,
        });
    }

    describe('readPendingUpdate edge cases', () => {
        it('returns null when parsed data is a string (typeof !== object)', async () => {
            storageData.cpm_pending_main_update = '"just a string"';
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('returns null for parsed array', async () => {
            storageData.cpm_pending_main_update = '[1, 2, 3]';
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            // Array is typeof 'object' but has no .version → cleared
            expect(result).toBeNull();
        });

        it('returns null for parsed object with empty version', async () => {
            storageData.cpm_pending_main_update = JSON.stringify({ version: '' });
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('returns null for parsed number', async () => {
            storageData.cpm_pending_main_update = '42';
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('handles corrupt JSON gracefully (catch branch)', async () => {
            storageData.cpm_pending_main_update = '{broken';
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result).toBeNull();
        });

        it('returns full marker when valid', async () => {
            storageData.cpm_pending_main_update = JSON.stringify({
                version: '2.0.0',
                changes: 'test',
                createdAt: 1000,
                attempts: 1,
                lastAttemptTs: 500,
                lastError: 'prev error',
            });
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result.version).toBe('2.0.0');
            expect(result.changes).toBe('test');
            expect(result.attempts).toBe(1);
        });

        it('defaults optional fields when missing', async () => {
            storageData.cpm_pending_main_update = JSON.stringify({ version: '2.0.0' });
            const updater = makeUpdater();
            const result = await updater.readPendingUpdate();
            expect(result.changes).toBe('');
            expect(result.attempts).toBe(0);
            expect(result.lastAttemptTs).toBe(0);
            expect(result.lastError).toBe('');
        });
    });

    describe('writePendingUpdate error handling', () => {
        it('does not throw when setItem fails', async () => {
            mockRisu.pluginStorage.setItem.mockRejectedValueOnce(new Error('write fail'));
            const updater = makeUpdater();
            // writePendingUpdate catches errors internally
            await expect(updater.writePendingUpdate({ version: '2.0.0' })).resolves.not.toThrow();
        });
    });

    describe('clearPendingUpdate fallback', () => {
        it('uses setItem("") when removeItem is not available', async () => {
            delete mockRisu.pluginStorage.removeItem;
            const updater = makeUpdater();
            storageData.cpm_pending_main_update = JSON.stringify({ version: '2.0.0' });
            await updater.clearPendingUpdate();
            expect(mockRisu.pluginStorage.setItem).toHaveBeenCalledWith(
                'cpm_pending_main_update',
                '',
            );
        });
    });

    describe('getInstalledVersion edge cases', () => {
        it('falls back to currentVersion when plugin not found in DB', async () => {
            mockRisu.getDatabase.mockResolvedValueOnce({ plugins: [] });
            const updater = makeUpdater();
            const version = await updater.getInstalledVersion();
            expect(version).toBe('1.19.0'); // falls back to currentVersion
        });

        it('falls back to currentVersion when DB has no plugins array', async () => {
            mockRisu.getDatabase.mockResolvedValueOnce({});
            const updater = makeUpdater();
            const version = await updater.getInstalledVersion();
            expect(version).toBe('1.19.0'); // falls back via optional chaining
        });

        it('catches getDatabase error and returns currentVersion', async () => {
            mockRisu.getDatabase.mockRejectedValueOnce(new Error('DB fail'));
            const updater = makeUpdater();
            const version = await updater.getInstalledVersion();
            expect(version).toBe('1.19.0');
        });
    });

    describe('downloadMainPluginCode — schema validation', () => {
        it('rejects when validateSchema returns invalid', async () => {
            const bundleData = {
                versions: { 'Cupcake Provider Manager': { version: '2.0.0', file: 'test.js', sha256: 'abc' } },
                code: { 'test.js': 'console.log("ok")' },
            };
            mockRisu.risuFetch.mockImplementationOnce(async () => ({
                data: JSON.stringify(bundleData),
                status: 200,
            }));
            const updater = makeUpdater({
                validateSchema: () => ({ valid: false }),
            });
            const result = await updater.downloadMainPluginCode('2.0.0');
            expect(result.ok).toBe(false);
            // Schema invalid → falls through to direct download path which also fails
        });

        it('rejects when bundle has no version for plugin', async () => {
            const bundleData = {
                versions: { 'Other Plugin': { version: '1.0.0', file: 'other.js', sha256: 'abc' } },
                code: {},
            };
            mockRisu.risuFetch.mockImplementationOnce(async () => ({
                data: JSON.stringify(bundleData),
                status: 200,
            }));
            const updater = makeUpdater();
            const result = await updater.downloadMainPluginCode('2.0.0');
            expect(result.ok).toBe(false);
        });
    });

    describe('validateAndInstall — size & TOCTOU checks', () => {
        function makeValidCode(version = '2.0.0') {
            return [
                '//@name Cupcake Provider Manager',
                `//@version ${version}`,
                '//@api 3.0',
                '//@arg key1 string',
                '//@arg key2 int',
                '',
                'x'.repeat(1000),
            ].join('\n');
        }

        it('rejects when new code is suspiciously small (< 95% of existing)', async () => {
            // Existing script is 500KB, new code is ~1KB → way under 95%
            const code = makeValidCode();
            const updater = makeUpdater();
            const result = await updater.validateAndInstall(code, '2.0.0', 'test changes');
            // With 500KB existing and ~1KB new, size check should reject
            expect(result.ok).toBe(false);
            expect(result.error).toContain('불완전');
        });

        it('TOCTOU: rejects when freshPlugin disappeared between reads', async () => {
            // First getDatabase returns plugin, second returns empty
            let callCount = 0;
            mockRisu.getDatabase.mockImplementation(async () => {
                callCount++;
                if (callCount <= 1) {
                    return {
                        plugins: [{
                            name: 'Cupcake_Provider_Manager',
                            versionOfPlugin: '1.19.0',
                            script: 'y'.repeat(300),
                            arguments: { key1: 'string' },
                            realArg: { key1: 'val1' },
                        }],
                    };
                }
                // Second call — plugin gone
                return { plugins: [] };
            });
            const code = makeValidCode();
            const updater = makeUpdater();
            const result = await updater.validateAndInstall(code, '2.0.0', 'changes');
            expect(result.ok).toBe(false);
        });
    });

    describe('safeMainPluginUpdate — error classification', () => {
        it('stops retrying on non-retriable download error', async () => {
            // All fetch attempts fail → download fails
            const updater = makeUpdater();
            const result = await updater.safeMainPluginUpdate('2.0.0', 'changes');
            expect(result.ok).toBe(false);
        });

        it('same-version noop — validateAndInstall returns same version error', async () => {
            const bundleCode = [
                '//@name Cupcake Provider Manager',
                '//@version 1.19.0',
                '//@api 3.0',
                '',
                'x'.repeat(500 * 1024),
            ].join('\n');
            const sha = await computeSHA256(bundleCode);
            const bundleData = {
                versions: { 'Cupcake Provider Manager': { version: '1.19.0', file: 'provider.js', sha256: sha } },
                code: { 'provider.js': bundleCode },
            };
            mockRisu.risuFetch.mockImplementationOnce(async () => ({
                data: JSON.stringify(bundleData),
                status: 200,
            }));
            const updater = makeUpdater();
            const result = await updater.safeMainPluginUpdate('1.19.0', '');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('같은 버전');
        });
    });

    describe('checkVersionsQuiet — manifest edge cases', () => {
        it('handles manifest that is not an object', async () => {
            mockRisu.risuFetch.mockResolvedValueOnce({
                data: '"not-an-object"',
                status: 200,
            });
            const updater = makeUpdater();
            // checkVersionsQuiet should not throw
            await expect(updater.checkVersionsQuiet()).resolves.not.toThrow();
        });

        it('handles manifest fetch failure', async () => {
            mockRisu.risuFetch.mockResolvedValueOnce({
                data: null,
                status: 500,
            });
            const updater = makeUpdater();
            await expect(updater.checkVersionsQuiet()).resolves.not.toThrow();
        });
    });
});
