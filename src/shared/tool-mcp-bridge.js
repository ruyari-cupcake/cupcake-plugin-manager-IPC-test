/**
 * @fileoverview Layer 1 bridge: registers CPM tools via Risu.registerMCP.
 * When the user's main provider is a native one (OpenAI/Anthropic/Google),
 * RisuAI automatically injects these tools and handles the tool-use loop.
 * Migrated from _temp_repo/src/lib/tool-use/tool-mcp-bridge.js
 */

import { isToolUseEnabled } from './tool-config.js';
import { getActiveToolList } from './tool-definitions.js';
import { executeToolCall } from './tool-executor.js';
import { getRisu } from './ipc-protocol.js';

const MCP_IDENTIFIER = 'plugin:cpm-tools';

/**
 * Register CPM tools with RisuAI's MCP system.
 * Called during manager init startup.
 * @param {string} [version]
 */
export async function registerCpmTools(version) {
    if (!(await isToolUseEnabled())) return;

    const Risu = getRisu();
    try {
        await Risu.registerMCP(
            {
                identifier: MCP_IDENTIFIER,
                name: 'Cupcake PM Tools',
                version: version || '1.0.0',
                description: 'CPM built-in tools (datetime, calculator, dice, web search, URL fetch)'
            },
            getActiveToolList,
            async (toolName, args) => {
                return await executeToolCall(toolName, args);
            }
        );
        console.log('[CPM Tool-Use] MCP tools registered (Layer 1)');
    } catch (e) {
        console.warn('[CPM Tool-Use] registerMCP failed:', /** @type {Error} */(e).message);
    }
}

/**
 * Re-register after settings change (e.g. user enables/disables a tool).
 * @param {string} [version]
 */
export async function refreshCpmTools(version) {
    const Risu = getRisu();
    try {
        await Risu.unregisterMCP(MCP_IDENTIFIER);
    } catch { /* may not exist yet */ }
    await registerCpmTools(version);
}
