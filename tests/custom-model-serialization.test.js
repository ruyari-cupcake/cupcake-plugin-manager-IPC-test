import { describe, it, expect } from 'vitest';
import {
    parseCustomModelsValue,
    normalizeCustomModel,
    serializeCustomModelExport,
    serializeCustomModelsSetting,
} from '../src/shared/custom-model-serialization.js';

// ── parseCustomModelsValue ──
describe('parseCustomModelsValue', () => {
    it('parses an array of objects, filtering non-objects', () => {
        const input = [{ name: 'A' }, null, 'not-obj', { name: 'B' }, 42];
        const result = parseCustomModelsValue(input);
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('A');
        expect(result[1].name).toBe('B');
    });

    it('parses a JSON string array', () => {
        const input = JSON.stringify([{ name: 'X' }, { name: 'Y' }]);
        const result = parseCustomModelsValue(input);
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('X');
    });

    it('returns [] for non-array JSON string', () => {
        expect(parseCustomModelsValue('{"name":"single"}')).toEqual([]);
    });

    it('returns [] for invalid JSON string', () => {
        expect(parseCustomModelsValue('not-json')).toEqual([]);
    });

    it('returns [] for null/undefined/number', () => {
        expect(parseCustomModelsValue(null)).toEqual([]);
        expect(parseCustomModelsValue(undefined)).toEqual([]);
        expect(parseCustomModelsValue(42)).toEqual([]);
    });

    it('returns [] for empty array', () => {
        expect(parseCustomModelsValue([])).toEqual([]);
    });

    it('returns [] for empty string', () => {
        expect(parseCustomModelsValue('')).toEqual([]);
    });

    it('filters out non-object entries from JSON string', () => {
        const input = JSON.stringify([null, 'str', { name: 'ok' }]);
        expect(parseCustomModelsValue(input)).toHaveLength(1);
    });
});

// ── normalizeCustomModel ──
describe('normalizeCustomModel', () => {
    it('normalizes minimal input with defaults', () => {
        const result = normalizeCustomModel({});
        expect(result.name).toBe('');
        expect(result.model).toBe('');
        expect(result.url).toBe('');
        expect(result.format).toBe('openai');
        expect(result.tok).toBe('o200k_base');
        expect(result.responsesMode).toBe('auto');
        expect(result.thinking).toBe('none');
        expect(result.thinkingBudget).toBe(0);
        expect(result.maxOutputLimit).toBe(0);
        expect(result.streaming).toBe(false);
        expect(result.decoupled).toBe(true); // inverse of streaming default
        expect(result.key).toBe('');
    });

    it('preserves actual values', () => {
        const result = normalizeCustomModel({
            name: 'MyModel',
            model: 'gpt-4',
            url: 'https://api.example.com',
            format: 'anthropic',
            key: 'sk-xxx',
        });
        expect(result.name).toBe('MyModel');
        expect(result.model).toBe('gpt-4');
        expect(result.url).toBe('https://api.example.com');
        expect(result.format).toBe('anthropic');
        expect(result.key).toBe('sk-xxx');
    });

    it('handles streaming/decoupled relationship correctly', () => {
        // streaming=true → decoupled=false
        const r1 = normalizeCustomModel({ streaming: true });
        expect(r1.streaming).toBe(true);
        expect(r1.decoupled).toBe(false);

        // streaming=false → decoupled=true
        const r2 = normalizeCustomModel({ streaming: false });
        expect(r2.streaming).toBe(false);
        expect(r2.decoupled).toBe(true);

        // decoupled=true → streaming=false (when streaming not set)
        const r3 = normalizeCustomModel({ decoupled: true });
        expect(r3.streaming).toBe(false);
        expect(r3.decoupled).toBe(true);

        // decoupled=false → streaming=true (when streaming not set)
        const r4 = normalizeCustomModel({ decoupled: false });
        expect(r4.streaming).toBe(true);
        expect(r4.decoupled).toBe(false);

        // both set — each honored independently
        const r5 = normalizeCustomModel({ streaming: true, decoupled: true });
        expect(r5.streaming).toBe(true);
        expect(r5.decoupled).toBe(true);
    });

    it('converts string booleans', () => {
        const result = normalizeCustomModel({
            sysfirst: 'true',
            mergesys: '1',
            altrole: 'yes',
            mustuser: 'on',
            maxout: 'false',
            thought: 'TRUE',
        });
        expect(result.sysfirst).toBe(true);
        expect(result.mergesys).toBe(true);
        expect(result.altrole).toBe(true);
        expect(result.mustuser).toBe(true);
        expect(result.maxout).toBe(false);
        expect(result.thought).toBe(true);
    });

    it('converts numeric booleans', () => {
        expect(normalizeCustomModel({ sysfirst: 1 }).sysfirst).toBe(true);
        expect(normalizeCustomModel({ sysfirst: 0 }).sysfirst).toBe(false);
    });

    it('converts integer fields', () => {
        const result = normalizeCustomModel({
            thinkingBudget: '1024',
            maxOutputLimit: 2048,
        });
        expect(result.thinkingBudget).toBe(1024);
        expect(result.maxOutputLimit).toBe(2048);
    });

    it('handles non-numeric integer fields gracefully', () => {
        const result = normalizeCustomModel({
            thinkingBudget: 'abc',
            maxOutputLimit: null,
        });
        expect(result.thinkingBudget).toBe(0);
        expect(result.maxOutputLimit).toBe(0);
    });

    it('trims proxyUrl', () => {
        const result = normalizeCustomModel({ proxyUrl: '  https://proxy.io  ' });
        expect(result.proxyUrl).toBe('https://proxy.io');
    });

    it('normalizes proxyDirect boolean values', () => {
        expect(normalizeCustomModel({ proxyDirect: 'true' }).proxyDirect).toBe(true);
        expect(normalizeCustomModel({ proxyDirect: 'false' }).proxyDirect).toBe(false);
        expect(normalizeCustomModel({ proxyDirect: 1 }).proxyDirect).toBe(true);
    });

    it('excludes key when includeKey=false', () => {
        const result = normalizeCustomModel({ key: 'secret' }, { includeKey: false });
        expect(result.key).toBeUndefined();
    });

    it('includes uniqueId only when present and includeUniqueId=true', () => {
        const r1 = normalizeCustomModel({ uniqueId: 'uid-123' });
        expect(r1.uniqueId).toBe('uid-123');

        const r2 = normalizeCustomModel({});
        expect(r2.uniqueId).toBeUndefined();

        const r3 = normalizeCustomModel({ uniqueId: 'uid-456' }, { includeUniqueId: false });
        expect(r3.uniqueId).toBeUndefined();
    });

    it('includes _tag only when present', () => {
        const r1 = normalizeCustomModel({ _tag: 'some-tag' });
        expect(r1._tag).toBe('some-tag');

        const r2 = normalizeCustomModel({});
        expect(r2._tag).toBeUndefined();
    });

    it('adds export marker when includeExportMarker=true', () => {
        const result = normalizeCustomModel({}, { includeExportMarker: true });
        expect(result._cpmModelExport).toBe(true);
    });

    it('handles null/undefined raw gracefully', () => {
        const result = normalizeCustomModel(null);
        expect(result.name).toBe('');
        expect(result.format).toBe('openai');
    });
});

