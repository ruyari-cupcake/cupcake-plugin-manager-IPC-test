// sanitize.js — Shared: 메시지 정화 함수군
import { safeStringify } from './helpers.js';

/**
 * Check if text is an inlay scene wrapper (should be preserved intact).
 * @param {string} text
 * @returns {boolean}
 */
export function isInlaySceneWrapperText(text) {
    if (typeof text !== 'string') return false;
    return /<lb-xnai\s+scene="[^"]*">\{\{(?:inlay|inlayed|inlayeddata)::[^}]*\}\}<\/lb-xnai>/i.test(text);
}

/**
 * RisuAI 내부 태그 (<qak>) 제거
 * @param {string} text 원본 텍스트
 * @returns {string}
 */
export function stripInternalTags(text) {
    if (typeof text !== 'string') return text;
    if (isInlaySceneWrapperText(text)) return text.trim();
    return text.replace(/<qak>|<\/qak>/g, '').trim();
}

/**
 * 멀티모달이 제거된 메시지에서 남은 자동 캡션 제거
 * @param {string} text 메시지 텍스트
 * @param {import('./types').ChatMessage} message 원본 메시지
 * @returns {string}
 */
export function stripStaleAutoCaption(text, message) {
    if (typeof text !== 'string') return text;
    if (isInlaySceneWrapperText(text) || /\{\{(?:inlay|inlayed|inlayeddata)::[^}]*\}\}/i.test(text)) return text;
    if (hasAttachedMultimodals(message)) return text;
    const lower = text.toLowerCase();
    const imageIntent = lower.includes('image') || lower.includes('photo') || lower.includes('picture') || lower.includes('첨부') || lower.includes('사진');
    if (!imageIntent) return text;
    return text.replace(/\s*\[[a-z0-9][a-z0-9 ,.'"-]{6,}\]\s*$/i, (match) => {
        // Only strip if the bracket content looks like an auto-generated image caption.
        // Captions are typically multi-word descriptions (≥2 alphabetic words with 2+ chars).
        // This avoids stripping structured references like [Chapter 12, Part 2].
        const inner = match.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
        const wordCount = (inner.match(/[a-z]{2,}/gi) || []).length;
        if (wordCount >= 3) return '';
        return match;   // Too few words to be an image caption — leave it alone
    }).trim();
}

/**
 * 메시지에 멀티모달 첨부가 있는지 확인
 * @param {import('./types').ChatMessage | null | undefined} message
 * @returns {boolean}
 */
export function hasAttachedMultimodals(message) {
    return !!(message && Array.isArray(message.multimodals) && message.multimodals.length > 0);
}

/**
 * 메시지 content가 유효한 값인지 확인 (빈 문자열, null 제외)
 * @param {string | import('./types').ContentPart[] | object | null | undefined} content
 * @returns {boolean}
 */
export function hasNonEmptyMessageContent(content) {
    if (content === null || content === undefined) return false;
    if (typeof content === 'string') return content.trim() !== '';
    if (Array.isArray(content)) return content.length > 0;
    if (typeof content === 'object') return true;
    return String(content).trim() !== '';
}

/**
 * 메시지에서 텍스트 + 멀티모달을 정규화 추출
 * @param {import('./types').ChatMessage} message
 * @returns {import('./types').NormalizedPayload}
 */
export function extractNormalizedMessagePayload(message) {
    const normalizedMultimodals = [];
    const textParts = [];

    if (Array.isArray(message?.multimodals)) {
        for (const modal of message.multimodals) {
            if (modal && typeof modal === 'object') normalizedMultimodals.push(modal);
        }
    }

    const content = message?.content;
    if (typeof content === 'string') {
        textParts.push(content);
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (typeof part.text === 'string' && part.text.trim() !== '') textParts.push(part.text);
            if (part.inlineData && part.inlineData.data) {
                const mimeType = part.inlineData.mimeType || 'application/octet-stream';
                const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
                if (mimeType.startsWith('image/')) normalizedMultimodals.push({ type: 'image', base64: dataUrl, mimeType });
                else if (mimeType.startsWith('audio/')) normalizedMultimodals.push({ type: 'audio', base64: dataUrl, mimeType });
                else if (mimeType.startsWith('video/')) normalizedMultimodals.push({ type: 'video', base64: dataUrl, mimeType });
            }
            if (part.type === 'image_url') {
                const imgUrlObj = /** @type {{ url?: string }} */ (typeof part.image_url === 'object' ? part.image_url : null);
                const imageUrl = typeof part.image_url === 'string' ? part.image_url
                    : (imgUrlObj && typeof imgUrlObj.url === 'string' ? imgUrlObj.url : '');
                if (imageUrl.startsWith('data:image/')) normalizedMultimodals.push({ type: 'image', base64: imageUrl, mimeType: imageUrl.split(';')[0]?.split(':')[1] || 'image/png' });
                else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) normalizedMultimodals.push({ type: 'image', url: imageUrl, mimeType: 'image/*' });
            }
            if (part.type === 'input_image') {
                const imageUrl = typeof part.image_url === 'string' ? part.image_url : (part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '');
                if (imageUrl.startsWith('data:image/')) normalizedMultimodals.push({ type: 'image', base64: imageUrl, mimeType: imageUrl.split(';')[0]?.split(':')[1] || 'image/png' });
                else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) normalizedMultimodals.push({ type: 'image', url: imageUrl, mimeType: 'image/*' });
            }
            if (part.type === 'input_audio' && part.input_audio && part.input_audio.data) {
                const format = part.input_audio.format || 'mp3';
                normalizedMultimodals.push({ type: 'audio', base64: `data:audio/${format};base64,${part.input_audio.data}`, mimeType: `audio/${format}` });
            }
            if (part.type === 'image' && part.source && part.source.type === 'base64' && part.source.data) {
                const mimeType = part.source.media_type || 'image/png';
                normalizedMultimodals.push({ type: 'image', base64: `data:${mimeType};base64,${part.source.data}`, mimeType });
            }
        }
    } else if (content !== null && content !== undefined) {
        const contentObj = /** @type {Record<string, unknown>} */ (content);
        if (typeof contentObj === 'object' && typeof contentObj.text === 'string') textParts.push(contentObj.text);
        else if (typeof content === 'object') {
            // Structured objects (e.g. multimodal parts missing .text) must be
            // JSON-serialized to preserve data. String(obj) produces the useless
            // "[object Object]" which corrupts downstream API payloads.
            try { textParts.push(JSON.stringify(content)); } catch { textParts.push(String(content)); }
        }
        else textParts.push(String(content));
    }

    return { text: textParts.join('\n\n'), multimodals: /** @type {import('./types').Multimodal[]} */ (normalizedMultimodals) };
}

