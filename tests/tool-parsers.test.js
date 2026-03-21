/**
 * @file tool-parsers.test.js — Tests for API response tool-call parsers
 * Covers: parseOpenAIToolCalls, parseAnthropicToolCalls, parseGeminiToolCalls,
 *         parseToolCalls (dispatcher), formatToolResult
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseOpenAIToolCalls,
    parseAnthropicToolCalls,
    parseGeminiToolCalls,
    parseToolCalls,
    formatToolResult,
} from '../src/shared/tool-parsers.js';

// ══════════════════════════════════════════════════════
// parseOpenAIToolCalls
// ══════════════════════════════════════════════════════
describe('parseOpenAIToolCalls', () => {
    it('returns hasToolCalls:false for null data', () => {
        expect(parseOpenAIToolCalls(null)).toEqual({ hasToolCalls: false });
    });
    it('returns hasToolCalls:false for empty choices', () => {
        expect(parseOpenAIToolCalls({ choices: [] })).toEqual({ hasToolCalls: false });
    });
    it('returns hasToolCalls:false when no tool_calls', () => {
        const data = { choices: [{ message: { content: 'Hello', role: 'assistant' } }] };
        const r = parseOpenAIToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('Hello');
    });
    it('returns hasToolCalls:false for empty tool_calls array', () => {
        const data = { choices: [{ message: { content: 'Hi', tool_calls: [] } }] };
        const r = parseOpenAIToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
    });
    it('correctly parses tool_calls', () => {
        const data = {
            choices: [{
                message: {
                    content: 'Let me calculate.',
                    tool_calls: [{
                        id: 'call_123',
                        function: { name: 'calculate', arguments: '{"expression":"2+2"}' }
                    }]
                }
            }]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.hasToolCalls).toBe(true);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0].id).toBe('call_123');
        expect(r.toolCalls[0].name).toBe('calculate');
        expect(r.toolCalls[0].arguments).toEqual({ expression: '2+2' });
        expect(r.textContent).toBe('Let me calculate.');
    });
    it('handles multiple tool_calls', () => {
        const data = {
            choices: [{
                message: {
                    content: '',
                    tool_calls: [
                        { id: 'c1', function: { name: 'a', arguments: '{}' } },
                        { id: 'c2', function: { name: 'b', arguments: '{}' } },
                    ]
                }
            }]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.toolCalls).toHaveLength(2);
    });
    it('generates fallback id when missing', () => {
        const data = {
            choices: [{
                message: {
                    tool_calls: [{ function: { name: 'a', arguments: '{}' } }]
                }
            }]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.toolCalls[0].id).toMatch(/^call_/);
    });
    it('handles invalid JSON arguments', () => {
        const data = {
            choices: [{
                message: {
                    tool_calls: [{ id: 'c1', function: { name: 'a', arguments: 'not-json' } }]
                }
            }]
        };
        const r = parseOpenAIToolCalls(data);
        expect(r.toolCalls[0].arguments).toEqual({});
    });
    it('stores full assistant message', () => {
        const msg = {
            content: '', role: 'assistant',
            tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{}' } }]
        };
        const r = parseOpenAIToolCalls({ choices: [{ message: msg }] });
        expect(r.assistantMessage).toBe(msg);
    });
});

// ══════════════════════════════════════════════════════
// parseAnthropicToolCalls
// ══════════════════════════════════════════════════════
describe('parseAnthropicToolCalls', () => {
    it('returns hasToolCalls:false for null data', () => {
        expect(parseAnthropicToolCalls(null)).toEqual({ hasToolCalls: false });
    });
    it('returns hasToolCalls:false when no tool_use blocks', () => {
        const data = { content: [{ type: 'text', text: 'Hello' }] };
        const r = parseAnthropicToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('Hello');
    });
    it('returns hasToolCalls:false for non-array content', () => {
        const r = parseAnthropicToolCalls({ content: 'just string' });
        expect(r.hasToolCalls).toBe(false);
    });
    it('parses tool_use blocks', () => {
        const data = {
            content: [
                { type: 'text', text: 'Let me search.' },
                { type: 'tool_use', id: 'toolu_abc', name: 'web_search', input: { query: 'test' } },
            ]
        };
        const r = parseAnthropicToolCalls(data);
        expect(r.hasToolCalls).toBe(true);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0].id).toBe('toolu_abc');
        expect(r.toolCalls[0].name).toBe('web_search');
        expect(r.toolCalls[0].arguments).toEqual({ query: 'test' });
        expect(r.textContent).toBe('Let me search.');
    });
    it('handles multiple tool_use blocks', () => {
        const data = {
            content: [
                { type: 'tool_use', id: 't1', name: 'a', input: {} },
                { type: 'tool_use', id: 't2', name: 'b', input: {} },
            ]
        };
        expect(parseAnthropicToolCalls(data).toolCalls).toHaveLength(2);
    });
    it('generates fallback id when missing', () => {
        const data = { content: [{ type: 'tool_use', name: 'a', input: {} }] };
        const r = parseAnthropicToolCalls(data);
        expect(r.toolCalls[0].id).toMatch(/^toolu_/);
    });
    it('stores full assistant message', () => {
        const content = [{ type: 'tool_use', id: 't1', name: 'a', input: {} }];
        const r = parseAnthropicToolCalls({ content });
        expect(r.assistantMessage).toEqual({ role: 'assistant', content });
    });
    it('concatenates text from multiple text blocks', () => {
        const data = {
            content: [
                { type: 'text', text: 'Hello ' },
                { type: 'tool_use', id: 't', name: 'a', input: {} },
                { type: 'text', text: 'world' },
            ]
        };
        const r = parseAnthropicToolCalls(data);
        expect(r.textContent).toBe('Hello world');
    });
});

// ══════════════════════════════════════════════════════
// parseGeminiToolCalls
// ══════════════════════════════════════════════════════
describe('parseGeminiToolCalls', () => {
    it('returns hasToolCalls:false for null data', () => {
        expect(parseGeminiToolCalls(null)).toEqual({ hasToolCalls: false });
    });
    it('returns hasToolCalls:false for empty candidates', () => {
        expect(parseGeminiToolCalls({ candidates: [] })).toEqual({ hasToolCalls: false });
    });
    it('returns hasToolCalls:false when no functionCall parts', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] };
        const r = parseGeminiToolCalls(data);
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('Hello');
    });
    it('parses functionCall parts', () => {
        const data = {
            candidates: [{
                content: { parts: [
                    { text: 'I will search.' },
                    { functionCall: { name: 'web_search', args: { query: 'test' } } },
                ] }
            }]
        };
        const r = parseGeminiToolCalls(data);
        expect(r.hasToolCalls).toBe(true);
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls[0].name).toBe('web_search');
        expect(r.toolCalls[0].arguments).toEqual({ query: 'test' });
        expect(r.toolCalls[0].id).toMatch(/^gemini_/);
    });
    it('handles multiple functionCall parts', () => {
        const data = {
            candidates: [{
                content: { parts: [
                    { functionCall: { name: 'a', args: {} } },
                    { functionCall: { name: 'b', args: {} } },
                ] }
            }]
        };
        expect(parseGeminiToolCalls(data).toolCalls).toHaveLength(2);
    });
    it('handles missing args', () => {
        const data = {
            candidates: [{ content: { parts: [{ functionCall: { name: 'a' } }] } }]
        };
        const r = parseGeminiToolCalls(data);
        expect(r.toolCalls[0].arguments).toEqual({});
    });
    it('stores model-role assistant message', () => {
        const parts = [{ functionCall: { name: 'a', args: {} } }];
        const r = parseGeminiToolCalls({ candidates: [{ content: { parts } }] });
        expect(r.assistantMessage.role).toBe('model');
    });
});

// ══════════════════════════════════════════════════════
// parseToolCalls — dispatcher
// ══════════════════════════════════════════════════════
describe('parseToolCalls', () => {
    it('dispatches to anthropic', () => {
        const data = { content: [{ type: 'text', text: 'hi' }] };
        const r = parseToolCalls(data, 'anthropic');
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('hi');
    });
    it('dispatches to google', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
        const r = parseToolCalls(data, 'google');
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('hi');
    });
    it('dispatches to openai by default', () => {
        const data = { choices: [{ message: { content: 'hi' } }] };
        const r = parseToolCalls(data, 'openai');
        expect(r.hasToolCalls).toBe(false);
        expect(r.textContent).toBe('hi');
    });
    it('falls back to openai for unknown format', () => {
        const data = { choices: [{ message: { content: 'hi' } }] };
        const r = parseToolCalls(data, 'unknown');
        expect(r.textContent).toBe('hi');
    });
});

// ══════════════════════════════════════════════════════
// formatToolResult
// ══════════════════════════════════════════════════════
describe('formatToolResult', () => {
    const call = { id: 'call_1', name: 'calc' };
    const text = '42';

    it('formats for OpenAI', () => {
        const r = formatToolResult(call, text, 'openai');
        expect(r).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '42' });
    });

    it('formats for Anthropic', () => {
        const r = formatToolResult(call, text, 'anthropic');
        expect(r).toEqual({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '42' }]
        });
    });

    it('formats for Google', () => {
        const r = formatToolResult(call, text, 'google');
        expect(r).toEqual({
            role: 'function',
            parts: [{ functionResponse: { name: 'calc', response: { result: '42' } } }]
        });
    });

    it('defaults to OpenAI format for unknown', () => {
        const r = formatToolResult(call, text, 'xxx');
        expect(r.role).toBe('tool');
    });

    it('handles empty result text', () => {
        const r = formatToolResult(call, '', 'openai');
        expect(r.content).toBe('');
    });
});
