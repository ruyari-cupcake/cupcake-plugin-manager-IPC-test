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
});
