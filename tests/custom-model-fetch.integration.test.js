import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectStream } from '../src/shared/helpers.js';

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

async function flushMicrotasks(rounds = 5) {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
    }
}

async function loadManagerWithCustomModels(customModels, overrides = {}) {
    const argsStore = new Map(Object.entries({
        cpm_custom_models: JSON.stringify(customModels),
        cpm_streaming_enabled: 'false',
        tools_githubCopilotToken: '',
        cpm_fallback_temp: '',
        cpm_fallback_max_tokens: '',
        cpm_fallback_top_p: '',
        cpm_fallback_freq_pen: '',
        cpm_fallback_pres_pen: '',
        ...overrides.args,
    }));

    const providers = [];
    const rootDoc = createFakeRootDocument();
    const nativeFetch = vi.fn(async (url, init = {}) => {
        if (overrides.nativeFetch) return overrides.nativeFetch(url, init);
        throw new Error(`Unexpected nativeFetch: ${url}`);
    });

    globalThis.window = {
        risuai: {
            nativeFetch,
            risuFetch: overrides.risuFetch,
            getArgument: vi.fn(async (key) => argsStore.get(key) ?? ''),
            setArgument: vi.fn(async (key, value) => {
                argsStore.set(key, String(value ?? ''));
            }),
            pluginStorage: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
            },
            addPluginChannelListener: vi.fn(() => {}),
            postPluginChannelMessage: vi.fn(() => {}),
            addProvider: vi.fn(async (label, handler, meta) => {
                providers.push({ label, handler, meta });
            }),
            registerSetting: vi.fn(async () => {}),
            getRootDocument: vi.fn(async () => rootDoc),
            showContainer: vi.fn(async () => {}),
            hideContainer: vi.fn(async () => {}),
        },
    };

    await import('../src/manager/index.js');
    await vi.advanceTimersByTimeAsync(1100);
    await flushMicrotasks();

    return {
        providers,
        nativeFetch,
        argsStore,
        rootDoc,
        findProvider(namePart) {
            return providers.find((p) => p.label.includes(namePart));
        },
    };
}

function jsonResponse(body, status = 200, headers = { 'content-type': 'application/json' }) {
    return new Response(JSON.stringify(body), { status, headers });
}

