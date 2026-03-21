/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalWindow;

async function flushMicrotasks(rounds = 5) {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
    }
}

function createFakeElement() {
    return {
        setAttribute: vi.fn(async () => {}),
        setStyle: vi.fn(async () => {}),
        setStyleAttribute: vi.fn(async () => {}),
        setInnerHTML: vi.fn(async () => {}),
        addEventListener: vi.fn(async () => {}),
        appendChild: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
    };
}

function createFakeRootDocument() {
    const body = { appendChild: vi.fn(async () => {}) };
    return {
        addEventListener: vi.fn(async () => {}),
        querySelector: vi.fn(async (selector) => {
            if (selector === 'body') return body;
            return null;
        }),
        createElement: vi.fn(async () => createFakeElement()),
    };
}

async function loadManagerSettings(overrides = {}) {
    const argsStore = new Map(Object.entries({
        cpm_custom_models: '[]',
        cpm_streaming_enabled: 'false',
        cpm_streaming_show_thinking: 'false',
        cpm_streaming_show_token_usage: 'false',
        tools_githubCopilotToken: '',
        cpm_fallback_temp: '',
        cpm_fallback_max_tokens: '',
        cpm_fallback_top_p: '',
        cpm_fallback_freq_pen: '',
        cpm_fallback_pres_pen: '',
        ...overrides.args,
    }));
    const pluginStorageStore = new Map(Object.entries(overrides.pluginStorage || {}));

    const settings = [];
    const providers = [];
    const rootDoc = createFakeRootDocument();

    globalThis.alert = vi.fn();
    globalThis.confirm = vi.fn(() => true);
    globalThis.navigator.clipboard = { writeText: vi.fn(async () => {}) };

    globalThis.window = {
        innerWidth: 1280,
        risuai: {
            nativeFetch: vi.fn(async (url) => {
                throw new Error(`Unexpected nativeFetch: ${url}`);
            }),
            risuFetch: overrides.risuFetch,
            getArgument: vi.fn(async (key) => argsStore.get(key) ?? ''),
            setArgument: vi.fn(async (key, value) => {
                argsStore.set(key, String(value ?? ''));
            }),
            pluginStorage: {
                getItem: vi.fn(async (key) => pluginStorageStore.get(key) ?? null),
                setItem: vi.fn(async (key, value) => {
                    pluginStorageStore.set(String(key), String(value ?? ''));
                }),
                removeItem: vi.fn(async (key) => {
                    pluginStorageStore.delete(String(key));
                }),
                keys: vi.fn(async () => [...pluginStorageStore.keys()]),
            },
            addPluginChannelListener: vi.fn(() => {}),
            postPluginChannelMessage: vi.fn(() => {}),
            addProvider: vi.fn(async (label, handler, meta) => {
                providers.push({ label, handler, meta });
            }),
            registerSetting: vi.fn(async (label, callback, icon, iconType) => {
                settings.push({ label, callback, icon, iconType });
            }),
            getRootDocument: vi.fn(async () => rootDoc),
            showContainer: vi.fn(async () => {}),
            hideContainer: vi.fn(async () => {}),
        },
    };

    await import('../src/manager/index.js');
    await vi.advanceTimersByTimeAsync(1100);
    await flushMicrotasks();

    const mainSetting = settings.find((entry) => entry.label === 'v2.0.1');
    expect(mainSetting).toBeTruthy();

    await mainSetting.callback(overrides.initialTab || 'tab-customs');
    await flushMicrotasks();

    return {
        argsStore,
        pluginStorageStore,
        providers,
        settings,
        rootDoc,
        mainSetting,
    };
}

