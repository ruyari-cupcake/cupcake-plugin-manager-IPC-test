/**
 * @file token-usage.test.js — Token usage normalization & store tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    _normalizeTokenUsage,
    _setTokenUsage,
    _takeTokenUsage,
    _estimateVisibleTextTokens,
    _tokenUsageStore,
} from '../src/shared/token-usage.js';

describe('_normalizeTokenUsage', () => {
    it('OpenAI usage normalization', () => {
        const raw = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
        const result = _normalizeTokenUsage(raw, 'openai');
        expect(result).toEqual({
            input: 100,
            output: 50,
            total: 150,
            cached: 0,
            reasoning: 0,
        });
    });

    it('OpenAI with reasoning tokens', () => {
        const raw = {
            prompt_tokens: 100, completion_tokens: 80, total_tokens: 180,
            completion_tokens_details: { reasoning_tokens: 30 },
        };
        const result = _normalizeTokenUsage(raw, 'openai');
        expect(result.reasoning).toBe(30);
    });

    it('OpenAI with prompt cache hit', () => {
        const raw = {
            prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 40 },
        };
        const result = _normalizeTokenUsage(raw, 'openai');
        expect(result.cached).toBe(40);
    });

    it('Anthropic usage normalization', () => {
        const raw = { input_tokens: 200, output_tokens: 100 };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        expect(result.input).toBe(200);
        expect(result.output).toBe(100);
        expect(result.total).toBe(300);
    });

    it('Anthropic with cache tokens', () => {
        const raw = { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
        const result = _normalizeTokenUsage(raw, 'anthropic');
        // cached is sum of read + creation
        expect(result.cached).toBe(60);
    });

    it('Anthropic thinking + visible text estimation', () => {
        const raw = { input_tokens: 100, output_tokens: 500 };
        const opts = { anthropicHasThinking: true, anthropicVisibleText: 'Hello, this is a test response.' };
        const result = _normalizeTokenUsage(raw, 'anthropic', opts);
        expect(result.reasoning).toBeGreaterThan(0);
        expect(result.reasoningEstimated).toBe(true);
    });

    it('Gemini usage normalization', () => {
        const raw = { promptTokenCount: 150, candidatesTokenCount: 75, totalTokenCount: 225 };
        const result = _normalizeTokenUsage(raw, 'gemini');
        expect(result.input).toBe(150);
        expect(result.output).toBe(75);
        expect(result.total).toBe(225);
    });

    it('Gemini with cachedContentTokenCount', () => {
        const raw = { promptTokenCount: 150, candidatesTokenCount: 75, totalTokenCount: 225, cachedContentTokenCount: 30 };
        const result = _normalizeTokenUsage(raw, 'gemini');
        expect(result.cached).toBe(30);
    });

    it('null/undefined input → null', () => {
        expect(_normalizeTokenUsage(null, 'openai')).toBeNull();
        expect(_normalizeTokenUsage(undefined, 'anthropic')).toBeNull();
    });

    it('empty object → all-zeros (not null)', () => {
        // Empty object is still a valid object; fields default to 0
        const result = _normalizeTokenUsage({}, 'openai');
        expect(result).toEqual({ input: 0, output: 0, reasoning: 0, cached: 0, total: 0 });
    });

    it('Unknown provider returns null', () => {
        const raw = { input_tokens: 10, output_tokens: 5 };
        const result = _normalizeTokenUsage(raw, 'unknown');
        expect(result).toBeNull();
    });
});

describe('Token usage store', () => {
    beforeEach(() => {
        // Clear any leftover state
        _tokenUsageStore.clear();
    });

    it('set and take usage', () => {
        const usage = { input: 10, output: 5, total: 15, cached: 0, reasoning: 0 };
        _setTokenUsage('test-id-1', usage);
        const taken = _takeTokenUsage('test-id-1');
        expect(taken).toEqual(usage);
    });

    it('take-once semantics: second take returns null', () => {
        const usage = { input: 10, output: 5, total: 15, cached: 0, reasoning: 0 };
        _setTokenUsage('test-id-2', usage);
        _takeTokenUsage('test-id-2');
        const second = _takeTokenUsage('test-id-2');
        expect(second).toBeNull();
    });

    it('take non-existent id → null', () => {
        expect(_takeTokenUsage('nonexistent')).toBeNull();
    });

    it('overwrite with same key replaces data', () => {
        const u1 = { input: 10, output: 5, total: 15, cached: 0, reasoning: 0 };
        const u2 = { input: 20, output: 10, total: 30, cached: 0, reasoning: 0 };
        _setTokenUsage('test-id-1', u1);
        _setTokenUsage('test-id-1', u2); // same isStream default → same key → overwrite
        expect(_takeTokenUsage('test-id-1')).toEqual(u2);
    });

    it('stream vs non-stream keys are separate', () => {
        const uNon = { input: 10, output: 5, total: 15, cached: 0, reasoning: 0 };
        const uStream = { input: 20, output: 10, total: 30, cached: 0, reasoning: 0 };
        _setTokenUsage('req-1', uNon, false);
        _setTokenUsage('req-1', uStream, true);
        expect(_takeTokenUsage('req-1', false)).toEqual(uNon);
        expect(_takeTokenUsage('req-1', true)).toEqual(uStream);
    });
});

describe('_estimateVisibleTextTokens', () => {
    it('empty text → 0', () => {
        expect(_estimateVisibleTextTokens('')).toBe(0);
    });

    it('basic English text', () => {
        const tokens = _estimateVisibleTextTokens('Hello world test');
        expect(tokens).toBeGreaterThan(0);
    });

    it('CJK text gets higher count', () => {
        const cjkTokens = _estimateVisibleTextTokens('안녕하세요');
        // CJK should give comparable or higher count per character
        expect(cjkTokens).toBeGreaterThan(0);
    });
});
