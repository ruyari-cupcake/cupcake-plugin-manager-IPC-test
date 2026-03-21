/**
 * @file ipc-communication-e2e.test.js — IPC sub-plugin communication E2E tests
 *
 * Tests the complete IPC message flow:
 * - Provider registration (REGISTER_PROVIDER → REGISTER_ACK)
 * - Fetch request/response cycle (FETCH_REQUEST → RESPONSE)
 * - Streaming via IPC (STREAM_CHUNK → STREAM_END)
 * - Abort signal propagation (Manager → Provider)
 * - Dynamic model discovery (DYNAMIC_MODELS_REQUEST → DYNAMIC_MODELS_RESULT)
 * - Error handling (MSG.ERROR, timeouts)
 * - Multi-provider scenarios
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ══════════════════════════════════════════════════
// IPC Protocol Constants (mirror shared/ipc-protocol.js)
// ══════════════════════════════════════════════════
const CH = {
    CONTROL: 'control',
    RESPONSE: 'response',
    FETCH: 'fetch',
    ABORT: 'abort',
};

const MSG = {
    REGISTER_PROVIDER: 'register-provider',
    REGISTER_ACK: 'register-ack',
    DYNAMIC_MODELS_REQUEST: 'dynamic-models-request',
    DYNAMIC_MODELS_RESULT: 'dynamic-models-result',
    FETCH_REQUEST: 'fetch-request',
    RESPONSE: 'response',
    ERROR: 'error',
    STREAM_CHUNK: 'stream-chunk',
    STREAM_END: 'stream-end',
    ABORT: 'abort',
};

const MANAGER_NAME = 'Cupcake Provider Manager';

// ══════════════════════════════════════════════════
// IPC Channel Bus Simulator
// ══════════════════════════════════════════════════

/**
 * Simulates the RisuAI V3 plugin channel system.
 * Each plugin has its own listener set; postPluginChannelMessage
 * routes to the target plugin's listeners.
 */
function createIPCBus() {
    /** @type {Map<string, Map<string, Function[]>>} pluginName→channel→listeners */
    const registry = new Map();

    function ensurePlugin(name) {
        if (!registry.has(name)) registry.set(name, new Map());
        return registry.get(name);
    }

    return {
        /**
         * Create a mock Risu-like object for a plugin.
         * @param {string} pluginName
         */
        createPluginRisu(pluginName) {
            return {
                addPluginChannelListener(channel, callback) {
                    const plugin = ensurePlugin(pluginName);
                    if (!plugin.has(channel)) plugin.set(channel, []);
                    plugin.get(channel).push(callback);
                },
                postPluginChannelMessage(targetPlugin, channel, message) {
                    const target = registry.get(targetPlugin);
                    if (!target) return;
                    const listeners = target.get(channel) || [];
                    for (const fn of listeners) {
                        // Simulate async delivery (microtask)
                        queueMicrotask(() => fn(message));
                    }
                },
                registerMCP: vi.fn().mockResolvedValue(undefined),
                unregisterMCP: vi.fn().mockResolvedValue(undefined),
                getArgument: vi.fn().mockResolvedValue(''),
                pluginStorage: {
                    getItem: vi.fn().mockResolvedValue(null),
                    setItem: vi.fn().mockResolvedValue(undefined),
                },
            };
        },

        /** Deliver a message synchronously (for testing without microtask delays) */
        deliverSync(targetPlugin, channel, message) {
            const target = registry.get(targetPlugin);
            if (!target) return;
            const listeners = target.get(channel) || [];
            for (const fn of listeners) fn(message);
        },

        /** Check if a plugin has listeners on a channel */
        hasListeners(pluginName, channel) {
            const plugin = registry.get(pluginName);
            return plugin?.has(channel) && plugin.get(channel).length > 0;
        },

        /** Clear all registrations */
        reset() {
            registry.clear();
        },
    };
}

