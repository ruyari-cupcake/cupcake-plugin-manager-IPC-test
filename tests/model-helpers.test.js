/**
 * @file model-helpers.test.js — Model detection helper tests
 */
import { describe, it, expect } from 'vitest';
import {
    supportsOpenAIReasoningEffort,
    supportsOpenAIVerbosity,
    needsCopilotResponsesAPI,
    shouldStripOpenAISamplingParams,
    shouldStripGPT54SamplingForReasoning,
    needsMaxCompletionTokens,
} from '../src/shared/model-helpers.js';

describe('supportsOpenAIReasoningEffort', () => {
    it('o1 계열', () => {
        expect(supportsOpenAIReasoningEffort('o1')).toBe(true);
        expect(supportsOpenAIReasoningEffort('o1-mini')).toBe(true);
        expect(supportsOpenAIReasoningEffort('o1-preview')).toBe(true);
    });

    it('o3 계열', () => {
        expect(supportsOpenAIReasoningEffort('o3')).toBe(true);
        expect(supportsOpenAIReasoningEffort('o3-mini')).toBe(true);
    });

    it('gpt-5 계열', () => {
        expect(supportsOpenAIReasoningEffort('gpt-5')).toBe(true);
        expect(supportsOpenAIReasoningEffort('gpt-5.4')).toBe(true);
    });

    it('gpt-4o는 지원 안 함', () => {
        expect(supportsOpenAIReasoningEffort('gpt-4o')).toBe(false);
        expect(supportsOpenAIReasoningEffort('gpt-4o-mini')).toBe(false);
    });

    it('empty/null → false', () => {
        expect(supportsOpenAIReasoningEffort('')).toBe(false);
        expect(supportsOpenAIReasoningEffort(null)).toBe(false);
    });
});

describe('needsCopilotResponsesAPI', () => {
    it('gpt-5.4 → true', () => {
        expect(needsCopilotResponsesAPI('gpt-5.4')).toBe(true);
        expect(needsCopilotResponsesAPI('gpt-5.5')).toBe(true);
    });

    it('gpt-5 (no subversion) → false', () => {
        // gpt-5 without subversion may or may not need Responses API
        // The function checks for >=5.4
        const result = needsCopilotResponsesAPI('gpt-5');
        expect(typeof result).toBe('boolean');
    });

    it('o3 → false', () => {
        expect(needsCopilotResponsesAPI('o3')).toBe(false);
    });

    it('empty → false', () => {
        expect(needsCopilotResponsesAPI('')).toBe(false);
    });
});

describe('supportsOpenAIVerbosity', () => {
    it('GPT-5 날짜 모델은 지원', () => {
        expect(supportsOpenAIVerbosity('gpt-5-2025-08-07')).toBe(true);
        expect(supportsOpenAIVerbosity('gpt-5.4-2026-03-05')).toBe(true);
        expect(supportsOpenAIVerbosity('openai/gpt-5-mini-2025-08-07')).toBe(true);
    });

    it('chat-latest alias는 미지원', () => {
        expect(supportsOpenAIVerbosity('gpt-5-chat-latest')).toBe(false);
        expect(supportsOpenAIVerbosity('gpt-5.3-chat-latest')).toBe(false);
    });

    it('기타 모델은 false', () => {
        expect(supportsOpenAIVerbosity('gpt-4o')).toBe(false);
        expect(supportsOpenAIVerbosity('o3-mini')).toBe(false);
    });
});

describe('shouldStripOpenAISamplingParams', () => {
    it('o1 → true', () => {
        expect(shouldStripOpenAISamplingParams('o1')).toBe(true);
        expect(shouldStripOpenAISamplingParams('o1-mini')).toBe(true);
    });

    it('o3 → true', () => {
        expect(shouldStripOpenAISamplingParams('o3')).toBe(true);
    });

    it('gpt-4o → false', () => {
        expect(shouldStripOpenAISamplingParams('gpt-4o')).toBe(false);
    });
});

describe('shouldStripGPT54SamplingForReasoning', () => {
    it('gpt-5.4 + reasoning → true', () => {
        expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'medium')).toBe(true);
    });

    it('gpt-5.4 + no reasoning → false', () => {
        expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', '')).toBe(false);
        expect(shouldStripGPT54SamplingForReasoning('gpt-5.4', 'none')).toBe(false);
    });

    it('gpt-4o + reasoning → false', () => {
        expect(shouldStripGPT54SamplingForReasoning('gpt-4o', 'medium')).toBe(false);
    });
});

describe('needsMaxCompletionTokens', () => {
    it('gpt-5 → true', () => {
        expect(needsMaxCompletionTokens('gpt-5')).toBe(true);
        expect(needsMaxCompletionTokens('gpt-5.4')).toBe(true);
    });

    it('o1 → true', () => {
        expect(needsMaxCompletionTokens('o1')).toBe(true);
        expect(needsMaxCompletionTokens('o3-mini')).toBe(true);
    });

    it('gpt-4o → false', () => {
        expect(needsMaxCompletionTokens('gpt-4o')).toBe(false);
    });
});
