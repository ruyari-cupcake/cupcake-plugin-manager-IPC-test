// @ts-check
/**
 * endpoints.js — Centralized endpoint URL constants for auto-updater.
 *
 * Migrated from temp_repo. The base URL is determined by CPM_ENV environment
 * variable at build time (Rollup pins the resolved value).
 *
 * - CPM_ENV=production → https://cupcake-plugin-manager.vercel.app
 * - CPM_ENV=test (or unset) → https://cupcake-plugin-manager-test.vercel.app
 */

const _URLS = {
    production: 'https://cupcake-plugin-manager.vercel.app',
    test: 'https://cupcake-plugin-manager-test.vercel.app',
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
    } catch (_) { /* iframe runtime — no process */ }
    return 'test';
}

const _env = _resolveEnv();

/** @type {string} The resolved base URL for CPM backend */
export const CPM_BASE_URL = _URLS[_env] || _URLS.test;

/** @type {string} Current environment key */
export const CPM_ENV = _env;

/** Version manifest endpoint (GET → JSON). */
export const VERSIONS_URL = `${CPM_BASE_URL}/api/versions`;

/** Main plugin JS download endpoint (GET → text/javascript). */
export const MAIN_UPDATE_URL = `${CPM_BASE_URL}/api/main-plugin`;

/** Single-bundle update endpoint (GET → JSON with code + hashes). */
export const UPDATE_BUNDLE_URL = `${CPM_BASE_URL}/api/update-bundle`;
