/**
 * @file key-pool-extended.test.js — Extended tests for KeyPool
 * Targets: fromJson with name param, Windows path detection, JSON parse error
 */
import { describe, it, expect } from 'vitest';
import { KeyPool } from '../src/shared/key-pool.js';

describe('KeyPool.fromJson — extended', () => {
    it('parses valid JSON credentials', () => {
        const json = JSON.stringify({ project_id: 'test', client_email: 'test@gsa.com', private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' });
        const pool = KeyPool.fromJson(json);
        expect(pool.remaining).toBe(1);
    });

    it('accepts name parameter', () => {
        const json = JSON.stringify({ project_id: 'test' });
        const pool = KeyPool.fromJson(json, 'VertexAI');
        expect(pool).toBeDefined();
    });

    it('handles multiple JSON credentials separated by delimiter', () => {
        const cred1 = JSON.stringify({ project_id: 'p1' });
        const cred2 = JSON.stringify({ project_id: 'p2' });
        const pool = KeyPool.fromJson(`${cred1},${cred2}`);
        expect(pool.remaining).toBeGreaterThanOrEqual(1);
    });

    it('detects Windows path and returns error in pool', () => {
        const pool = KeyPool.fromJson('C:\\Users\\test\\key.json');
        expect(pool.remaining).toBe(0);
        expect(pool._jsonParseError).toBeTruthy();
    });

    it('detects UNC path and returns error in pool', () => {
        const pool = KeyPool.fromJson('\\\\server\\share\\key.json');
        expect(pool.remaining).toBe(0);
        expect(pool._jsonParseError).toBeTruthy();
    });

    it('sets _jsonParseError on invalid JSON', () => {
        const pool = KeyPool.fromJson('not valid json');
        expect(pool.remaining).toBe(0);
        expect(pool._jsonParseError).toBeTruthy();
    });

    it('handles empty input', () => {
        const pool = KeyPool.fromJson('');
        expect(pool.remaining).toBe(0);
    });

    it('handles null/undefined input', () => {
        const pool = KeyPool.fromJson(null);
        expect(pool.remaining).toBe(0);
    });
});

describe('KeyPool — basic operations', () => {
    it('creates pool from whitespace-separated keys', () => {
        const pool = new KeyPool('key1 key2 key3');
        expect(pool.remaining).toBe(3);
    });

    it('creates pool from newline-separated keys', () => {
        const pool = new KeyPool('key1\nkey2');
        expect(pool.remaining).toBe(2);
    });

    it('pick returns a key', () => {
        const pool = new KeyPool('single-key');
        expect(pool.pick()).toBe('single-key');
    });

    it('withRotation rotates on rejection', async () => {
        const pool = new KeyPool('k1 k2 k3');
        const results = [];
        const res = await pool.withRotation(async (key) => {
            results.push(key);
            if (results.length < 3) return { success: false, content: 'fail', _status: 429 };
            return { success: true, content: 'ok' };
        });
        expect(res.success).toBe(true);
        expect(results.length).toBe(3);
    });

    it('returns 0 remaining for empty input', () => {
        const pool = new KeyPool('');
        expect(pool.remaining).toBe(0);
    });

    it('trims whitespace from keys', () => {
        const pool = new KeyPool('  key1  \n  key2  ');
        expect(pool.remaining).toBe(2);
        expect(pool.pick()).toBeTruthy();
    });
});
