// message-format.js — Shared: Message formatters (OpenAI / Anthropic / Gemini)

/** @typedef {import('./types').ChatMessage} ChatMessage */
/** @typedef {import('./types').OpenAIFormattedMessage} OpenAIFormattedMessage */
/** @typedef {import('./types').OpenAIFormatConfig} OpenAIFormatConfig */
/** @typedef {import('./types').AnthropicFormatResult} AnthropicFormatResult */
/** @typedef {import('./types').GeminiFormatResult} GeminiFormatResult */
/** @typedef {import('./types').GeminiFormatConfig} GeminiFormatConfig */

import {
    sanitizeMessages, extractNormalizedMessagePayload,
    hasNonEmptyMessageContent, stripThoughtDisplayContent
} from './sanitize.js';
import { ThoughtSignatureCache } from './sse-parser.js';

/**
 * base64 data URI에서 mimeType과 data를 분리
 * @param {string} dataUri
 * @returns {{ mimeType: string|null, data: string }}
 */
function parseBase64DataUri(dataUri) {
    if (!dataUri || typeof dataUri !== 'string') return { mimeType: null, data: '' };
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) return { mimeType: null, data: dataUri };
    const prefix = dataUri.substring(0, commaIdx);
    const mimeType = prefix.split(';')[0]?.split(':')[1] || null;
    const data = dataUri.substring(commaIdx + 1);
    return { mimeType, data };
}

/**
 * OpenAI API 포맷으로 변환
 * @param {ChatMessage[]} messages 원본 메시지 배열
 * @param {OpenAIFormatConfig} [config] 변환 옵션
 * @returns {OpenAIFormattedMessage[]}
 */
