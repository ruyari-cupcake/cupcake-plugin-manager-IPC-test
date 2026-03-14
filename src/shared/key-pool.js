/**
 * key-pool.js — API 키 로테이션 풀
 * 원시 문자열에서 직접 생성 (getArgument 의존 제거)
 */

/** @constant {number} 키 로테이션 기본 최대 재시도 횟수 */
const DEFAULT_MAX_RETRIES = 30;

/** @constant {number[]} 로테이션 대상 HTTP 상태 코드 */
const RETRYABLE_STATUS_CODES = [429, 529, 503];

/**
 * 공백으로 구분된 API 키 풀.
 * 429/503 에러 시 자동으로 소진된 키를 제외하고 다음 키로 전환.
 */
export class KeyPool {
    /**
     * @param {string} rawString 공백으로 구분된 API 키 목록
     * @param {string} [name] 풀 이름 (에러 메시지 구분용)
     */
    constructor(rawString, name = '') {
        /** @type {string[]} */
        this.keys = (rawString || '').trim().split(/\s+/).filter(k => k.length > 0);
        /** @type {string[]} 원본 키 목록 (소진 시 복원용) */
        this._originalKeys = [...this.keys];
        /** @type {string} 풀 이름 */
        this.name = name;
    }

    /** @returns {string} 랜덤 키 (풀 비어있으면 빈 문자열) */
    pick() {
        return this.keys.length === 0 ? '' : this.keys[Math.floor(Math.random() * this.keys.length)];
    }

    /**
     * 실패한 키를 풀에서 제거
     * @param {string} failedKey 제거할 키
     * @returns {number} 남은 키 수
     */
    drain(failedKey) {
        const idx = this.keys.indexOf(failedKey);
        if (idx > -1) this.keys.splice(idx, 1);
        return this.keys.length;
    }

    /**
     * M-8: 원본 키 목록으로 복원 (소진 후 다음 요청에서 재시도 가능)
     */
    reset() {
        this.keys = [...this._originalKeys];
    }

    /** @returns {number} 남은 키 수 */
    get remaining() { return this.keys.length; }

    /**
     * 키 로테이션으로 fetch 재시도
     * @param {(key: string) => Promise<import('./types').ProviderResult>} fetchFn 키를 받아 요청 수행
     * @param {import('./types').KeyPoolRotationOptions} [opts] 재시도 옵션
     * @returns {Promise<import('./types').ProviderResult>}
     */
    async withRotation(fetchFn, opts = {}) {
        const maxRetries = opts.maxRetries || DEFAULT_MAX_RETRIES;
        const isRetryable = opts.isRetryable || ((r) => RETRYABLE_STATUS_CODES.includes(r._status));

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const key = this.pick();
            if (!key) return { success: false, content: `[KeyPool]${this.name ? ' ' + this.name + ':' : ''} 사용 가능한 키 없음` };
            const result = await fetchFn(key);
            if (result.success || !isRetryable(result)) return result;
            const rem = this.drain(key);
            console.warn(`[KeyPool]${this.name ? ' ' + this.name : ''} 🔄 키 교체 (HTTP ${result._status || '?'}, 남은 키: ${rem}개, 시도: ${attempt + 1})`);
            if (rem === 0) {
                console.warn(`[KeyPool]${this.name ? ' ' + this.name + ':' : ''} ⚠️ 모든 키가 소진되었습니다. 원본 키 복원.`);
                this.reset();
                return result;
            }
        }
        return { success: false, content: `[KeyPool] 최대 재시도 횟수(${maxRetries}) 초과` };
    }

    /**
     * JSON 배열/객체 형식의 키 풀 생성 (AWS/Vertex 자격증명용)
     * @param {string} rawString JSON 문자열
     * @returns {KeyPool}
     */
    static fromJson(rawString) {
        const pool = new KeyPool('');
        const trimmed = (rawString || '').trim();
        if (!trimmed) return pool;
        try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr)) {
                pool.keys = arr.filter(o => o && typeof o === 'object').map(o => JSON.stringify(o));
                pool._originalKeys = [...pool.keys];
                return pool;
            }
        } catch {}
        // M-1: comma-separated JSON fallback: {"a":1},{"b":2}
        if (trimmed.startsWith('{')) {
            try {
                const arr = JSON.parse('[' + trimmed + ']');
                if (Array.isArray(arr)) {
                    pool.keys = arr.filter(o => o && typeof o === 'object').map(o => JSON.stringify(o));
                    pool._originalKeys = [...pool.keys];
                    return pool;
                }
            } catch {}
        }
        try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                pool.keys = [trimmed];
                pool._originalKeys = [...pool.keys];
                return pool;
            }
        } catch {}
        return pool;
    }
}
