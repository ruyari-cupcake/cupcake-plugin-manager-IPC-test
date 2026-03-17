import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock getRisu
let mockRisu;
vi.mock('../src/shared/ipc-protocol.js', () => ({
    getRisu: () => mockRisu,
}));

const { getInstalledPlugins, installCompanionPlugin, downloadAndInstallPlugin } = await import('../src/shared/companion-installer.js');

const VALID_PLUGIN_CODE = `
//@api 3.0
//@name Test Plugin
//@display-name Test Plugin Display
//@version 1.0.0
//@update-url https://example.com/plugin.js
//@arg test_key "Test Key" password
//@arg test_name "Test Name" text

console.log('Hello from test plugin');
`;

describe('companion-installer', () => {
    beforeEach(() => {
        mockRisu = {
            getDatabase: vi.fn(async () => ({
                plugins: [
                    { name: 'Existing Plugin', versionOfPlugin: '1.0.0', enabled: true, updateURL: 'https://example.com/existing.js' },
                    { name: 'Disabled Plugin', versionOfPlugin: '0.5.0', enabled: false },
                ],
            })),
            setDatabase: vi.fn(async () => {}),
            nativeFetch: vi.fn(),
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getInstalledPlugins', () => {
        it('returns formatted plugin list', async () => {
            const plugins = await getInstalledPlugins();
            expect(plugins).toHaveLength(2);
            expect(plugins[0]).toEqual({
                name: 'Existing Plugin',
                versionOfPlugin: '1.0.0',
                enabled: true,
                updateURL: 'https://example.com/existing.js',
            });
            expect(plugins[1]).toEqual({
                name: 'Disabled Plugin',
                versionOfPlugin: '0.5.0',
                enabled: false,
                updateURL: '',
            });
        });

        it('returns empty array when Risu is null', async () => {
            mockRisu = null;
            const plugins = await getInstalledPlugins();
            expect(plugins).toEqual([]);
        });

        it('returns empty array when getDatabase is missing', async () => {
            mockRisu = {};
            const plugins = await getInstalledPlugins();
            expect(plugins).toEqual([]);
        });

        it('returns empty array on error', async () => {
            mockRisu.getDatabase = vi.fn(async () => { throw new Error('DB error'); });
            const plugins = await getInstalledPlugins();
            expect(plugins).toEqual([]);
        });

        it('handles missing plugins array', async () => {
            mockRisu.getDatabase = vi.fn(async () => ({}));
            const plugins = await getInstalledPlugins();
            expect(plugins).toEqual([]);
        });

        it('handles plugin without versionOfPlugin', async () => {
            mockRisu.getDatabase = vi.fn(async () => ({
                plugins: [{ name: 'No Version' }],
            }));
            const plugins = await getInstalledPlugins();
            expect(plugins[0].versionOfPlugin).toBe('0.0.0');
        });
    });

    describe('installCompanionPlugin', () => {
        it('successfully installs a valid plugin', async () => {
            // After install, getDatabase returns the new plugin
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) {
                    return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0', enabled: true }] };
                }
                return { plugins: [] };
            });

            const result = await installCompanionPlugin(VALID_PLUGIN_CODE);
            expect(result.success).toBe(true);
            expect(result.message).toContain('Test Plugin');
            expect(result.message).toContain('1.0.0');
            expect(mockRisu.setDatabase).toHaveBeenCalledOnce();

            const call = mockRisu.setDatabase.mock.calls[0][0];
            expect(call.plugins).toHaveLength(1);
            expect(call.plugins[0].name).toBe('Test Plugin');
            expect(call.plugins[0].version).toBe('3.0');
            expect(call.plugins[0].versionOfPlugin).toBe('1.0.0');
            expect(call.plugins[0].updateURL).toBe('https://example.com/plugin.js');
            expect(call.plugins[0].displayName).toBe('Test Plugin Display');
            expect(call.plugins[0].enabled).toBe(true);
        });

        it('rejects when Risu API unavailable', async () => {
            mockRisu = {};
            const result = await installCompanionPlugin(VALID_PLUGIN_CODE);
            expect(result.success).toBe(false);
            expect(result.message).toContain('unavailable');
        });

        it('rejects code without //@name', async () => {
            const result = await installCompanionPlugin('//@api 3.0\nconsole.log("hi")');
            expect(result.success).toBe(false);
            expect(result.message).toContain('//@name');
        });

        it('rejects non-3.0 API version', async () => {
            const code = '//@name Test\n//@api 2.0\nconsole.log("hi")';
            const result = await installCompanionPlugin(code);
            expect(result.success).toBe(false);
            expect(result.message).toContain('3.0');
        });

        it('rejects code without //@api', async () => {
            const code = '//@name Test\nconsole.log("hi")';
            const result = await installCompanionPlugin(code);
            expect(result.success).toBe(false);
            expect(result.message).toContain('3.0');
        });

        it('rejects already installed same version', async () => {
            mockRisu.getDatabase = vi.fn(async () => ({
                plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0' }],
            }));
            const result = await installCompanionPlugin(VALID_PLUGIN_CODE);
            expect(result.success).toBe(false);
            expect(result.message).toContain('already installed');
        });

        it('allows upgrade to newer version', async () => {
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) {
                    return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0' }] };
                }
                return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '0.9.0' }] };
            });

            const result = await installCompanionPlugin(VALID_PLUGIN_CODE);
            expect(result.success).toBe(true);
        });

        it('reports user decline when plugin not found after install', async () => {
            mockRisu.getDatabase = vi.fn(async () => ({ plugins: [] }));
            const result = await installCompanionPlugin(VALID_PLUGIN_CODE);
            expect(result.success).toBe(false);
            expect(result.message).toContain('declined');
        });

        it('handles setDatabase error', async () => {
            mockRisu.getDatabase = vi.fn(async () => ({ plugins: [] }));
            mockRisu.setDatabase = vi.fn(async () => { throw new Error('Permission denied'); });
            const result = await installCompanionPlugin(VALID_PLUGIN_CODE);
            expect(result.success).toBe(false);
            expect(result.message).toContain('Permission denied');
        });

        it('parses @arg metadata correctly', async () => {
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0' }] };
                return { plugins: [] };
            });

            await installCompanionPlugin(VALID_PLUGIN_CODE);
            const plugin = mockRisu.setDatabase.mock.calls[0][0].plugins[0];
            expect(plugin.argMeta.test_key).toEqual({ label: 'Test Key', type: 'password' });
            expect(plugin.argMeta.test_name).toEqual({ label: 'Test Name', type: 'text' });
        });

        it('handles code without @update-url', async () => {
            const code = '//@api 3.0\n//@name No Update URL\n//@version 1.0.0\nconsole.log("hi")';
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) return { plugins: [{ name: 'No Update URL', versionOfPlugin: '1.0.0' }] };
                return { plugins: [] };
            });

            await installCompanionPlugin(code);
            const plugin = mockRisu.setDatabase.mock.calls[0][0].plugins[0];
            expect(plugin.updateURL).toBe('');
        });

        it('handles code without @version (defaults to 0.0.0)', async () => {
            const code = '//@api 3.0\n//@name No Version\nconsole.log("hi")';
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) return { plugins: [{ name: 'No Version', versionOfPlugin: '0.0.0' }] };
                return { plugins: [] };
            });

            await installCompanionPlugin(code);
            const plugin = mockRisu.setDatabase.mock.calls[0][0].plugins[0];
            expect(plugin.versionOfPlugin).toBe('0.0.0');
        });
    });

    describe('downloadAndInstallPlugin', () => {
        it('downloads and installs via nativeFetch', async () => {
            mockRisu.nativeFetch = vi.fn(async () => ({ ok: true, data: VALID_PLUGIN_CODE }));
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0' }] };
                return { plugins: [] };
            });

            const result = await downloadAndInstallPlugin('https://example.com/plugin.js');
            expect(result.success).toBe(true);
            expect(mockRisu.nativeFetch).toHaveBeenCalledWith('https://example.com/plugin.js', { method: 'GET' });
        });

        it('falls back to fetch when nativeFetch unavailable', async () => {
            mockRisu.nativeFetch = undefined;
            const mockFetch = vi.fn(async () => ({
                ok: true,
                text: async () => VALID_PLUGIN_CODE,
            }));
            globalThis.fetch = mockFetch;

            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0' }] };
                return { plugins: [] };
            });

            const result = await downloadAndInstallPlugin('https://example.com/plugin.js');
            expect(result.success).toBe(true);
        });

        it('handles HTTP error from nativeFetch', async () => {
            mockRisu.nativeFetch = vi.fn(async () => ({ ok: false, status: 404 }));
            const result = await downloadAndInstallPlugin('https://example.com/missing.js');
            expect(result.success).toBe(false);
            expect(result.message).toContain('404');
        });

        it('handles HTTP error from fallback fetch', async () => {
            mockRisu.nativeFetch = undefined;
            globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
            const result = await downloadAndInstallPlugin('https://example.com/error.js');
            expect(result.success).toBe(false);
            expect(result.message).toContain('500');
        });

        it('rejects too-short downloaded code', async () => {
            mockRisu.nativeFetch = vi.fn(async () => ({ ok: true, data: 'short' }));
            const result = await downloadAndInstallPlugin('https://example.com/tiny.js');
            expect(result.success).toBe(false);
            expect(result.message).toContain('too short');
        });

        it('handles network error', async () => {
            mockRisu.nativeFetch = vi.fn(async () => { throw new Error('Network error'); });
            const result = await downloadAndInstallPlugin('https://example.com/fail.js');
            expect(result.success).toBe(false);
            expect(result.message).toContain('Network error');
        });

        it('handles nativeFetch returning text() method', async () => {
            mockRisu.nativeFetch = vi.fn(async () => ({
                ok: true,
                data: null,
                text: async () => VALID_PLUGIN_CODE,
            }));
            let callCount = 0;
            mockRisu.getDatabase = vi.fn(async () => {
                callCount++;
                if (callCount > 1) return { plugins: [{ name: 'Test Plugin', versionOfPlugin: '1.0.0' }] };
                return { plugins: [] };
            });

            const result = await downloadAndInstallPlugin('https://example.com/plugin.js');
            expect(result.success).toBe(true);
        });

        it('handles empty response data', async () => {
            mockRisu.nativeFetch = vi.fn(async () => ({ ok: true, data: '' }));
            const result = await downloadAndInstallPlugin('https://example.com/empty.js');
            expect(result.success).toBe(false);
            expect(result.message).toContain('too short');
        });
    });
});
