import { beforeEach, describe, expect, it } from 'vitest';
import {
    storeApiRequest,
    updateApiRequest,
    getLatestApiRequest,
    getAllApiRequests,
    getApiRequestById,
    clearApiRequests,
} from '../src/shared/api-request-log.js';

describe('API Request Log', () => {
    beforeEach(() => {
        clearApiRequests();
    });

    it('stores and retrieves a request', () => {
        const id = storeApiRequest({ modelName: 'gpt-4o', url: 'https://api.openai.com' });
        expect(typeof id).toBe('string');
        const entry = getApiRequestById(id);
        expect(entry.modelName).toBe('gpt-4o');
        expect(entry.url).toBe('https://api.openai.com');
    });

    it('preserves same object reference for later mutation', () => {
        const entry = { id: 'req-1', modelName: 'gpt-4.1', status: null };
        storeApiRequest(entry);
        entry.status = 200;
        expect(getApiRequestById('req-1').status).toBe(200);
    });

    it('getLatestApiRequest returns the most recent', () => {
        storeApiRequest({ modelName: 'first' });
        storeApiRequest({ modelName: 'second' });
        expect(getLatestApiRequest().modelName).toBe('second');
    });

    it('updateApiRequest merges fields', () => {
        const id = storeApiRequest({ modelName: 'test', status: null });
        updateApiRequest(id, { status: 200, response: 'OK' });
        const entry = getApiRequestById(id);
        expect(entry.status).toBe(200);
        expect(entry.response).toBe('OK');
        expect(entry.modelName).toBe('test');
    });

    it('updateApiRequest ignores unknown ID', () => {
        updateApiRequest('nonexistent', { status: 404 });
        expect(getAllApiRequests()).toHaveLength(0);
    });

    it('getAllApiRequests returns newest first', () => {
        storeApiRequest({ modelName: 'a' });
        storeApiRequest({ modelName: 'b' });
        storeApiRequest({ modelName: 'c' });
        const all = getAllApiRequests();
        expect(all).toHaveLength(3);
        expect(all[0].modelName).toBe('c');
        expect(all[2].modelName).toBe('a');
    });

    it('evicts oldest when exceeding max size', () => {
        for (let i = 0; i < 60; i++) {
            storeApiRequest({ idx: i });
        }
        const all = getAllApiRequests();
        expect(all.length).toBeLessThanOrEqual(50);
        expect(all[all.length - 1].idx).toBeGreaterThanOrEqual(10);
    });

    it('getApiRequestById returns null for unknown ID', () => {
        expect(getApiRequestById('bogus')).toBeNull();
    });

    it('clearApiRequests resets everything', () => {
        storeApiRequest({ modelName: 'test' });
        clearApiRequests();
        expect(getLatestApiRequest()).toBeNull();
        expect(getAllApiRequests()).toHaveLength(0);
    });
});
