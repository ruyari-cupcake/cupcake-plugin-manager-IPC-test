// gemini-helpers.js — Shared: Gemini-specific utilities

/**
 * 모델별 안전 설정 반환 — 특정 모델에서 CIVIC_INTEGRITY 제외
 *
 * @param {string} [modelId] 모델 ID (제공 시 모델별 필터링 적용)
 * @returns {import('./types').GeminiSafetySetting[]}
 */
export function getGeminiSafetySettings(modelId) {
    const categories = ['HATE_SPEECH', 'DANGEROUS_CONTENT', 'HARASSMENT', 'SEXUALLY_EXPLICIT', 'CIVIC_INTEGRITY'];
    // Some models don't support CIVIC_INTEGRITY — skip it for those
    const skipCivic = modelId && (/flash-lite|2\.0-pro-exp|gemini-exp/i.test(modelId));
    return categories
        .filter(c => !(skipCivic && c === 'CIVIC_INTEGRITY'))
        .map(c => ({ category: `HARM_CATEGORY_${c}`, threshold: 'OFF' }));
}

/**
 * Gemini generationConfig 파라미터 범위 검증 및 보정
 * @param {import('./types').GeminiGenerationConfig | null | undefined} gc 생성 설정 (in-place 수정)
 */
export function validateGeminiParams(gc) {
    if (!gc || typeof gc !== 'object') return;
    /** @type {Array<[string, number, number, number | undefined, boolean]>} */
    const rules = [['temperature', 0, 2, 1, false], ['topP', 0, 1, undefined, false], ['topK', 1, 64, undefined, false], ['frequencyPenalty', -2, 2, undefined, false], ['presencePenalty', -2, 2, undefined, false]];
    for (const [key, min, max, fb, ex] of rules) {
        // @ts-ignore — GeminiGenerationConfig keys are validated at definition
        if (gc[key] == null) continue;
        // @ts-ignore
        const v = gc[key];
        const bad = v < min || (ex ? v >= max : v > max) || (key === 'topK' && !Number.isInteger(v));
        // @ts-ignore
        if (bad) { if (fb !== undefined) gc[key] = fb; else delete gc[key]; }
    }
}

/**
 * 모델이 실험 모델인지 확인
 * @param {string | null | undefined} modelId
 * @returns {boolean}
 */
export function isExperimentalGeminiModel(modelId) {
    return !!(modelId && (modelId.includes('exp') || modelId.includes('experimental')));
}

/**
 * 모델이 frequency/presence penalty를 지원하는지 확인
 * @param {string | null | undefined} modelId
 * @returns {boolean}
 */
export function geminiSupportsPenalty(modelId) {
    if (!modelId) return false;
    const id = modelId.toLowerCase();
    if (id.includes('exp') || id.includes('experimental')) return false;
    if (id.includes('flash-lite') || id.includes('nano')) return false;
    if (id.includes('embedding') || id.includes('embed') || id.includes('aqa')) return false;
    return true;
}

/**
 * 실험 모델에서 미지원 파라미터 제거
 * @param {import('./types').GeminiGenerationConfig} gc 생성 설정 (in-place 수정)
 * @param {string} modelId 모델 식별자
 */
export function cleanExperimentalModelParams(gc, modelId) {
    const supported = geminiSupportsPenalty(modelId);
    if (!supported) { delete gc.frequencyPenalty; delete gc.presencePenalty; }
    else { if (gc.frequencyPenalty === 0) delete gc.frequencyPenalty; if (gc.presencePenalty === 0) delete gc.presencePenalty; }
}

/**
 * Gemini 사고(thinking) 설정 빌드
 * @param {string} model 모델 ID
 * @param {string | null | undefined} level 사고 레벨 ('off'|'minimal'|'low'|'medium'|'high')
 * @param {string | number | null | undefined} budget 토큰 예산
 * @param {boolean} [isVertexAI] Vertex AI 사용 여부
 * @returns {import('./types').GeminiThinkingConfig | null}
 */
export function buildGeminiThinkingConfig(model, level, budget, isVertexAI) {
    const isGemini3 = /gemini-3/i.test(model || '');
    const budgetNum = parseInt(String(budget)) || 0;
    if (isGemini3) {
        if (level && level !== 'off' && level !== 'none') {
            return isVertexAI
                ? { includeThoughts: true, thinking_level: level }
                : { includeThoughts: true, thinkingLevel: String(level).toLowerCase() };
        }
        return null;
    }
    if (budgetNum > 0) return { includeThoughts: true, thinkingBudget: budgetNum };
    if (level && level !== 'off' && level !== 'none') {
        const budgets = { 'minimal': 1024, 'low': 4096, 'medium': 10240, 'high': 24576 };
        const key = String(level).toLowerCase();
        return { includeThoughts: true, thinkingBudget: budgets[key] || parseInt(level) || 10240 };
    }
    // Gemini 2.5: explicitly disable thinking when "off" — default is thinking-enabled
    if (level === 'off') return { thinkingBudget: 0 };
    return null;
}
