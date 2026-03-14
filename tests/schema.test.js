/**
 * @file schema.test.js — schema.js 검증 테스트
 * SEC-2: 경량 구조 검증
 */
import { describe, it, expect } from 'vitest';
import { validateSchema, parseAndValidate, schemas } from '../src/shared/schema.js';

describe('validateSchema', () => {
    describe('string type', () => {
        it('valid string passes', () => {
            const r = validateSchema('hello', { type: 'string' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe('hello');
        });

        it('non-string fails', () => {
            expect(validateSchema(123, { type: 'string' }).valid).toBe(false);
        });

        it('maxLength truncates', () => {
            const r = validateSchema('abcdefgh', { type: 'string', maxLength: 5 });
            expect(r.valid).toBe(true);
            expect(r.value).toBe('abcde');
        });

        it('null with required fails', () => {
            expect(validateSchema(null, { type: 'string', required: true }).valid).toBe(false);
        });

        it('null with default returns default', () => {
            const r = validateSchema(null, { type: 'string', default: 'fallback' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe('fallback');
        });

        it('empty string passes', () => {
            const r = validateSchema('', { type: 'string' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe('');
        });
    });

    describe('number type', () => {
        it('valid number passes', () => {
            const r = validateSchema(42, { type: 'number' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(42);
        });

        it('string number coerces', () => {
            const r = validateSchema('3.14', { type: 'number' });
            expect(r.valid).toBe(true);
            expect(r.value).toBeCloseTo(3.14);
        });

        it('NaN fails', () => {
            expect(validateSchema('not-a-number', { type: 'number' }).valid).toBe(false);
        });

        it('zero passes', () => {
            const r = validateSchema(0, { type: 'number' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(0);
        });
    });

    describe('boolean type', () => {
        it('true passes', () => {
            const r = validateSchema(true, { type: 'boolean' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(true);
        });

        it('string "true" coerces', () => {
            const r = validateSchema('true', { type: 'boolean' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(true);
        });

        it('string "false" coerces', () => {
            const r = validateSchema('false', { type: 'boolean' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(false);
        });

        it('number 1 coerces to true', () => {
            const r = validateSchema(1, { type: 'boolean' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(true);
        });

        it('number 0 coerces to false', () => {
            const r = validateSchema(0, { type: 'boolean' });
            expect(r.valid).toBe(true);
            expect(r.value).toBe(false);
        });

        it('random string fails', () => {
            expect(validateSchema('maybe', { type: 'boolean' }).valid).toBe(false);
        });
    });

    describe('array type', () => {
        it('valid array passes', () => {
            const r = validateSchema([1, 2, 3], { type: 'array' });
            expect(r.valid).toBe(true);
            expect(r.value).toEqual([1, 2, 3]);
        });

        it('non-array fails', () => {
            expect(validateSchema('notarray', { type: 'array' }).valid).toBe(false);
        });

        it('maxItems truncates', () => {
            const r = validateSchema([1, 2, 3, 4, 5], { type: 'array', maxItems: 3 });
            expect(r.valid).toBe(true);
            expect(r.value).toEqual([1, 2, 3]);
        });

        it('items schema filters invalid elements', () => {
            const r = validateSchema([1, 'two', 3, 'four'], {
                type: 'array',
                items: { type: 'number' },
            });
            expect(r.valid).toBe(true);
            expect(r.value).toEqual([1, 3]);
        });

        it('empty array passes', () => {
            const r = validateSchema([], { type: 'array' });
            expect(r.valid).toBe(true);
            expect(r.value).toEqual([]);
        });
    });

    describe('object type', () => {
        it('valid object passes', () => {
            const r = validateSchema({ a: 1 }, { type: 'object' });
            expect(r.valid).toBe(true);
        });

        it('array fails as object', () => {
            expect(validateSchema([1, 2], { type: 'object' }).valid).toBe(false);
        });

        it('properties schema filters', () => {
            const r = validateSchema(
                { name: 'test', count: 5, extra: 'ignored' },
                {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        count: { type: 'number' },
                    },
                },
            );
            expect(r.valid).toBe(true);
            expect(r.value).toEqual({ name: 'test', count: 5 });
        });

        it('required property missing fails', () => {
            const r = validateSchema(
                { name: 'test' },
                {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        count: { type: 'number', required: true },
                    },
                },
            );
            expect(r.valid).toBe(false);
        });

        it('non-object value fails', () => {
            expect(validateSchema('string', { type: 'object' }).valid).toBe(false);
        });

        it('null value fails', () => {
            expect(validateSchema(null, { type: 'object', required: true }).valid).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('no schema → pass through', () => {
            const r = validateSchema('anything', null);
            expect(r.valid).toBe(true);
            expect(r.value).toBe('anything');
        });

        it('undefined with no required → pass', () => {
            const r = validateSchema(undefined, { type: 'string' });
            expect(r.valid).toBe(true);
            expect(r.value).toBeUndefined();
        });

        it('unknown type → pass through', () => {
            const r = validateSchema('unknown', { type: 'custom' });
            expect(r.valid).toBe(true);
        });
    });
});

describe('parseAndValidate', () => {
    it('valid JSON string passes', () => {
        const r = parseAndValidate('{"a":1}', { type: 'object' });
        expect(r.valid).toBe(true);
        expect(r.value).toEqual({ a: 1 });
    });

    it('invalid JSON fails', () => {
        const r = parseAndValidate('{invalid', { type: 'object' });
        expect(r.valid).toBe(false);
    });

    it('non-string input (object) passes through', () => {
        const r = parseAndValidate({ a: 1 }, { type: 'object' });
        expect(r.valid).toBe(true);
    });

    it('valid JSON but wrong schema fails', () => {
        const r = parseAndValidate('"hello"', { type: 'number' });
        expect(r.valid).toBe(false);
    });
});

describe('schemas', () => {
    it('settingsBackup is object type', () => {
        expect(schemas.settingsBackup.type).toBe('object');
    });

    it('bootStatus validates correct data', () => {
        const data = {
            lastBootTime: Date.now(),
            status: 'ok',
            completedPhases: ['init', 'load'],
        };
        const r = validateSchema(data, schemas.bootStatus);
        expect(r.valid).toBe(true);
        expect(r.value.status).toBe('ok');
    });

    it('bootStatus truncates long error strings', () => {
        const data = {
            error: 'x'.repeat(3000),
        };
        const r = validateSchema(data, schemas.bootStatus);
        expect(r.valid).toBe(true);
        expect(r.value.error.length).toBeLessThanOrEqual(2000);
    });

    it('bootStatus truncates completedPhases array', () => {
        const data = {
            completedPhases: Array.from({ length: 100 }, (_, i) => `phase${i}`),
        };
        const r = validateSchema(data, schemas.bootStatus);
        expect(r.valid).toBe(true);
        expect(r.value.completedPhases.length).toBeLessThanOrEqual(50);
    });

    // ── updateBundleVersions ──
    it('updateBundleVersions validates object', () => {
        const r = validateSchema({ 'Plugin A': { version: '1.0' } }, schemas.updateBundleVersions);
        expect(r.valid).toBe(true);
    });

    it('updateBundleVersions rejects non-object', () => {
        const r = validateSchema([1, 2], schemas.updateBundleVersions);
        expect(r.valid).toBe(false);
    });

    // ── updateBundle ──
    it('updateBundle validates correct data', () => {
        const data = { versions: { 'Plugin A': { version: '1.0' } }, code: { 'main.js': 'console.log(1)' } };
        const r = validateSchema(data, schemas.updateBundle);
        expect(r.valid).toBe(true);
    });

    it('updateBundle rejects missing versions', () => {
        const r = validateSchema({ code: {} }, schemas.updateBundle);
        expect(r.valid).toBe(false);
    });

    it('updateBundle rejects non-object', () => {
        const r = validateSchema('bad', schemas.updateBundle);
        expect(r.valid).toBe(false);
    });
});