// ── serializeCustomModelExport ──
describe('serializeCustomModelExport', () => {
    it('strips key, uniqueId, _tag and adds export marker', () => {
        const result = serializeCustomModelExport({
            name: 'Test',
            key: 'sk-secret',
            uniqueId: 'uid-1',
            _tag: 'internal',
        });
        expect(result.name).toBe('Test');
        expect(result.key).toBeUndefined();
        expect(result.uniqueId).toBeUndefined();
        expect(result._tag).toBeUndefined();
        expect(result._cpmModelExport).toBe(true);
    });

    it('preserves model configuration fields', () => {
        const result = serializeCustomModelExport({
            name: 'Claude',
            model: 'claude-3-5-sonnet',
            format: 'anthropic',
            streaming: true,
            proxyDirect: true,
            thinking: 'medium',
            thinkingBudget: 2048,
        });
        expect(result.model).toBe('claude-3-5-sonnet');
        expect(result.format).toBe('anthropic');
        expect(result.streaming).toBe(true);
        expect(result.proxyDirect).toBe(true);
        expect(result.thinking).toBe('medium');
        expect(result.thinkingBudget).toBe(2048);
    });
});

// ── serializeCustomModelsSetting ──
describe('serializeCustomModelsSetting', () => {
    it('serializes array to JSON string', () => {
        const models = [{ name: 'M1', model: 'gpt-4', format: 'openai' }];
        const result = serializeCustomModelsSetting(models);
        const parsed = JSON.parse(result);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].name).toBe('M1');
        expect(parsed[0].format).toBe('openai');
    });

    it('excludes key by default', () => {
        const models = [{ name: 'M1', key: 'secret' }];
        const result = serializeCustomModelsSetting(models);
        const parsed = JSON.parse(result);
        expect(parsed[0].key).toBeUndefined();
    });

    it('includes key when includeKey=true', () => {
        const models = [{ name: 'M1', key: 'secret' }];
        const result = serializeCustomModelsSetting(models, { includeKey: true });
        const parsed = JSON.parse(result);
        expect(parsed[0].key).toBe('secret');
    });

    it('handles JSON string input', () => {
        const input = JSON.stringify([{ name: 'Test' }]);
        const result = serializeCustomModelsSetting(input);
        const parsed = JSON.parse(result);
        expect(parsed).toHaveLength(1);
    });

    it('handles empty/invalid input', () => {
        expect(JSON.parse(serializeCustomModelsSetting(null))).toEqual([]);
        expect(JSON.parse(serializeCustomModelsSetting(''))).toEqual([]);
        expect(JSON.parse(serializeCustomModelsSetting('bad-json'))).toEqual([]);
    });

    it('normalizes all fields in serialized output', () => {
        const models = [{ name: 'X', streaming: 'true', thinkingBudget: '512', proxyDirect: 'true' }];
        const result = serializeCustomModelsSetting(models);
        const parsed = JSON.parse(result);
        expect(parsed[0].streaming).toBe(true);
        expect(parsed[0].proxyDirect).toBe(true);
        expect(parsed[0].thinkingBudget).toBe(512);
        expect(parsed[0].format).toBe('openai'); // default
    });
});
