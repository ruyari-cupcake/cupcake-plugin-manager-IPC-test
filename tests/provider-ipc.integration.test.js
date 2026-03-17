import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGER_NAME, CH, MSG } from '../src/shared/ipc-protocol.js';

async function waitForValue(getValue, timeoutMs = 500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = getValue();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return getValue();
}

function createPluginRisu(pluginName, handlers = {}) {
    const channels = new Map();
    const managerControlMessages = [];
    const managerResponseMessages = [];

    const risu = {
        addPluginChannelListener(channelName, callback) {
            channels.set(pluginName + channelName, callback);
        },
        postPluginChannelMessage(targetPluginName, channelName, message) {
            if (targetPluginName === MANAGER_NAME) {
                if (channelName === CH.CONTROL) managerControlMessages.push(message);
                if (channelName === CH.RESPONSE) managerResponseMessages.push(message);
            }
            const target = channels.get(targetPluginName + channelName);
            if (target) target(message);
        },
        nativeFetch: vi.fn(async (url, init = {}) => {
            if (handlers.nativeFetch) return handlers.nativeFetch(url, init);
            throw new Error(`Unexpected nativeFetch: ${url}`);
        }),
        getArgument: vi.fn(async () => ''),
        setArgument: vi.fn(async () => {}),
        pluginStorage: {
            getItem: vi.fn(async () => null),
            setItem: vi.fn(async () => {}),
        },
    };

    channels.set(MANAGER_NAME + CH.CONTROL, (message) => {
        managerControlMessages.push(message);
        if (message?.type === MSG.REGISTER_PROVIDER) {
            const listener = channels.get(pluginName + CH.CONTROL);
            listener?.({ type: MSG.REGISTER_ACK });
        }
    });
    channels.set(MANAGER_NAME + CH.RESPONSE, (message) => {
        managerResponseMessages.push(message);
    });

    return {
        risu,
        sendToPlugin(channelName, message) {
            const listener = channels.get(pluginName + channelName);
            if (!listener) throw new Error(`Missing listener for ${pluginName}:${channelName}`);
            return listener(message);
        },
        getManagerControlMessages() {
            return managerControlMessages;
        },
        getManagerResponseMessages() {
            return managerResponseMessages;
        },
    };
}

