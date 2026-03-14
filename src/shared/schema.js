/**
 * schema.js — 경량 구조 검증 (pluginStorage/원격 데이터 방어)
 * temp_repo에서 포팅: validateSchema, parseAndValidate, schemas
 */

/**
 * 단일 값의 타입/제약 검증
 * @param {unknown} data 검증 대상
 * @param {import('./types').SchemaDefinition} schema 스키마 정의
 * @returns {{ valid: boolean, value: unknown }}
 */
export function validateSchema(data, schema) {
    if (!schema || typeof schema !== 'object') return { valid: true, value: data };

    const type = schema.type;

    // null/undefined check
    if (data === null || data === undefined) {
        if (schema.required) return { valid: false, value: undefined };
        if (schema.default !== undefined) return { valid: true, value: schema.default };
        return { valid: true, value: data };
    }

    // Type checking
    if (type === 'string') {
        if (typeof data !== 'string') return { valid: false, value: undefined };
        if (schema.maxLength && data.length > schema.maxLength) {
            return { valid: true, value: data.substring(0, schema.maxLength) };
        }
        return { valid: true, value: data };
    }

    if (type === 'number') {
        const num = typeof data === 'number' ? data : Number(data);
        if (isNaN(num)) return { valid: false, value: undefined };
        return { valid: true, value: num };
    }

    if (type === 'boolean') {
        if (typeof data === 'boolean') return { valid: true, value: data };
        if (data === 'true' || data === 1) return { valid: true, value: true };
        if (data === 'false' || data === 0) return { valid: true, value: false };
        return { valid: false, value: undefined };
    }

    if (type === 'array') {
        if (!Array.isArray(data)) return { valid: false, value: undefined };
        let arr = data;
        if (schema.maxItems && arr.length > schema.maxItems) {
            arr = arr.slice(0, schema.maxItems);
        }
        if (schema.items) {
            arr = arr.filter(item => {
                const result = validateSchema(item, schema.items);
                return result.valid;
            });
        }
        return { valid: true, value: arr };
    }

    if (type === 'object') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, value: undefined };
        if (schema.properties) {
            const result = {};
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                const propResult = validateSchema(data[key], propSchema);
                if (propResult.valid && propResult.value !== undefined) {
                    result[key] = propResult.value;
                } else if (propSchema.required) {
                    return { valid: false, value: undefined };
                }
            }
            return { valid: true, value: result };
        }
        return { valid: true, value: data };
    }

    return { valid: true, value: data };
}

/**
 * JSON 문자열 파싱 + 스키마 검증 (한 번에)
 * @param {string} jsonStr JSON 문자열
 * @param {import('./types').SchemaDefinition} schema 스키마 정의
 * @returns {{ valid: boolean, value: unknown }}
 */
export function parseAndValidate(jsonStr, schema) {
    try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        return validateSchema(data, schema);
    } catch {
        return { valid: false, value: undefined };
    }
}

/**
 * 미리 정의된 스키마
 */
export const schemas = {
    /** Settings backup data schema */
    settingsBackup: {
        type: 'object',
    },
    /** Boot status schema */
    bootStatus: {
        type: 'object',
        properties: {
            lastBootTime: { type: 'number' },
            status: { type: 'string' },
            completedPhases: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            failedPhase: { type: 'string' },
            error: { type: 'string', maxLength: 2000 },
        },
    },
    /** Update bundle versions manifest schema */
    updateBundleVersions: {
        type: 'object',
    },
    /** Update bundle (versions + code) schema */
    updateBundle: {
        type: 'object',
        properties: {
            versions: { type: 'object', required: true },
            code: { type: 'object' },
        },
    },
};
