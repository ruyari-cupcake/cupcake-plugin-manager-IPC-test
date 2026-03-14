import { safeUUID } from './ipc-protocol.js';

/**
 * @param {number} [maxSize=50]
 */
export function createApiRequestLog(maxSize = 50) {
    /** @type {Array<Record<string, any>>} */
    const entries = [];

    return {
        /**
         * @param {Record<string, any>} entry
         * @returns {string}
         */
        store(entry = {}) {
            const target = entry && typeof entry === 'object' ? entry : { value: entry };
            if (!target.id) target.id = safeUUID();
            if (!target.timestamp) target.timestamp = Date.now();
            entries.unshift(target);
            if (entries.length > maxSize) entries.pop();
            return target.id;
        },

        /**
         * @param {string} id
         * @param {Record<string, any>} patch
         */
        update(id, patch = {}) {
            const found = entries.find((item) => item.id === id);
            if (!found || !patch || typeof patch !== 'object') return;
            Object.assign(found, patch);
        },

        getLatest() {
            return entries[0] || null;
        },

        getAll() {
            return entries;
        },

        /**
         * @param {string} id
         */
        getById(id) {
            return entries.find((item) => item.id === id) || null;
        },

        clear() {
            entries.length = 0;
        },
    };
}

const defaultApiRequestLog = createApiRequestLog(50);

export function storeApiRequest(entry) {
    return defaultApiRequestLog.store(entry);
}

export function updateApiRequest(id, patch) {
    return defaultApiRequestLog.update(id, patch);
}

export function getLatestApiRequest() {
    return defaultApiRequestLog.getLatest();
}

export function getAllApiRequests() {
    return defaultApiRequestLog.getAll();
}

export function getApiRequestById(id) {
    return defaultApiRequestLog.getById(id);
}

export function clearApiRequests() {
    return defaultApiRequestLog.clear();
}