describe('provider IPC integration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('OpenAI provider registers, serves dynamic models, and responds to FETCH requests', async () => {
        const env = createPluginRisu('CPM Provider - OpenAI', {
            nativeFetch: async (url) => {
                if (url.endsWith('/v1/models')) {
                    return new Response(JSON.stringify({ data: [
                        { id: 'gpt-4.1-mini' },
                        { id: 'gpt-5.4' },
                    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (url.endsWith('/v1/chat/completions')) {
                    return new Response(JSON.stringify({
                        choices: [{ message: { content: 'hello from openai' } }],
                        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        globalThis.window = { risuai: env.risu };

        await import('../src/providers/openai.js');
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(env.getManagerControlMessages().some((msg) => msg.type === MSG.REGISTER_PROVIDER)).toBe(true);

        await env.sendToPlugin(CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId: 'dyn-1',
            settings: { cpm_openai_key: 'sk-test', cpm_openai_url: 'https://api.openai.com' },
        });

        const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-1'));
        expect(dynResult.success).toBe(true);
        expect(dynResult.models.some((m) => m.id === 'gpt-4.1-mini')).toBe(true);

        await env.sendToPlugin(CH.FETCH, {
            type: MSG.FETCH_REQUEST,
            requestId: 'fetch-1',
            modelDef: { id: 'gpt-4.1', uniqueId: 'openai-gpt-4.1' },
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.7,
            maxTokens: 128,
            args: {},
            settings: { cpm_openai_key: 'sk-test', cpm_openai_url: 'https://api.openai.com' },
        });

        const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-1'));
        expect(fetchResult).toBeTruthy();
        expect(fetchResult.data.success).toBe(true);
        expect(fetchResult.data.content).toContain('hello from openai');
    });

    it('Anthropic provider registers and returns dynamic models over the same control channel', async () => {
        const env = createPluginRisu('CPM Provider - Anthropic', {
            nativeFetch: async (url) => {
                if (url.includes('/v1/models')) {
                    return new Response(JSON.stringify({ data: [
                            { type: 'model', id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' },
                    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        globalThis.window = { risuai: env.risu };

        await import('../src/providers/anthropic.js');
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(env.getManagerControlMessages().some((msg) => msg.type === MSG.REGISTER_PROVIDER)).toBe(true);

        await env.sendToPlugin(CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId: 'dyn-a1',
            settings: { cpm_anthropic_key: 'sk-ant', cpm_anthropic_url: 'https://api.anthropic.com' },
        });

        const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-a1'));
        expect(dynResult.success).toBe(true);
        expect(dynResult.models.some((m) => m.id.includes('claude-3-7-sonnet'))).toBe(true);
    });

    it('Gemini provider registers, refreshes dynamic models, and handles non-streaming fetch', async () => {
        const env = createPluginRisu('CPM Provider - Gemini', {
            nativeFetch: async (url) => {
                if (url.includes('/v1beta/models?')) {
                    return new Response(JSON.stringify({ models: [
                        {
                            name: 'models/gemini-2.5-flash',
                            displayName: 'Gemini 2.5 Flash',
                            supportedGenerationMethods: ['generateContent'],
                        },
                    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (url.includes(':generateContent')) {
                    return new Response(JSON.stringify({
                        candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }],
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        globalThis.window = { risuai: env.risu };

        await import('../src/providers/gemini.js');
        await new Promise((resolve) => setTimeout(resolve, 20));

        await env.sendToPlugin(CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId: 'dyn-g1',
            settings: { cpm_gemini_key: 'gm-test' },
        });

        const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-g1'));
        expect(dynResult.success).toBe(true);
        expect(dynResult.models.some((m) => m.id === 'gemini-2.5-flash')).toBe(true);

        await env.sendToPlugin(CH.FETCH, {
            type: MSG.FETCH_REQUEST,
            requestId: 'fetch-g1',
            modelDef: { id: 'gemini-2.5-flash', uniqueId: 'google-gemini-2.5-flash' },
            messages: [{ role: 'user', content: 'hi gemini' }],
            temperature: 0.4,
            maxTokens: 128,
            args: {},
            settings: { cpm_gemini_key: 'gm-test' },
        });

        const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-g1'));
        expect(fetchResult.data.success).toBe(true);
        expect(fetchResult.data.content).toContain('hello from gemini');
    });

    it('DeepSeek provider registers, refreshes dynamic models, and handles fetch requests', async () => {
        const env = createPluginRisu('CPM Provider - DeepSeek', {
            nativeFetch: async (url) => {
                if (url.endsWith('/models')) {
                    return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                if (url.endsWith('/v1/chat/completions')) {
                    return new Response(JSON.stringify({
                        choices: [{ message: { content: 'hello from deepseek' } }],
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        globalThis.window = { risuai: env.risu };

        await import('../src/providers/deepseek.js');
        await new Promise((resolve) => setTimeout(resolve, 20));

        await env.sendToPlugin(CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId: 'dyn-d1',
            settings: { cpm_deepseek_key: 'ds-test', cpm_deepseek_url: 'https://api.deepseek.com' },
        });

        const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-d1'));
        expect(dynResult.success).toBe(true);
        expect(dynResult.models.some((m) => m.id === 'deepseek-chat')).toBe(true);

        await env.sendToPlugin(CH.FETCH, {
            type: MSG.FETCH_REQUEST,
            requestId: 'fetch-d1',
            modelDef: { id: 'deepseek-chat', uniqueId: 'deepseek-deepseek-chat' },
            messages: [{ role: 'user', content: 'hi deepseek' }],
            temperature: 0.2,
            maxTokens: 64,
            args: {},
            settings: { cpm_deepseek_key: 'ds-test', cpm_deepseek_url: 'https://api.deepseek.com' },
        });

        const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-d1'));
        expect(fetchResult.data.success).toBe(true);
        expect(fetchResult.data.content).toContain('hello from deepseek');
    });

    it('OpenRouter provider registers, refreshes dynamic models, and handles fetch requests', async () => {
        const env = createPluginRisu('CPM Provider - OpenRouter', {
            nativeFetch: async (url) => {
                if (url.endsWith('/v1/models')) {
                    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' }] }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                if (url.endsWith('/v1/chat/completions')) {
                    return new Response(JSON.stringify({
                        choices: [{ message: { content: 'hello from openrouter' } }],
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        globalThis.window = { risuai: env.risu };

        await import('../src/providers/openrouter.js');
        await new Promise((resolve) => setTimeout(resolve, 20));

        await env.sendToPlugin(CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId: 'dyn-r1',
            settings: { cpm_openrouter_key: 'or-test', cpm_openrouter_url: 'https://openrouter.ai/api' },
        });

        const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-r1'));
        expect(dynResult.success).toBe(true);
        expect(dynResult.models.some((m) => m.id === 'openai/gpt-4.1-mini')).toBe(true);

        await env.sendToPlugin(CH.FETCH, {
            type: MSG.FETCH_REQUEST,
            requestId: 'fetch-r1',
            modelDef: { id: 'openai/gpt-4.1-mini', uniqueId: 'openrouter-openai/gpt-4.1-mini' },
            messages: [{ role: 'user', content: 'hi openrouter' }],
            temperature: 0.6,
            maxTokens: 128,
            args: {},
            settings: {
                cpm_openrouter_key: 'or-test',
                cpm_openrouter_url: 'https://openrouter.ai/api',
                cpm_openrouter_model: 'openai/gpt-4.1-mini',
            },
        });

        const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-r1'));
        expect(fetchResult.data.success).toBe(true);
        expect(fetchResult.data.content).toContain('hello from openrouter');
    });

    it('AWS provider registers, refreshes dynamic models, and invokes Bedrock with normalized model IDs', async () => {
        let invokeCall = null;
        const env = createPluginRisu('CPM Provider - AWS Bedrock', {
            nativeFetch: async (url, init = {}) => {
                if (url.includes('/foundation-models')) {
                    return new Response(JSON.stringify({
                        modelSummaries: [{
                            modelId: 'anthropic.claude-4-5-sonnet-20250929-v1:0',
                            modelName: 'Claude Sonnet 4.5',
                            providerName: 'Anthropic',
                            outputModalities: ['TEXT'],
                            inferenceTypesSupported: ['ON_DEMAND'],
                        }],
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (url.includes('/inference-profiles')) {
                    return new Response(JSON.stringify({
                        inferenceProfileSummaries: [{
                            inferenceProfileId: 'global.anthropic.claude-opus-4-6-v1:0',
                            inferenceProfileName: 'Claude Opus 4.6',
                        }],
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (url.includes('/model/global.anthropic.claude-4-5-sonnet-20250929-v1:0/invoke')) {
                    invokeCall = { url, init };
                    return new Response(JSON.stringify({
                        content: [{ type: 'text', text: 'hello from aws' }],
                        usage: { input_tokens: 10, output_tokens: 6 },
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        globalThis.window = { risuai: env.risu };

        await import('../src/providers/aws.js');
        await new Promise((resolve) => setTimeout(resolve, 20));

        await env.sendToPlugin(CH.CONTROL, {
            type: MSG.DYNAMIC_MODELS_REQUEST,
            requestId: 'dyn-aws1',
            settings: { cpm_aws_key: 'AKIA_TEST', cpm_aws_secret: 'SECRET_TEST', cpm_aws_region: 'us-east-1' },
        });

        const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-aws1'));
        expect(dynResult.success).toBe(true);
        expect(dynResult.models.some((m) => m.id === 'global.anthropic.claude-4-5-sonnet-20250929-v1:0')).toBe(true);
        expect(dynResult.models.some((m) => m.id === 'global.anthropic.claude-opus-4-6-v1:0')).toBe(true);

        await env.sendToPlugin(CH.FETCH, {
            type: MSG.FETCH_REQUEST,
            requestId: 'fetch-aws1',
            modelDef: { id: 'anthropic.claude-4-5-sonnet-20250929-v1:0', uniqueId: 'aws-anthropic.claude-4-5-sonnet-20250929-v1:0' },
            messages: [{ role: 'user', content: 'hi aws' }],
            temperature: 0.7,
            maxTokens: 256,
            args: {},
            settings: {
                cpm_aws_key: 'AKIA_TEST',
                cpm_aws_secret: 'SECRET_TEST',
                cpm_aws_region: 'us-east-1',
                cpm_aws_thinking_budget: '2048',
            },
        });

        const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-aws1'));
        expect(fetchResult.data.success).toBe(true);
        expect(fetchResult.data.content).toContain('hello from aws');
        expect(invokeCall?.url).toContain('/model/global.anthropic.claude-4-5-sonnet-20250929-v1:0/invoke');

        const requestBody = JSON.parse(new TextDecoder().decode(invokeCall.init.body));
        expect(requestBody.anthropic_version).toBe('bedrock-2023-05-31');
        expect(requestBody.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
        expect(requestBody.temperature).toBe(1);
    });

    it('Vertex provider refreshes dynamic models, uses OAuth credentials, and falls back across regions for Gemini fetches', async () => {
        const originalImportKey = globalThis.crypto?.subtle?.importKey;
        const originalSign = globalThis.crypto?.subtle?.sign;
        const credentialJson = JSON.stringify({
            project_id: 'vertex-proj',
            client_email: 'svc@vertex-proj.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----',
        });
        const attemptedGenerateUrls = [];

        globalThis.crypto.subtle.importKey = vi.fn(async () => ({}));
        globalThis.crypto.subtle.sign = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);

        try {
            const env = createPluginRisu('CPM Provider - Vertex AI', {
                nativeFetch: async (url, init = {}) => {
                    if (url.includes('oauth2.googleapis.com/token')) {
                        return new Response(JSON.stringify({ access_token: 'vertex-access-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
                    }
                    if (url.includes('/v1/publishers/google/models?pageSize=100')) {
                        return new Response(JSON.stringify({
                            models: [{
                                name: 'publishers/google/models/gemini-2.5-pro',
                                displayName: 'Gemini 2.5 Pro',
                                supportedActions: ['generateContent'],
                            }],
                        }), { status: 200, headers: { 'content-type': 'application/json' } });
                    }
                    if (url.includes('/publishers/anthropic/models')) {
                        return new Response(JSON.stringify({
                            models: [{
                                name: 'projects/vertex-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5-20250929',
                                displayName: 'Claude 4.5 Sonnet',
                            }],
                        }), { status: 200, headers: { 'content-type': 'application/json' } });
                    }
                    if (url.includes(':generateContent')) {
                        attemptedGenerateUrls.push(url);
                        if (url.includes('/locations/europe-west4/')) {
                            return new Response(JSON.stringify({ error: { message: 'region mismatch' } }), { status: 404, headers: { 'content-type': 'application/json' } });
                        }
                        if (url.includes('/locations/us-central1/')) {
                            return new Response(JSON.stringify({
                                candidates: [{ content: { parts: [{ text: 'hello from vertex gemini fallback' }] } }],
                            }), { status: 200, headers: { 'content-type': 'application/json' } });
                        }
                    }
                    throw new Error(`Unexpected URL: ${url}`);
                },
            });
            globalThis.window = { risuai: env.risu };

            await import('../src/providers/vertex.js');
            await new Promise((resolve) => setTimeout(resolve, 20));

            await env.sendToPlugin(CH.CONTROL, {
                type: MSG.DYNAMIC_MODELS_REQUEST,
                requestId: 'dyn-v1',
                settings: { cpm_vertex_key_json: credentialJson, cpm_vertex_location: 'global' },
            });

            const dynResult = await waitForValue(() => env.getManagerControlMessages().find((msg) => msg.type === MSG.DYNAMIC_MODELS_RESULT && msg.requestId === 'dyn-v1'));
            expect(dynResult.success).toBe(true);
            expect(dynResult.models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
            expect(dynResult.models.some((m) => m.id === 'claude-sonnet-4-5-20250929')).toBe(true);

            await env.sendToPlugin(CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'fetch-v1',
                modelDef: { id: 'gemini-2.5-pro', uniqueId: 'vertex-gemini-2.5-pro' },
                messages: [{ role: 'user', content: 'hi vertex gemini' }],
                temperature: 0.4,
                maxTokens: 512,
                args: {},
                settings: {
                    cpm_vertex_key_json: credentialJson,
                    cpm_vertex_location: 'europe-west4',
                    cpm_vertex_model: 'gemini-2.5-pro',
                },
            });

            const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-v1'));
            expect(fetchResult.data.success).toBe(true);
            expect(fetchResult.data.content).toContain('hello from vertex gemini fallback');
            expect(attemptedGenerateUrls.some((url) => url.includes('/locations/europe-west4/'))).toBe(true);
            expect(attemptedGenerateUrls.some((url) => url.includes('/locations/us-central1/'))).toBe(true);
        } finally {
            globalThis.crypto.subtle.importKey = originalImportKey;
            globalThis.crypto.subtle.sign = originalSign;
        }
    });

    it('Vertex provider streams Gemini chunks over IPC response channel', async () => {
        const originalImportKey = globalThis.crypto?.subtle?.importKey;
        const originalSign = globalThis.crypto?.subtle?.sign;
        const credentialJson = JSON.stringify({
            project_id: 'vertex-stream-proj',
            client_email: 'svc@vertex-stream-proj.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----',
        });

        globalThis.crypto.subtle.importKey = vi.fn(async () => ({}));
        globalThis.crypto.subtle.sign = vi.fn(async () => new Uint8Array([5, 6, 7, 8]).buffer);

        try {
            const streamBody = new ReadableStream({
                start(controller) {
                    const encoder = new TextEncoder();
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n\n'));
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"from vertex stream"}]}}]}\n\n'));
                    controller.close();
                },
            });

            const env = createPluginRisu('CPM Provider - Vertex AI', {
                nativeFetch: async (url) => {
                    if (url.includes('oauth2.googleapis.com/token')) {
                        return new Response(JSON.stringify({ access_token: 'vertex-stream-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
                    }
                    if (url.includes(':streamGenerateContent?alt=sse')) {
                        return new Response(streamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
                    }
                    throw new Error(`Unexpected URL: ${url}`);
                },
            });
            globalThis.window = { risuai: env.risu };

            await import('../src/providers/vertex.js');
            await new Promise((resolve) => setTimeout(resolve, 20));

            await env.sendToPlugin(CH.FETCH, {
                type: MSG.FETCH_REQUEST,
                requestId: 'fetch-v-stream',
                modelDef: { id: 'gemini-2.5-pro', uniqueId: 'vertex-gemini-2.5-pro' },
                messages: [{ role: 'user', content: 'stream please' }],
                temperature: 0.2,
                maxTokens: 128,
                args: {},
                settings: {
                    cpm_vertex_key_json: credentialJson,
                    cpm_vertex_location: 'global',
                    cpm_streaming_enabled: true,
                },
            });

            const streamChunk = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.STREAM_CHUNK && msg.requestId === 'fetch-v-stream'));
            const streamEnd = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.STREAM_END && msg.requestId === 'fetch-v-stream'));
            const fetchResult = await waitForValue(() => env.getManagerResponseMessages().find((msg) => msg.type === MSG.RESPONSE && msg.requestId === 'fetch-v-stream'));

            expect(streamChunk.chunk).toContain('hello');
            expect(streamEnd).toBeTruthy();
            expect(fetchResult.data.success).toBe(true);
            expect(fetchResult.data._streamed).toBe(true);
            expect(fetchResult.data.content).toContain('hello from vertex stream');
        } finally {
            globalThis.crypto.subtle.importKey = originalImportKey;
            globalThis.crypto.subtle.sign = originalSign;
        }
    });
});
