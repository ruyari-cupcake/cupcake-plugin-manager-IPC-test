/**
 * @file provider-patches.test.js — 프로바이더 패치 통합 테스트
 *
 * 프로바이더 모듈은 RisuAI 런타임 API에 의존하므로
 * 직접 import가 불가합니다. 대신 패치된 로직의 순수 부분을
 * 단위 테스트하고, 키 로직 패턴을 검증합니다.
 */
import { describe, it, expect } from 'vitest';
import { normalizeAwsAnthropicModelId } from '../src/shared/dynamic-models.js';

describe('STB-2: DeepSeek max_tokens clamping logic', () => {
    // Extracted clamping logic from deepseek.js
    function clampDeepSeekMaxTokens(maxTokens, modelId) {
        const isReasoner = /deepseek-reasoner/i.test(modelId);
        const maxTokensLimit = isReasoner ? 65536 : 8192;
        return maxTokens ? Math.min(maxTokens, maxTokensLimit) : undefined;
    }

    it('chat model clamped to 8192', () => {
        expect(clampDeepSeekMaxTokens(10000, 'deepseek-chat')).toBe(8192);
    });

    it('reasoner model clamped to 65536', () => {
        expect(clampDeepSeekMaxTokens(100000, 'deepseek-reasoner')).toBe(65536);
    });

    it('under-limit value passes through (chat)', () => {
        expect(clampDeepSeekMaxTokens(4096, 'deepseek-chat')).toBe(4096);
    });

    it('under-limit value passes through (reasoner)', () => {
        expect(clampDeepSeekMaxTokens(32000, 'deepseek-reasoner')).toBe(32000);
    });

    it('undefined maxTokens returns undefined', () => {
        expect(clampDeepSeekMaxTokens(undefined, 'deepseek-chat')).toBeUndefined();
    });

    it('zero maxTokens returns undefined', () => {
        expect(clampDeepSeekMaxTokens(0, 'deepseek-chat')).toBeUndefined();
    });

    it('DeepSeek-Reasoner case insensitive', () => {
        expect(clampDeepSeekMaxTokens(100000, 'DeepSeek-Reasoner')).toBe(65536);
    });
});

describe('STB-11: Gemini/Vertex/AWS max token clamp parity', () => {
    function clampGeminiMaxTokens(maxTokens, modelId) {
        if (!Number.isFinite(maxTokens)) return maxTokens;
        const limit = /gemini-(?:[3-9]|2\.[5-9])/i.test(String(modelId || '')) ? 65536 : 8192;
        return Math.min(maxTokens, limit);
    }

    function clampClaudeFamilyMaxTokens(maxTokens) {
        return Number.isFinite(maxTokens) ? Math.min(maxTokens, 128000) : maxTokens;
    }

    it('clamps Gemini 2.0/older family to 8192', () => {
        expect(clampGeminiMaxTokens(12000, 'gemini-2.0-flash')).toBe(8192);
    });

    it('clamps Gemini 2.5+ and 3.x family to 65536', () => {
        expect(clampGeminiMaxTokens(100000, 'gemini-2.5-pro')).toBe(65536);
        expect(clampGeminiMaxTokens(100000, 'gemini-3-pro-preview')).toBe(65536);
    });

    it('passes through Gemini values under the model limit', () => {
        expect(clampGeminiMaxTokens(4096, 'gemini-2.0-flash')).toBe(4096);
        expect(clampGeminiMaxTokens(32000, 'gemini-2.5-flash')).toBe(32000);
    });

    it('clamps Claude-family max tokens to 128000', () => {
        expect(clampClaudeFamilyMaxTokens(150000)).toBe(128000);
    });

    it('passes through Claude-family values under limit', () => {
        expect(clampClaudeFamilyMaxTokens(64000)).toBe(64000);
    });

    it('preserves undefined values for optional max token fields', () => {
        expect(clampGeminiMaxTokens(undefined, 'gemini-2.5-pro')).toBeUndefined();
        expect(clampClaudeFamilyMaxTokens(undefined)).toBeUndefined();
    });
});

describe('STB-4: AWS model ID normalization', () => {
    it('adds us. prefix to anthropic models', () => {
        expect(normalizeAwsAnthropicModelId('anthropic.claude-v2')).toBe('us.anthropic.claude-v2');
    });

    it('does not double-prefix', () => {
        expect(normalizeAwsAnthropicModelId('us.anthropic.claude-v2')).toBe('us.anthropic.claude-v2');
    });

    it('does not modify non-anthropic models', () => {
        expect(normalizeAwsAnthropicModelId('amazon.titan-v2')).toBe('amazon.titan-v2');
    });

    it('preserves eu-prefixed inference profiles', () => {
        expect(normalizeAwsAnthropicModelId('eu.anthropic.claude-sonnet-4-6-v1:0')).toBe('eu.anthropic.claude-sonnet-4-6-v1:0');
    });
});

