/**
 * @file gemini-helpers.test.js — Gemini 유틸리티 테스트
 */
import { describe, it, expect } from 'vitest';
import {
    getGeminiSafetySettings,
    validateGeminiParams,
    geminiSupportsPenalty,
    cleanExperimentalModelParams,
    buildGeminiThinkingConfig,
} from '../src/shared/gemini-helpers.js';

describe('getGeminiSafetySettings', () => {
    it('5개 안전 카테고리 반환', () => {
        const settings = getGeminiSafetySettings();
        expect(settings).toHaveLength(5);
    });

    it('모든 threshold가 OFF', () => {
        const settings = getGeminiSafetySettings();
        for (const s of settings) {
            expect(s.threshold).toBe('OFF');
        }
    });

    it('각 카테고리 HARM_CATEGORY_ 접두사', () => {
        const settings = getGeminiSafetySettings();
        for (const s of settings) {
            expect(s.category).toMatch(/^HARM_CATEGORY_/);
        }
    });

    it('필수 카테고리 포함: HATE_SPEECH, DANGEROUS_CONTENT, HARASSMENT, SEXUALLY_EXPLICIT, CIVIC_INTEGRITY', () => {
        const settings = getGeminiSafetySettings();
        const categories = settings.map(s => s.category);
        expect(categories).toContain('HARM_CATEGORY_HATE_SPEECH');
        expect(categories).toContain('HARM_CATEGORY_DANGEROUS_CONTENT');
        expect(categories).toContain('HARM_CATEGORY_HARASSMENT');
        expect(categories).toContain('HARM_CATEGORY_SEXUALLY_EXPLICIT');
        expect(categories).toContain('HARM_CATEGORY_CIVIC_INTEGRITY');
    });

    // H-7: model-aware safety settings
    it('flash-lite 모델은 CIVIC_INTEGRITY 제외', () => {
        const settings = getGeminiSafetySettings('gemini-2.0-flash-lite');
        const categories = settings.map(s => s.category);
        expect(categories).not.toContain('HARM_CATEGORY_CIVIC_INTEGRITY');
        expect(settings).toHaveLength(4);
    });

    it('exp 모델은 CIVIC_INTEGRITY 제외 (2.0-pro-exp)', () => {
        const settings = getGeminiSafetySettings('gemini-2.0-pro-exp');
        const categories = settings.map(s => s.category);
        expect(categories).not.toContain('HARM_CATEGORY_CIVIC_INTEGRITY');
    });

    it('일반 gemini-2.5-flash는 CIVIC_INTEGRITY 포함', () => {
        const settings = getGeminiSafetySettings('gemini-2.5-flash');
        const categories = settings.map(s => s.category);
        expect(categories).toContain('HARM_CATEGORY_CIVIC_INTEGRITY');
        expect(settings).toHaveLength(5);
    });
});

describe('validateGeminiParams', () => {
    it('정상 범위 값은 변경 없음', () => {
        const gc = { temperature: 1.0, topP: 0.5, topK: 20 };
        validateGeminiParams(gc);
        expect(gc.temperature).toBe(1.0);
        expect(gc.topP).toBe(0.5);
        expect(gc.topK).toBe(20);
    });

    it('temperature 초과 → 기본값 1로 대체', () => {
        const gc = { temperature: 5.0 };
        validateGeminiParams(gc);
        expect(gc.temperature).toBe(1);
    });

    it('temperature 미만(음수) → 기본값 1로 대체', () => {
        const gc = { temperature: -1 };
        validateGeminiParams(gc);
        expect(gc.temperature).toBe(1);
    });

    it('topP 범위 초과 → 삭제', () => {
        const gc = { topP: 1.5 };
        validateGeminiParams(gc);
        expect(gc.topP).toBeUndefined();
    });

    it('topK 비정수 → 삭제', () => {
        const gc = { topK: 3.5 };
        validateGeminiParams(gc);
        expect(gc.topK).toBeUndefined();
    });

    it('frequencyPenalty 경계값 ≥2 → 삭제 (배타적 상한)', () => {
        const gc = { frequencyPenalty: 2 };
        validateGeminiParams(gc);
        expect(gc.frequencyPenalty).toBeUndefined();
    });

    it('null/undefined 입력 → 에러 없음', () => {
        expect(() => validateGeminiParams(null)).not.toThrow();
        expect(() => validateGeminiParams(undefined)).not.toThrow();
    });

    it('존재하지 않는 키 → 무시', () => {
        const gc = { customField: 999 };
        validateGeminiParams(gc);
        expect(gc.customField).toBe(999);
    });
});

