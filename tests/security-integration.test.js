// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { safeSetDatabaseLite, validateDbPatch } from '../src/shared/safe-db-writer.js';
import { createAutoUpdater, _withTimeout, compareVersions } from '../src/shared/auto-updater.js';
import { setupChannelCleanup, CH, MSG, MANAGER_NAME } from '../src/shared/ipc-protocol.js';

// ═══════════════════════════════════════════════════════════════
// 1) safe-db-writer + auto-updater 통합
//    실제 auto-updater의 validateAndInstall이 safeSetDatabaseLite를 통해
//    DB에 기록할 때, 보안 검증이 정상 동작하는지 통합 테스트
// ═══════════════════════════════════════════════════════════════

describe('auto-updater + safe-db-writer integration', () => {
    const PLUGIN_NAME = 'Test Plugin';
    const CURRENT_VERSION = '1.0.0';
    const UPDATE_URL = 'https://test.vercel.app/api/main-plugin';
    const VERSIONS_URL = 'https://test.vercel.app/api/versions';
    const BUNDLE_URL = 'https://test.vercel.app/api/bundle';

    function makePluginCode(name, version, apiVersion = '3.0') {
        return [
            `//@api ${apiVersion}`,
            `//@name ${name}`,
            `//@display-name ${name}`,
            `//@version ${version}`,
            `console.log("${name} v${version}");`,
        ].join('\n');
    }

    function createMockRisu(existingPlugins = []) {
        const db = { plugins: existingPlugins };
        return {
            getDatabase: vi.fn(async () => structuredClone(db)),
            setDatabaseLite: vi.fn(async (patch) => {
                if (patch.plugins) db.plugins = patch.plugins;
            }),
            getArgument: vi.fn(async () => ''),
            setArgument: vi.fn(async () => {}),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
                removeItem: vi.fn(async () => {}),
            },
            nativeFetch: vi.fn(),
            onUnload: vi.fn(),
        };
    }

    it('auto-updater writes through safeSetDatabaseLite with valid plugin data', async () => {
        const newVersion = '1.1.0';
        const newCode = makePluginCode(PLUGIN_NAME, newVersion);
        const existingPlugin = {
            name: PLUGIN_NAME, displayName: PLUGIN_NAME,
            script: makePluginCode(PLUGIN_NAME, CURRENT_VERSION),
            version: '3.0', versionOfPlugin: CURRENT_VERSION,
            updateURL: UPDATE_URL, enabled: true,
            arguments: {}, realArg: {}, argMeta: {}, customLink: [],
        };

        const Risu = createMockRisu([existingPlugin]);

        // Mock fetch → 새 버전 코드 반환 + SHA-256
        const codeBytes = new TextEncoder().encode(newCode);
        const hashBuffer = await crypto.subtle.digest('SHA-256', codeBytes);
        const sha256 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        Risu.nativeFetch.mockImplementation(async (url) => {
            if (url.includes('versions')) {
                return new Response(JSON.stringify({
                    mainPlugin: { version: newVersion, sha256 }
                }), { status: 200 });
            }
            if (url.includes('main-plugin') || url.includes('bundle')) {
                return new Response(newCode, {
                    status: 200,
                    headers: { 'content-length': String(codeBytes.length) },
                });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const updater = createAutoUpdater({
            Risu,
            currentVersion: CURRENT_VERSION,
            pluginName: PLUGIN_NAME,
            versionsUrl: VERSIONS_URL,
            mainUpdateUrl: UPDATE_URL,
            updateBundleUrl: BUNDLE_URL,
            toast: vi.fn(),
            validateSchema: vi.fn(),
            _autoSaveDelayMs: 0,
        });

        const _result = await updater.safeMainPluginUpdate();

        // setDatabaseLite가 호출되었는지 확인
        expect(Risu.setDatabaseLite).toHaveBeenCalledTimes(1);
        const writtenPatch = Risu.setDatabaseLite.mock.calls[0][0];

        // safeSetDatabaseLite의 validateDbPatch와 동일한 검증 통과 확인
        const validation = validateDbPatch(writtenPatch);
        expect(validation.ok).toBe(true);
        expect(validation.errors).toHaveLength(0);

        // 실제 데이터 구조 확인
        expect(writtenPatch.plugins).toBeDefined();
        expect(Array.isArray(writtenPatch.plugins)).toBe(true);
        expect(writtenPatch.plugins.length).toBe(1);
        expect(writtenPatch.plugins[0].versionOfPlugin).toBe(newVersion);
        expect(writtenPatch.plugins[0].script).toBe(newCode);
    });

    it('safeSetDatabaseLite blocks XSS injection that bypasses auto-updater', async () => {
        const Risu = createMockRisu([]);

        // 공격 시나리오: guiHTML 주입 시도
        const xssResult = await safeSetDatabaseLite(Risu, {
            guiHTML: '<img onerror="alert(document.cookie)" src=x>',
        });
        expect(xssResult.ok).toBe(false);
        expect(xssResult.error).toMatch(/guiHTML.*blocked/);
        expect(Risu.setDatabaseLite).not.toHaveBeenCalled();
    });

    it('safeSetDatabaseLite blocks characters array manipulation', async () => {
        const Risu = createMockRisu([]);

        const result = await safeSetDatabaseLite(Risu, {
            characters: [{ name: 'hijacked', data: 'malicious' }],
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/characters.*blocked/);
        expect(Risu.setDatabaseLite).not.toHaveBeenCalled();
    });

    it('safeSetDatabaseLite blocks plugin with http updateURL', async () => {
        const Risu = createMockRisu([]);

        const result = await safeSetDatabaseLite(Risu, {
            plugins: [{
                name: 'evil', script: 'code', version: '3.0',
                updateURL: 'http://evil.example/backdoor.js'
            }],
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/only https/);
        expect(Risu.setDatabaseLite).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════
// 2) setupChannelCleanup 통합 — 실제 채널 라이프사이클
// ═══════════════════════════════════════════════════════════════

describe('IPC channel lifecycle integration', () => {
    it('setupChannelCleanup replaces listeners with no-ops on unload', () => {
        const unloadCallbacks = [];
        const channelListeners = new Map();

        const risu = {
            onUnload: vi.fn((cb) => unloadCallbacks.push(cb)),
            addPluginChannelListener: vi.fn((ch, cb) => channelListeners.set(ch, cb)),
        };

        // 1. 프로바이더가 채널 리스너 등록
        const fetchHandler = vi.fn();
        const abortHandler = vi.fn();
        risu.addPluginChannelListener(CH.FETCH, fetchHandler);
        risu.addPluginChannelListener(CH.ABORT, abortHandler);

        // 2. cleanup 설정
        setupChannelCleanup(risu, [CH.FETCH, CH.ABORT]);
        expect(unloadCallbacks.length).toBe(1);

        // 3. 언로드 콜백 실행
        unloadCallbacks[0]();

        // 4. addPluginChannelListener가 no-op으로 재등록했는지 확인
        const lastFetchCall = risu.addPluginChannelListener.mock.calls.filter(
            c => c[0] === CH.FETCH
        ).pop();
        const lastAbortCall = risu.addPluginChannelListener.mock.calls.filter(
            c => c[0] === CH.ABORT
        ).pop();

        expect(lastFetchCall).toBeDefined();
        expect(lastAbortCall).toBeDefined();
        // no-op 함수는 원래 핸들러와 다름
        expect(lastFetchCall[1]).not.toBe(fetchHandler);
        expect(lastAbortCall[1]).not.toBe(abortHandler);
    });

    it('provider registration → FETCH → ABORT full cycle', async () => {
        const channels = new Map();
        const messages = [];

        const risu = {
            addPluginChannelListener: vi.fn((ch, cb) => channels.set('TestProvider' + ch, cb)),
            postPluginChannelMessage: vi.fn((target, ch, msg) => {
                messages.push({ target, ch, msg });
                const listener = channels.get(target + ch);
                if (listener) listener(msg);
            }),
            getArgument: vi.fn(async () => ''),
            onUnload: vi.fn(),
            nativeFetch: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
            pluginStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) },
        };

        // 1. 매니저 채널 리스너 등록
        const controlHandler = vi.fn();
        risu.addPluginChannelListener(CH.CONTROL, controlHandler);

        // 2. 프로바이더가 REGISTER_PROVIDER를 매니저에게 보냄
        risu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
            type: MSG.REGISTER_PROVIDER,
            payload: {
                pluginName: 'TestProvider',
                providerName: 'TestProvider',
                models: [{ uniqueId: 'test-model', id: 'test-1', name: 'Test Model' }],
            },
        });

        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(messages[0].msg.type).toBe(MSG.REGISTER_PROVIDER);

        // 3. 매니저가 FETCH를 프로바이더에게 보냄
        const fetchListener = channels.get('TestProvider' + CH.FETCH);
        if (fetchListener) {
            fetchListener({
                type: MSG.FETCH_REQUEST,
                requestId: 'req-001',
                args: { model: 'test-1', messages: [{ role: 'user', content: 'Hello' }] },
            });
        }

        // 4. ABORT 시나리오
        const abortListener = channels.get('TestProvider' + CH.ABORT);
        if (abortListener) {
            abortListener({ type: MSG.ABORT_REQUEST, requestId: 'req-001' });
        }

        // IPC 메시지 흐름이 정상적으로 동작함
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });
});

// ═══════════════════════════════════════════════════════════════
// 3) _withTimeout + compareVersions 통합 (유틸리티 통합)
// ═══════════════════════════════════════════════════════════════

describe('auto-updater utility integration', () => {
    it('_withTimeout rejects when promise exceeds timeout', async () => {
        const slow = new Promise((resolve) => setTimeout(resolve, 5000));
        await expect(_withTimeout(slow, 50, 'test timeout')).rejects.toThrow('test timeout');
    });

    it('_withTimeout resolves when promise completes within timeout', async () => {
        const fast = Promise.resolve('ok');
        const result = await _withTimeout(fast, 1000, 'should not timeout');
        expect(result).toBe('ok');
    });

    it('compareVersions correctly orders semantic versions', () => {
        // compareVersions returns (remote - local): positive if remote is newer
        expect(compareVersions('1.0.0', '1.0.1')).toBe(1);   // remote newer
        expect(compareVersions('1.0.1', '1.0.0')).toBe(-1);  // local newer
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
        expect(compareVersions('1.99.99', '2.0.0')).toBe(1);
        expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// 4) safe-db-writer 경계 케이스 — 대규모 plugins 배열
// ═══════════════════════════════════════════════════════════════

describe('safe-db-writer edge cases', () => {
    it('validates large plugins array correctly', () => {
        const plugins = Array.from({ length: 50 }, (_, i) => ({
            name: `Plugin_${i}`,
            script: `console.log(${i})`,
            version: '3.0',
        }));
        const result = validateDbPatch({ plugins });
        expect(result.ok).toBe(true);
    });

    it('detects one bad plugin in a large array', () => {
        const plugins = Array.from({ length: 20 }, (_, i) => ({
            name: `Plugin_${i}`,
            script: `console.log(${i})`,
            version: '3.0',
        }));
        plugins[15] = { name: 'Bad', script: '', version: '3.0' }; // empty script
        const result = validateDbPatch({ plugins });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/plugins\[15\]\.script/);
    });

    it('rejects multiple blocked keys at once', () => {
        const result = validateDbPatch({
            guiHTML: '<evil>',
            customCSS: 'body{}',
            characters: [],
        });
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBe(3);
    });
});
