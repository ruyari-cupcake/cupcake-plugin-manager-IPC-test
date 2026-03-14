// model-helpers.js — Shared: 모델 감지 헬퍼 (OpenAI / Copilot / Gemini)
// Ported from temp_repo (model-helpers.js)
// Pure functions, zero side effects.

/**
 * Check if a model supports OpenAI reasoning_effort parameter.
 * Matches o3/o4 variants and GPT-5 family.
 * @param {string} modelName
 * @returns {boolean}
 */
export function supportsOpenAIReasoningEffort(modelName) {
    if (!modelName) return false;
    const m = String(modelName).toLowerCase();
    if (/(?:^|\/)o(?:1(?:-mini|-preview|-pro)?|3(?:-mini|-pro|-deep-research)?|4-mini(?:-deep-research)?)$/i.test(m)) return true;
    return /(?:^|\/)gpt-5(?:\.\d+)?(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(m);
}

/**
 * Check if a model supports the OpenAI `verbosity` parameter.
 * This matches the native/temp_repo behavior: GPT-5 parameter models only,
 * excluding `*-chat-latest` aliases.
 * @param {string} modelName
 * @returns {boolean}
 */
export function supportsOpenAIVerbosity(modelName) {
    if (!modelName) return false;
    return /(?:^|\/)gpt-5(?:\.\d+)?(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(String(modelName).toLowerCase());
}

/**
 * Detect models that require the OpenAI Responses API on GitHub Copilot.
 * GPT-5.4+ models use /responses endpoint instead of /chat/completions.
 * @param {string} modelName
 * @returns {boolean}
 */
export function needsCopilotResponsesAPI(modelName) {
    if (!modelName) return false;
    const m = String(modelName).toLowerCase();
    const match = m.match(/(?:^|\/)gpt-5\.(\d+)/);
    if (match && parseInt(match[1]) >= 4) return true;
    return false;
}

/**
 * Detect o3/o4 family models that only accept reasoning_effort (no sampling params).
 * @param {string} modelName
 * @returns {boolean}
 */
export function shouldStripOpenAISamplingParams(modelName) {
    if (!modelName) return false;
    return /(?:^|\/)o(?:1(?:-mini|-preview|-pro)?|3(?:-mini|-pro|-deep-research)?|4-mini(?:-deep-research)?)$/i.test(
        String(modelName).toLowerCase(),
    );
}

/**
 * GPT-5.4 reasoning compatibility:
 * When reasoning effort is not 'none', GPT-5.4 rejects sampling params like
 * temperature and top_p. Strip them before dispatch.
 * @param {string} modelName
 * @param {string} reasoningEffort
 * @returns {boolean}
 */
export function shouldStripGPT54SamplingForReasoning(modelName, reasoningEffort) {
    if (!modelName) return false;
    const model = String(modelName).toLowerCase();
    const effort = String(reasoningEffort || '').trim().toLowerCase();
    if (!effort || effort === 'none' || effort === 'off') return false;
    return /(?:^|\/)gpt-5\.4(?:-(?:mini|nano|pro))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(model);
}

/**
 * Detect if max_completion_tokens should be used instead of max_tokens.
 * Required by newer OpenAI models (GPT-4.5, GPT-5, o-series).
 * @param {string} modelName
 * @returns {boolean}
 */
export function needsMaxCompletionTokens(modelName) {
    if (!modelName) return false;
    return /(?:^|\/)(?:gpt-(?:4\.5|5)|o[1-9])/i.test(modelName);
}
