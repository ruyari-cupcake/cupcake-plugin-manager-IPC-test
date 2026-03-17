/**
 * 공유 테스트 팩토리 — 반복되는 mock 패턴 통합
 *
 * 사용법:
 *   import { createMockRisuIPC, createMockRisuStorage, createSSEMockReader } from './helpers/test-factories.js';
 */
import { vi } from 'vitest';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  IPC 채널 Mock (registerWithManager 등에 사용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function createMockRisuIPC() {
    const listeners = {};
    return {
        addPluginChannelListener: vi.fn((ch, fn) => {
            if (!listeners[ch]) listeners[ch] = [];
            listeners[ch].push(fn);
        }),
        postPluginChannelMessage: vi.fn(),
        /** 테스트 전용 — 채널에 메시지 방출 */
        _emit(ch, msg) {
            (listeners[ch] || []).forEach(fn => fn(msg));
        },
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  pluginStorage Mock (settings-backup, safe-db-writer 등)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function createMockRisuStorage(storedData = null) {
    return {
        pluginStorage: {
            getItem: vi.fn().mockResolvedValue(storedData),
            setItem: vi.fn().mockResolvedValue(undefined),
        },
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  pluginStorage + setDatabaseLite 통합 Mock
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function createMockRisuFull(initialStorage = {}) {
    const storage = { ...initialStorage };
    return {
        pluginStorage: {
            getItem: vi.fn(async (k) => storage[k] || null),
            setItem: vi.fn(async (k, v) => { storage[k] = v; }),
        },
        setDatabaseLite: vi.fn().mockResolvedValue(undefined),
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SSE ReadableStream Mock (sse-parser 테스트용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function createSSEMockReader(sseLines) {
    let idx = 0;
    const encoder = new TextEncoder();
    const reader = {
        read: vi.fn(async () => {
            if (idx < sseLines.length) {
                return { done: false, value: encoder.encode(sseLines[idx++]) };
            }
            return { done: true, value: undefined };
        }),
        cancel: vi.fn(),
    };
    return {
        reader,
        response: { body: { getReader: () => reader } },
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ReadableStream from chunks (collectStream 테스트용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function createChunkedStream(chunks) {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(chunks[i++]);
            } else {
                controller.close();
            }
        },
    });
}
