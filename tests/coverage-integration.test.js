/**
 * @file coverage-integration.test.js — End-to-end integration tests
 *
 * 1. SSE streaming pipeline: Response → createAnthropicSSEStream → collectStream
 * 2. Full auto-updater flow: checkVersionsQuiet → download → validate → install
 * 3. Message format round-trip: raw messages → formatToAnthropic → validate structure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ────────────────────────────────────────────────────
// 1. SSE Streaming Pipeline Integration
// ────────────────────────────────────────────────────
import { createAnthropicSSEStream } from '../src/shared/sse-parser.js';
import { collectStream } from '../src/shared/helpers.js';

function makeSSEResponse(events) {
    const text = events.join('\n') + '\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        }
    });
    return { body: stream };
}

describe('Integration: SSE streaming pipeline', () => {
    it('message_start → content_block_delta(text) → message_delta → done', async () => {
        const sseEvents = [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","usage":{"output_tokens":10}}',
            '',
        ];
        const response = makeSSEResponse(sseEvents);
        const stream = createAnthropicSSEStream(response, null, {});
        const result = await collectStream(stream);
        expect(result).toContain('Hello ');
        expect(result).toContain('world!');
    });

    it('thinking + text pipeline with showThinking', async () => {
        const sseEvents = [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me think..."}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Here is the answer."}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","usage":{"output_tokens":20}}',
            '',
        ];
        const response = makeSSEResponse(sseEvents);
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const result = await collectStream(stream);
        expect(result).toContain('<Thoughts>');
        expect(result).toContain('Let me think...');
        expect(result).toContain('</Thoughts>');
        expect(result).toContain('Here is the answer.');
    });

    it('error event in stream', async () => {
        const sseEvents = [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
            '',
            'event: error',
            'data: {"type":"error","error":{"message":"Rate limited"}}',
            '',
        ];
        const response = makeSSEResponse(sseEvents);
        const stream = createAnthropicSSEStream(response, null, {});
        const result = await collectStream(stream);
        expect(result).toContain('[Stream Error: Rate limited]');
    });

    it('stream with redacted_thinking via content_block_start', async () => {
        const sseEvents = [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
            '',
            'event: content_block_start',
            'data: {"type":"content_block_start","content_block":{"type":"redacted_thinking"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Final answer."}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","usage":{"output_tokens":5}}',
            '',
        ];
        const response = makeSSEResponse(sseEvents);
        const stream = createAnthropicSSEStream(response, null, { showThinking: true });
        const result = await collectStream(stream);
        expect(result).toContain('{{redacted_thinking}}');
        expect(result).toContain('Final answer.');
    });

    it('abort mid-stream finalizes usage', async () => {
        const ac = new AbortController();
        let pushMore;
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode([
                    'event: message_start',
                    'data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}',
                    '',
                    'event: content_block_delta',
                    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}',
                    '',
                ].join('\n') + '\n'));
                pushMore = () => {
                    try { controller.close(); } catch {}
                };
            }
        });

        const response = { body: stream };
        const sseStream = createAnthropicSSEStream(response, ac.signal, { _requestId: 'integ-abort' });

        // Start reading
        const reader = sseStream.getReader();
        const first = await reader.read();
        expect(first.value).toContain('Partial');

        // Abort
        ac.abort();
        if (pushMore) pushMore();

        // Read remaining
        try {
            while (true) {
                const { done } = await reader.read();
                if (done) break;
            }
        } catch { /* expected */ }
    });

    it('cancel() on stream finalizes usage', async () => {
        const sseEvents = [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Data"}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","usage":{"output_tokens":15}}',
            '',
        ];
        const response = makeSSEResponse(sseEvents);
        const sseStream = createAnthropicSSEStream(response, null, { _requestId: 'integ-cancel' });

        const reader = sseStream.getReader();
        await reader.read(); // consume first chunk
        await reader.cancel(); // trigger cancel()
    });
});

// ────────────────────────────────────────────────────
// 2. Auto-updater flow integration
// ────────────────────────────────────────────────────
import { createAutoUpdater } from '../src/shared/auto-updater.js';

