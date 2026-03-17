/**
 * @file helpers.test.js — 범용 헬퍼 함수 테스트
 *
 * 주의: safeGetArg, safeGetBoolArg, setArg 등은 RisuAI API 의존이므로
 * 순수 함수만 테스트합니다.
 */
import { describe, it, expect } from 'vitest';
import { safeStringify, shouldEnableStreaming, isCompatibilityModeSettingEnabled } from '../src/shared/helpers.js';

describe('safeStringify', () => {
    it('기본 JSON 직렬화', () => {
        const result = safeStringify({ a: 1, b: 'hello' });
        expect(JSON.parse(result)).toEqual({ a: 1, b: 'hello' });
    });

    it('배열 내 null 요소 필터링', () => {
        const obj = { items: [1, null, 2, null, 3] };
        const result = JSON.parse(safeStringify(obj));
        expect(result.items).toEqual([1, 2, 3]);
    });

    it('중첩 배열 내 null 필터링', () => {
        const obj = { a: { b: [null, { c: [null, 1] }] } };
        const result = JSON.parse(safeStringify(obj));
        expect(result.a.b).toHaveLength(1);
        expect(result.a.b[0].c).toEqual([1]);
    });

    it('빈 배열 → 빈 배열', () => {
        expect(JSON.parse(safeStringify({ arr: [] }))).toEqual({ arr: [] });
    });

    it('비배열 값은 변경 없음', () => {
        const result = JSON.parse(safeStringify({ str: 'hello', num: 42, bool: true }));
        expect(result.str).toBe('hello');
        expect(result.num).toBe(42);
        expect(result.bool).toBe(true);
    });

    it('null 최상위 값', () => {
        expect(safeStringify(null)).toBe('null');
    });

    it('문자열 값', () => {
        expect(safeStringify('test')).toBe('"test"');
    });
});

describe('compatibility streaming helpers', () => {
    it('detects compatibility mode booleans from persisted values', () => {
        expect(isCompatibilityModeSettingEnabled(true)).toBe(true);
        expect(isCompatibilityModeSettingEnabled('true')).toBe(true);
        expect(isCompatibilityModeSettingEnabled('on')).toBe(true);
        expect(isCompatibilityModeSettingEnabled('false')).toBe(false);
        expect(isCompatibilityModeSettingEnabled(undefined)).toBe(false);
    });

    it('disables general-provider streaming when compatibility mode is enabled', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: true })).toBe(false);
    });

    it('keeps Copilot streaming enabled even in compatibility mode', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: true, cpm_compatibility_mode: true }, { isCopilot: true })).toBe(true);
    });

    it('returns false when streaming is globally disabled', () => {
        expect(shouldEnableStreaming({ cpm_streaming_enabled: false, cpm_compatibility_mode: false }, { isCopilot: true })).toBe(false);
    });
});
