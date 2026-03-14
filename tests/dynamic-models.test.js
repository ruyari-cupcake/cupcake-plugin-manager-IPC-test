import { describe, it, expect } from 'vitest';
import {
    formatOpenAIDynamicModels,
    formatAnthropicDynamicModels,
    formatGeminiDynamicModels,
    formatDeepSeekDynamicModels,
    formatOpenRouterDynamicModels,
    normalizeAwsAnthropicModelId,
    formatAwsDynamicModels,
    formatVertexGoogleModels,
    formatVertexClaudeModels,
    mergeDynamicModels,
} from '../src/shared/dynamic-models.js';

describe('formatOpenAIDynamicModels', () => {
    it('filters non-chat models and formats names', () => {
        const result = formatOpenAIDynamicModels([
            { id: 'gpt-5.4-2026-03-05' },
            { id: 'chatgpt-4o-latest' },
            { id: 'text-embedding-3-large' },
            { id: 'gpt-4o-realtime-preview' },
        ]);
        expect(result.map((m) => m.id)).toEqual(['gpt-5.4-2026-03-05', 'chatgpt-4o-latest']);
        expect(result[0].name).toBe('GPT-5.4 (2026/03/05)');
        expect(result[1].name).toBe('ChatGPT-4o (Latest)');
    });
});

describe('formatAnthropicDynamicModels', () => {
    it('keeps only model entries and appends compact date suffix', () => {
        const result = formatAnthropicDynamicModels([
            { type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude 4.5 Sonnet' },
            { type: 'other', id: 'skip-me' },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Claude 4.5 Sonnet (2025/09/29)');
    });
});

describe('formatGeminiDynamicModels', () => {
    it('keeps only gemini generateContent models', () => {
        const result = formatGeminiDynamicModels([
            { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-2.0-flash', supportedGenerationMethods: [] },
        ]);
        expect(result).toEqual([
            { uniqueId: 'google-gemini-2.5-pro', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'GoogleAI' },
        ]);
    });
});

describe('formatDeepSeekDynamicModels', () => {
    it('formats DeepSeek names', () => {
        const result = formatDeepSeekDynamicModels([{ id: 'deepseek-reasoner' }]);
        expect(result[0].name).toBe('DeepSeek Reasoner');
    });
});

describe('formatOpenRouterDynamicModels', () => {
    it('maps OpenRouter model IDs', () => {
        const result = formatOpenRouterDynamicModels([{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }]);
        expect(result[0]).toEqual({
            uniqueId: 'openrouter-anthropic/claude-sonnet-4',
            id: 'anthropic/claude-sonnet-4',
            name: 'Claude Sonnet 4',
            provider: 'OpenRouter',
        });
    });
});

describe('normalizeAwsAnthropicModelId', () => {
    it('uses global prefix for Claude 4.5+ dates', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-4-5-sonnet-20250929-v1:0')).toBe('global.anthropic.claude-4-5-sonnet-20250929-v1:0');
    });

    it('uses us prefix for older models', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-4-sonnet-20250514-v1:0')).toBe('us.anthropic.claude-4-sonnet-20250514-v1:0');
    });

    it('preserves existing eu prefix', () => {
        expect(normalizeAwsAnthropicModelId('eu.anthropic.claude-sonnet-4-6-v1:0')).toBe('eu.anthropic.claude-sonnet-4-6-v1:0');
    });
});

describe('formatAwsDynamicModels', () => {
    it('filters model summaries and adds cross-region profiles', () => {
        const result = formatAwsDynamicModels(
            [
                {
                    modelId: 'anthropic.claude-4-5-sonnet-20250929-v1:0',
                    modelName: 'Claude Sonnet 4.5',
                    providerName: 'Anthropic',
                    outputModalities: ['TEXT'],
                    inferenceTypesSupported: ['ON_DEMAND'],
                },
                {
                    modelId: 'amazon.titan-image',
                    modelName: 'Titan Image',
                    providerName: 'Amazon',
                    outputModalities: ['IMAGE'],
                    inferenceTypesSupported: ['ON_DEMAND'],
                },
            ],
            [
                { inferenceProfileId: 'global.anthropic.claude-opus-4-6-v1:0', inferenceProfileName: 'Claude Opus 4.6' },
            ],
        );
        expect(result.map((m) => m.id)).toEqual([
            'global.anthropic.claude-4-5-sonnet-20250929-v1:0',
            'global.anthropic.claude-opus-4-6-v1:0',
        ]);
    });
});

describe('formatVertex*DynamicModels', () => {
    it('formats Vertex Google and Claude models', () => {
        const google = formatVertexGoogleModels([
            { name: 'publishers/google/models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedActions: ['generateContent'] },
            { name: 'publishers/google/models/embedding-001', supportedActions: ['embedContent'] },
        ]);
        const claude = formatVertexClaudeModels([
            { name: 'projects/x/locations/global/publishers/anthropic/models/claude-sonnet-4-5-20250929', displayName: 'Claude 4.5 Sonnet' },
        ]);
        expect(google).toHaveLength(1);
        expect(claude[0].name).toContain('2025/09/29');
    });
});

describe('mergeDynamicModels', () => {
    it('deduplicates by uniqueId and tracks newly added models', () => {
        const existing = [
            { uniqueId: 'openai-gpt-4.1', id: 'gpt-4.1', name: 'GPT-4.1' },
        ];
        const incoming = [
            { uniqueId: 'openai-gpt-4.1', id: 'gpt-4.1', name: 'GPT-4.1 Updated' },
            { uniqueId: 'openai-gpt-5.4', id: 'gpt-5.4', name: 'GPT-5.4' },
        ];
        const result = mergeDynamicModels(existing, incoming, 'OpenAI');
        expect(result.mergedModels).toHaveLength(2);
        expect(result.addedModels).toEqual([
            { uniqueId: 'openai-gpt-5.4', id: 'gpt-5.4', name: 'GPT-5.4', provider: 'OpenAI' },
        ]);
        expect(result.mergedModels.find((m) => m.uniqueId === 'openai-gpt-4.1')?.name).toBe('GPT-4.1 Updated');
    });
});
