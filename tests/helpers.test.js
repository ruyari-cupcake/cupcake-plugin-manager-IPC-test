/**
 * @file helpers.test.js — 범용 헬퍼 함수 테스트
 *
 * 주의: safeGetArg, safeGetBoolArg, setArg 등은 RisuAI API 의존이므로
 * 순수 함수만 테스트합니다.
 */
import { describe, it, expect, vi } from 'vitest';
import { safeStringify } from '../src/shared/helpers.js';

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
