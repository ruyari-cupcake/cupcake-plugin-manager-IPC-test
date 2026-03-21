/**
 * coverage-boost-pure.test.js
 * vi.mock 없이 순수 함수 직접 테스트
 * 대상: helpers.js (escHtml, extractImageUrlFromPart, safeStringify, _stripNonSerializable)
 *       tool-parsers.js (edge cases)
 */
import { describe, it, expect } from 'vitest';
import {
    escHtml,
    extractImageUrlFromPart,
    safeStringify,
    _stripNonSerializable
} from '../src/shared/helpers.js';
import {
    parseOpenAIToolCalls,
    parseAnthropicToolCalls,
    parseGeminiToolCalls,
    parseToolCalls,
    formatToolResult
} from '../src/shared/tool-parsers.js';

// ──────────────────────────────────────
// helpers.js — _stripNonSerializable
// ──────────────────────────────────────
describe('_stripNonSerializable', () => {
    it('function → undefined', () => {
        expect(_stripNonSerializable(() => {})).toBe(undefined);
    });
    it('symbol → undefined', () => {
        expect(_stripNonSerializable(Symbol('x'))).toBe(undefined);
    });
    it('bigint → undefined', () => {
        expect(_stripNonSerializable(BigInt(42))).toBe(undefined);
    });
    it('null, undefined passthrough', () => {
        expect(_stripNonSerializable(null)).toBe(null);
        expect(_stripNonSerializable(undefined)).toBe(undefined);
    });
    it('Date → String', () => {
        const d = new Date('2025-01-01T00:00:00Z');
        expect(typeof _stripNonSerializable(d)).toBe('string');
    });
    it('RegExp → String', () => {
        expect(typeof _stripNonSerializable(/abc/)).toBe('string');
    });
    it('Error → String', () => {
        expect(typeof _stripNonSerializable(new Error('oops'))).toBe('string');
    });
    it('Uint8Array passthrough', () => {
        const buf = new Uint8Array([1, 2, 3]);
        expect(_stripNonSerializable(buf)).toBe(buf);
    });
    it('ArrayBuffer passthrough', () => {
        const ab = new ArrayBuffer(4);
        expect(_stripNonSerializable(ab)).toBe(ab);
    });
    it('nested object strips fn properties', () => {
        const obj = { a: 1, b: 'hi', fn: () => {}, sym: Symbol('y') };
        const r = _stripNonSerializable(obj);
        expect(r).toEqual({ a: 1, b: 'hi' });
    });
    it('array with functions filtered', () => {
        const r = _stripNonSerializable([1, () => {}, 'ok', Symbol('z')]);
        expect(r).toEqual([1, 'ok']);
    });
    it('depth > 15 stops recursing', () => {
        let deep = { val: 'leaf' };
        for (let i = 0; i < 20; i++) deep = { child: deep };
        const res = _stripNonSerializable(deep);
        expect(res).toBeDefined();
    });
    it('primitive passthrough (number, string, boolean)', () => {
        expect(_stripNonSerializable(42)).toBe(42);
        expect(_stripNonSerializable('hello')).toBe('hello');
        expect(_stripNonSerializable(true)).toBe(true);
    });
});

// ──────────────────────────────────────
// helpers.js — escHtml
// ──────────────────────────────────────
describe('escHtml', () => {
    it('escapes all special chars', () => {
        expect(escHtml('<script>"alert(\'xss\')&</script>')).toBe(
            '&lt;script&gt;&quot;alert(&#39;xss&#39;)&amp;&lt;/script&gt;'
        );
    });
    it('escapes & < > " \' individually', () => {
        expect(escHtml('&')).toBe('&amp;');
        expect(escHtml('<')).toBe('&lt;');
        expect(escHtml('>')).toBe('&gt;');
        expect(escHtml('"')).toBe('&quot;');
        expect(escHtml("'")).toBe('&#39;');
    });
    it('non-string returns empty string', () => {
        expect(escHtml(123)).toBe('');
        expect(escHtml(null)).toBe('');
        expect(escHtml(undefined)).toBe('');
    });
    it('already safe string unchanged', () => {
        expect(escHtml('hello world')).toBe('hello world');
    });
});

// ──────────────────────────────────────
// helpers.js — extractImageUrlFromPart
// ──────────────────────────────────────
describe('extractImageUrlFromPart', () => {
    it('type=image_url with string url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: 'http://img.png' })).toBe('http://img.png');
    });
    it('type=image_url with object url', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: { url: 'http://img2.png' } })).toBe('http://img2.png');
    });
    it('type=input_image with string url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: 'http://img3.png' })).toBe('http://img3.png');
    });
    it('type=input_image with object url', () => {
        expect(extractImageUrlFromPart({ type: 'input_image', image_url: { url: 'http://img4.png' } })).toBe('http://img4.png');
    });
    it('null/undefined input → empty string', () => {
        expect(extractImageUrlFromPart(null)).toBe('');
        expect(extractImageUrlFromPart(undefined)).toBe('');
    });
    it('non-object input → empty string', () => {
        expect(extractImageUrlFromPart('string')).toBe('');
        expect(extractImageUrlFromPart(42)).toBe('');
    });
    it('unknown type → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'text', text: 'hi' })).toBe('');
    });
    it('image_url with no url property → empty string', () => {
        expect(extractImageUrlFromPart({ type: 'image_url', image_url: {} })).toBe('');
    });
});

