/**
 * @file security-patches.test.js — 보안 패치 유닛 테스트
 * SEC-1: escHtml, extractImageUrlFromPart
 * SEC-3: _stripNonSerializable
 */
import { describe, it, expect } from 'vitest';
import { escHtml, extractImageUrlFromPart, _stripNonSerializable } from '../src/shared/helpers.js';

describe('escHtml (SEC-1)', () => {
    it('escapes < and >', () => {
        expect(escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes & and "', () => {
        expect(escHtml('a & b "c"')).toBe('a &amp; b &quot;c&quot;');
    });

    it('returns empty string for non-string', () => {
        expect(escHtml(null)).toBe('');
        expect(escHtml(undefined)).toBe('');
        expect(escHtml(123)).toBe('');
    });

    it('passes through safe strings', () => {
        expect(escHtml('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
        expect(escHtml('')).toBe('');
    });

    it('escapes multiple occurrences', () => {
        expect(escHtml('a<b>c<d')).toBe('a&lt;b&gt;c&lt;d');
    });
});

describe('extractImageUrlFromPart (SEC-1)', () => {
    it('extracts from image_url object form', () => {
        const url = extractImageUrlFromPart({
            type: 'image_url',
            image_url: { url: 'https://example.com/img.png' },
        });
        expect(url).toBe('https://example.com/img.png');
    });

    it('extracts from image_url string form', () => {
        const url = extractImageUrlFromPart({
            type: 'image_url',
            image_url: 'https://example.com/img.png',
        });
        expect(url).toBe('https://example.com/img.png');
    });

    it('extracts from input_image type', () => {
        const url = extractImageUrlFromPart({
            type: 'input_image',
            image_url: { url: 'data:image/png;base64,abc' },
        });
        expect(url).toBe('data:image/png;base64,abc');
    });

    it('returns empty for text part', () => {
        expect(extractImageUrlFromPart({ type: 'text', text: 'hello' })).toBe('');
    });

    it('returns empty for null/undefined', () => {
        expect(extractImageUrlFromPart(null)).toBe('');
        expect(extractImageUrlFromPart(undefined)).toBe('');
    });

    it('returns empty for non-object', () => {
        expect(extractImageUrlFromPart('string')).toBe('');
    });

    it('handles missing image_url property', () => {
        expect(extractImageUrlFromPart({ type: 'image_url' })).toBe('');
    });
});

describe('_stripNonSerializable (SEC-3)', () => {
    it('keeps plain objects intact', () => {
        const obj = { a: 1, b: 'hello', c: true };
        const result = _stripNonSerializable(obj);
        expect(result).toEqual(obj);
    });

    it('strips functions', () => {
        const obj = { a: 1, fn: () => {} };
        const result = _stripNonSerializable(obj);
        expect(result.a).toBe(1);
        expect(result.fn).toBeUndefined();
    });

    it('strips symbols', () => {
        const obj = { a: 1, [Symbol('test')]: 'sym' };
        const result = _stripNonSerializable(obj);
        expect(result.a).toBe(1);
    });

    it('handles nested objects', () => {
        const obj = { a: { b: { c: 1, fn: function() {} } } };
        const result = _stripNonSerializable(obj);
        expect(result.a.b.c).toBe(1);
        expect(result.a.b.fn).toBeUndefined();
    });

    it('handles arrays', () => {
        const obj = { arr: [1, 'two', null, { x: () => {} }] };
        const result = _stripNonSerializable(obj);
        expect(result.arr[0]).toBe(1);
        expect(result.arr[1]).toBe('two');
        expect(result.arr[2]).toBeNull();
    });

    it('returns primitives directly', () => {
        expect(_stripNonSerializable('hello')).toBe('hello');
        expect(_stripNonSerializable(42)).toBe(42);
        expect(_stripNonSerializable(null)).toBeNull();
        expect(_stripNonSerializable(true)).toBe(true);
    });

    it('depth limit prevents infinite recursion', () => {
        // Create a deeply nested object (> default 15 depth)
        let obj = { value: 'deep' };
        for (let i = 0; i < 20; i++) {
            obj = { child: obj };
        }
        // Should not throw
        const result = _stripNonSerializable(obj);
        expect(result).toBeDefined();
    });

    it('handles undefined values', () => {
        expect(_stripNonSerializable(undefined)).toBeUndefined();
    });

    it('strips AbortSignal-like objects', () => {
        const obj = { signal: { aborted: false, addEventListener: () => {} }, data: 'keep' };
        const result = _stripNonSerializable(obj);
        expect(result.data).toBe('keep');
        // The signal object's addEventListener (function) should be stripped
        expect(result.signal.addEventListener).toBeUndefined();
    });
});
