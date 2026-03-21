// @ts-check
/**
 * endpoints.js — Centralized endpoint URL constants for auto-updater.
 *
 * IPC architecture uses GitHub raw URLs as primary update source.
 * Vercel static hosting is secondary fallback.
 *
 * - CPM_ENV=production → prod repo raw URLs
 * - CPM_ENV=test (or unset) → IPC-test repo raw URLs
 */

const _GITHUB_RAW = {
    production: 'https://raw.githubusercontent.com/ruyari-cupcake/cupcake-plugin-manager-IPC-prod/main/dist',
    test: 'https://raw.githubusercontent.com/ruyari-cupcake/cupcake-plugin-manager-IPC-test/main/dist',
};

const _VERCEL = {
    production: 'https://cupcake-plugin-manager.vercel.app',
    test: 'https://ipc-eight.vercel.app',
};

/**
 * Resolve CPM_ENV from environment (Node build) or fall back to 'test'.
 * In the iframe runtime (no process.env), this always evaluates to 'test'.
 * @returns {'production' | 'test'}
 */
function _resolveEnv() {
    try {
        // @ts-ignore — process.env exists only in Node (build-time)
        const env = (typeof process !== 'undefined' && process.env?.CPM_ENV) || '';
        if (env === 'production') return 'production';
    } catch { /* iframe runtime — no process */ }
    return 'test';
}

const _env = _resolveEnv();

/** @type {string} GitHub raw base URL for dist files */
export const CPM_BASE_URL = _GITHUB_RAW[_env] || _GITHUB_RAW.test;

/** @type {string} Vercel static hosting base URL (fallback) */
export const CPM_VERCEL_URL = _VERCEL[_env] || _VERCEL.test;

/** @type {string} Current environment key */
export const CPM_ENV = _env;

/** Version manifest: update-bundle.json from GitHub raw (lightweight: just versions + hashes). */
export const VERSIONS_URL = `${CPM_BASE_URL}/update-bundle.json`;

/** Main plugin JS download: direct raw URL. */
export const MAIN_UPDATE_URL = `${CPM_BASE_URL}/cupcake-provider-manager.js`;

/** Full update bundle JSON (all plugins code + hashes). */
export const UPDATE_BUNDLE_URL = `${CPM_BASE_URL}/update-bundle.json`;