// ──────────────────────────────────────
// helpers.js — safeStringify
// ──────────────────────────────────────
describe('safeStringify', () => {
    it('filters null from arrays', () => {
        expect(safeStringify([1, null, 2])).toBe('[1,2]');
    });
    it('filters undefined from arrays', () => {
        expect(safeStringify([1, undefined, 'a'])).toBe('[1,"a"]');
    });
    it('stringifies object normally', () => {
        expect(safeStringify({ x: 1 })).toBe('{"x":1}');
    });
    it('nested array null filtering', () => {
        expect(safeStringify({ a: [null, { b: [null, 1] }] })).toBe('{"a":[{"b":[1]}]}');
    });
    it('handles undefined input', () => {
        expect(safeStringify(undefined)).toBe(undefined);
    });
    it('handles string input', () => {
        expect(safeStringify('hello')).toBe('"hello"');
    });
    it('handles number input', () => {
        expect(safeStringify(42)).toBe('42');
    });
    it('empty array', () => {
        expect(safeStringify([])).toBe('[]');
    });
});

// ──────────────────────────────────────
// tool-parsers.js — edge cases
// ──────────────────────────────────────
describe('tool-parsers edge cases', () => {
    // _safeParse edge: non-string input
    it('parseOpenAI: tc.function.arguments as object (not string) → passthrough', () => {
        const data = {
            choices: [{ message: {
                tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: { x: 1 } } }]
            }}]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.hasToolCalls).toBe(true);
        expect(r.toolCalls[0].arguments).toEqual({ x: 1 });
    });

    it('parseOpenAI: missing function.name → empty string', () => {
        const data = {
            choices: [{ message: {
                tool_calls: [{ id: 'c2', function: { arguments: '{"a":1}' } }]
            }}]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.toolCalls[0].name).toBe('');
    });

    it('parseOpenAI: missing tc.id → auto-generated', () => {
        const data = {
            choices: [{ message: {
                tool_calls: [{ function: { name: 'fn', arguments: '{}' } }]
            }}]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.toolCalls[0].id).toMatch(/^call_/);
    });

    it('parseOpenAI: invalid JSON arguments → empty object', () => {
        const data = {
            choices: [{ message: {
                tool_calls: [{ id: 'c3', function: { name: 'fn', arguments: '{bad json' } }]
            }}]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.toolCalls[0].arguments).toEqual({});
    });

    it('parseOpenAI: null data → no tool calls', () => {
        expect(parseOpenAIToolCalls(null).hasToolCalls).toBe(false);
    });

    it('parseOpenAI: empty tool_calls array → no tool calls', () => {
        const data = { choices: [{ message: { tool_calls: [], content: 'hi' } }] };
        const r = parseOpenAIToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('hi');
    });

    it('parseAnthropic: no content array → no tool calls', () => {
        expect(parseAnthropicToolCalls({ content: 'string' }).hasToolCalls).toBe(false);
    });

    it('parseAnthropic: no tool_use blocks → text extraction', () => {
        const data = { content: [{ type: 'text', text: 'answer' }] };
        const r = parseAnthropicToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('answer');
    });

    it('parseAnthropic: missing b.id → auto-generated', () => {
        const data = { content: [{ type: 'tool_use', name: 'fn', input: { k: 1 } }] };
        const r = parseAnthropicToolCalls(data);
        expect(r.toolCalls[0].id).toMatch(/^toolu_/);
    });

    it('parseGemini: no parts → no tool calls', () => {
        expect(parseGeminiToolCalls({ candidates: [{ content: {} }] }).hasToolCalls).toBe(false);
    });

    it('parseGemini: text only → textContent', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
        const r = parseGeminiToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('hello');
    });

    it('parseGemini: missing functionCall.name → empty string', () => {
        const data = { candidates: [{ content: { parts: [{ functionCall: { args: {} } }] } }] };
        const r = parseGeminiToolCalls(data);
        expect(r.toolCalls[0].name).toBe('');
    });

    // parseToolCalls dispatcher
    it('parseToolCalls dispatches to anthropic', () => {
        const data = { content: [{ type: 'text', text: 'ok' }] };
        expect(parseToolCalls(data, 'anthropic').textContent).toBe('ok');
    });
    it('parseToolCalls dispatches to google', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
        expect(parseToolCalls(data, 'google').textContent).toBe('hi');
    });
    it('parseToolCalls defaults to openai', () => {
        expect(parseToolCalls(null, 'unknown').hasToolCalls).toBe(false);
    });

    // formatToolResult
    it('formatToolResult: anthropic format', () => {
        const r = formatToolResult({ id: 'tid', name: 'fn' }, 'result', 'anthropic');
        expect(r.role).toBe('user');
        expect(r.content[0].type).toBe('tool_result');
        expect(r.content[0].tool_use_id).toBe('tid');
    });
    it('formatToolResult: google format', () => {
        const r = formatToolResult({ id: 'tid', name: 'fn' }, 'result', 'google');
        expect(r.role).toBe('function');
        expect(r.parts[0].functionResponse.name).toBe('fn');
    });
    it('formatToolResult: openai format', () => {
        const r = formatToolResult({ id: 'tid', name: 'fn' }, 'result', 'openai');
        expect(r.role).toBe('tool');
        expect(r.tool_call_id).toBe('tid');
    });
});
