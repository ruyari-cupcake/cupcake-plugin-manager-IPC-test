/**
 * @fileoverview Tool-Use configuration loader.
 * Reads user settings via safeGetArg (IPC-compatible).
 * Migrated from _temp_repo/src/lib/tool-use/tool-config.js
 */

import { safeGetArg, safeGetBoolArg } from './helpers.js';

/**
 * @returns {Promise<boolean>}
 */
export async function isToolUseEnabled() {
    return safeGetBoolArg('cpm_tool_use_enabled', false);
}

/**
 * @param {string} toolId
 * @returns {Promise<boolean>}
 */
export async function isToolEnabled(toolId) {
    if (!(await isToolUseEnabled())) return false;
    return safeGetBoolArg(`cpm_tool_${toolId}`, false);
}

/**
 * @returns {Promise<number>}
 */
export async function getToolMaxDepth() {
    const v = await safeGetArg('cpm_tool_max_depth');
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n > 0) ? Math.min(n, 20) : 5;
}

/**
 * @returns {Promise<number>}
 */
export async function getToolTimeout() {
    const v = await safeGetArg('cpm_tool_timeout');
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n > 0) ? Math.min(n, 60000) : 10000;
}

/**
 * Web search provider configuration.
 * @returns {Promise<{provider:string, url:string, key:string, cx:string}>}
 */
export async function getWebSearchConfig() {
    return {
        provider: (await safeGetArg('cpm_tool_websearch_provider')) || 'brave',
        url: (await safeGetArg('cpm_tool_websearch_url')) || '',
        key: (await safeGetArg('cpm_tool_websearch_key')) || '',
        cx: (await safeGetArg('cpm_tool_websearch_cx')) || '',
    };
}