export function formatToOpenAI(messages, config = {}) {
    let msgs = sanitizeMessages(messages);

    if (config.mergesys) {
        let sysPrompt = "";
        let newMsgs = [];
        for (let m of msgs) {
            if (m.role === 'system') sysPrompt += (sysPrompt ? '\n' : '') + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            else newMsgs.push(m);
        }
        if (sysPrompt && newMsgs.length > 0) {
            newMsgs[0].content = sysPrompt + "\n\n" + (typeof newMsgs[0].content === 'string' ? newMsgs[0].content : JSON.stringify(newMsgs[0].content));
        }
        msgs = newMsgs;
    }

    if (config.mustuser) {
        if (msgs.length > 0 && msgs[0].role !== 'user' && msgs[0].role !== 'system') {
            msgs.unshift({ role: 'user', content: ' ' });
        }
    }

    /** @type {OpenAIFormattedMessage[]} */
    let arr = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || typeof m !== 'object') continue;
        let role = typeof m.role === 'string' ? m.role : 'user';
        if (!role) continue;
        if (role === 'model' || role === 'char') role = 'assistant';
        const msg = { role, content: '' };
        if (config.altrole && msg.role === 'assistant') msg.role = 'model';

        const payload = extractNormalizedMessagePayload(m);

        if (payload.multimodals.length > 0) {
            const contentParts = [];
            const textContent = payload.text.trim();
            if (textContent) contentParts.push({ type: 'text', text: textContent });
            for (const modal of payload.multimodals) {
                if (!modal || typeof modal !== 'object') continue;
                if (modal.type === 'image') {
                    if (modal.base64) contentParts.push({ type: 'image_url', image_url: { url: modal.base64 } });
                    else if (modal.url) contentParts.push({ type: 'image_url', image_url: { url: modal.url } });
                } else if (modal.type === 'audio') {
                    const { mimeType: _audioMime, data: _audioData } = parseBase64DataUri(modal.base64);
                    let _audioFormat = 'mp3';
                    if (_audioMime) {
                        const _m = _audioMime.toLowerCase();
                        if (_m.includes('wav')) _audioFormat = 'wav';
                        else if (_m.includes('ogg')) _audioFormat = 'ogg';
                        else if (_m.includes('flac')) _audioFormat = 'flac';
                        else if (_m.includes('webm')) _audioFormat = 'webm';
                    }
                    contentParts.push({ type: 'input_audio', input_audio: { data: _audioData, format: _audioFormat } });
                }
            }
            // @ts-ignore — content가 동적으로 string | array
            msg.content = contentParts.length > 0 ? contentParts : (textContent || '');
        } else if (typeof m.content === 'string') {
            msg.content = m.content;
        } else if (Array.isArray(m.content)) {
            const mappedParts = [];
            for (const part of m.content) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'image' && part.source && part.source.type === 'base64' && part.source.data) {
                    const mimeType = part.source.media_type || 'image/png';
                    mappedParts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${part.source.data}` } });
                    continue;
                }
                if (part.inlineData && part.inlineData.data) {
                    const mimeType = part.inlineData.mimeType || 'application/octet-stream';
                    if (mimeType.startsWith('image/')) {
                        mappedParts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${part.inlineData.data}` } });
                    } else if (mimeType.startsWith('audio/')) {
                        mappedParts.push({ type: 'input_audio', input_audio: { data: part.inlineData.data, format: mimeType.split('/')[1] || 'mp3' } });
                    }
                    continue;
                }
                mappedParts.push(part);
            }
            // @ts-ignore — content가 동적으로 string | array
            msg.content = mappedParts;
        } else {
            msg.content = payload.text || String(m.content ?? '');
        }

        if (msg.content === null || msg.content === undefined) continue;
        // mustuser placeholder bypass: preserve single-space user placeholder
        const _isMustUserPlaceholder = config.mustuser && msg.role === 'user' && msg.content === ' ';
        if (!_isMustUserPlaceholder && !hasNonEmptyMessageContent(msg.content)) continue;
        if (m.name && typeof m.name === 'string') msg.name = m.name;
        arr.push(msg);
    }

    if (config.sysfirst) {
        const firstIdx = arr.findIndex(m => m.role === 'system');
        if (firstIdx > 0) {
            const el = arr.splice(firstIdx, 1)[0];
            arr.unshift(el);
        }
    }

    // C-2: altrole일 때 연속 동일 role 메시지 병합 (네이티브 requiresAlternateRole 동작)
    if (config.altrole) {
        /** @type {OpenAIFormattedMessage[]} */
        const merged = [];
        for (const msg of arr) {
            const prev = merged[merged.length - 1];
            if (!prev || prev.role !== msg.role) {
                merged.push(msg);
                continue;
            }
            if (typeof prev.content === 'string' && typeof msg.content === 'string') {
                prev.content += '\n' + msg.content;
                continue;
            }
            const prevParts = Array.isArray(prev.content)
                ? prev.content
                : (hasNonEmptyMessageContent(prev.content) ? [{ type: 'text', text: String(prev.content) }] : []);
            const msgParts = Array.isArray(msg.content)
                ? msg.content
                : (hasNonEmptyMessageContent(msg.content) ? [{ type: 'text', text: String(msg.content) }] : []);
            prev.content = [...prevParts, ...msgParts];
        }
        arr.length = 0;
        arr.push(...merged);
    }

    // BUG-Q4 FIX: GPT-5.x 모델 — system → developer 역할 변환 (네이티브 DeveloperRole 플래그 동작과 동일)
    if (config.developerRole) {
        for (const m of arr) {
            if (m.role === 'system') m.role = 'developer';
        }
    }

    return arr;
}

/**
 * Anthropic Claude API 포맷으로 변환
 *
 * BUG-Q1/Q2 FIX: Claude 응답 품질 차이 원인 수정
 *   1. content를 항상 structured content blocks [{type:'text', text}] 으로 전송
 *   2. 선두 system만 top-level system 필드로 추출, 비선두는 user + "system: " 접두사
 *   3. 첨 메시지 플레이스홀더 "Start" (네이티브와 동일)
 * @param {ChatMessage[]} messages 원본 메시지 배열
 * @param {object} [config] 변환 옵션
 * @returns {AnthropicFormatResult}
 */