describe('FEAT-1: Model override pattern', () => {
    function getActualModelId(settingValue, defaultId) {
        return (settingValue || '').trim() || defaultId;
    }

    it('uses override when set', () => {
        expect(getActualModelId('custom-model-v2', 'default-model')).toBe('custom-model-v2');
    });

    it('falls back to default when empty', () => {
        expect(getActualModelId('', 'default-model')).toBe('default-model');
    });

    it('falls back to default when undefined', () => {
        expect(getActualModelId(undefined, 'default-model')).toBe('default-model');
    });

    it('falls back to default when null', () => {
        expect(getActualModelId(null, 'default-model')).toBe('default-model');
    });

    it('trims whitespace from override', () => {
        expect(getActualModelId('  custom-model  ', 'default-model')).toBe('custom-model');
    });

    it('whitespace-only falls back to default', () => {
        expect(getActualModelId('   ', 'default-model')).toBe('default-model');
    });
});

describe('STB-10: stream_options pattern', () => {
    function shouldAddStreamOptions(settings) {
        return settings.cpm_streaming_show_token_usage === true || settings.cpm_streaming_show_token_usage === 'true' ||
            settings.cpm_show_token_usage === true || settings.cpm_show_token_usage === 'true';
    }

    function shouldStreamOpenRouter(settings) {
        return settings.cpm_streaming_enabled === true || settings.cpm_streaming_enabled === 'true';
    }

    it('adds when true', () => {
        expect(shouldAddStreamOptions({ cpm_streaming_show_token_usage: true })).toBe(true);
    });

    it('adds when "true"', () => {
        expect(shouldAddStreamOptions({ cpm_streaming_show_token_usage: 'true' })).toBe(true);
    });

    it('does not add when false', () => {
        expect(shouldAddStreamOptions({ cpm_streaming_show_token_usage: false })).toBe(false);
    });

    it('supports legacy temp_repo key', () => {
        expect(shouldAddStreamOptions({ cpm_show_token_usage: true })).toBe(true);
    });

    it('does not add when missing', () => {
        expect(shouldAddStreamOptions({})).toBe(false);
    });

    it('OpenRouter streaming follows global streaming flag', () => {
        expect(shouldStreamOpenRouter({ cpm_streaming_enabled: true })).toBe(true);
        expect(shouldStreamOpenRouter({ cpm_streaming_enabled: 'true' })).toBe(true);
        expect(shouldStreamOpenRouter({ cpm_streaming_enabled: false })).toBe(false);
    });
});

describe('FEAT-6: OpenRouter reasoning.max_tokens pattern', () => {
    function buildReasoningObject(reasoningEffort, maxTokens) {
        if (!reasoningEffort || reasoningEffort === 'none' || reasoningEffort === 'off') return null;
        const obj = { effort: reasoningEffort };
        if (maxTokens) obj.max_tokens = maxTokens;
        return obj;
    }

    it('includes max_tokens when provided', () => {
        const r = buildReasoningObject('high', 4096);
        expect(r).toEqual({ effort: 'high', max_tokens: 4096 });
    });

    it('omits max_tokens when 0/undefined', () => {
        const r = buildReasoningObject('medium', 0);
        expect(r).toEqual({ effort: 'medium' });
    });

    it('returns null for "none"', () => {
        expect(buildReasoningObject('none', 4096)).toBeNull();
    });

    it('returns null for "off"', () => {
        expect(buildReasoningObject('off', 4096)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(buildReasoningObject('', 4096)).toBeNull();
    });
});

describe('FEAT-8: Gemini usePlainFetch pattern', () => {
    function shouldUsePlainFetch(settings) {
        return settings.chat_gemini_usePlainFetch === true || settings.chat_gemini_usePlainFetch === 'true';
    }

    it('true when boolean true', () => {
        expect(shouldUsePlainFetch({ chat_gemini_usePlainFetch: true })).toBe(true);
    });

    it('true when string "true"', () => {
        expect(shouldUsePlainFetch({ chat_gemini_usePlainFetch: 'true' })).toBe(true);
    });

    it('false when unset', () => {
        expect(shouldUsePlainFetch({})).toBe(false);
    });
});

describe('STB-1: Vertex region fallback pattern', () => {
    it('generates correct fallback regions excluding current', () => {
        const location = 'us-central1';
        const all = ['us-central1', 'us-east4', 'europe-west1', 'asia-northeast1'];
        const fallback = all.filter(r => r !== location);
        expect(fallback).toEqual(['us-east4', 'europe-west1', 'asia-northeast1']);
        expect(fallback).not.toContain('us-central1');
    });

    it('includes all regions when current is not in list', () => {
        const location = 'global';
        const all = ['us-central1', 'us-east4', 'europe-west1', 'asia-northeast1'];
        const fallback = all.filter(r => r !== location);
        expect(fallback).toHaveLength(4);
    });
});
