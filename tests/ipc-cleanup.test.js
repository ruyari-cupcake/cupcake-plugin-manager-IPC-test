import { describe, it, expect, vi } from 'vitest';
import { setupChannelCleanup, CH, MSG, safeUUID, getRisu, MANAGER_NAME } from '../src/shared/ipc-protocol.js';

describe('setupChannelCleanup', () => {
    it('registers onUnload callback that replaces channel listeners with no-ops', () => {
        let unloadCb;
        const mockRisu = {
            onUnload: vi.fn((cb) => { unloadCb = cb; }),
            addPluginChannelListener: vi.fn(),
        };
        setupChannelCleanup(mockRisu, [CH.CONTROL, CH.FETCH, CH.RESPONSE]);
        expect(mockRisu.onUnload).toHaveBeenCalledOnce();

        // Trigger unload
        unloadCb();
        expect(mockRisu.addPluginChannelListener).toHaveBeenCalledTimes(3);
        expect(mockRisu.addPluginChannelListener).toHaveBeenCalledWith(CH.CONTROL, expect.any(Function));
        expect(mockRisu.addPluginChannelListener).toHaveBeenCalledWith(CH.FETCH, expect.any(Function));
        expect(mockRisu.addPluginChannelListener).toHaveBeenCalledWith(CH.RESPONSE, expect.any(Function));

        // Verify the replacement callbacks are no-ops (don't throw)
        const replacementCb = mockRisu.addPluginChannelListener.mock.calls[0][1];
        expect(() => replacementCb({ type: 'test' })).not.toThrow();
    });

    it('does nothing when Risu has no onUnload', () => {
        const mockRisu = {
            addPluginChannelListener: vi.fn(),
        };
        // Should not throw
        setupChannelCleanup(mockRisu, [CH.CONTROL]);
        expect(mockRisu.addPluginChannelListener).not.toHaveBeenCalled();
    });

    it('handles empty channel list', () => {
        let unloadCb;
        const mockRisu = {
            onUnload: vi.fn((cb) => { unloadCb = cb; }),
            addPluginChannelListener: vi.fn(),
        };
        setupChannelCleanup(mockRisu, []);
        unloadCb();
        expect(mockRisu.addPluginChannelListener).not.toHaveBeenCalled();
    });
});

describe('ipc-protocol constants', () => {
    it('MANAGER_NAME is the correct string', () => {
        expect(MANAGER_NAME).toBe('Cupcake Provider Manager');
    });

    it('CH has all required channels', () => {
        expect(CH.CONTROL).toBe('control');
        expect(CH.RESPONSE).toBe('response');
        expect(CH.FETCH).toBe('fetch');
        expect(CH.ABORT).toBe('abort');
    });

    it('MSG has all message types', () => {
        expect(MSG.REGISTER_PROVIDER).toBe('register-provider');
        expect(MSG.REGISTER_ACK).toBe('register-ack');
        expect(MSG.DYNAMIC_MODELS_REQUEST).toBe('dynamic-models-request');
        expect(MSG.DYNAMIC_MODELS_RESULT).toBe('dynamic-models-result');
        expect(MSG.FETCH_REQUEST).toBe('fetch-request');
        expect(MSG.RESPONSE).toBe('response');
        expect(MSG.ERROR).toBe('error');
        expect(MSG.STREAM_CHUNK).toBe('stream-chunk');
        expect(MSG.STREAM_END).toBe('stream-end');
        expect(MSG.ABORT).toBe('abort');
    });
});

describe('safeUUID', () => {
    it('returns a string matching UUID v4 format', () => {
        const uuid = safeUUID();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('returns unique values', () => {
        const set = new Set();
        for (let i = 0; i < 100; i++) set.add(safeUUID());
        expect(set.size).toBe(100);
    });

    it('uses fallback when crypto.randomUUID throws', () => {
        const original = crypto.randomUUID;
        crypto.randomUUID = undefined;
        try {
            const uuid = safeUUID();
            expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        } finally {
            crypto.randomUUID = original;
        }
    });
});
