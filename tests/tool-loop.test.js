/**
 * @file tool-loop.test.js — Tests for Layer 2 tool-use loop
 * Covers: runToolLoop (normal flow, no tool calls, abort, max depth, max calls,
 *         timeout, fetch error, final retry, missing rawData)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──
const mockGetActiveToolList = vi.fn().mockResolvedValue([
    { name: 'calculate', description: 'calc', inputSchema: { type: 'object', properties: { expression: { type: 'string' } } } }
]);
const mockExecuteToolCall = vi.fn().mockResolvedValue([{ type: 'text', text: '{"result":42}' }]);
const mockParseToolCalls = vi.fn();
const mockFormatToolResult = vi.fn().mockReturnValue({ role: 'tool', tool_call_id: 'c1', content: '42' });
const mockGetToolMaxDepth = vi.fn().mockResolvedValue(20);
const mockGetToolTimeout = vi.fn().mockResolvedValue(0);

vi.mock('../src/shared/tool-definitions.js', () => ({
    getActiveToolList: (...a) => mockGetActiveToolList(...a),
}));
vi.mock('../src/shared/tool-executor.js', () => ({
    executeToolCall: (...a) => mockExecuteToolCall(...a),
}));
vi.mock('../src/shared/tool-parsers.js', () => ({
    parseToolCalls: (...a) => mockParseToolCalls(...a),
    formatToolResult: (...a) => mockFormatToolResult(...a),
}));
vi.mock('../src/shared/tool-config.js', () => ({
    getToolMaxDepth: (...a) => mockGetToolMaxDepth(...a),
    getToolTimeout: (...a) => mockGetToolTimeout(...a),
}));

const { runToolLoop } = await import('../src/shared/tool-loop.js');

const MSG = [{ role: 'user', content: 'Hello' }];

function baseOpts(overrides = {}) {
    return {
        initialResult: {
            success: true,
            content: 'hi',
            _rawData: { choices: [{ message: { content: 'hi' } }] },
            _status: 200,
        },
        messages: [...MSG],
        config: { format: 'openai' },
        temp: 0.7,
        maxTokens: 1000,
        args: {},
        fetchFn: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveToolList.mockResolvedValue([{ name: 'calculate' }]);
    mockGetToolMaxDepth.mockResolvedValue(20);
    mockGetToolTimeout.mockResolvedValue(0);
});

// ══════════════════════════════════════════════════
// Basic flow: no tool calls in response
// ══════════════════════════════════════════════════
describe('runToolLoop — no tool calls', () => {
    it('returns content when no tool_calls found', async () => {
        mockParseToolCalls.mockReturnValue({ hasToolCalls: false, textContent: 'Hello!' });
        const opts = baseOpts();
        const r = await runToolLoop(opts);
        expect(r.success).toBe(true);
        expect(r.content).toBe('Hello!');
        expect(opts.fetchFn).not.toHaveBeenCalled();
    });

    it('returns stripped result when no _rawData', async () => {
        const opts = baseOpts({
            initialResult: { success: true, content: 'hi', _status: 200 }
        });
        const r = await runToolLoop(opts);
        expect(r.success).toBe(true);
        expect(r).not.toHaveProperty('_rawData');
    });

    it('returns stripped result when no active tools', async () => {
        mockGetActiveToolList.mockResolvedValue([]);
        const opts = baseOpts();
        const r = await runToolLoop(opts);
        expect(r.success).toBe(true);
        expect(r).not.toHaveProperty('_rawData');
    });
});

// ══════════════════════════════════════════════════
// Single round of tool use
// ══════════════════════════════════════════════════
describe('runToolLoop — single round', () => {
    it('executes one tool call and returns final response', async () => {
        // First parse => tool calls
        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true,
                assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] },
                toolCalls: [{ id: 'c1', name: 'calculate', arguments: { expression: '2+2' } }],
                textContent: ''
            })
            // Second parse => no tool calls (final)
            .mockReturnValueOnce({
                hasToolCalls: false,
                textContent: 'The answer is 4.'
            });

        const fetchFn = vi.fn().mockResolvedValue({
            success: true, content: 'The answer is 4.',
            _rawData: { choices: [{ message: { content: 'The answer is 4.' } }] }, _status: 200
        });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(true);
        expect(r.content).toBe('The answer is 4.');
        expect(mockExecuteToolCall).toHaveBeenCalledWith('calculate', { expression: '2+2' });
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});

// ══════════════════════════════════════════════════
// Abort signal
// ══════════════════════════════════════════════════
describe('runToolLoop — abort', () => {
    it('stops when abort signal is set', async () => {
        const ac = new AbortController();
        ac.abort();

        mockParseToolCalls.mockReturnValue({
            hasToolCalls: true,
            assistantMessage: {},
            toolCalls: [{ id: 'c1', name: 'calculate', arguments: {} }],
            textContent: ''
        });

        const r = await runToolLoop(baseOpts({ abortSignal: ac.signal }));
        expect(r.content).toBe('');
        expect(mockExecuteToolCall).not.toHaveBeenCalled();
    });
});

// ══════════════════════════════════════════════════
// Max depth limit
// ══════════════════════════════════════════════════
describe('runToolLoop — max depth', () => {
    it('stops at max depth and sends final request', async () => {
        mockGetToolMaxDepth.mockResolvedValue(1);
        // Always returns tool calls
        mockParseToolCalls.mockReturnValue({
            hasToolCalls: true,
            assistantMessage: { role: 'assistant' },
            toolCalls: [{ id: 'c1', name: 'calculate', arguments: {} }],
            textContent: ''
        });

        const fetchFn = vi.fn()
            // loop round 1 -> still has tool calls
            .mockResolvedValueOnce({
                success: true, content: '', _rawData: { choices: [{ message: {} }] }, _status: 200
            })
            // final (no tools) -> text
            .mockResolvedValueOnce({
                success: true, content: 'Final answer.', _rawData: null, _status: 200
            });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(r.content).toBe('Final answer.');
    });
});

// ══════════════════════════════════════════════════
// Fetch failure during loop
// ══════════════════════════════════════════════════
describe('runToolLoop — fetch errors', () => {
    it('returns error when fetchFn throws', async () => {
        mockParseToolCalls.mockReturnValue({
            hasToolCalls: true,
            assistantMessage: {},
            toolCalls: [{ id: 'c1', name: 'a', arguments: {} }],
            textContent: ''
        });

        const fetchFn = vi.fn().mockRejectedValue(new Error('network error'));
        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(false);
        expect(r.content).toContain('network error');
    });

    it('returns error when fetchFn returns failure', async () => {
        mockParseToolCalls.mockReturnValue({
            hasToolCalls: true,
            assistantMessage: {},
            toolCalls: [{ id: 'c1', name: 'a', arguments: {} }],
            textContent: ''
        });

        const fetchFn = vi.fn().mockResolvedValue({
            success: false, content: 'API rate limit', _status: 429
        });
        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(false);
        expect(r.content).toContain('API rate limit');
    });
});

// ══════════════════════════════════════════════════
// Tool executor errors
// ══════════════════════════════════════════════════
describe('runToolLoop — tool errors', () => {
    it('catches tool executor exception and continues', async () => {
        mockExecuteToolCall.mockRejectedValueOnce(new Error('tool crashed'));
        mockFormatToolResult.mockReturnValue({ role: 'tool', content: '{"error":"tool crashed"}' });

        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true,
                assistantMessage: {},
                toolCalls: [{ id: 'c1', name: 'a', arguments: {} }],
                textContent: ''
            })
            .mockReturnValueOnce({
                hasToolCalls: false,
                textContent: 'Done despite error.'
            });

        const fetchFn = vi.fn().mockResolvedValue({
            success: true, content: 'Done', _rawData: {}, _status: 200
        });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(true);
        expect(r.content).toBe('Done despite error.');
    });
});

// ══════════════════════════════════════════════════
// Timeout
// ══════════════════════════════════════════════════
describe('runToolLoop — timeout', () => {
    it('applies tool timeout to executor', async () => {
        mockGetToolTimeout.mockResolvedValue(50); // 50ms
        mockExecuteToolCall.mockImplementation(
            () => new Promise(resolve => setTimeout(() => resolve([{ type: 'text', text: '{"r":1}' }]), 200))
        );

        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true,
                assistantMessage: {},
                toolCalls: [{ id: 'c1', name: 'a', arguments: {} }],
                textContent: ''
            })
            .mockReturnValueOnce({ hasToolCalls: false, textContent: 'ok' });

        const fetchFn = vi.fn().mockResolvedValue({
            success: true, content: 'ok', _rawData: {}, _status: 200
        });

        // Tool should time out, but loop continues with error result
        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(true);
    });
});

// ══════════════════════════════════════════════════
// MAX_CALLS limit (10)
// ══════════════════════════════════════════════════
describe('runToolLoop — MAX_CALLS', () => {
    it('stops executing tools after 10 total calls', async () => {
        const manyTools = Array.from({ length: 12 }, (_, i) => ({
            id: `c${i}`, name: 'calculate', arguments: {}
        }));

        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true,
                assistantMessage: {},
                toolCalls: manyTools,
                textContent: ''
            })
            .mockReturnValue({ hasToolCalls: false, textContent: 'done' });

        const fetchFn = vi.fn().mockResolvedValue({
            success: true, content: 'done', _rawData: {}, _status: 200
        });

        await runToolLoop(baseOpts({ fetchFn }));
        // Should have been called 10 times, not 12
        expect(mockExecuteToolCall).toHaveBeenCalledTimes(10);
    });
});

// ══════════════════════════════════════════════════
// Max-depth final retry branches (lines 131–177)
// ══════════════════════════════════════════════════
describe('runToolLoop — max-depth final response', () => {
    it('returns parsedFinal textContent when no tool_calls in final', async () => {
        mockGetToolMaxDepth.mockResolvedValue(1);
        // Initial parse + loop round always return tool_calls
        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c1', name: 'a', arguments: {} }], textContent: ''
            })
            // After loop round re-parse: still tool calls (triggers max depth)
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c2', name: 'a', arguments: {} }], textContent: ''
            })
            // Parse final result: text only (no tool calls)
            .mockReturnValueOnce({
                hasToolCalls: false, textContent: 'Final parsed text'
            });

        const fetchFn = vi.fn()
            .mockResolvedValueOnce({ success: true, content: '', _rawData: {}, _status: 200 })
            .mockResolvedValueOnce({ success: true, content: 'raw', _rawData: { some: 'data' }, _status: 200 });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(true);
        expect(r.content).toBe('Final parsed text');
        expect(r._status).toBe(200);
    });

    it('performs retry when final still has tool_calls', async () => {
        mockGetToolMaxDepth.mockResolvedValue(1);
        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c1', name: 'a', arguments: {} }], textContent: ''
            })
            // After loop: still tool calls
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c2', name: 'a', arguments: {} }], textContent: ''
            })
            // Parse final: still tool calls → triggers retry
            .mockReturnValueOnce({
                hasToolCalls: true, toolCalls: [{ id: 'c3', name: 'a', arguments: {} }], textContent: ''
            })
            // Parse retry: text only
            .mockReturnValueOnce({
                hasToolCalls: false, textContent: 'Retry success text'
            });

        const fetchFn = vi.fn()
            .mockResolvedValueOnce({ success: true, content: '', _rawData: {}, _status: 200 })
            // Final request
            .mockResolvedValueOnce({ success: true, content: 'x', _rawData: { d: 1 }, _status: 200 })
            // Retry request
            .mockResolvedValueOnce({ success: true, content: 'y', _rawData: { d: 2 }, _status: 200 });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(true);
        expect(r.content).toBe('Retry success text');
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('falls back to retryResult when retry still has tool_calls', async () => {
        mockGetToolMaxDepth.mockResolvedValue(1);
        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c1', name: 'a', arguments: {} }], textContent: ''
            })
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c2', name: 'a', arguments: {} }], textContent: ''
            })
            // final parse: still tool calls
            .mockReturnValueOnce({
                hasToolCalls: true, toolCalls: [{ id: 'c3' }], textContent: ''
            })
            // retry parse: STILL has tool calls → give up
            .mockReturnValueOnce({
                hasToolCalls: true, toolCalls: [{ id: 'c4' }], textContent: ''
            });

        const fetchFn = vi.fn()
            .mockResolvedValueOnce({ success: true, content: '', _rawData: {}, _status: 200 })
            .mockResolvedValueOnce({ success: true, content: 'f', _rawData: { d: 1 }, _status: 200 })
            .mockResolvedValueOnce({ success: true, content: 'fallback', _rawData: { d: 2 }, _status: 200 });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.content).toBe('fallback');
    });

    it('returns finalResult directly when _rawData is absent', async () => {
        mockGetToolMaxDepth.mockResolvedValue(1);
        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c1', name: 'a', arguments: {} }], textContent: ''
            })
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c2', name: 'a', arguments: {} }], textContent: ''
            });

        const fetchFn = vi.fn()
            .mockResolvedValueOnce({ success: true, content: '', _rawData: {}, _status: 200 })
            // Final: no _rawData
            .mockResolvedValueOnce({ success: true, content: 'plain final', _status: 200 });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.content).toBe('plain final');
    });

    it('returns retryResult when retry has no _rawData', async () => {
        mockGetToolMaxDepth.mockResolvedValue(1);
        mockParseToolCalls
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c1', name: 'a', arguments: {} }], textContent: ''
            })
            .mockReturnValueOnce({
                hasToolCalls: true, assistantMessage: {}, toolCalls: [{ id: 'c2', name: 'a', arguments: {} }], textContent: ''
            })
            // final: still has tool calls
            .mockReturnValueOnce({
                hasToolCalls: true, toolCalls: [{ id: 'c3' }], textContent: ''
            });

        const fetchFn = vi.fn()
            .mockResolvedValueOnce({ success: true, content: '', _rawData: {}, _status: 200 })
            .mockResolvedValueOnce({ success: true, content: 'x', _rawData: { d: 1 }, _status: 200 })
            // retry: no _rawData → falls through to retryResult.content
            .mockResolvedValueOnce({ success: true, content: 'retry plain', _status: 200 });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.content).toBe('retry plain');
    });
});

// ══════════════════════════════════════════════════
// Loop with no _rawData in next result
// ══════════════════════════════════════════════════
describe('runToolLoop — loop nextResult without _rawData', () => {
    it('returns content when nextResult has no _rawData', async () => {
        mockParseToolCalls.mockReturnValueOnce({
            hasToolCalls: true,
            assistantMessage: {},
            toolCalls: [{ id: 'c1', name: 'a', arguments: {} }],
            textContent: ''
        });

        const fetchFn = vi.fn().mockResolvedValue({
            success: true, content: 'mid-loop text', _status: 200
            // no _rawData
        });

        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(true);
        expect(r.content).toBe('mid-loop text');
    });

    it('returns null result as error', async () => {
        mockParseToolCalls.mockReturnValueOnce({
            hasToolCalls: true,
            assistantMessage: {},
            toolCalls: [{ id: 'c1', name: 'a', arguments: {} }],
            textContent: ''
        });

        const fetchFn = vi.fn().mockResolvedValue(null);
        const r = await runToolLoop(baseOpts({ fetchFn }));
        expect(r.success).toBe(false);
    });
});
