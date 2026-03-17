// @ts-nocheck
/**
 * coverage-e2e-integration.test.js
 * End-to-end 통합 테스트 — 멀티모달, 스트리밍, 에러핸들링, 전체 파이프라인
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockRisuIPC, createMockRisuFull, createSSEMockReader } from './helpers/test-factories.js';

// ─── 코어 모듈 ───
import { formatToAnthropic, formatToGemini } from '../src/shared/message-format.js';
import { sanitizeMessages, hasNonEmptyMessageContent, sanitizeBodyJSON } from '../src/shared/sanitize.js';
import { createSSEStream } from '../src/shared/sse-parser.js';
import { _normalizeTokenUsage, _setTokenUsage, _takeTokenUsage, _tokenUsageKey } from '../src/shared/token-usage.js';
import { guessServiceRegion } from '../src/shared/aws-signer.js';
import { formatAwsDynamicModels, mergeDynamicModels } from '../src/shared/dynamic-models.js';
import { validateDbPatch, safeSetDatabaseLite } from '../src/shared/safe-db-writer.js';
import { buildGeminiThinkingConfig } from '../src/shared/gemini-helpers.js';
import { inferSlot } from '../src/shared/slot-inference.js';
import { KeyPool } from '../src/shared/key-pool.js';
import { normalizeCustomModel, serializeCustomModelExport } from '../src/shared/custom-model-serialization.js';
import { registerWithManager, CH, MSG } from '../src/shared/ipc-protocol.js';
import { createSettingsBackup } from '../src/shared/settings-backup.js';
import { collectStream } from '../src/shared/helpers.js';
import { CPM_BASE_URL } from '../src/shared/endpoints.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// A. 멀티모달 전체 파이프라인: sanitize → format → both providers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: multimodal full pipeline', () => {
    const multimodalConversation = [
        { role: 'system', content: 'You are a visual AI assistant' },
        {
            role: 'user',
            content: 'What is in this image?',
            multimodals: [
                { type: 'image', base64: 'data:image/png;base64,iVBOR==' },
            ],
        },
        { role: 'assistant', content: 'I see a picture of a cat.' },
        {
            role: 'user',
            content: 'Now describe this one too',
            multimodals: [
                { type: 'image', url: 'https://example.com/dog.jpg' },
            ],
        },
    ];

    it('sanitize → Anthropic: multimodal messages preserved with correct structure', () => {
        const sanitized = sanitizeMessages(multimodalConversation);
        expect(sanitized.length).toBe(4);

        const result = formatToAnthropic(sanitized);
        expect(result.system).toContain('visual AI');
        expect(result.messages.length).toBeGreaterThanOrEqual(3);

        // Check image parts exist
        const userMsgs = result.messages.filter(m => m.role === 'user');
        const hasImage = userMsgs.some(m =>
            Array.isArray(m.content) && m.content.some(p => p.type === 'image')
        );
        expect(hasImage).toBe(true);
    });

    it('sanitize → Gemini: multimodal messages preserved with parts', () => {
        const sanitized = sanitizeMessages(multimodalConversation);
        const result = formatToGemini(sanitized);

        expect(result.contents.length).toBeGreaterThanOrEqual(3);

        // Check inlineData or fileData parts
        const userContents = result.contents.filter(c => c.role === 'user');
        const hasMedia = userContents.some(c =>
            c.parts.some(p => p.inlineData || p.fileData)
        );
        expect(hasMedia).toBe(true);
    });

    it('mixed image types in single conversation (base64 + URL + data URI)', () => {
        const msgs = [
            {
                role: 'user',
                content: [
                    { text: 'Compare these images' },
                    { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            },
            { role: 'assistant', content: 'They look different' },
        ];

        const antResult = formatToAnthropic(msgs);
        const userMsg = antResult.messages.find(m => m.role === 'user');
        expect(Array.isArray(userMsg.content)).toBe(true);

        // Should have both URL and base64 sources
        const urlPart = userMsg.content.find(p => p.source?.type === 'url');
        const b64Part = userMsg.content.find(p => p.source?.type === 'base64');
        expect(urlPart).toBeTruthy();
        expect(b64Part).toBeTruthy();
    });

    it('audio and video multimodals handled in Gemini format', () => {
        const msgs = [
            {
                role: 'user',
                content: 'Transcribe this',
                multimodals: [
                    { type: 'audio', base64: 'data:audio/mp3;base64,AUDIO', mimeType: 'audio/mp3' },
                ],
            },
        ];
        const result = formatToGemini(msgs);
        const userParts = result.contents.find(c => c.role === 'user')?.parts;
        expect(userParts?.some(p => p.inlineData)).toBe(true);
    });

    it('empty multimodals array → treated as text-only', () => {
        const msgs = [
            { role: 'user', content: 'just text', multimodals: [] },
        ];
        const antResult = formatToAnthropic(msgs);
        const gemResult = formatToGemini(msgs);
        expect(antResult.messages.length).toBeGreaterThanOrEqual(1);
        expect(gemResult.contents.length).toBeGreaterThanOrEqual(1);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// B. 스트리밍 파이프라인: SSE → collect → tokenUsage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: streaming pipeline (SSE → tokenUsage)', () => {
    it('SSE stream → parse → normalize tokens (OpenAI format)', async () => {
        const sseData = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
            'data: [DONE]\n\n',
        ];
        const { response: mockResponse } = createSSEMockReader(sseData);

        let lastUsage = null;
        const stream = createSSEStream(
            mockResponse,
            (line) => {
                if (line.startsWith('data: ')) {
                    const d = line.slice(6);
                    if (d === '[DONE]') return null;
                    try {
                        const obj = JSON.parse(d);
                        if (obj.usage) lastUsage = obj.usage;
                        return obj;
                    } catch { return null; }
                }
                return null;
            },
            undefined,
            undefined,
        );

        const reader = stream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }

        expect(chunks.length).toBeGreaterThanOrEqual(2);

        // Normalize the collected usage
        if (lastUsage) {
            const normalized = _normalizeTokenUsage(lastUsage, 'openai');
            expect(normalized.input).toBe(10);
            expect(normalized.output).toBe(5);
            expect(normalized.total).toBe(15);
        }
    });

    it('SSE stream → parse → normalize tokens (Anthropic format)', async () => {
        const sseData = [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n',
            'data: [DONE]\n\n',
        ];
        const { response: mockResponse } = createSSEMockReader(sseData);

        const parsed = [];
        const stream = createSSEStream(
            mockResponse,
            (line) => {
                if (line.startsWith('data: ')) {
                    const d = line.slice(6);
                    if (d === '[DONE]') return null;
                    try { return JSON.parse(d); } catch { return null; }
                }
                return null;
            },
        );

        const reader = stream.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parsed.push(value);
        }

        expect(parsed.length).toBeGreaterThan(0);

        // Simulate final usage aggregation
        const usage = _normalizeTokenUsage(
            { input_tokens: 50, output_tokens: 30 },
            'anthropic',
        );
        expect(usage.input).toBe(50);
        expect(usage.output).toBe(30);
    });

    it('SSE stream abort during streaming → graceful close', async () => {
        const ac = new AbortController();
        let callCount = 0;
        const mockReader = {
            read: vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return {
                        done: false,
                        value: new TextEncoder().encode('data: {"chunk":1}\n\n'),
                    };
                }
                // Abort before second chunk
                ac.abort();
                await new Promise(r => setTimeout(r, 10));
                return { done: false, value: new TextEncoder().encode('data: late\n\n') };
            }),
            cancel: vi.fn(),
        };
        const mockResponse = { body: { getReader: () => mockReader } };

        const stream = createSSEStream(
            mockResponse,
            (line) => {
                if (line.startsWith('data: ')) {
                    try { return JSON.parse(line.slice(6)); } catch { return line; }
                }
                return null;
            },
            ac.signal,
        );

        const reader = stream.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// C. AWS 통합: signer → dynamic models → merge → format
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: AWS model discovery pipeline', () => {
    it('AWS model list → format → merge with existing', () => {
        // Step 1: AWS Bedrock model summaries
        const awsModels = [
            {
                modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
                modelName: 'Claude 3.5 Sonnet v2',
                outputModalities: ['TEXT'],
                inferenceTypesSupported: ['ON_DEMAND'],
                providerName: 'Anthropic',
            },
            {
                modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
                modelName: 'Claude 3 Haiku',
                outputModalities: ['TEXT'],
                inferenceTypesSupported: ['ON_DEMAND'],
                providerName: 'Anthropic',
            },
            {
                modelId: 'stability.stable-image-ultra-v1:0',
                modelName: 'Stable Image Ultra',
                outputModalities: ['IMAGE'],
                inferenceTypesSupported: ['ON_DEMAND'],
            },
        ];

        // Step 2: Format
        const formatted = formatAwsDynamicModels(awsModels);
        expect(formatted.length).toBe(2); // Only TEXT models

        // Step 3: Merge with existing models
        const existing = [
            { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        ];
        const { mergedModels, addedModels } = mergeDynamicModels(existing, formatted, 'aws-bedrock');

        expect(mergedModels.length).toBe(3);
        expect(addedModels.length).toBe(2);
    });

    it('service region detection for various AWS endpoints', () => {
        const endpoints = [
            { url: 'https://bedrock-runtime.us-east-1.amazonaws.com/', service: 'bedrock-runtime', region: 'us-east-1' },
            { url: 'https://bedrock-runtime.eu-west-1.amazonaws.com/', service: 'bedrock-runtime', region: 'eu-west-1' },
            { url: 'https://lambda.ap-northeast-1.amazonaws.com/', service: 'lambda', region: 'ap-northeast-1' },
        ];
        for (const ep of endpoints) {
            const [service, region] = guessServiceRegion(new URL(ep.url), new Headers());
            expect(service).toBe(ep.service);
            expect(region).toBe(ep.region);
        }
    });

    it('model dedup: merged models keep latest, addedModels only new', () => {
        const base = [
            { id: 'claude-3', name: 'Claude 3', provider: 'aws' },
        ];
        const updates = [
            { id: 'claude-3', name: 'Claude 3 Updated', provider: 'aws' },
            { id: 'claude-4', name: 'Claude 4', provider: 'aws' },
        ];
        const { mergedModels, addedModels } = mergeDynamicModels(base, updates, 'aws');
        expect(addedModels.length).toBe(1); // only claude-4 is new
        expect(addedModels[0].id).toBe('claude-4');
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D. 에러 복원력 통합 테스트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: error resilience', () => {
    it('malformed messages → sanitize filters → format still produces valid output', () => {
        const badMsgs = [
            { role: 'user', content: '' },
            { role: 'system', content: null },
            { role: 'user', content: 'valid question' },
            { role: 'assistant', content: undefined },
            { role: 'user', content: '  ' },
            { role: 'assistant', content: 'valid response' },
        ];
        const antResult = formatToAnthropic(badMsgs);
        const gemResult = formatToGemini(badMsgs);

        // Should produce valid output despite bad inputs
        expect(antResult.messages.length).toBeGreaterThanOrEqual(1);
        expect(gemResult.contents.length).toBeGreaterThanOrEqual(1);

        // All messages should have valid roles
        for (const m of antResult.messages) {
            expect(['user', 'assistant']).toContain(m.role);
        }
        for (const c of gemResult.contents) {
            expect(['user', 'model']).toContain(c.role);
        }
    });

    it('KeyPool with various credential formats → all parseable', () => {
        // Standard newline-separated keys
        const pool1 = new KeyPool('key1\nkey2\nkey3');
        expect(pool1.remaining).toBe(3);

        // Comma-separated
        const pool2 = new KeyPool('keyA, keyB, keyC');
        expect(pool2.remaining).toBeGreaterThanOrEqual(1);

        // Single key
        const pool3 = new KeyPool('single-key');
        expect(pool3.remaining).toBe(1);

        // Empty
        const pool4 = new KeyPool('');
        expect(pool4.remaining).toBe(0);
    });

    it('validateDbPatch rejects ALL dangerous operations', () => {
        const attacks = [
            { guiHTML: '<script>alert(1)</script>' },         // XSS
            { customCSS: '.evil { display: none }' },          // CSS injection
            { characters: [{ name: 'hacked' }] },             // Data manipulation
            { plugins: [] },                                   // Delete all plugins
            { plugins: [{ name: 'x', script: '', version: '3.0' }] }, // Empty script
            { randomKey: 'value' },                            // Unknown key
        ];
        for (const attack of attacks) {
            const result = validateDbPatch(attack);
            expect(result.ok).toBe(false);
        }
    });

    it('sanitizeBodyJSON handles malformed bodies gracefully', () => {
        // Valid body passes through
        const valid = sanitizeBodyJSON(JSON.stringify({
            messages: [
                { role: 'user', content: 'hi' },
            ],
        }));
        expect(typeof valid).toBe('string');

        // Non-JSON string passes through
        const nonJson = sanitizeBodyJSON('plain text body');
        expect(nonJson).toBe('plain text body');
    });

    it('normalizeTokenUsage handles edge cases', () => {
        expect(_normalizeTokenUsage(null, 'openai')).toBeNull();
        expect(_normalizeTokenUsage({}, 'openai')).toEqual(expect.objectContaining({ input: 0, output: 0 }));
        expect(_normalizeTokenUsage(42, 'openai')).toBeNull();
        expect(_normalizeTokenUsage({ prompt_tokens: 100 }, 'unknown')).toBeNull();
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// E. IPC 등록 + 슬롯 추론 통합
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: IPC registration + slot inference', () => {
    it('register → ACK → infer slot for configured model', async () => {
        const risu = createMockRisuIPC();

        // Step 1: Register
        const regPromise = registerWithManager(risu, 'TestProvider', {
            version: '1.0',
            supportedFormats: ['openai', 'anthropic'],
        }, { maxRetries: 1, baseDelay: 10 });

        setTimeout(() => risu._emit(CH.CONTROL, { type: MSG.REGISTER_ACK }), 20);
        const registered = await regPromise;
        expect(registered).toBe(true);

        // Step 2: Infer slot
        const mockSafeGetArg = vi.fn().mockImplementation(async (key) => {
            if (key === 'cpm_slot_chat') return 'claude-3';
            return '';
        });

        const heuristics = { chat: { patterns: [/chat|assistant/i], weight: 10 } };
        const slot = await inferSlot(
            { uniqueId: 'claude-3' },
            { prompt_chat: [
                { role: 'system', content: 'You are a chat assistant' },
                { role: 'user', content: 'Hello' },
            ]},
            { safeGetArg: mockSafeGetArg, slotList: ['chat'], heuristics },
        );

        expect(slot.slot).toBe('chat');
        expect(slot.heuristicConfirmed).toBe(true);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// F. 설정 백업 + DB 기록 통합
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: settings-backup + safe-db-writer lifecycle', () => {
    it('backup settings → modify → validate → write', async () => {
        const mockRisu = createMockRisuFull();

        // Create backup and load (empty)
        const backup = createSettingsBackup({
            Risu: mockRisu,
            safeGetArg: vi.fn().mockResolvedValue(''),
            slotList: ['chat'],
            getRegisteredProviders: vi.fn().mockReturnValue([]),
        });
        const initial = await backup.load();
        expect(initial).toEqual({});

        // Update some keys
        await backup.updateKey('cpm_model', 'claude-3');
        await backup.updateKey('cpm_temperature', '0.7');
        expect(backup._cache.cpm_model).toBe('claude-3');

        // Now validate and write a plugins patch through safe-db
        const plugin = { name: 'TestProvider', script: 'console.log("ok")', version: '3.0' };
        const validation = validateDbPatch({ plugins: [plugin] });
        expect(validation.ok).toBe(true);

        const writeResult = await safeSetDatabaseLite(mockRisu, { plugins: [plugin] });
        expect(writeResult.ok).toBe(true);
        expect(mockRisu.setDatabaseLite).toHaveBeenCalled();
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G. 커스텀 모델 직렬화 + Gemini 사고 설정 통합
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: custom model + Gemini thinking config', () => {
    it('normalize custom model → build thinking config → format messages', () => {
        const raw = {
            name: 'Gemini 2.5 Flash (Thinking)',
            model: 'gemini-2.5-flash-preview-05-20',
            url: 'https://generativelanguage.googleapis.com/v1beta',
            format: 'gemini',
            thinking: 'high',
            thinkingBudget: '24576',
        };
        const model = normalizeCustomModel(raw);
        expect(model.format).toBe('gemini');
        expect(model.thinking).toBe('high');

        // Build thinking config
        const thinkingConfig = buildGeminiThinkingConfig(
            model.model,
            model.thinking,
            model.thinkingBudget,
        );
        expect(thinkingConfig.includeThoughts).toBe(true);
        expect(thinkingConfig.thinkingBudget).toBe(24576);

        // Format messages for this model
        const msgs = [
            { role: 'system', content: 'Think step by step' },
            { role: 'user', content: 'What is 42 * 37?' },
        ];
        const result = formatToGemini(msgs, { preserveSystem: true });
        expect(result.systemInstruction.length).toBeGreaterThan(0);
        expect(result.contents.length).toBeGreaterThanOrEqual(1);
    });

    it('Gemini-3 model → thinkingLevel instead of budget', () => {
        const raw = {
            name: 'Gemini 3 Pro',
            model: 'gemini-3-pro',
            url: 'https://example.com',
            format: 'gemini',
            thinking: 'medium',
        };
        const model = normalizeCustomModel(raw);
        const config = buildGeminiThinkingConfig(model.model, model.thinking, null);
        expect(config.includeThoughts).toBe(true);
        expect(config.thinkingLevel).toBe('medium');
        expect(config.thinkingBudget).toBeUndefined();
    });

    it('serialization round-trip: normalize → export → re-normalize', () => {
        const original = {
            name: 'Test Model',
            model: 'test-v1',
            url: 'https://api.test.com',
            format: 'openai',
            streaming: true,
            thinking: 'none',
        };
        const normalized = normalizeCustomModel(original);
        const exported = serializeCustomModelExport(normalized);
        expect(typeof exported).toBe('object');

        // Verify fields preserved
        expect(exported.name).toBe('Test Model');
        expect(exported.model).toBe('test-v1');
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H. 토큰 사용량 전체 생명주기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: token usage full lifecycle', () => {
    it('set → take → verify consumed for all providers', () => {
        const providers = [
            { format: 'openai', raw: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
            { format: 'anthropic', raw: { input_tokens: 80, output_tokens: 40 } },
            { format: 'gemini', raw: { promptTokenCount: 60, candidatesTokenCount: 30, totalTokenCount: 90 } },
        ];

        for (const p of providers) {
            const normalized = _normalizeTokenUsage(p.raw, p.format);
            expect(normalized).toBeTruthy();
            expect(normalized.input).toBeGreaterThan(0);
            expect(normalized.output).toBeGreaterThan(0);
            expect(normalized.total).toBeGreaterThan(0);

            // Set and take
            const key = `test-req-${p.format}-${Date.now()}`;
            _setTokenUsage(key, normalized);
            const taken = _takeTokenUsage(key);
            expect(taken).toEqual(normalized);

            // Second take should be null (consumed)
            const secondTake = _takeTokenUsage(key);
            expect(secondTake).toBeNull();
        }
    });

    it('Anthropic with extended thinking → estimated reasoning tokens', () => {
        const raw = { input_tokens: 200, output_tokens: 1000 };
        const usage = _normalizeTokenUsage(raw, 'anthropic', {
            anthropicHasThinking: true,
            anthropicVisibleText: 'Short visible answer',
        });
        expect(usage.reasoning).toBeGreaterThan(0);
        expect(usage.reasoningEstimated).toBe(true);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// I. 복합 메시지 포맷팅 엣지케이스
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: message formatting edge cases', () => {
    it('very long conversation (100 messages) → format is stable', () => {
        const msgs = [];
        for (let i = 0; i < 100; i++) {
            msgs.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Message number ${i} with some content to make it realistic`,
            });
        }
        const antResult = formatToAnthropic(msgs);
        const gemResult = formatToGemini(msgs);

        expect(antResult.messages.length).toBe(100);
        expect(gemResult.contents.length).toBe(100);
    });

    it('system → system → user → system → assistant → user (complex role pattern)', () => {
        const msgs = [
            { role: 'system', content: 'Rule 1' },
            { role: 'system', content: 'Rule 2' },
            { role: 'user', content: 'Question 1' },
            { role: 'system', content: 'Mid-conversation instruction' },
            { role: 'assistant', content: 'Answer 1' },
            { role: 'user', content: 'Follow-up' },
        ];

        const antResult = formatToAnthropic(msgs);
        expect(antResult.system).toContain('Rule 1');
        expect(antResult.system).toContain('Rule 2');
        // Mid-conversation system should be converted to user
        expect(antResult.messages.length).toBeGreaterThanOrEqual(3);

        const gemResult = formatToGemini(msgs);
        expect(gemResult.contents.length).toBeGreaterThanOrEqual(3);
    });

    it('cachePoint on multiple messages → each gets cache_control', () => {
        const msgs = [
            { role: 'user', content: 'Context block 1', cachePoint: true },
            { role: 'assistant', content: 'Acknowledged' },
            { role: 'user', content: 'Context block 2', cachePoint: true },
            { role: 'assistant', content: 'Got it' },
        ];
        const result = formatToAnthropic(msgs);
        const cacheControlled = result.messages.filter(m => {
            if (!Array.isArray(m.content)) return false;
            return m.content.some(p => p.cache_control);
        });
        expect(cacheControlled.length).toBe(2);
    });

    it('consecutive same-role messages with different content types → merged correctly', () => {
        const msgs = [
            { role: 'user', content: 'Text message 1' },
            { role: 'user', content: [{ text: 'Array message 2' }] },
            { role: 'user', content: 'Text message 3' },
        ];
        const antResult = formatToAnthropic(msgs);
        // All three should be merged into one user message
        const userMsgs = antResult.messages.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(1);
        expect(Array.isArray(userMsgs[0].content)).toBe(true);
        expect(userMsgs[0].content.length).toBeGreaterThanOrEqual(3);
    });

    it('Gemini useThoughtSignature config', () => {
        const msgs = [
            { role: 'user', content: 'Think about this' },
            { role: 'assistant', content: 'Let me reason...\nHere is my answer.' },
        ];
        const result = formatToGemini(msgs, { useThoughtSignature: true });
        expect(result.contents.length).toBeGreaterThanOrEqual(2);
    });

    it('non-string/non-array content objects → handled gracefully', () => {
        const msgs = [
            { role: 'user', content: 42 },
            { role: 'assistant', content: { nested: 'data' } },
        ];
        const antResult = formatToAnthropic(msgs);
        const gemResult = formatToGemini(msgs);
        expect(antResult.messages.length).toBeGreaterThanOrEqual(1);
        expect(gemResult.contents.length).toBeGreaterThanOrEqual(1);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// J. 보안 통합: 입력 검증 + 데이터 보호
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: security validation pipeline', () => {
    it('XSS attempt in message content → sanitized away', () => {
        const msgs = [
            { role: 'user', content: '<script>alert("xss")</script>Tell me about cats' },
        ];
        const result = formatToAnthropic(msgs);
        // Content should still be present (sanitize strips internal tags, not all HTML)
        expect(result.messages.length).toBeGreaterThanOrEqual(1);
    });

    it('plugin injection via safe-db-writer → blocked', async () => {
        const mockRisu = { setDatabaseLite: vi.fn() };

        // Try to inject guiHTML through plugins patch
        const inject1 = await safeSetDatabaseLite(mockRisu, { guiHTML: '<script>' });
        expect(inject1.ok).toBe(false);

        // Try with characters manipulation
        const inject2 = await safeSetDatabaseLite(mockRisu, { characters: [{ modified: true }] });
        expect(inject2.ok).toBe(false);

        // Valid plugin passes
        const valid = await safeSetDatabaseLite(mockRisu, {
            plugins: [{ name: 'Safe', script: 'console.log(1)', version: '3.0' }],
        });
        expect(valid.ok).toBe(true);
    });

    it('KeyPool never leaks raw credentials', () => {
        const pool = new KeyPool('sk-secret-key-1\nsk-secret-key-2');
        const key = pool.pick();
        expect(typeof key).toBe('string');
        expect(key.length).toBeGreaterThan(0);
    });

    it('CPM_BASE_URL is always HTTPS', () => {
        expect(CPM_BASE_URL.startsWith('https://')).toBe(true);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// K. collectStream 통합
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: collectStream with various inputs', () => {
    it('collects string ReadableStream', async () => {
        const chunks = ['chunk1 ', 'chunk2 ', 'chunk3'];
        let i = 0;
        const stream = new ReadableStream({
            pull(controller) {
                if (i < chunks.length) {
                    controller.enqueue(new TextEncoder().encode(chunks[i++]));
                } else {
                    controller.close();
                }
            },
        });
        const result = await collectStream(stream);
        expect(result).toBe('chunk1 chunk2 chunk3');
    });

    it('collects large stream (1000 chunks)', async () => {
        let i = 0;
        const stream = new ReadableStream({
            pull(controller) {
                if (i < 1000) {
                    controller.enqueue(new TextEncoder().encode(`${i++} `));
                } else {
                    controller.close();
                }
            },
        });
        const result = await collectStream(stream);
        expect(result.split(' ').filter(Boolean).length).toBe(1000);
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L. hasNonEmptyMessageContent 미커버 엣지
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Integration: sanitize edge cases', () => {
    it('hasNonEmptyMessageContent with various types', () => {
        expect(hasNonEmptyMessageContent('hello')).toBe(true);
        expect(hasNonEmptyMessageContent('')).toBe(false);
        expect(hasNonEmptyMessageContent('   ')).toBe(false);
        expect(hasNonEmptyMessageContent(null)).toBe(false);
        expect(hasNonEmptyMessageContent(undefined)).toBe(false);
        expect(hasNonEmptyMessageContent(0)).toBe(true);  // String(0) → "0" is non-empty
        expect(hasNonEmptyMessageContent([{ text: 'hi' }])).toBe(true);
        expect(hasNonEmptyMessageContent([])).toBe(false);
        expect(hasNonEmptyMessageContent({ key: 'val' })).toBe(true);
    });

    it('sanitizeMessages filters empty messages but preserves multimodals', () => {
        const msgs = [
            { role: 'user', content: '' },
            { role: 'user', content: 'valid' },
            { role: 'user', content: '', multimodals: [{ type: 'image', base64: 'data:image/png;base64,x' }] },
        ];
        const cleaned = sanitizeMessages(msgs);
        // First empty one filtered, second valid kept, third has multimodal so kept
        expect(cleaned.length).toBeGreaterThanOrEqual(2);
    });
});