/**
 * 메시지 배열 정화 (빈 메시지 제거, 내부 태그 제거, 자동 캡션 제거)
 * @param {import('./types').ChatMessage[]} messages
 * @returns {import('./types').ChatMessage[]}
 */
export function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const result = [];
    for (const m of messages) {
        if (m == null || typeof m !== 'object') continue;
        if (typeof m.role !== 'string' || !m.role) continue;
        if (m.content === null || m.content === undefined) continue;
        const cleaned = { ...m };
        if (typeof /** @type {any} */ (cleaned).toJSON === 'function') delete /** @type {any} */ (cleaned).toJSON;
        if (typeof cleaned.content === 'string') {
            cleaned.content = stripInternalTags(cleaned.content);
            cleaned.content = stripStaleAutoCaption(cleaned.content, cleaned);
        }
        if (!hasNonEmptyMessageContent(cleaned.content) && !hasAttachedMultimodals(cleaned)) continue;
        result.push(cleaned);
    }
    return result;
}

/**
 * JSON 문자열의 messages/contents 배열을 정화
 * @param {string} jsonStr 원본 JSON 문자열
 * @returns {string} 정화된 JSON 문자열
 */
/**
 * <Thoughts> 디스플레이 블록 제거 (sanitize에서 공유)
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 */
export function stripThoughtDisplayContent(text) {
    if (!text) return text;
    let cleaned = text;
    cleaned = cleaned.replace(/<Thoughts>[\s\S]*?<\/Thoughts>\s*/g, '');
    if (cleaned.includes('> [Thought Process]')) {
        const lastMarkerIdx = cleaned.lastIndexOf('> [Thought Process]');
        const afterLastMarker = cleaned.substring(lastMarkerIdx);
        const contentMatch = afterLastMarker.match(/\n{3,}\s*(?=[^\s>\\])/);
        if (contentMatch) {
            cleaned = afterLastMarker.substring(contentMatch.index).trim();
        } else {
            cleaned = '';
        }
    }
    cleaned = cleaned.replace(/\\n\\n/g, '');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeBodyJSON(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr);
        if (Array.isArray(obj.messages)) {
            const before = obj.messages.length;
            obj.messages = obj.messages.filter(m => {
                if (m == null || typeof m !== 'object') return false;
                if (!hasNonEmptyMessageContent(m.content) && !hasAttachedMultimodals(m)) return false;
                if (typeof m.role !== 'string' || !m.role) return false;
                if (typeof m.toJSON === 'function') delete m.toJSON;
                return true;
            });
            const removed = before - obj.messages.length;
            if (removed > 0) console.warn(`[Cupcake PM] sanitizeBodyJSON: removed ${removed} invalid messages (${before} → ${obj.messages.length})`);
        }
        if (Array.isArray(obj.contents)) {
            const before = obj.contents.length;
            obj.contents = obj.contents.filter(m => m != null && typeof m === 'object');
            const removed = before - obj.contents.length;
            if (removed > 0) console.warn(`[Cupcake PM] sanitizeBodyJSON: removed ${removed} invalid contents (${before} → ${obj.contents.length})`);
        }
        const result = safeStringify(obj);
        // Validate output: ensure it's still valid JSON
        try {
            JSON.parse(result);
        } catch {
            console.error('[Cupcake PM] sanitizeBodyJSON: Output validation failed — returning original');
            return jsonStr;
        }
        return result;
    } catch (e) {
        // Non-JSON passthrough: don't crash on non-JSON bodies
        if (typeof jsonStr === 'string' && jsonStr.trimStart().match(/^[{[]/)) {
            console.warn('[Cupcake PM] sanitizeBodyJSON: JSON parse error:', e.message);
        }
        return jsonStr;
    }
}