export function formatToAnthropic(messages, config = {}) {
    const validMsgs = sanitizeMessages(messages);

    // 1. 선두(leading) 시스템 메시지만 추출 — 비선두는 위치 유지
    const leadingSystem = [];
    let splitIdx = 0;
    for (let i = 0; i < validMsgs.length; i++) {
        if (validMsgs[i].role === 'system') {
            leadingSystem.push(typeof validMsgs[i].content === 'string' ? validMsgs[i].content : JSON.stringify(validMsgs[i].content));
            splitIdx = i + 1;
        } else {
            break;
        }
    }
    const systemPrompt = leadingSystem.join('\n\n');
    const remainingMsgs = validMsgs.slice(splitIdx);

    // 2. 비선두 시스템 메시지를 user 역할로 변환 (네이티브 reformater 동작과 동일)
    const chatMsgs = remainingMsgs.map(m => {
        if (m.role === 'system') {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return { ...m, role: 'user', content: `system: ${content}` };
        }
        return m;
    });

    const formattedMsgs = [];
    for (const m of chatMsgs) {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const payload = extractNormalizedMessagePayload(m);

        if (payload.multimodals.length > 0) {
            const contentParts = [];
            const textContent = payload.text.trim();
            if (textContent) contentParts.push({ type: 'text', text: textContent });
            for (const modal of payload.multimodals) {
                if (!modal || typeof modal !== 'object') continue;
                if (modal.type === 'image') {
                    const base64Str = modal.base64 || '';
                    const commaIdx = base64Str.indexOf(',');
                    const mediaType = (commaIdx > -1 ? base64Str.split(';')[0]?.split(':')[1] : null) || 'image/png';
                    const data = commaIdx > -1 ? base64Str.substring(commaIdx + 1) : base64Str;
                    contentParts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
                }
            }
            if (contentParts.length > 0) {
                if (formattedMsgs.length > 0 && formattedMsgs[formattedMsgs.length - 1].role === role) {
                    const prev = formattedMsgs[formattedMsgs.length - 1];
                    if (!Array.isArray(prev.content)) prev.content = [{ type: 'text', text: typeof prev.content === 'string' ? prev.content : '' }];
                    prev.content.push(... /** @type {any[]} */ (contentParts));
                } else {
                    formattedMsgs.push({ role, content: contentParts });
                }
            } else {
                const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                if (!hasNonEmptyMessageContent(text)) continue;
                // 항상 structured content block 사용
                if (formattedMsgs.length > 0 && formattedMsgs[formattedMsgs.length - 1].role === role) {
                    const prev = formattedMsgs[formattedMsgs.length - 1];
                    if (Array.isArray(prev.content)) {
                        prev.content.push({ type: 'text', text });
                    } else {
                        prev.content = [{ type: 'text', text: typeof prev.content === 'string' ? prev.content : '' }, { type: 'text', text }];
                    }
                } else {
                    formattedMsgs.push({ role, content: [{ type: 'text', text }] });
                }
            }
            continue;
        }

        if (Array.isArray(m.content)) {
            const contentParts = [];
            for (const part of m.content) {
                if (!part || typeof part !== 'object') continue;
                if (typeof part.text === 'string' && part.text.trim() !== '') {
                    contentParts.push({ type: 'text', text: part.text });
                    continue;
                }
                if (part.type === 'image' && part.source && part.source.type === 'base64' && part.source.data) {
                    contentParts.push(part);
                    continue;
                }
                if (part.inlineData && part.inlineData.data) {
                    const mimeType = part.inlineData.mimeType || 'application/octet-stream';
                    if (mimeType.startsWith('image/')) {
                        contentParts.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: part.inlineData.data } });
                    }
                    continue;
                }
                if (part.type === 'image_url' || part.type === 'input_image') {
                    const imageUrl = typeof part.image_url === 'string'
                        ? part.image_url
                        : (part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '');
                    if (imageUrl.startsWith('data:image/')) {
                        const mediaType = imageUrl.split(';')[0]?.split(':')[1] || 'image/png';
                        const data = imageUrl.split(',')[1] || '';
                        if (data) contentParts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
                    } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                        contentParts.push({ type: 'image', source: { type: 'url', url: imageUrl } });
                    }
                }
            }

            if (contentParts.length > 0) {
                if (formattedMsgs.length > 0 && formattedMsgs[formattedMsgs.length - 1].role === role) {
                    const prev = formattedMsgs[formattedMsgs.length - 1];
                    if (typeof prev.content === 'string') prev.content = [{ type: 'text', text: prev.content }, ...contentParts];
                    else if (Array.isArray(prev.content)) prev.content.push(... /** @type {any[]} */ (contentParts));
                } else {
                    formattedMsgs.push({ role, content: contentParts });
                }
                continue;
            }
        }

        // 기본 텍스트 경로 — 항상 structured content block [{type:'text', text}] 사용
        const content = payload.text || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        if (!hasNonEmptyMessageContent(content)) continue;
        if (formattedMsgs.length > 0 && formattedMsgs[formattedMsgs.length - 1].role === role) {
            const prev = formattedMsgs[formattedMsgs.length - 1];
            if (Array.isArray(prev.content)) {
                prev.content.push({ type: 'text', text: content });
            } else {
                prev.content = [{ type: 'text', text: typeof prev.content === 'string' ? prev.content : '' }, { type: 'text', text: content }];
            }
            if (prev._origSources) prev._origSources.push(m);
        } else {
            formattedMsgs.push({ role, content: [{ type: 'text', text: content }], _origSources: [m] });
        }
    }
    if (formattedMsgs.length === 0 || formattedMsgs[0].role !== 'user') {
        formattedMsgs.unshift({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    }

    // Anthropic prompt caching: add cache_control to messages with cachePoint
    // Use the _origSources array (attached during formatting) to correctly map
    // original chatMsgs → formatted messages regardless of merge operations.
    for (const msg of formattedMsgs) {
        const sources = msg._origSources;
        if (!sources) continue;
        const hasCachePoint = sources.some(s => s?.cachePoint);
        if (hasCachePoint) {
            if (typeof msg.content === 'string') {
                msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                /** @type {any} */ (msg.content[msg.content.length - 1]).cache_control = { type: 'ephemeral' };
            }
        }
        delete msg._origSources; // Clean up internal tracking property
    }

    return { messages: /** @type {import('./types').AnthropicFormattedMessage[]} */ (formattedMsgs), system: systemPrompt };
}

// stripThoughtDisplayContent는 sanitize.js에서 공유 import
// Re-export for backward compatibility
export { stripThoughtDisplayContent } from './sanitize.js';

/**
 * Google Gemini API 포맷으로 변환
 *
 * BUG-Q5 FIX: 비선두 system 메시지를 "system: content" 접두사로 변환
 * @param {ChatMessage[]} messagesRaw 원본 메시지 배열
 * @param {GeminiFormatConfig} [config] 변환 옵션
 * @returns {GeminiFormatResult}
 */
export function formatToGemini(messagesRaw, config = {}) {
    const messages = sanitizeMessages(messagesRaw);
    const systemInstruction = [];
    const contents = [];
    let systemPhase = true;

    for (const m of messages) {
        if (m.role === 'system' && systemPhase) {
            systemInstruction.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            continue;
        }
        if (m.role !== 'system') systemPhase = false;

        const role = (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user';
        const payload = extractNormalizedMessagePayload(m);
        const normalizedMultimodals = payload.multimodals;
        let text = payload.text;
        if (!text && !Array.isArray(m.content) && typeof m.content !== 'string') {
            text = JSON.stringify(m.content);
        }

        let trimmed = text.trim();
        if (role === 'model') trimmed = stripThoughtDisplayContent(trimmed);

        if (m.role === 'system') {
            // BUG-Q5 FIX: 네이티브 RisuAI reformater와 동일한 포맷 사용 ("system: content")
            //   기존: [System]\ncontent\n[/System] 태그 → 모델이 XML 태그로 오해할 수 있음
            //   수정: "system: content" 접두사 (네이티브와 동일)
            const sysText = `system: ${trimmed}`;
            if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
                contents[contents.length - 1].parts.push({ text: sysText });
            } else {
                contents.push({ role: 'user', parts: [{ text: sysText }] });
            }
            continue;
        }

        if (trimmed === '' && normalizedMultimodals.length === 0) continue;

        if (normalizedMultimodals.length > 0) {
            const lastMessage = contents.length > 0 ? contents[contents.length - 1] : null;
            if (lastMessage && lastMessage.role === role) {
                if (trimmed) {
                    const _lastPart = lastMessage.parts[lastMessage.parts.length - 1];
                    if (_lastPart?.inlineData || _lastPart?.fileData || _lastPart?.text === undefined) {
                        lastMessage.parts.push({ text: trimmed });
                    } else {
                        _lastPart.text += '\n\n' + trimmed;
                    }
                }
                for (const modal of normalizedMultimodals) {
                    if (modal.type === 'image' || modal.type === 'audio' || modal.type === 'video') {
                        if (modal.url && modal.type === 'image') {
                            lastMessage.parts.push({ fileData: { mimeType: modal.mimeType || 'image/*', fileUri: modal.url } });
                            continue;
                        }
                        const base64 = modal.base64 || '';
                        const commaIdx = base64.indexOf(',');
                        const mimeType = (commaIdx > -1 ? base64.split(';')[0]?.split(':')[1] : null) || modal.mimeType || 'application/octet-stream';
                        const data = commaIdx > -1 ? base64.substring(commaIdx + 1) : base64;
                        lastMessage.parts.push({ inlineData: { mimeType, data } });
                    }
                }
            } else {
                const newParts = [];
                if (trimmed) newParts.push({ text: trimmed });
                for (const modal of normalizedMultimodals) {
                    if (modal.type === 'image' || modal.type === 'audio' || modal.type === 'video') {
                        if (modal.url && modal.type === 'image') {
                            newParts.push({ fileData: { mimeType: modal.mimeType || 'image/*', fileUri: modal.url } });
                            continue;
                        }
                        const base64 = modal.base64 || '';
                        const commaIdx = base64.indexOf(',');
                        const mimeType = (commaIdx > -1 ? base64.split(';')[0]?.split(':')[1] : null) || modal.mimeType || 'application/octet-stream';
                        const data = commaIdx > -1 ? base64.substring(commaIdx + 1) : base64;
                        newParts.push({ inlineData: { mimeType, data } });
                    }
                }
                if (newParts.length > 0) contents.push({ role, parts: newParts });
            }
            continue;
        }

        const part = { text: trimmed || text };
        if (config.useThoughtSignature && role === 'model') {
            const cachedSig = ThoughtSignatureCache.get(trimmed || text);
            if (cachedSig) part.thoughtSignature = cachedSig;
        }

        if (contents.length > 0 && contents[contents.length - 1].role === role) {
            contents[contents.length - 1].parts.push(part);
        } else {
            contents.push({ role, parts: [part] });
        }
    }

    if (contents.length > 0 && contents[0].role === 'model') contents.unshift({ role: 'user', parts: [{ text: 'Start' }] });

    if (!config.preserveSystem && systemInstruction.length > 0) {
        // BUG-Q5 FIX: 네이티브와 동일한 "system: content" 접두사 사용
        //   기존: [System Content]\n...\n[/System Content] 태그
        //   수정: "system: {content}" (간결하고 네이티브 동작과 일치)
        const sysText = `system: ${systemInstruction.join('\n\n')}`;
        if (contents.length > 0 && contents[0].role === 'user') {
            contents[0].parts.unshift({ text: sysText });
        } else {
            contents.unshift({ role: 'user', parts: [{ text: sysText }] });
        }
        systemInstruction.length = 0;
    }

    return { contents: /** @type {import('./types').GeminiContent[]} */ (contents), systemInstruction };
}