// ══════════════════════════════════════════════════
// Helper: wait for async microtask delivery
// ══════════════════════════════════════════════════
function tick(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function flushMicrotasks() {
    await tick(0);
    await tick(0);
}

// ══════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════

describe('IPC Communication E2E', () => {
    let bus;

    beforeEach(() => {
        bus = createIPCBus();
    });

    afterEach(() => {
        bus.reset();
    });

    // ──────────────────────────────────────────────
    // § Provider Registration
    // ──────────────────────────────────────────────

    describe('Provider Registration', () => {
        it('should complete registration handshake (REGISTER_PROVIDER → REGISTER_ACK)', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            const receivedMessages = [];

            // Manager listens on CONTROL channel
            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                receivedMessages.push(msg);
                if (msg.type === MSG.REGISTER_PROVIDER) {
                    // Reply with ACK
                    providerRisu.postPluginChannelMessage(
                        'CPM Provider - OpenAI', CH.CONTROL,
                        { type: MSG.REGISTER_ACK, success: true }
                    );
                }
            });

            // Provider listens on CONTROL for ACK
            let ackReceived = false;
            providerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.REGISTER_ACK) {
                    ackReceived = true;
                }
            });

            // Provider sends registration
            providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                type: MSG.REGISTER_PROVIDER,
                pluginName: 'CPM Provider - OpenAI',
                name: 'OpenAI',
                models: [
                    { id: 'gpt-4o', name: 'GPT-4o', format: 'openai' },
                    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', format: 'openai' },
                ],
                settingsFields: ['cpm_openai_key', 'cpm_openai_url'],
            });

            await flushMicrotasks();

            expect(receivedMessages).toHaveLength(1);
            expect(receivedMessages[0].type).toBe(MSG.REGISTER_PROVIDER);
            expect(receivedMessages[0].name).toBe('OpenAI');
            expect(receivedMessages[0].models).toHaveLength(2);
            expect(ackReceived).toBe(true);
        });

        it('should handle multiple provider registrations', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providers = [
                { pluginName: 'CPM Provider - OpenAI', name: 'OpenAI', models: [{ id: 'gpt-4o' }] },
                { pluginName: 'CPM Provider - Anthropic', name: 'Anthropic', models: [{ id: 'claude-3' }] },
                { pluginName: 'CPM Provider - Gemini', name: 'GoogleAI', models: [{ id: 'gemini-2.5-flash' }] },
            ];

            const registered = [];
            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.REGISTER_PROVIDER) {
                    registered.push(msg.name);
                }
            });

            for (const p of providers) {
                const pRisu = bus.createPluginRisu(p.pluginName);
                pRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                    type: MSG.REGISTER_PROVIDER,
                    ...p,
                });
            }

            await flushMicrotasks();

            expect(registered).toEqual(['OpenAI', 'Anthropic', 'GoogleAI']);
        });

        it('should ignore messages without valid type', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const handled = [];

            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg?.type) handled.push(msg.type);
            });

            const providerRisu = bus.createPluginRisu('SomePlugin');
            providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, { hello: 'world' });
            providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, null);

            await flushMicrotasks();

            // null message triggers listener but handler should filter
            expect(handled).toEqual([]);
        });
    });

    // ──────────────────────────────────────────────
    // § Fetch Request/Response Cycle
    // ──────────────────────────────────────────────

    describe('Fetch Request/Response (Non-Streaming)', () => {
        it('should complete a full fetch request/response cycle', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            // Provider listens for fetch requests
            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    // Simulate API call and respond
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.RESPONSE,
                        requestId: msg.requestId,
                        data: {
                            success: true,
                            content: 'Hello from GPT-4o!',
                            _status: 200,
                        },
                    });
                }
            });

            // Manager sends fetch request and waits for response
            const requestId = 'req-001';
            let resolvedData = null;

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.requestId === requestId && msg.type === MSG.RESPONSE) {
                    resolvedData = msg.data;
                }
            });

            managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId,
                modelDef: { id: 'gpt-4o', name: 'GPT-4o', format: 'openai' },
                messages: [{ role: 'user', content: 'Hello!' }],
                temperature: 0.7,
                maxTokens: 2048,
            });

            await flushMicrotasks();

            expect(resolvedData).not.toBeNull();
            expect(resolvedData.success).toBe(true);
            expect(resolvedData.content).toBe('Hello from GPT-4o!');
            expect(resolvedData._status).toBe(200);
        });

        it('should carry raw data for tool-use parsing', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            const rawApiResponse = {
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{
                            id: 'call_123',
                            type: 'function',
                            function: {
                                name: 'calculate',
                                arguments: '{"expression":"2+3"}',
                            },
                        }],
                    },
                }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            };

            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.RESPONSE,
                        requestId: msg.requestId,
                        data: {
                            success: true,
                            content: '',
                            _rawData: rawApiResponse,
                            _status: 200,
                        },
                    });
                }
            });

            let received = null;
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.RESPONSE) received = msg.data;
            });

            managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'req-toolcall',
                messages: [{ role: 'user', content: 'What is 2+3?' }],
            });

            await flushMicrotasks();

            expect(received._rawData).toBeDefined();
            expect(received._rawData.choices[0].message.tool_calls).toHaveLength(1);
            expect(received._rawData.choices[0].message.tool_calls[0].function.name).toBe('calculate');
        });

        it('should handle multiple concurrent requests with separate requestIds', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    // Respond with requestId in content to prove routing
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.RESPONSE,
                        requestId: msg.requestId,
                        data: { success: true, content: `Response for ${msg.requestId}` },
                    });
                }
            });

            const responses = new Map();
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.RESPONSE) {
                    responses.set(msg.requestId, msg.data);
                }
            });

            // Fire 3 concurrent requests
            for (const id of ['req-A', 'req-B', 'req-C']) {
                managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.FETCH, {
                    type: MSG.FETCH_REQUEST,
                    requestId: id,
                    messages: [{ role: 'user', content: `Query ${id}` }],
                });
            }

            await flushMicrotasks();

            expect(responses.size).toBe(3);
            expect(responses.get('req-A').content).toBe('Response for req-A');
            expect(responses.get('req-B').content).toBe('Response for req-B');
            expect(responses.get('req-C').content).toBe('Response for req-C');
        });
    });

    // ──────────────────────────────────────────────
    // § Streaming via IPC
    // ──────────────────────────────────────────────

    describe('Streaming via IPC (STREAM_CHUNK → STREAM_END)', () => {
        it('should deliver chunks in order and signal completion', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            const requestId = 'req-stream-001';
            const receivedChunks = [];
            let streamEnded = false;
            let streamEndPayload = null;

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.requestId !== requestId) return;
                if (msg.type === MSG.STREAM_CHUNK) {
                    receivedChunks.push(msg.chunk);
                }
                if (msg.type === MSG.STREAM_END) {
                    streamEnded = true;
                    streamEndPayload = msg;
                }
            });

            // Provider simulates streaming response
            providerRisu.addPluginChannelListener(CH.FETCH, async (msg) => {
                if (msg.type !== MSG.FETCH_REQUEST) return;

                const chunks = ['Hello', ', ', 'world', '!'];
                for (const chunk of chunks) {
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.STREAM_CHUNK,
                        requestId: msg.requestId,
                        chunk,
                    });
                }
                // Signal end
                providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                    type: MSG.STREAM_END,
                    requestId: msg.requestId,
                    tokenUsage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
                });
            });

            // Send request
            bus.deliverSync('CPM Provider - OpenAI', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId,
                messages: [{ role: 'user', content: 'Greet me' }],
            });

            await flushMicrotasks();
            await tick(10);

            expect(receivedChunks).toEqual(['Hello', ', ', 'world', '!']);
            expect(streamEnded).toBe(true);
            expect(streamEndPayload.tokenUsage).toEqual({
                prompt_tokens: 20,
                completion_tokens: 4,
                total_tokens: 24,
            });
        });

        it('should handle empty stream (immediate STREAM_END)', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const requestId = 'req-empty-stream';
            let endReceived = false;

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.requestId === requestId && msg.type === MSG.STREAM_END) {
                    endReceived = true;
                }
            });

            // Deliver STREAM_END without any chunks
            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, {
                type: MSG.STREAM_END,
                requestId,
            });

            expect(endReceived).toBe(true);
        });

        it('should interleave chunks from different requestIds correctly', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);

            const chunksA = [];
            const chunksB = [];

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.STREAM_CHUNK) {
                    if (msg.requestId === 'stream-A') chunksA.push(msg.chunk);
                    if (msg.requestId === 'stream-B') chunksB.push(msg.chunk);
                }
            });

            // Interleave chunks from two streams
            const allChunks = [
                { requestId: 'stream-A', chunk: 'A1' },
                { requestId: 'stream-B', chunk: 'B1' },
                { requestId: 'stream-A', chunk: 'A2' },
                { requestId: 'stream-B', chunk: 'B2' },
                { requestId: 'stream-A', chunk: 'A3' },
            ];

            for (const c of allChunks) {
                bus.deliverSync(MANAGER_NAME, CH.RESPONSE, {
                    type: MSG.STREAM_CHUNK,
                    ...c,
                });
            }

            expect(chunksA).toEqual(['A1', 'A2', 'A3']);
            expect(chunksB).toEqual(['B1', 'B2']);
        });

        it('should include STREAM_END with error when streaming fails', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const requestId = 'req-stream-err';
            let endMsg = null;

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.requestId === requestId && msg.type === MSG.STREAM_END) {
                    endMsg = msg;
                }
            });

            // Deliver partial stream then error end
            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, {
                type: MSG.STREAM_CHUNK,
                requestId,
                chunk: 'Partial...',
            });
            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, {
                type: MSG.STREAM_END,
                requestId,
                error: 'API connection reset',
            });

            expect(endMsg).not.toBeNull();
            expect(endMsg.error).toBe('API connection reset');
        });
    });

    // ──────────────────────────────────────────────
    // § Error Handling
    // ──────────────────────────────────────────────

    describe('Error Handling', () => {
        it('should propagate MSG.ERROR from provider to manager', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - Anthropic');

            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.ERROR,
                        requestId: msg.requestId,
                        error: 'API key invalid',
                    });
                }
            });

            let errorData = null;
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.ERROR) errorData = msg;
            });

            bus.deliverSync('CPM Provider - Anthropic', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'req-err-001',
                messages: [{ role: 'user', content: 'test' }],
            });

            await flushMicrotasks();

            expect(errorData).not.toBeNull();
            expect(errorData.error).toBe('API key invalid');
            expect(errorData.requestId).toBe('req-err-001');
        });

        it('should handle provider timeout (no response)', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);

            // Provider registered but never responds
            bus.createPluginRisu('CPM Provider - DeadProvider');

            const responses = [];
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                responses.push(msg);
            });

            // Send request — no listener on provider side, so no response
            managerRisu.postPluginChannelMessage('CPM Provider - DeadProvider', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'req-timeout',
                messages: [{ role: 'user', content: 'hello' }],
            });

            await tick(50);

            // No response received (manager would handle this via timer)
            expect(responses).toHaveLength(0);
        });

        it('should handle malformed response messages gracefully', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const collected = [];

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                collected.push(msg);
            });

            // Various malformed messages
            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, { type: MSG.RESPONSE }); // No requestId
            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, { requestId: 'x' }); // No type
            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, {}); // Empty

            expect(collected).toHaveLength(3); // All delivered, manager handler filters
        });
    });

    // ──────────────────────────────────────────────
    // § Abort Signal Propagation
    // ──────────────────────────────────────────────

    describe('Abort Signal Propagation', () => {
        it('should send ABORT message to provider when aborted', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            let abortReceived = null;

            providerRisu.addPluginChannelListener(CH.ABORT, (msg) => {
                abortReceived = msg;
            });

            // Manager sends abort
            managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.ABORT, {
                type: MSG.ABORT,
                requestId: 'req-abort-001',
            });

            await flushMicrotasks();

            expect(abortReceived).not.toBeNull();
            expect(abortReceived.type).toBe(MSG.ABORT);
            expect(abortReceived.requestId).toBe('req-abort-001');
        });

        it('should abort mid-stream and close cleanly', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            const requestId = 'req-abort-stream';
            const chunks = [];
            let abortSent = false;

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.requestId === requestId && msg.type === MSG.STREAM_CHUNK) {
                    chunks.push(msg.chunk);
                    // After receiving 2 chunks, manager decides to abort
                    if (chunks.length === 2 && !abortSent) {
                        abortSent = true;
                        managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.ABORT, {
                            type: MSG.ABORT,
                            requestId,
                        });
                    }
                }
            });

            let providerAborted = false;
            providerRisu.addPluginChannelListener(CH.ABORT, (msg) => {
                if (msg.requestId === requestId) providerAborted = true;
            });

            // Send 4 chunks synchronously (simulates fast stream)
            for (const chunk of ['one', 'two', 'three', 'four']) {
                bus.deliverSync(MANAGER_NAME, CH.RESPONSE, {
                    type: MSG.STREAM_CHUNK,
                    requestId,
                    chunk,
                });
            }

            await flushMicrotasks();

            // All 4 chunks delivered (abort is async, doesn't suppress in-flight chunks)
            expect(chunks).toEqual(['one', 'two', 'three', 'four']);
            // But abort was sent to provider
            expect(providerAborted).toBe(true);
        });
    });

    // ──────────────────────────────────────────────
    // § Dynamic Model Discovery
    // ──────────────────────────────────────────────

    describe('Dynamic Model Discovery', () => {
        it('should request and receive dynamic models via CONTROL channel', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            const dynamicModels = [
                { id: 'gpt-4o-2024-11-20', name: 'GPT-4o Nov2024' },
                { id: 'o3-mini', name: 'o3 Mini' },
                { id: 'gpt-4.1', name: 'GPT-4.1' },
            ];

            // Provider responds to dynamic model requests
            providerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.DYNAMIC_MODELS_REQUEST) {
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                        type: MSG.DYNAMIC_MODELS_RESULT,
                        requestId: msg.requestId,
                        success: true,
                        models: dynamicModels,
                    });
                }
            });

            let modelsResult = null;
            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.DYNAMIC_MODELS_RESULT) {
                    modelsResult = msg;
                }
            });

            // Manager requests dynamic models
            managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.CONTROL, {
                type: MSG.DYNAMIC_MODELS_REQUEST,
                requestId: 'dm-001',
                settings: { cpm_openai_key: 'sk-test' },
            });

            await flushMicrotasks();

            expect(modelsResult).not.toBeNull();
            expect(modelsResult.success).toBe(true);
            expect(modelsResult.models).toHaveLength(3);
            expect(modelsResult.models[0].id).toBe('gpt-4o-2024-11-20');
        });

        it('should handle dynamic model request failure', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - Gemini');

            providerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.DYNAMIC_MODELS_REQUEST) {
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                        type: MSG.DYNAMIC_MODELS_RESULT,
                        requestId: msg.requestId,
                        success: false,
                        error: 'API key invalid',
                        models: [],
                    });
                }
            });

            let result = null;
            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.DYNAMIC_MODELS_RESULT) result = msg;
            });

            managerRisu.postPluginChannelMessage('CPM Provider - Gemini', CH.CONTROL, {
                type: MSG.DYNAMIC_MODELS_REQUEST,
                requestId: 'dm-fail',
                settings: {},
            });

            await flushMicrotasks();

            expect(result.success).toBe(false);
            expect(result.error).toBe('API key invalid');
            expect(result.models).toEqual([]);
        });
    });

    // ──────────────────────────────────────────────
    // § Full Request Lifecycle (Registration → Fetch → Response)
    // ──────────────────────────────────────────────

    describe('Full Lifecycle Integration', () => {
        it('should complete registration → fetch → response lifecycle', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - OpenAI');

            const lifecycle = [];

            // Manager: handle registrations
            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.REGISTER_PROVIDER) {
                    lifecycle.push('registration-received');
                    // Send ACK
                    managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.CONTROL, {
                        type: MSG.REGISTER_ACK,
                        success: true,
                    });
                }
            });

            // Manager: handle responses
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.RESPONSE) {
                    lifecycle.push(`response:${msg.data.content}`);
                }
            });

            // Provider: handle ACK and fetch requests
            providerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.REGISTER_ACK) {
                    lifecycle.push('ack-received');
                }
            });

            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    lifecycle.push('fetch-received');
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.RESPONSE,
                        requestId: msg.requestId,
                        data: { success: true, content: 'AI response' },
                    });
                }
            });

            // Step 1: Register
            providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                type: MSG.REGISTER_PROVIDER,
                pluginName: 'CPM Provider - OpenAI',
                name: 'OpenAI',
                models: [{ id: 'gpt-4o' }],
            });

            await flushMicrotasks();

            // Step 2: Fetch
            managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'lifecycle-001',
                messages: [{ role: 'user', content: 'Hi' }],
            });

            await flushMicrotasks();

            expect(lifecycle).toEqual([
                'registration-received',
                'ack-received',
                'fetch-received',
                'response:AI response',
            ]);
        });

        it('should handle streaming lifecycle (registration → fetch → chunks → end)', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const providerRisu = bus.createPluginRisu('CPM Provider - Anthropic');

            const events = [];

            // Manager registration
            managerRisu.addPluginChannelListener(CH.CONTROL, (msg) => {
                if (msg.type === MSG.REGISTER_PROVIDER) {
                    events.push('registered');
                    managerRisu.postPluginChannelMessage('CPM Provider - Anthropic', CH.CONTROL, {
                        type: MSG.REGISTER_ACK,
                        success: true,
                    });
                }
            });

            // Manager response handler
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.STREAM_CHUNK) events.push(`chunk:${msg.chunk}`);
                if (msg.type === MSG.STREAM_END) events.push('stream-end');
            });

            // Provider fetch handler
            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type !== MSG.FETCH_REQUEST) return;
                events.push('fetch-received');

                // Stream response
                for (const text of ['Once ', 'upon ', 'a time']) {
                    providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.STREAM_CHUNK,
                        requestId: msg.requestId,
                        chunk: text,
                    });
                }
                providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                    type: MSG.STREAM_END,
                    requestId: msg.requestId,
                    tokenUsage: { prompt_tokens: 15, completion_tokens: 3 },
                });
            });

            // Execute lifecycle
            providerRisu.postPluginChannelMessage(MANAGER_NAME, CH.CONTROL, {
                type: MSG.REGISTER_PROVIDER,
                pluginName: 'CPM Provider - Anthropic',
                name: 'Anthropic',
                models: [{ id: 'claude-3-haiku' }],
            });
            await flushMicrotasks();

            bus.deliverSync('CPM Provider - Anthropic', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'stream-lifecycle',
                messages: [{ role: 'user', content: 'Tell a story' }],
            });
            await flushMicrotasks();

            expect(events).toEqual([
                'registered',
                'fetch-received',
                'chunk:Once ',
                'chunk:upon ',
                'chunk:a time',
                'stream-end',
            ]);
        });
    });

    // ──────────────────────────────────────────────
    // § Multi-Provider Routing
    // ──────────────────────────────────────────────

    describe('Multi-Provider Routing', () => {
        it('should route requests to correct provider based on pluginName', async () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            const openaiRisu = bus.createPluginRisu('CPM Provider - OpenAI');
            const anthropicRisu = bus.createPluginRisu('CPM Provider - Anthropic');

            const openaiReceived = [];
            const anthropicReceived = [];

            openaiRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    openaiReceived.push(msg.requestId);
                    openaiRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.RESPONSE,
                        requestId: msg.requestId,
                        data: { success: true, content: 'OpenAI response' },
                    });
                }
            });

            anthropicRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                if (msg.type === MSG.FETCH_REQUEST) {
                    anthropicReceived.push(msg.requestId);
                    anthropicRisu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
                        type: MSG.RESPONSE,
                        requestId: msg.requestId,
                        data: { success: true, content: 'Anthropic response' },
                    });
                }
            });

            const managerResponses = new Map();
            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                if (msg.type === MSG.RESPONSE) {
                    managerResponses.set(msg.requestId, msg.data.content);
                }
            });

            // Route to OpenAI
            managerRisu.postPluginChannelMessage('CPM Provider - OpenAI', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'openai-req',
                messages: [{ role: 'user', content: 'Hello OpenAI' }],
            });

            // Route to Anthropic
            managerRisu.postPluginChannelMessage('CPM Provider - Anthropic', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'anthropic-req',
                messages: [{ role: 'user', content: 'Hello Claude' }],
            });

            await flushMicrotasks();

            expect(openaiReceived).toEqual(['openai-req']);
            expect(anthropicReceived).toEqual(['anthropic-req']);
            expect(managerResponses.get('openai-req')).toBe('OpenAI response');
            expect(managerResponses.get('anthropic-req')).toBe('Anthropic response');
        });

        it('should not cross-deliver messages between providers', async () => {
            bus.createPluginRisu(MANAGER_NAME);
            const openaiRisu = bus.createPluginRisu('CPM Provider - OpenAI');
            const anthropicRisu = bus.createPluginRisu('CPM Provider - Anthropic');

            const openaiMessages = [];
            const anthropicMessages = [];

            openaiRisu.addPluginChannelListener(CH.FETCH, (msg) => openaiMessages.push(msg));
            anthropicRisu.addPluginChannelListener(CH.FETCH, (msg) => anthropicMessages.push(msg));

            // Send to OpenAI only
            bus.deliverSync('CPM Provider - OpenAI', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'only-openai',
            });

            expect(openaiMessages).toHaveLength(1);
            expect(anthropicMessages).toHaveLength(0);
        });
    });

    // ──────────────────────────────────────────────
    // § Message Format Validation
    // ──────────────────────────────────────────────

    describe('Message Format Validation', () => {
        it('should preserve all FETCH_REQUEST fields through IPC', async () => {
            const providerRisu = bus.createPluginRisu('TestProvider');
            let receivedMsg = null;

            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                receivedMsg = msg;
            });

            const fullRequest = {
                type: MSG.FETCH_REQUEST,
                requestId: 'fmt-001',
                modelDef: {
                    id: 'gpt-4o',
                    name: 'GPT-4o',
                    format: 'openai',
                    provider: 'OpenAI',
                    uniqueId: 'openai::gpt-4o',
                },
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'Hello!' },
                ],
                temperature: 0.8,
                maxTokens: 4096,
                args: {
                    temperature: 0.8,
                    max_tokens: 4096,
                    top_p: 0.95,
                    frequency_penalty: 0.3,
                },
                settings: {
                    cpm_openai_key: 'sk-test',
                    cpm_streaming_enabled: true,
                },
            };

            bus.deliverSync('TestProvider', CH.FETCH, fullRequest);

            expect(receivedMsg).toEqual(fullRequest);
            expect(receivedMsg.modelDef.format).toBe('openai');
            expect(receivedMsg.messages).toHaveLength(2);
            expect(receivedMsg.args.top_p).toBe(0.95);
            expect(receivedMsg.settings.cpm_openai_key).toBe('sk-test');
        });

        it('should preserve RESPONSE data integrity', () => {
            const managerRisu = bus.createPluginRisu(MANAGER_NAME);
            let received = null;

            managerRisu.addPluginChannelListener(CH.RESPONSE, (msg) => {
                received = msg;
            });

            const response = {
                type: MSG.RESPONSE,
                requestId: 'fmt-resp-001',
                data: {
                    success: true,
                    content: '안녕하세요! 반가워요.',
                    _rawData: {
                        choices: [{ message: { content: '안녕하세요! 반가워요.' } }],
                        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
                    },
                    _status: 200,
                    _streaming: false,
                },
            };

            bus.deliverSync(MANAGER_NAME, CH.RESPONSE, response);

            expect(received.data.content).toBe('안녕하세요! 반가워요.');
            expect(received.data._rawData.usage.total_tokens).toBe(20);
            expect(received.data._status).toBe(200);
        });

        it('should handle unicode and large content in messages', () => {
            const providerRisu = bus.createPluginRisu('TestProvider');
            let received = null;

            providerRisu.addPluginChannelListener(CH.FETCH, (msg) => {
                received = msg;
            });

            const largeContent = '가'.repeat(50000); // ~50KB of Korean text
            bus.deliverSync('TestProvider', CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'unicode-test',
                messages: [
                    { role: 'user', content: largeContent },
                    { role: 'user', content: '🎉🧁💜 emoji test' },
                ],
            });

            expect(received.messages[0].content.length).toBe(50000);
            expect(received.messages[1].content).toBe('🎉🧁💜 emoji test');
        });
    });

    // ──────────────────────────────────────────────
    // § Channel Isolation
    // ──────────────────────────────────────────────

    describe('Channel Isolation', () => {
        it('should not leak messages across different channels', () => {
            const pluginRisu = bus.createPluginRisu('TestPlugin');

            const controlMsgs = [];
            const responseMsgs = [];
            const fetchMsgs = [];

            pluginRisu.addPluginChannelListener(CH.CONTROL, (msg) => controlMsgs.push(msg));
            pluginRisu.addPluginChannelListener(CH.RESPONSE, (msg) => responseMsgs.push(msg));
            pluginRisu.addPluginChannelListener(CH.FETCH, (msg) => fetchMsgs.push(msg));

            bus.deliverSync('TestPlugin', CH.CONTROL, { type: 'ctrl-msg' });
            bus.deliverSync('TestPlugin', CH.RESPONSE, { type: 'resp-msg' });
            bus.deliverSync('TestPlugin', CH.FETCH, { type: 'fetch-msg' });

            expect(controlMsgs).toEqual([{ type: 'ctrl-msg' }]);
            expect(responseMsgs).toEqual([{ type: 'resp-msg' }]);
            expect(fetchMsgs).toEqual([{ type: 'fetch-msg' }]);
        });

        it('should support multiple listeners on same channel', () => {
            const pluginRisu = bus.createPluginRisu('TestPlugin');
            const results = [];

            pluginRisu.addPluginChannelListener(CH.CONTROL, () => results.push('listener-1'));
            pluginRisu.addPluginChannelListener(CH.CONTROL, () => results.push('listener-2'));

            bus.deliverSync('TestPlugin', CH.CONTROL, { type: 'test' });

            expect(results).toEqual(['listener-1', 'listener-2']);
        });
    });
});
