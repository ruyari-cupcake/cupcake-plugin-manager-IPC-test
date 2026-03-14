/**
 * @file key-pool.test.js — KeyPool 단위 테스트
 */
import { describe, it, expect, vi } from 'vitest';
import { KeyPool } from '../src/shared/key-pool.js';

describe('KeyPool', () => {
    describe('constructor', () => {
        it('공백 구분 키 파싱', () => {
            const pool = new KeyPool('key1 key2 key3');
            expect(pool.remaining).toBe(3);
        });

        it('빈 문자열 → 키 0개', () => {
            const pool = new KeyPool('');
            expect(pool.remaining).toBe(0);
        });

        it('null/undefined 안전 처리', () => {
            expect(new KeyPool(null).remaining).toBe(0);
            expect(new KeyPool(undefined).remaining).toBe(0);
        });

        it('줄바꿈·탭 구분 키 파싱', () => {
            const pool = new KeyPool('key1\nkey2\tkey3');
            expect(pool.remaining).toBe(3);
        });

        it('중복 공백 무시', () => {
            const pool = new KeyPool('  key1   key2  ');
            expect(pool.remaining).toBe(2);
        });
    });

    describe('pick', () => {
        it('키 풀에서 키 하나 반환', () => {
            const pool = new KeyPool('only-key');
            expect(pool.pick()).toBe('only-key');
        });

        it('빈 풀에서 빈 문자열 반환', () => {
            const pool = new KeyPool('');
            expect(pool.pick()).toBe('');
        });

        it('풀 내 키 중 하나를 반환', () => {
            const pool = new KeyPool('a b c');
            const key = pool.pick();
            expect(['a', 'b', 'c']).toContain(key);
        });
    });

    describe('drain', () => {
        it('실패한 키 제거', () => {
            const pool = new KeyPool('a b c');
            const remaining = pool.drain('b');
            expect(remaining).toBe(2);
            expect(pool.remaining).toBe(2);
        });

        it('존재하지 않는 키 drain → 변화 없음', () => {
            const pool = new KeyPool('a b');
            const remaining = pool.drain('z');
            expect(remaining).toBe(2);
        });

        it('마지막 키 drain → 0 반환', () => {
            const pool = new KeyPool('only');
            expect(pool.drain('only')).toBe(0);
            expect(pool.remaining).toBe(0);
        });
    });

    describe('withRotation', () => {
        it('첫 시도 성공 → 즉시 반환', async () => {
            const pool = new KeyPool('key1 key2');
            const fetchFn = vi.fn().mockResolvedValue({ success: true, content: 'ok' });

            const result = await pool.withRotation(fetchFn);
            expect(result.success).toBe(true);
            expect(fetchFn).toHaveBeenCalledTimes(1);
        });

        it('429 에러 → 키 회전 후 재시도', async () => {
            const pool = new KeyPool('key1 key2');
            const fetchFn = vi.fn()
                .mockResolvedValueOnce({ success: false, _status: 429 })
                .mockResolvedValue({ success: true, content: 'ok' });

            const result = await pool.withRotation(fetchFn);
            expect(result.success).toBe(true);
            expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
        });

        it('비재시도 에러 → 즉시 반환', async () => {
            const pool = new KeyPool('key1 key2');
            const fetchFn = vi.fn()
                .mockResolvedValue({ success: false, _status: 401, content: 'bad key' });

            const result = await pool.withRotation(fetchFn);
            expect(result.success).toBe(false);
            expect(fetchFn).toHaveBeenCalledTimes(1);
        });

        it('모든 키 소진 → 마지막 에러 반환', async () => {
            const pool = new KeyPool('key1');
            const fetchFn = vi.fn()
                .mockResolvedValue({ success: false, _status: 429 });

            const result = await pool.withRotation(fetchFn);
            expect(result.success).toBe(false);
        });

        it('빈 풀 → 키 없음 메시지', async () => {
            const pool = new KeyPool('');
            const fetchFn = vi.fn();

            const result = await pool.withRotation(fetchFn);
            expect(result.success).toBe(false);
            expect(result.content).toContain('키 없음');
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('커스텀 isRetryable 함수', async () => {
            const pool = new KeyPool('a b c');
            const fetchFn = vi.fn()
                .mockResolvedValueOnce({ success: false, _status: 500, _custom: true })
                .mockResolvedValue({ success: true, content: 'ok' });

            const result = await pool.withRotation(fetchFn, {
                isRetryable: (r) => r._custom === true,
            });
            expect(result.success).toBe(true);
        });

        it('최대 재시도 횟수 초과', async () => {
            const pool = new KeyPool('a b c d e f g h i j k l m n o');
            const fetchFn = vi.fn().mockResolvedValue({ success: false, _status: 429 });

            const result = await pool.withRotation(fetchFn, { maxRetries: 3 });
            expect(result.success).toBe(false);
            expect(result.content).toContain('3');
        });
    });

    describe('reset (M-8)', () => {
        it('소진 후 원본 키 복원', () => {
            const pool = new KeyPool('a b c');
            pool.drain('a');
            pool.drain('b');
            pool.drain('c');
            expect(pool.remaining).toBe(0);
            pool.reset();
            expect(pool.remaining).toBe(3);
        });

        it('부분 소진 후 복원', () => {
            const pool = new KeyPool('x y');
            pool.drain('x');
            expect(pool.remaining).toBe(1);
            pool.reset();
            expect(pool.remaining).toBe(2);
        });

        it('withRotation에서 모든 키 소진 시 자동 reset', async () => {
            const pool = new KeyPool('key1');
            const fetchFn = vi.fn().mockResolvedValue({ success: false, _status: 429 });
            await pool.withRotation(fetchFn);
            // After exhaustion, keys should be restored
            expect(pool.remaining).toBe(1);
        });
    });

    describe('fromJson', () => {
        it('JSON 배열 → 각 객체를 문자열 키로', () => {
            const pool = KeyPool.fromJson('[{"project_id":"p1"},{"project_id":"p2"}]');
            expect(pool.remaining).toBe(2);
        });

        it('단일 JSON 객체 → 1개 키', () => {
            const pool = KeyPool.fromJson('{"project_id":"p1","private_key":"xxx"}');
            expect(pool.remaining).toBe(1);
        });

        it('빈 입력 → 빈 풀', () => {
            expect(KeyPool.fromJson('').remaining).toBe(0);
            expect(KeyPool.fromJson(null).remaining).toBe(0);
        });

        it('유효하지 않은 JSON → 빈 풀', () => {
            const pool = KeyPool.fromJson('not-json');
            expect(pool.remaining).toBe(0);
        });

        it('빈 배열 → 빈 풀', () => {
            const pool = KeyPool.fromJson('[]');
            expect(pool.remaining).toBe(0);
        });

        it('배열 내 비객체 필터링', () => {
            const pool = KeyPool.fromJson('[null, "str", {"id":"ok"}, 42]');
            expect(pool.remaining).toBe(1);
        });

        // M-1: comma-separated JSON fallback
        it('쉼표 구분 JSON 객체 파싱', () => {
            const pool = KeyPool.fromJson('{"project_id":"p1"},{"project_id":"p2"}');
            expect(pool.remaining).toBe(2);
            const key0 = JSON.parse(pool.pick());
            expect(key0.project_id).toBeDefined();
        });

        it('쉼표 구분 단일 객체 (대괄호 없이)', () => {
            const pool = KeyPool.fromJson('{"id":"single"}');
            expect(pool.remaining).toBe(1);
        });

        it('fromJson 생성 후 _originalKeys 보존', () => {
            const pool = KeyPool.fromJson('[{"a":1},{"b":2}]');
            pool.drain(pool.pick());
            expect(pool.remaining).toBeLessThan(2);
            pool.reset();
            expect(pool.remaining).toBe(2);
        });
    });

    // M-2: name parameter
    describe('name parameter', () => {
        it('이름 설정', () => {
            const pool = new KeyPool('key1', 'TestPool');
            expect(pool.name).toBe('TestPool');
        });

        it('이름 없으면 빈 문자열', () => {
            const pool = new KeyPool('key1');
            expect(pool.name).toBe('');
        });

        it('withRotation 에러 메시지에 이름 포함', async () => {
            const pool = new KeyPool('', 'MyProvider');
            const fetchFn = vi.fn();
            const result = await pool.withRotation(fetchFn);
            expect(result.content).toContain('MyProvider');
        });
    });
});