describe('geminiSupportsPenalty', () => {
    it('일반 모델 → true', () => {
        expect(geminiSupportsPenalty('gemini-2.5-pro')).toBe(true);
        expect(geminiSupportsPenalty('gemini-2.5-flash')).toBe(true);
    });

    it('실험적 모델 → false', () => {
        expect(geminiSupportsPenalty('gemini-2.5-pro-exp-0827')).toBe(false);
        expect(geminiSupportsPenalty('gemini-experimental')).toBe(false);
    });

    it('flash-lite → false', () => {
        expect(geminiSupportsPenalty('gemini-2.5-flash-lite')).toBe(false);
    });

    it('nano → false', () => {
        expect(geminiSupportsPenalty('gemini-nano')).toBe(false);
    });

    it('embedding 모델 → false', () => {
        expect(geminiSupportsPenalty('text-embedding-004')).toBe(false);
    });

    it('빈/null → false', () => {
        expect(geminiSupportsPenalty('')).toBe(false);
        expect(geminiSupportsPenalty(null)).toBe(false);
    });
});

describe('cleanExperimentalModelParams', () => {
    it('미지원 모델 → penalty 삭제', () => {
        const gc = { frequencyPenalty: 0.5, presencePenalty: 0.3 };
        cleanExperimentalModelParams(gc, 'gemini-2.5-pro-exp-0827');
        expect(gc.frequencyPenalty).toBeUndefined();
        expect(gc.presencePenalty).toBeUndefined();
    });

    it('지원 모델 + 값 0 → 삭제 (불필요한 기본값 정리)', () => {
        const gc = { frequencyPenalty: 0, presencePenalty: 0 };
        cleanExperimentalModelParams(gc, 'gemini-2.5-pro');
        expect(gc.frequencyPenalty).toBeUndefined();
        expect(gc.presencePenalty).toBeUndefined();
    });

    it('지원 모델 + 비제로 값 → 유지', () => {
        const gc = { frequencyPenalty: 0.5, presencePenalty: 0.3 };
        cleanExperimentalModelParams(gc, 'gemini-2.5-pro');
        expect(gc.frequencyPenalty).toBe(0.5);
        expect(gc.presencePenalty).toBe(0.3);
    });
});

describe('buildGeminiThinkingConfig', () => {
    it('Gemini 3 + level → 올바른 config', () => {
        const config = buildGeminiThinkingConfig('gemini-3-pro-preview', 'medium', 0, false);
        expect(config).not.toBeNull();
        expect(config.includeThoughts).toBe(true);
        expect(config.thinkingLevel).toBe('medium');
    });

    it('Gemini 3 + Vertex → thinking_level 스네이크케이스', () => {
        const config = buildGeminiThinkingConfig('gemini-3-pro-preview', 'high', 0, true);
        expect(config.thinking_level).toBe('high');
    });

    it('Gemini 3 + off → null', () => {
        const config = buildGeminiThinkingConfig('gemini-3-pro-preview', 'off', 0, false);
        expect(config).toBeNull();
    });

    it('Gemini 2.5 + budget → thinkingBudget', () => {
        const config = buildGeminiThinkingConfig('gemini-2.5-pro', 'medium', 10240, false);
        expect(config.thinkingBudget).toBe(10240);
        expect(config.includeThoughts).toBe(true);
    });

    it('Gemini 2.5 + level (no budget) → 매핑된 budget', () => {
        const config = buildGeminiThinkingConfig('gemini-2.5-pro', 'high', 0, false);
        expect(config.thinkingBudget).toBe(24576);
    });

    it('Gemini 2.5 + off → thinkingBudget: 0', () => {
        const config = buildGeminiThinkingConfig('gemini-2.5-pro', 'off', 0, false);
        expect(config).toEqual({ thinkingBudget: 0 });
    });

    it('level/budget 모두 없음 → null', () => {
        const config = buildGeminiThinkingConfig('gemini-2.5-pro', null, 0, false);
        expect(config).toBeNull();
    });
});