function sseResponse(lines) {
    const payload = `${lines.join('\n')}\n`;
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function parseBody(init) {
    const body = init?.body;
    if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
    if (typeof body === 'string') return JSON.parse(body);
    return body;
}

describe('custom model fetch integration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.window;
    });

    it('routes custom Copilot OpenAI models through Responses API mode', async () => {
        const customModel = {
            uniqueId: 'custom-copilot-gpt54',
            name: 'Custom Copilot GPT-5.4',
            model: 'gpt-5.4',
            format: 'openai',
            url: 'https://api.githubcopilot.com/chat/completions',
            responsesMode: 'on',
            reasoning: 'high',
        };

        let capturedRequest = null;
        const env = await loadManagerWithCustomModels([customModel], {
            args: { tools_githubCopilotToken: 'ghu_test_token' },
            nativeFetch: async (url, init = {}) => {
                if (url.includes('/copilot_internal/v2/token')) {
                    return jsonResponse({
                        token: 'cpt_test_token',
                        expires_at: new Date(Date.now() + 60_000).toISOString(),
                        endpoint: 'https://api.githubcopilot.com',
                    });
                }
                if (url.includes('/responses')) {
                    capturedRequest = { url, init, body: parseBody(init) };
                    return jsonResponse({
                        output: [
                            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need a concise answer.' }] },
                            { type: 'message', content: [{ type: 'output_text', text: 'hello from responses api' }] },
                        ],
                        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
                    });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });

        const provider = env.findProvider('Custom Copilot GPT-5.4');
        expect(provider).toBeTruthy();

        const result = await provider.handler({
            prompt_chat: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Say hi.' },
            ],
            temperature: 0.8,
            top_p: 0.9,
            max_tokens: 256,
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('hello from responses api');
        expect(capturedRequest.url).toContain('/responses');
        expect(capturedRequest.body.messages).toBeUndefined();
        expect(Array.isArray(capturedRequest.body.input)).toBe(true);
        expect(capturedRequest.body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
        expect(capturedRequest.body.temperature).toBeUndefined();
        expect(capturedRequest.body.top_p).toBeUndefined();
        expect(capturedRequest.init.headers.Authorization).toBe('Bearer cpt_test_token');
    });

    it('formats custom Anthropic models with system extraction and thinking config', async () => {
        const customModel = {
            uniqueId: 'custom-claude',
            name: 'Custom Claude',
            model: 'claude-sonnet-4-20250514',
            format: 'anthropic',
            url: 'https://api.anthropic.com',
            key: 'sk-ant-test',
            effort: 'high',
        };

        let capturedRequest = null;
        const env = await loadManagerWithCustomModels([customModel], {
            nativeFetch: async (url, init = {}) => {
                capturedRequest = { url, init, body: parseBody(init) };
                return jsonResponse({
                    content: [{ type: 'text', text: 'hello from claude' }],
                    usage: { input_tokens: 4, output_tokens: 7 },
                });
            },
        });

        const provider = env.findProvider('Custom Claude');
        expect(provider).toBeTruthy();

        const result = await provider.handler({
            prompt_chat: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Reply briefly.' },
            ],
            temperature: 0.6,
            max_tokens: 128,
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('hello from claude');
        expect(capturedRequest.url).toBe('https://api.anthropic.com/v1/messages');
        expect(capturedRequest.init.headers['x-api-key']).toBe('sk-ant-test');
        expect(capturedRequest.init.headers.Authorization).toBeUndefined();
        expect(capturedRequest.body.system).toBe('You are helpful.');
        expect(capturedRequest.body.messages.every((m) => m.role !== 'system')).toBe(true);
        expect(capturedRequest.body.thinking).toEqual({ type: 'adaptive' });
        expect(capturedRequest.body.output_config).toEqual({ effort: 'high' });
        expect(capturedRequest.body.temperature).toBe(0.6);
    });

    it('formats custom Google models with system instruction and API-key query', async () => {
        const customModel = {
            uniqueId: 'custom-gemini',
            name: 'Custom Gemini',
            model: 'gemini-2.0-flash',
            format: 'google',
            url: 'https://generativelanguage.googleapis.com/v1beta',
            key: 'g-test-key',
            sysfirst: true,
        };

        let capturedRequest = null;
        const env = await loadManagerWithCustomModels([customModel], {
            nativeFetch: async (url, init = {}) => {
                capturedRequest = { url, init, body: parseBody(init) };
                return jsonResponse({
                    candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }],
                    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
                });
            },
        });

        const provider = env.findProvider('Custom Gemini');
        expect(provider).toBeTruthy();

        const result = await provider.handler({
            prompt_chat: [
                { role: 'system', content: 'Follow system instructions.' },
                { role: 'user', content: 'Say hi.' },
            ],
            temperature: 0.7,
            max_tokens: 64,
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('hello from gemini');
        expect(capturedRequest.url).toContain('/v1beta/models/gemini-2.0-flash:generateContent');
        expect(capturedRequest.url).toContain('key=g-test-key');
        expect(capturedRequest.body.systemInstruction).toEqual({ parts: [{ text: 'Follow system instructions.' }] });
        expect(Array.isArray(capturedRequest.body.contents)).toBe(true);
        expect(capturedRequest.body.generationConfig.temperature).toBe(0.7);
        expect(capturedRequest.body.generationConfig.maxOutputTokens).toBe(64);
    });

    it('supports custom OpenAI streaming requests end-to-end', async () => {
        const customModel = {
            uniqueId: 'custom-openai-stream',
            name: 'Custom OpenAI Stream',
            model: 'gpt-4.1-mini',
            format: 'openai',
            url: 'https://api.openai.com/v1/chat/completions',
            key: 'sk-test',
            streaming: true,
        };

        const env = await loadManagerWithCustomModels([customModel], {
            args: { cpm_streaming_enabled: 'true' },
            nativeFetch: async (url, init = {}) => {
                expect(url).toBe('https://api.openai.com/v1/chat/completions');
                const body = parseBody(init);
                expect(body.stream).toBe(true);
                return sseResponse([
                    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
                    'data: {"choices":[{"delta":{"content":" world"}}]}',
                    'data: [DONE]',
                ]);
            },
        });

        const provider = env.findProvider('Custom OpenAI Stream');
        expect(provider).toBeTruthy();

        const result = await provider.handler({
            prompt_chat: [{ role: 'user', content: 'Stream please.' }],
            temperature: 0.5,
            max_tokens: 32,
        });

        expect(result.success).toBe(true);
        const text = result.content instanceof ReadableStream ? await collectStream(result.content) : result.content;
        expect(text).toContain('Hello world');
    });
});
