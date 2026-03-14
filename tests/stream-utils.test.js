/**
 * @file stream-utils.test.js — collectStream 유틸 테스트 (H-13)
 */
import { describe, it, expect } from 'vitest';
import { collectStream } from '../src/shared/helpers.js';

describe('collectStream', () => {
    it('string chunks 수집', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('Hello ');
                controller.enqueue('World');
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('Hello World');
    });

    it('Uint8Array chunks 디코딩', async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('Hello '));
                controller.enqueue(encoder.encode('Binary'));
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('Hello Binary');
    });

    it('혼합 string + Uint8Array chunks', async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('String ');
                controller.enqueue(encoder.encode('Binary'));
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('String Binary');
    });

    it('null chunk 무시', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('data');
                controller.enqueue(null);
                controller.enqueue(' more');
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('data more');
    });

    it('빈 스트림 → 빈 문자열', async () => {
        const stream = new ReadableStream({
            start(controller) { controller.close(); }
        });
        const result = await collectStream(stream);
        expect(result).toBe('');
    });

    it('abortSignal 중단', async () => {
        const ac = new AbortController();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue('part1');
                // Don't close - will be cancelled
            }
        });
        // Abort immediately
        ac.abort();
        const result = await collectStream(stream, ac.signal);
        // Should return whatever was collected before abort
        expect(typeof result).toBe('string');
    });

    it('ArrayBuffer chunk 디코딩', async () => {
        const encoder = new TextEncoder();
        const buf = encoder.encode('ArrayBufferData').buffer;
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(buf);
                controller.close();
            }
        });
        const result = await collectStream(stream);
        expect(result).toBe('ArrayBufferData');
    });
});
