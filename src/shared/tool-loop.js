/**
 * @fileoverview Layer 2: CPM standalone tool-use loop.
 * Used when CPM IS the provider (RisuAI's requestPlugin ignores arg.tools).
 * Repeatedly calls fetchFn until no more tool_calls or max depth reached.
 * Migrated from _temp_repo/src/lib/tool-use/tool-loop.js
 */

import { getActiveToolList } from './tool-definitions.js';
import { executeToolCall } from './tool-executor.js';
import { parseToolCalls, formatToolResult } from './tool-parsers.js';
import { getToolMaxDepth, getToolTimeout } from './tool-config.js';

/**
 * @param {Function} fn
 * @param {number} ms
 * @returns {Promise<string>}
 */
async function _executeWithTimeout(fn, ms) {
    if (ms <= 0) return await fn();
    return Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tool execution timed out')), ms))
    ]);
}

/**
 * Run the tool-use loop for Layer 2.
 *
 * @param {Object} opts
 * @param {{success:boolean, content:string, _rawData?:any, _status?:number}} opts.initialResult - First fetch result (with _cpmReturnRawJSON)
 * @param {Array<any>} opts.messages - Sanitized messages used for the initial request
 * @param {Record<string,any>} opts.config - fetch config (url, format, key, etc.)
 * @param {number} opts.temp
 * @param {number} opts.maxTokens
 * @param {Record<string,any>} opts.args
 * @param {AbortSignal} [opts.abortSignal]
 * @param {string} [opts._reqId]
 * @param {Function} opts.fetchFn - fetch function reference
 * @returns {Promise<{success:boolean, content:string, _status?:number}>}
 */
export async function runToolLoop(opts) {
    const { initialResult, messages, config, temp, maxTokens, args, abortSignal, _reqId, fetchFn } = opts;
    const format = config.format || 'openai';
    const maxDepth = await getToolMaxDepth();
    const timeout = await getToolTimeout();
    const activeTools = await getActiveToolList();

    if (activeTools.length === 0) return _stripRaw(initialResult);

    // Parse the initial raw response
    if (!initialResult._rawData) return _stripRaw(initialResult);
    const firstParsed = parseToolCalls(initialResult._rawData, format);
    if (!firstParsed.hasToolCalls) {
        // No tool calls — return text content normally
        return { success: true, content: firstParsed.textContent || initialResult.content || '' };
    }

    // Working copy of messages for the loop
    const workingMessages = [...messages];
    let currentParsed = firstParsed;
    let depth = 0;
    let totalCalls = 0;
    const MAX_CALLS = 10;

    while (depth < maxDepth && totalCalls < MAX_CALLS) {
        if (abortSignal?.aborted) break;
        if (!currentParsed.hasToolCalls) break;

        // Add assistant message (with tool_calls) to history
        workingMessages.push(currentParsed.assistantMessage);

        // Execute each tool call
        let hitCallLimit = false;
        for (const call of (currentParsed.toolCalls || [])) {
            if (abortSignal?.aborted) break;
            if (totalCalls >= MAX_CALLS) { hitCallLimit = true; break; }
            totalCalls++;

            let resultText;
            try {
                const resultArr = await _executeWithTimeout(
                    () => executeToolCall(call.name, call.arguments),
                    timeout
                );
                resultText = Array.isArray(resultArr) && resultArr[0]?.text
                    ? resultArr[0].text
                    : JSON.stringify(resultArr);
            } catch (e) {
                resultText = JSON.stringify({ error: /** @type {Error} */(e).message });
            }

            // Add tool result to messages
            workingMessages.push(formatToolResult(call, resultText, format));
        }

        // If we hit MAX_CALLS mid-round, add error results for unprocessed calls
        if (hitCallLimit) {
            const processed = new Set((currentParsed.toolCalls || []).slice(0, totalCalls).map(c => c.id));
            for (const call of (currentParsed.toolCalls || [])) {
                if (!processed.has(call.id)) {
                    workingMessages.push(formatToolResult(call, JSON.stringify({ error: 'Tool call limit reached (' + MAX_CALLS + ' total calls)' }), format));
                }
            }
        }

        depth++;

        // Re-request with tool results in messages
        const loopConfig = {
            ...config,
            streaming: false,
            _cpmReturnRawJSON: true,
            _cpmActiveTools: activeTools,
            _cpmToolUseRound: depth
        };

        let nextResult;
        try {
            nextResult = await fetchFn(
                loopConfig, workingMessages, temp, maxTokens, args, abortSignal, _reqId
            );
        } catch (fetchErr) {
            return { success: false, content: `[Tool-Use Loop] API request failed during round ${depth}: ${/** @type {Error} */(fetchErr).message}`, _status: 0 };
        }

        if (!nextResult || !nextResult.success) {
            return { success: false, content: nextResult?.content || '[Tool-Use Loop] API error during tool round', _status: nextResult?._status };
        }

        if (!nextResult._rawData) {
            return { success: true, content: nextResult.content || '' };
        }

        currentParsed = parseToolCalls(nextResult._rawData, format);
    }

    // If still has tool_calls after max depth, force final response without tools
    if (currentParsed.hasToolCalls && depth >= maxDepth) {
        workingMessages.push(currentParsed.assistantMessage);
        for (const call of (currentParsed.toolCalls || [])) {
            workingMessages.push(formatToolResult(call, JSON.stringify({ error: `Tool call limit exceeded (${maxDepth} rounds)` }), format));
        }
        workingMessages.push({
            role: 'user',
            content: '[System] Tool call limit reached. Please provide your final answer using the information gathered so far.'
        });

        const finalConfig = /** @type {any} */ ({ ...config, streaming: false, _cpmReturnRawJSON: false });
        // No tools in final request — force text-only response
        delete finalConfig._cpmActiveTools;
        const finalResult = await fetchFn(
            finalConfig, workingMessages, temp, maxTokens, args, abortSignal, _reqId
        );

        if (finalResult?._rawData) {
            const parsedFinal = parseToolCalls(finalResult._rawData, format);
            if (!parsedFinal.hasToolCalls && parsedFinal.textContent) {
                return { success: true, content: parsedFinal.textContent, _status: finalResult._status || 200 };
            }

            if (parsedFinal.hasToolCalls) {
                const retryMessages = [...workingMessages, {
                    role: 'user',
                    content: '[System] Do not call any more tools. Return a plain final answer only.'
                }];
                const retryResult = await fetchFn(
                    finalConfig, retryMessages, temp, maxTokens, args, abortSignal, _reqId
                );

                if (retryResult?._rawData) {
                    const parsedRetry = parseToolCalls(retryResult._rawData, format);
                    if (!parsedRetry.hasToolCalls && parsedRetry.textContent) {
                        return { success: true, content: parsedRetry.textContent, _status: retryResult._status || 200 };
                    }
                }

                return { success: retryResult.success, content: retryResult.content || '', _status: retryResult._status };
            }
        }

        return { success: finalResult.success, content: finalResult.content || '', _status: finalResult._status };
    }

    // Normal exit — last response had no tool_calls
    return {
        success: true,
        content: currentParsed.textContent || '',
        _status: 200
    };
}

/** @param {any} result */
function _stripRaw(result) {
    const { _rawData, ...rest } = result;
    return rest;
}