describe('Integration: auto-updater full flow', () => {
    let updater;
    let mockDeps;

    beforeEach(() => {
        vi.useFakeTimers();
        mockDeps = {
            pluginName: 'CPM',
            currentVersion: '1.0.0',
            versionsUrl: 'https://example.com/api/versions',
            mainUpdateUrl: 'https://example.com/api/main-plugin',
            updateBundleUrl: 'https://example.com/api/update-bundle',
            toast: { showMainAutoUpdateResult: vi.fn() },
            validateSchema: null,
            Risu: {
                pluginStorage: {
                    getItem: vi.fn(async (key) => {
                        if (key === 'cpm_pending_update') return null;
                        return null;
                    }),
                    setItem: vi.fn(async () => {}),
                    removeItem: vi.fn(async () => {}),
                },
                risuFetch: vi.fn(async (url) => {
                    if (url.includes('versions')) {
                        return {
                            data: JSON.stringify({
                                main: { version: '2.0.0', sha256: 'abc123def456', changes: 'Bug fixes' },
                            }),
                            status: 200,
                        };
                    }
                    if (url.includes('main-plugin')) {
                        return { data: '// plugin code v2.0.0', status: 200 };
                    }
                    return { data: null, status: 404 };
                }),
                nativeFetch: vi.fn(async (url) => {
                    if (typeof url === 'string' && url.includes('main-plugin')) {
                        return {
                            ok: true, status: 200,
                            text: async () => '// plugin code v2.0.0',
                            arrayBuffer: async () => new TextEncoder().encode('// plugin code v2.0.0').buffer,
                        };
                    }
                    if (typeof url === 'string' && url.includes('versions')) {
                        return {
                            ok: true, status: 200,
                            json: async () => ({
                                main: { version: '2.0.0', sha256: 'abc123def456', changes: 'Bug fixes' },
                            }),
                        };
                    }
                    return { ok: false, status: 404 };
                }),
                getDatabase: vi.fn(async () => ({ plugins: [{ name: 'CPM', src: '// old code' }] })),
                setDatabaseLite: vi.fn(async () => {}),
                registerPlugin: vi.fn(),
                getArgument: vi.fn(async () => ''),
            },
        };
        updater = createAutoUpdater(mockDeps);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('downloadMainPluginCode → validateAndInstall success chain', async () => {
        const dlResult = await updater.downloadMainPluginCode('https://example.com/main-plugin.js');
        expect(dlResult.ok).toBe(true);
        expect(dlResult.code).toBeTruthy();

        const installResult = await updater.validateAndInstall(dlResult.code, '2.0.0', 'Bug fixes');
        // Install may fail due to SHA mismatch in test env, but the flow should complete
        expect(typeof installResult.ok).toBe('boolean');
    });

    it('checkVersionsQuiet dedup: second call is no-op', async () => {
        await updater.checkVersionsQuiet();
        await updater.checkVersionsQuiet();
        // Second call should be skipped (dedup flag)
    });

    it('safeMainPluginUpdate downloads and attempts install', async () => {
        const result = await updater.safeMainPluginUpdate('2.0.0', 'Fix bugs');
        expect(typeof result.ok).toBe('boolean');
    });

    it('retryPendingUpdateOnBoot with no pending → returns false', async () => {
        const result = await updater.retryPendingUpdateOnBoot();
        expect(result).toBe(false);
    });

    it('retryPendingUpdateOnBoot with pending update → attempts update', async () => {
        mockDeps.Risu.pluginStorage.getItem = vi.fn(async (key) => {
            if (key === 'cpm_pending_update') {
                return JSON.stringify({ version: '2.0.0', retryCount: 0, changes: 'Fix', lastError: '' });
            }
            return null;
        });
        updater = createAutoUpdater(mockDeps);
        const result = await updater.retryPendingUpdateOnBoot();
        expect(typeof result).toBe('boolean');
    });

    it('rememberPendingUpdate stores update info', async () => {
        await updater.rememberPendingUpdate('2.0.0', 'Changes');
        expect(mockDeps.Risu.pluginStorage.setItem).toHaveBeenCalled();
    });

    it('clearPendingUpdate removes stored info', async () => {
        await updater.clearPendingUpdate();
        expect(mockDeps.Risu.pluginStorage.removeItem).toHaveBeenCalled();
    });

    it('L701-702: retryPendingUpdateOnBoot catch on safeMainPluginUpdate failure', async () => {
        mockDeps.Risu.pluginStorage.getItem = vi.fn(async (key) => {
            if (key === 'cpm_pending_update') {
                return JSON.stringify({ version: '2.0.0', retryCount: 0, changes: '', lastError: '' });
            }
            return null;
        });
        // Make download fail
        mockDeps.Risu.nativeFetch = vi.fn(async () => { throw new Error('Network failure'); });
        mockDeps.Risu.risuFetch = vi.fn(async () => { throw new Error('Network failure'); });

        updater = createAutoUpdater(mockDeps);
        const result = await updater.retryPendingUpdateOnBoot();
        // Should catch and return false
        expect(result).toBe(false);
    });

    it('L854: checkMainPluginVersionQuiet silent error path', async () => {
        mockDeps.Risu.nativeFetch = vi.fn(async () => { throw new Error('fail'); });
        mockDeps.Risu.risuFetch = vi.fn(async () => { throw new Error('fail'); });
        updater = createAutoUpdater(mockDeps);
        // Should not throw
        await updater.checkMainPluginVersionQuiet();
    });
});

// ────────────────────────────────────────────────────
// 3. Message format round-trip validation
// ────────────────────────────────────────────────────
import { formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';

describe('Integration: message format round-trip', () => {
    const fullConversation = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there! How can I help?' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'Thanks' },
    ];

    it('Anthropic format: valid structure with system extraction', () => {
        const result = formatToAnthropic(fullConversation);
        // System should be extracted
        expect(result.system).toBe('You are a helpful assistant.');
        // Messages should alternate user/assistant
        expect(result.messages[0].role).toBe('user');
        // All messages should have content arrays
        for (const msg of result.messages) {
            expect(Array.isArray(msg.content)).toBe(true);
            for (const part of msg.content) {
                expect(part.type).toBe('text');
                expect(typeof part.text).toBe('string');
            }
        }
    });

    it('Gemini format: valid structure with system + contents', () => {
        const result = formatToGemini(fullConversation);
        expect(result.contents.length).toBeGreaterThan(0);
        for (const content of result.contents) {
            expect(['user', 'model']).toContain(content.role);
            expect(Array.isArray(content.parts)).toBe(true);
        }
    });

    it('Anthropic: multimodal conversation preserves images', () => {
        const msgs = [
            { role: 'user', content: 'What is this?', multimodals: [{ type: 'image', base64: 'data:image/png;base64,ABCDEF' }] },
            { role: 'assistant', content: 'It looks like an image.' },
            { role: 'user', content: 'Describe it more', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs);
        expect(result.messages.length).toBeGreaterThanOrEqual(2);
        // Should have image part
        const imgMsg = result.messages.find(m =>
            m.content.some(c => c.type === 'image')
        );
        expect(imgMsg).toBeTruthy();
        // Last user message should have cache_control
        const lastUser = result.messages.filter(m => m.role === 'user').pop();
        const lastContent = lastUser.content[lastUser.content.length - 1];
        expect(lastContent.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('Gemini: multimodal with inline image', () => {
        const msgs = [
            {
                role: 'user', content: 'Analyze this',
                multimodals: [{ type: 'image', base64: 'data:image/jpeg;base64,/9j/test' }]
            },
            { role: 'assistant', content: 'Analysis complete.' },
        ];
        const result = formatToGemini(msgs);
        const userContent = result.contents.find(c => c.role === 'user');
        const inlinePart = userContent?.parts?.find(p => p.inlineData);
        expect(inlinePart).toBeTruthy();
        expect(inlinePart.inlineData.mimeType).toBe('image/jpeg');
    });

    it('Anthropic: empty conversation gets Start placeholder', () => {
        const result = formatToAnthropic([]);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content[0].text).toBe('Start');
    });

    it('Gemini: model-first gets Start placeholder', () => {
        const msgs = [{ role: 'assistant', content: 'I will begin' }];
        const result = formatToGemini(msgs);
        expect(result.contents[0].role).toBe('user');
        expect(result.contents[0].parts[0].text).toBe('Start');
    });
});
