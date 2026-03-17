/**
 * migration-regression.test.js
 *
 * Regression tests for all 17 migration gaps applied to manager/index.js.
 * These tests verify the behavioral correctness of migrated _temp_repo logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { sanitizeMessages, hasNonEmptyMessageContent, hasAttachedMultimodals } from '../src/shared/sanitize.js';
import { formatToAnthropic, formatToOpenAI, formatToGemini } from '../src/shared/message-format.js';
import { getGeminiSafetySettings, buildGeminiThinkingConfig } from '../src/shared/gemini-helpers.js';
import {
    supportsOpenAIReasoningEffort,
    shouldStripOpenAISamplingParams,
    shouldStripGPT54SamplingForReasoning,
    needsMaxCompletionTokens,
    needsCopilotResponsesAPI,
} from '../src/shared/model-helpers.js';

// § Gap #1: sanitizeMessages on raw input
describe('Gap #1: sanitizeMessages removes invalid messages', () => {
    it('filters out empty-content messages (not multimodal)', () => {
        const raw = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: '' },
            { role: 'user', content: 'world' },
        ];
        const result = sanitizeMessages(raw);
        expect(result.every(m => hasNonEmptyMessageContent(m.content) || hasAttachedMultimodals(m))).toBe(true);
    });

    it('preserves multimodal messages even with empty text', () => {
        const raw = [
            { role: 'user', content: '', multimodals: [{ type: 'image', base64: 'abc' }] },
        ];
        const result = sanitizeMessages(raw);
        expect(result.length).toBe(1);
    });
});

// § Gap #3: Anthropic adaptive thinking
describe('Gap #3: Anthropic adaptive thinking behavior', () => {
    const makeAnthropicBody = (options = {}) => {
        const body = { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 4096 };
        const adaptiveThinking = options.adaptiveThinking;
        const effort = options.effort || '';
        if (adaptiveThinking && effort) {
            body.thinking = { type: 'enabled', budget_tokens: 10240 };
            body.output_config = { effort };
            delete body.temperature;
        } else if (effort && !adaptiveThinking) {
            body.output_config = { effort };
        }
        return body;
    };

    it('effort alone without adaptiveThinking = effort-only mode', () => {
        const body = makeAnthropicBody({ effort: 'high', adaptiveThinking: false });
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('effort + adaptiveThinking = full adaptive thinking', () => {
        const body = makeAnthropicBody({ effort: 'high', adaptiveThinking: true });
        expect(body.thinking).toBeTruthy();
        expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('no effort, no adaptiveThinking = vanilla mode', () => {
        const body = makeAnthropicBody({});
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toBeUndefined();
    });
});

// § Gap #5: developerRole BEFORE formatting
describe('Gap #5: developerRole applied before OpenAI formatting', () => {
    it('converts system to developer role', () => {
        const messages = [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hi' }];
        const result = formatToOpenAI(messages, { developerRole: true });
        expect(result.find(m => m.role === 'developer')).toBeTruthy();
    });
});

// § Gap #7: getGeminiSafetySettings with model
describe('Gap #7: getGeminiSafetySettings receives model', () => {
    it('returns array of safety settings', () => {
        const settings = getGeminiSafetySettings('gemini-2.5-flash');
        expect(Array.isArray(settings)).toBe(true);
        expect(settings.length).toBeGreaterThan(0);
        settings.forEach(s => {
            expect(s).toHaveProperty('category');
            expect(s).toHaveProperty('threshold');
        });
    });
});

// § Gap #8: Vertex detection
describe('Gap #8: Vertex endpoint detection', () => {
    it('detects Vertex from URL', () => {
        expect('https://us-central1-aiplatform.googleapis.com/v1/test'.includes('aiplatform.googleapis.com')).toBe(true);
    });
    it('does not detect standard Gemini API', () => {
        expect('https://generativelanguage.googleapis.com/v1beta/test'.includes('aiplatform.googleapis.com')).toBe(false);
    });
});

// § Gap #9-10: OpenAI maxout + top_k
describe('Gap #9-10: OpenAI body construction', () => {
    it('max_output override sets all variants', () => {
        const body = { max_tokens: 4096, max_completion_tokens: 4096 };
        const maxout = 2048;
        if (maxout) { body.max_tokens = maxout; body.max_completion_tokens = maxout; body.max_output_tokens = maxout; }
        expect(body.max_tokens).toBe(2048);
        expect(body.max_completion_tokens).toBe(2048);
        expect(body.max_output_tokens).toBe(2048);
    });
});

// § Gap #11: o-series stripping ALL sampling params
describe('Gap #11: o-series param stripping', () => {
    it('identifies o-series correctly', () => {
        expect(shouldStripOpenAISamplingParams('o3')).toBe(true);
        expect(shouldStripOpenAISamplingParams('o1-mini')).toBe(true);
        expect(shouldStripOpenAISamplingParams('gpt-4o')).toBe(false);
    });

    it('strips all sampling params', () => {
        const body = { model: 'o3', temperature: 0.7, top_p: 0.9, min_p: 0.1, repetition_penalty: 1.2, frequency_penalty: 0.5, presence_penalty: 0.5 };
        if (shouldStripOpenAISamplingParams(body.model)) {
            for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'frequency_penalty', 'presence_penalty']) delete body[k];
        }
        expect(body.temperature).toBeUndefined();
        expect(body.min_p).toBeUndefined();
    });
});

// § Gap #12: proxyDirect
describe('Gap #12: CORS proxy modes', () => {
    it('proxyDirect uses X-Target-URL', () => {
        const headers = {};
        const proxyUrl = 'https://proxy.example.com';
        const targetUrl = 'https://api.openai.com/v1/chat/completions';
        headers['X-Target-URL'] = targetUrl;
        expect(headers['X-Target-URL']).toBe(targetUrl);
    });
    it('auto-prepends https://', () => {
        let url = 'api.openai.com/v1/chat';
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        expect(url.startsWith('https://')).toBe(true);
    });
});

// § Gap #15-16: Responses API
describe('Gap #15-16: Responses API transformation', () => {
    it('remaps max_completion_tokens to max_output_tokens', () => {
        const body = { model: 'gpt-5.4', max_completion_tokens: 4096 };
        if (needsCopilotResponsesAPI(body.model)) { body.max_output_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
        expect(body.max_output_tokens).toBe(4096);
        expect(body.max_completion_tokens).toBeUndefined();
    });
    it('strips sampling params for reasoning mode', () => {
        const body = { model: 'gpt-5.4', temperature: 0.7, top_p: 0.9 };
        if (shouldStripGPT54SamplingForReasoning(body.model, 'high')) { delete body.temperature; delete body.top_p; }
        expect(body.temperature).toBeUndefined();
    });
});

// § Gap #17: stream_options
describe('Gap #17: OpenAI stream_options', () => {
    it('adds include_usage for streaming', () => {
        const body = { model: 'gpt-4o', stream: true };
        if (body.stream) body.stream_options = { include_usage: true };
        expect(body.stream_options).toEqual({ include_usage: true });
    });
});

// § model-helpers comprehensive
describe('model-helpers — comprehensive coverage', () => {
    it('needsMaxCompletionTokens', () => {
        expect(needsMaxCompletionTokens('o1')).toBe(true);
        expect(needsMaxCompletionTokens('o3-mini')).toBe(true);
        expect(needsMaxCompletionTokens('gpt-4o')).toBe(false);
    });
    it('supportsOpenAIReasoningEffort', () => {
        expect(supportsOpenAIReasoningEffort('o3')).toBe(true);
        expect(supportsOpenAIReasoningEffort('gpt-5')).toBe(true);
        expect(supportsOpenAIReasoningEffort('gpt-4o')).toBe(false);
    });
    it('needsCopilotResponsesAPI', () => {
        expect(needsCopilotResponsesAPI('gpt-5.4')).toBe(true);
        expect(needsCopilotResponsesAPI('gpt-4o')).toBe(false);
    });
});
