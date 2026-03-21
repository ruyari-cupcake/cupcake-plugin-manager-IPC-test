/**
 * @fileoverview Tool definitions in MCP-compatible format.
 * Used by both Layer 1 (registerMCP) and Layer 2 (CPM tool-loop).
 * Schema follows MCPToolDef: { name, description, inputSchema }.
 * Migrated from _temp_repo/src/lib/tool-use/tool-definitions.js
 */

import { isToolEnabled } from './tool-config.js';

// ── Built-in tool definitions ──

export const TOOL_DATETIME = {
    name: 'get_current_datetime',
    description: 'Returns the current date and time. Use when the user asks about the current time, date, day of the week, or timezone.',
    inputSchema: {
        type: 'object',
        properties: {
            timezone: { type: 'string', description: 'IANA timezone (e.g. "Asia/Seoul", "America/New_York"). Defaults to user local timezone.' },
            locale: { type: 'string', description: 'Locale for formatting (e.g. "ko-KR", "en-US"). Defaults to "ko-KR".' }
        },
        required: []
    }
};

export const TOOL_CALCULATE = {
    name: 'calculate',
    description: 'Evaluates a mathematical expression safely. Supports basic arithmetic (+, -, *, /, %, **) and Math functions (sin, cos, sqrt, pow, abs, log, floor, ceil, round, min, max, PI, E).',
    inputSchema: {
        type: 'object',
        properties: {
            expression: { type: 'string', description: 'Math expression to evaluate. Example: "Math.sqrt(144) + 5 * 3"' }
        },
        required: ['expression']
    }
};

export const TOOL_DICE = {
    name: 'roll_dice',
    description: 'Rolls dice using standard notation (NdM format). Supports modifiers (+/-). Example: "2d6+3", "1d20", "4d8-2".',
    inputSchema: {
        type: 'object',
        properties: {
            notation: { type: 'string', description: 'Dice notation. Examples: "2d6", "1d20+5", "3d8-2". Default: "1d6".' }
        },
        required: []
    }
};

export const TOOL_WEB_SEARCH = {
    name: 'web_search',
    description: 'Searches the web for current information. Use when the user asks about recent events, facts, or anything requiring up-to-date information.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query string.' },
            count: { type: 'number', description: 'Number of results to return (1-10). Default: 5.' }
        },
        required: ['query']
    }
};

export const TOOL_FETCH_URL = {
    name: 'fetch_url',
    description: 'Fetches and extracts text content from a URL. Use when the user provides a link and asks about its content.',
    inputSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The HTTP/HTTPS URL to fetch.' }
        },
        required: ['url']
    }
};

// ── Tool ID → definition map ──
const TOOL_MAP = {
    datetime: TOOL_DATETIME,
    calculator: TOOL_CALCULATE,
    dice: TOOL_DICE,
    web_search: TOOL_WEB_SEARCH,
    fetch_url: TOOL_FETCH_URL,
};

/**
 * Returns the list of currently enabled tools (MCP format).
 * @returns {Promise<Array<{name:string, description:string, inputSchema:object}>>}
 */
export async function getActiveToolList() {
    const active = [];
    for (const [id, def] of Object.entries(TOOL_MAP)) {
        if (await isToolEnabled(id)) {
            active.push(def);
        }
    }
    return active;
}

/**
 * Get a tool definition by function name.
 * @param {string} name
 * @returns {{name:string, description:string, inputSchema:object}|null}
 */
export function getToolByName(name) {
    return Object.values(TOOL_MAP).find(t => t.name === name) || null;
}
