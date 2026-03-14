/**
 * @file ipc-protocol.test.js — IPC 프로토콜 정의 테스트
 */
import { describe, it, expect, vi } from 'vitest';
import { MANAGER_NAME, CH, MSG, safeUUID, getRisu, registerWithManager } from '../src/shared/ipc-protocol.js';

describe('Constants', () => {
    it('MANAGER_NAME 정의', () => {
        expect(MANAGER_NAME).toBe('Cupcake Provider Manager');
    });

    it('CH 채널 이름 모두 정의', () => {
        expect(CH.CONTROL).toBe('control');
        expect(CH.RESPONSE).toBe('response');
        expect(CH.FETCH).toBe('fetch');
        expect(CH.ABORT).toBe('abort');
    });

    it('MSG 메시지 타입 모두 정의', () => {
        expect(MSG.REGISTER_PROVIDER).toBeDefined();
        expect(MSG.REGISTER_ACK).toBeDefined();
        expect(MSG.FETCH_REQUEST).toBeDefined();
        expect(MSG.RESPONSE).toBeDefined();
        expect(MSG.ERROR).toBeDefined();
        expect(MSG.ABORT).toBeDefined();
    });
});

describe('safeUUID', () => {
    it('UUID v4 형식 반환', () => {
        const uuid = safeUUID();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('호출마다 고유값', () => {
        const uuids = new Set(Array.from({ length: 100 }, () => safeUUID()));
        expect(uuids.size).toBe(100);
    });

    it('crypto.randomUUID 미지원 시 폴백', () => {
        const origRandomUUID = globalThis.crypto.randomUUID;
        globalThis.crypto.randomUUID = undefined;
        try {
            const uuid = safeUUID();
            // 폴백도 UUID 형식 유지
            expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{3,4}-[0-9a-f]{12}$/);
        } finally {
            globalThis.crypto.randomUUID = origRandomUUID;
        }
    });
});

describe('getRisu', () => {
    it('window.risuai 반환', () => {
        const mock = { test: true };
        globalThis.window = { risuai: mock };
        expect(getRisu()).toBe(mock);
        delete globalThis.window;
    });

    it('window.risuai 없으면 window.Risuai 반환', () => {
        const mock = { fallback: true };
        globalThis.window = { Risuai: mock };
        expect(getRisu()).toBe(mock);
        delete globalThis.window;
    });
});

describe('registerWithManager', () => {
    it('ACK 수신 시 true 반환', async () => {
        const listeners = {};
        const mockRisu = {
            addPluginChannelListener: (ch, cb) => { listeners[ch] = cb; },
            postPluginChannelMessage: (_target, _ch, _msg) => {
                // ACK 즉시 전송 시뮬레이션
                setTimeout(() => {
                    if (listeners[CH.CONTROL]) {
                        listeners[CH.CONTROL]({ type: MSG.REGISTER_ACK });
                    }
                }, 10);
            },
        };

        const result = await registerWithManager(
            mockRisu, 'TestPlugin',
            { name: 'TestPlugin', models: [] },
            { maxRetries: 3, baseDelay: 50 },
        );
        expect(result).toBe(true);
    });

    it('ACK 미수신 시 false 반환 (maxRetries 초과)', async () => {
        const mockRisu = {
            addPluginChannelListener: () => {},
            postPluginChannelMessage: () => {},
        };

        const result = await registerWithManager(
            mockRisu, 'TestPlugin',
            { name: 'TestPlugin', models: [] },
            { maxRetries: 2, baseDelay: 50 },
        );
        expect(result).toBe(false);
    }, 15000);

    it('ACK 외 CONTROL 메시지도 단일 리스너에서 함께 처리 가능', async () => {
        const listeners = {};
        const forwarded = [];
        const mockRisu = {
            addPluginChannelListener: (ch, cb) => { listeners[ch] = cb; },
            postPluginChannelMessage: () => {
                setTimeout(() => {
                    listeners[CH.CONTROL]?.({ type: MSG.DYNAMIC_MODELS_REQUEST, requestId: 'req-1', settings: { key: 'x' } });
                    listeners[CH.CONTROL]?.({ type: MSG.REGISTER_ACK });
                }, 10);
            },
        };

        const result = await registerWithManager(
            mockRisu,
            'TestPlugin',
            { name: 'TestPlugin', models: [] },
            {
                maxRetries: 3,
                baseDelay: 50,
                onControlMessage: (msg) => forwarded.push(msg),
            },
        );

        expect(result).toBe(true);
        expect(forwarded).toEqual([{ type: MSG.DYNAMIC_MODELS_REQUEST, requestId: 'req-1', settings: { key: 'x' } }]);
    });
});