describe('manager custom model settings parity', () => {
    beforeEach(() => {
        originalWindow = globalThis.window;
        vi.resetModules();
        vi.clearAllMocks();
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
        globalThis.window = originalWindow;
        delete globalThis.alert;
        delete globalThis.confirm;
    });

    it('renders temp_repo advanced custom model fields in the IPC settings UI', async () => {
        await loadManagerSettings();

        expect(document.getElementById('cpm-cm-proxy-url')).not.toBeNull();
        expect(document.getElementById('cpm-cm-proxy-direct')).not.toBeNull();
        expect(document.getElementById('cpm-cm-max-output')).not.toBeNull();
        expect(document.getElementById('cpm-cm-adaptive-thinking')).not.toBeNull();
        expect(document.getElementById('cpm-stream-status')).not.toBeNull();
        expect(document.getElementById('cpm-compat-status')).not.toBeNull();
    });

    it('persists proxyUrl, proxyDirect, maxOutputLimit, and adaptiveThinking when saving a custom model', async () => {
        const env = await loadManagerSettings();

        document.getElementById('cpm-add-custom-btn').click();

        document.getElementById('cpm-cm-name').value = 'Advanced Custom';
        document.getElementById('cpm-cm-model').value = 'gpt-4.1';
        document.getElementById('cpm-cm-url').value = 'https://api.example.com/v1';
        document.getElementById('cpm-cm-key').value = 'sk-live';
        document.getElementById('cpm-cm-proxy-url').value = '  https://proxy.example.com  ';
        document.getElementById('cpm-cm-proxy-direct').checked = true;
        document.getElementById('cpm-cm-max-output').value = '4096';
        document.getElementById('cpm-cm-adaptive-thinking').checked = true;

        document.getElementById('cpm-cm-save').click();

        const saved = JSON.parse(env.argsStore.get('cpm_custom_models'));
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
            name: 'Advanced Custom',
            model: 'gpt-4.1',
            url: 'https://api.example.com/v1',
            key: 'sk-live',
            proxyUrl: 'https://proxy.example.com',
            proxyDirect: true,
            maxOutputLimit: 4096,
            adaptiveThinking: true,
        });
    });

    it('exports normalized custom model definitions without secrets or runtime-only ids', async () => {
        await loadManagerSettings({
            args: {
                cpm_custom_models: JSON.stringify([{
                    uniqueId: 'custom_export_1',
                    name: 'Exportable Model',
                    model: 'claude-3-7-sonnet',
                    url: 'https://api.example.com/messages',
                    key: 'secret-key',
                    proxyUrl: 'https://proxy.example.com',
                    proxyDirect: true,
                    format: 'anthropic',
                    maxOutputLimit: 4096,
                    adaptiveThinking: true,
                    customParams: '{"top_p":0.8}',
                }]),
            },
        });

        const _nativeCreate1 = Document.prototype.createElement;
        let capturedAnchor = null;
        vi.spyOn(document, 'createElement').mockImplementation(function(tagName, options) {
            const element = _nativeCreate1.call(document, tagName, options);
            if (String(tagName).toLowerCase() === 'a') capturedAnchor = element;
            return element;
        });

        document.querySelector('.cpm-cm-export-btn').click();

        expect(capturedAnchor).not.toBeNull();
        const exported = JSON.parse(decodeURIComponent(capturedAnchor.href.split(',')[1]));
        expect(exported).toMatchObject({
            name: 'Exportable Model',
            model: 'claude-3-7-sonnet',
            url: 'https://api.example.com/messages',
            proxyUrl: 'https://proxy.example.com',
            proxyDirect: true,
            format: 'anthropic',
            maxOutputLimit: 4096,
            adaptiveThinking: true,
            customParams: '{"top_p":0.8}',
            _cpmModelExport: true,
        });
        expect(exported.key).toBeUndefined();
        expect(exported.uniqueId).toBeUndefined();
    });

    it('imports custom model JSON through shared normalization rules', async () => {
        const env = await loadManagerSettings();

        let createdInput = null;
        const _nativeCreate = Document.prototype.createElement;
        vi.spyOn(document, 'createElement').mockImplementation(function(tagName, options) {
            const element = _nativeCreate.call(document, tagName, options);
            if (String(tagName).toLowerCase() === 'input') {
                createdInput = element;
                element.click = vi.fn();
            }
            return element;
        });

        document.getElementById('cpm-import-model-btn').click();

        Object.defineProperty(createdInput, 'files', {
            configurable: true,
            value: [{
                text: async () => JSON.stringify({
                    _cpmModelExport: true,
                    name: 'Imported Advanced',
                    model: 'gpt-5.4',
                    url: 'https://api.githubcopilot.com/chat/completions',
                    proxyUrl: '  https://proxy.example.com/worker  ',
                    proxyDirect: 'true',
                    format: 'openai',
                    maxOutputLimit: '16384',
                    adaptiveThinking: 'true',
                    streaming: 'false',
                    thought: 'true',
                    customParams: '{"temperature":0.9}',
                }),
            }],
        });

        await createdInput.onchange({ target: createdInput });

        const saved = JSON.parse(env.argsStore.get('cpm_custom_models'));
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
            name: 'Imported Advanced',
            model: 'gpt-5.4',
            url: 'https://api.githubcopilot.com/chat/completions',
            proxyUrl: 'https://proxy.example.com/worker',
            proxyDirect: true,
            maxOutputLimit: 16384,
            adaptiveThinking: true,
            streaming: false,
            decoupled: true,
            thought: true,
            key: '',
            customParams: '{"temperature":0.9}',
        });
    });

    it('exports settings envelope with pluginStorage snapshot and export version', async () => {
        await loadManagerSettings({
            args: {
                cpm_streaming_enabled: 'true',
                cpm_custom_models: JSON.stringify([{ name: 'Env', model: 'gpt-4.1', proxyDirect: true }]),
            },
            pluginStorage: {
                cpm_last_boot_status: '{"ok":true}',
                cpm_last_main_update_flush: 'flush-123',
                unrelated_key: 'ignore-me',
            },
        });

        const _nativeCreate2 = Document.prototype.createElement;
        let capturedAnchor = null;
        let anchorResolve;
        const anchorReady = new Promise((resolve) => { anchorResolve = resolve; });
        vi.spyOn(document, 'createElement').mockImplementation(function(tagName, options) {
            const element = _nativeCreate2.call(document, tagName, options);
            if (String(tagName).toLowerCase() === 'a') {
                capturedAnchor = element;
                anchorResolve(element);
            }
            return element;
        });

        document.getElementById('cpm-export-btn').click();
        await anchorReady;
        await flushMicrotasks(10);

        expect(capturedAnchor).not.toBeNull();
        const exported = JSON.parse(decodeURIComponent(capturedAnchor.href.split(',')[1]));
        expect(exported._cpmExportVersion).toBe(3);
        expect(exported.metadata).toMatchObject({
            kind: 'settings-export',
            generatedBy: 'manager-ui',
            streamingEnabled: true,
            hasCustomModels: true,
        });
        expect(typeof exported.metadata.generatedAt).toBe('string');
        expect(exported.metadata.exportedPluginStorageKeyCount).toBeGreaterThanOrEqual(2);
        expect(exported.settings.cpm_streaming_enabled).toBe('true');
        expect(JSON.parse(exported.settings.cpm_custom_models)[0].proxyDirect).toBe(true);
        expect(JSON.parse(exported.pluginStorage.cpm_last_boot_status).settingsOk).toBe(true);
        expect(exported.pluginStorage.cpm_last_main_update_flush).toBe('flush-123');
        expect(exported.pluginStorage.unrelated_key).toBeUndefined();
    });

    it('imports settings envelope and restores pluginStorage snapshot', async () => {
        const env = await loadManagerSettings({
            pluginStorage: {
                cpm_last_boot_status: 'old-status',
                cpm_pending_main_update: 'old-update',
            },
        });

        let createdInput = null;
        const _nativeCreate3 = Document.prototype.createElement;
        vi.spyOn(document, 'createElement').mockImplementation(function(tagName, options) {
            const element = _nativeCreate3.call(document, tagName, options);
            if (String(tagName).toLowerCase() === 'input') {
                createdInput = element;
                element.click = vi.fn();
            }
            return element;
        });

        document.getElementById('cpm-import-btn').click();

        Object.defineProperty(createdInput, 'files', {
            configurable: true,
            value: [{
                text: undefined,
            }],
        });

        const filePayload = JSON.stringify({
            _cpmExportVersion: 2,
            settings: {
                cpm_streaming_enabled: 'true',
                cpm_custom_models: [{
                    name: 'Imported Envelope Model',
                    model: 'gpt-5.4',
                    url: 'https://api.example.com/v1',
                    proxyUrl: ' https://proxy.example.com/direct ',
                    proxyDirect: true,
                }],
            },
            pluginStorage: {
                cpm_last_boot_status: '{"ok":false}',
                cpm_last_main_update_flush: 'flush-ts',
            },
        });

        const originalFileReader = globalThis.FileReader;
        let readResolve;
        const readDone = new Promise((resolve) => { readResolve = resolve; });
        class MockFileReader {
            readAsText() {
                this.onload?.({ target: { result: filePayload } });
                readResolve();
            }
        }
        globalThis.FileReader = MockFileReader;

        await createdInput.onchange({ target: createdInput });
        await readDone;
        await flushMicrotasks(20);
        globalThis.FileReader = originalFileReader;

        const savedModels = JSON.parse(env.argsStore.get('cpm_custom_models'));
        expect(env.argsStore.get('cpm_streaming_enabled')).toBe('true');
        expect(savedModels[0]).toMatchObject({
            name: 'Imported Envelope Model',
            proxyUrl: 'https://proxy.example.com/direct',
            proxyDirect: true,
        });
        expect(env.pluginStorageStore.get('cpm_last_boot_status')).toBe('{"ok":false}');
        expect(env.pluginStorageStore.get('cpm_last_main_update_flush')).toBe('flush-ts');
        expect(env.pluginStorageStore.get('cpm_pending_main_update')).toBeUndefined();
    });

    it('renders expanded diagnostics sections with bridge, storage, boot, and slot data', async () => {
        await loadManagerSettings({
            initialTab: 'tab-diagnostics',
            args: {
                cpm_streaming_enabled: 'true',
                cpm_compatibility_mode: 'true',
                cpm_copilot_nodeless_mode: 'fallback',
                cpm_slot_translation: 'openai-gpt-4.1',
            },
            pluginStorage: {
                cpm_last_boot_status: JSON.stringify({
                    version: '2.0.0',
                    settingsOk: true,
                    models: 12,
                    ok: ['settings', 'providers'],
                    fail: [],
                }),
                cpm_last_main_update_flush: 'flush-123',
            },
            risuFetch: vi.fn(async () => ({ ok: true })),
        });

        document.querySelector('[data-target="tab-diagnostics"]').click();
        await vi.advanceTimersByTimeAsync(80);
        await flushMicrotasks(20);

        expect(document.getElementById('cpm-diag-overview').textContent).toContain('진단 포맷');
        expect(document.getElementById('cpm-diag-overview').textContent).toContain('언어/시간대');
        expect(document.getElementById('cpm-diag-bridge').textContent).toContain('ReadableStream 브릿지');
        expect(document.getElementById('cpm-diag-storage').textContent).toContain('pluginStorage 키');
        expect(document.getElementById('cpm-diag-boot').textContent).toContain('설정 등록');
        expect(document.getElementById('cpm-diag-slots').textContent).toContain('translation');
    });

    it('purges managed CPM settings and pluginStorage from the operations tab', async () => {
        const env = await loadManagerSettings({
            initialTab: 'tab-operations',
            args: {
                cpm_streaming_enabled: 'true',
                cpm_custom_models: JSON.stringify([{ name: 'To Purge', model: 'gpt-4.1', url: 'https://api.example.com/v1' }]),
                cpm_c1_name: 'legacy-model',
            },
            pluginStorage: {
                cpm_last_boot_status: JSON.stringify({ settingsOk: true }),
                cpm_last_main_update_flush: 'flush-123',
            },
        });

        document.querySelector('[data-target="tab-operations"]').click();
        await vi.advanceTimersByTimeAsync(80);
        await flushMicrotasks(20);

        document.getElementById('cpm-ops-purge-btn').click();
        await flushMicrotasks(30);

        expect(globalThis.confirm).toHaveBeenCalledTimes(2);
        expect(env.argsStore.get('cpm_streaming_enabled')).toBe('');
        expect(env.argsStore.get('cpm_custom_models')).toBe('');
        expect(env.argsStore.get('cpm_c1_name')).toBe('');
        expect(env.pluginStorageStore.get('cpm_last_boot_status')).toBeUndefined();
        expect(env.pluginStorageStore.get('cpm_last_main_update_flush')).toBeUndefined();
        expect(document.getElementById('cpm-ops-summary').textContent).toContain('pluginStorage 키');
        expect(document.getElementById('cpm-ops-summary').textContent).toContain('권장 순서');
    });
});
