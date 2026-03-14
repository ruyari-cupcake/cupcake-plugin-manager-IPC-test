import { describe, expect, it } from 'vitest';

describe('Copilot quota parity patterns', () => {
    function detectProxyCacheWarning(userData) {
        return !!(userData && userData.token && userData.tracking_id && !userData.quota_snapshots && !userData.limited_user_quotas);
    }

    function quotaLabel(item) {
        return String(item?.name || item?.type || item?.key || 'quota').replace(/_/g, ' ');
    }

    function normalizeLimitedUserQuotas(luq) {
        if (Array.isArray(luq)) return luq;
        if (typeof luq === 'object' && luq !== null) {
            return Object.entries(luq).map(([k, v]) => ({ name: k, ...(typeof v === 'object' ? v : { value: v }) }));
        }
        return [];
    }

    function splitTokenMeta(meta) {
        const boolFeatures = [];
        const otherFields = {};
        for (const [k, v] of Object.entries(meta || {})) {
            if (typeof v === 'boolean') boolFeatures.push({ key: k, enabled: v });
            else if (k === 'expires_at') otherFields[k] = new Date(v * 1000).toLocaleString('ko-KR');
            else if (k === 'refresh_in') otherFields[k] = `${v}초`;
            else otherFields[k] = v;
        }
        return { boolFeatures, otherFields };
    }

    it('detects proxy-cached token endpoint response masquerading as quota response', () => {
        expect(detectProxyCacheWarning({ token: 'abc', tracking_id: 'tid-1' })).toBe(true);
    });

    it('does not flag proxy warning when actual quota data exists', () => {
        expect(detectProxyCacheWarning({ token: 'abc', tracking_id: 'tid-1', quota_snapshots: {} })).toBe(false);
        expect(detectProxyCacheWarning({ token: 'abc', tracking_id: 'tid-1', limited_user_quotas: [] })).toBe(false);
    });

    it('uses name, type, key fallback order for quota labels', () => {
        expect(quotaLabel({ name: 'premium_interactions' })).toBe('premium interactions');
        expect(quotaLabel({ type: 'chat_quota' })).toBe('chat quota');
        expect(quotaLabel({ key: 'monthly_limit' })).toBe('monthly limit');
        expect(quotaLabel({})).toBe('quota');
    });

    it('normalizes limited_user_quotas object format into array', () => {
        expect(normalizeLimitedUserQuotas({ premium_interactions: { remaining: 12 } })).toEqual([
            { name: 'premium_interactions', remaining: 12 },
        ]);
    });

    it('passes through limited_user_quotas array format', () => {
        const arr = [{ name: 'premium_interactions', remaining: 12 }];
        expect(normalizeLimitedUserQuotas(arr)).toBe(arr);
    });

    it('splits token metadata into boolean features and other fields', () => {
        const { boolFeatures, otherFields } = splitTokenMeta({
            chat_enabled: true,
            code_review: false,
            refresh_in: 300,
            sku: 'copilot_for_individuals_subscriber',
        });

        expect(boolFeatures).toEqual([
            { key: 'chat_enabled', enabled: true },
            { key: 'code_review', enabled: false },
        ]);
        expect(otherFields.refresh_in).toBe('300초');
        expect(otherFields.sku).toBe('copilot_for_individuals_subscriber');
    });
});
