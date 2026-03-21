/**
 * @file message-format.test.js — 메시지 포맷 변환기 테스트
 *
 * BUG-Q1~Q5 회귀 테스트 포함: 네이티브 RisuAI 대비 포맷 정확성 검증
 */
import { describe, it, expect } from 'vitest';
import { formatToOpenAI, formatToAnthropic, formatToGemini, stripThoughtDisplayContent } from '../src/shared/message-format.js';

// ─── 기본 메시지 헬퍼 ───
const mkMsg = (role, content, extra = {}) => ({ role, content, ...extra });

const basicConversation = [
    mkMsg('system', 'You are a helpful assistant.'),
    mkMsg('user', 'Hello'),
    mkMsg('assistant', 'Hi there!'),
    mkMsg('user', 'How are you?'),
];

// ═══════════════════════════════════════
// formatToOpenAI
// ═══════════════════════════════════════
describe('formatToOpenAI', () => {
    it('기본 메시지 변환', () => {
        const result = formatToOpenAI(basicConversation);
        expect(result).toHaveLength(4);
        expect(result[0].role).toBe('system');
        expect(result[1].role).toBe('user');
        expect(result[2].role).toBe('assistant');
    });

    it('model/char role → assistant로 정규화', () => {
        const msgs = [mkMsg('user', 'Hi'), mkMsg('model', 'Hello'), mkMsg('char', 'Bye')];
        const result = formatToOpenAI(msgs);
        expect(result[1].role).toBe('assistant');
        expect(result[2].role).toBe('assistant');
    });

    it('빈 content 메시지 필터링', () => {
        const msgs = [mkMsg('user', ''), mkMsg('user', 'valid'), mkMsg('user', '   ')];
        const result = formatToOpenAI(msgs);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('valid');
    });

    // BUG-Q4 회귀 테스트: GPT-5 developer role
    describe('developerRole config', () => {
        it('developerRole: true → system → developer', () => {
            const msgs = [mkMsg('system', 'You are helpful'), mkMsg('user', 'Hi')];
            const result = formatToOpenAI(msgs, { developerRole: true });
            expect(result[0].role).toBe('developer');
            expect(result[1].role).toBe('user');
        });

        it('developerRole: false → system 유지', () => {
            const msgs = [mkMsg('system', 'You are helpful'), mkMsg('user', 'Hi')];
            const result = formatToOpenAI(msgs, { developerRole: false });
            expect(result[0].role).toBe('system');
        });
    });

    describe('mergesys config', () => {
        it('system 메시지를 첫 비시스템 메시지에 병합', () => {
            const msgs = [mkMsg('system', 'SysPrompt'), mkMsg('user', 'Hello')];
            const result = formatToOpenAI(msgs, { mergesys: true });
            expect(result).toHaveLength(1);
            expect(result[0].role).toBe('user');
            expect(result[0].content).toContain('SysPrompt');
            expect(result[0].content).toContain('Hello');
        });
    });

    describe('mustuser config', () => {
        it('첫 메시지가 user/system 아니면 user 메시지 삽입', () => {
            const msgs = [mkMsg('assistant', 'Hi')];
            const result = formatToOpenAI(msgs, { mustuser: true });
            expect(result[0].role).toBe('user');
            expect(result[0].content).toBe(' ');
        });
    });

    describe('sysfirst config', () => {
        it('system 메시지를 맨 앞으로 이동', () => {
            const msgs = [mkMsg('user', 'Hi'), mkMsg('system', 'I am system')];
            const result = formatToOpenAI(msgs, { sysfirst: true });
            expect(result[0].role).toBe('system');
        });
    });

    describe('altrole config', () => {
        it('assistant → model 역할 변환', () => {
            const msgs = [mkMsg('user', 'Hi'), mkMsg('assistant', 'Reply')];
            const result = formatToOpenAI(msgs, { altrole: true });
            expect(result[1].role).toBe('model');
        });
    });

    describe('멀티모달', () => {
        it('이미지 멀티모달 변환', () => {
            const msgs = [mkMsg('user', 'Look', { multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }] })];
            const result = formatToOpenAI(msgs);
            expect(Array.isArray(result[0].content)).toBe(true);
            const imageParts = result[0].content.filter(p => p.type === 'image_url');
            expect(imageParts).toHaveLength(1);
        });
    });
});

// ═══════════════════════════════════════
// formatToAnthropic
// ═══════════════════════════════════════
describe('formatToAnthropic', () => {
    it('기본 변환 — system 분리 + messages 배열', () => {
        const result = formatToAnthropic(basicConversation);
        expect(result.system).toBe('You are a helpful assistant.');
        expect(result.messages.length).toBeGreaterThanOrEqual(3);
    });

    // BUG-Q1 회귀 테스트: Structured content blocks
    it('BUG-Q1: content가 항상 structured blocks [{type:"text", text}] 형식', () => {
        const result = formatToAnthropic(basicConversation);
        for (const msg of result.messages) {
            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    expect(block).toHaveProperty('type');
                    expect(block).toHaveProperty('text');
                }
            }
        }
    });

    // BUG-Q2 회귀 테스트: 비선두 시스템 위치 유지
    it('BUG-Q2: 비선두 system 메시지가 위치를 유지하고 user role로 변환', () => {
        const msgs = [
            mkMsg('system', 'System prompt'),
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Depth prompt — 중간 삽입'),
            mkMsg('assistant', 'Reply'),
        ];
        const result = formatToAnthropic(msgs);
        // 선두 system만 분리
        expect(result.system).toBe('System prompt');
        // 비선두 system → user 변환 후 앞의 user와 병합됨
        // messages[0] = user (Hello + "system: Depth prompt")
        // messages[1] = assistant (Reply)
        const firstMsg = result.messages[0];
        expect(firstMsg.role).toBe('user');
        const textContent = Array.isArray(firstMsg.content)
            ? firstMsg.content.map(b => b.text).join(' ')
            : firstMsg.content;
        expect(textContent).toContain('Hello');
        expect(textContent).toContain('system:');
        expect(textContent).toContain('Depth prompt');
        // assistant가 그 뒤에 위치
        expect(result.messages[1].role).toBe('assistant');
    });

    // BUG-Q3 회귀 테스트: 첫 메시지가 user가 아니면 "Start" 삽입
    it('BUG-Q3: 첫 메시지 플레이스홀더가 "Start"', () => {
        const msgs = [mkMsg('assistant', 'I start')];
        const result = formatToAnthropic(msgs);
        expect(result.messages[0].role).toBe('user');
        const firstContent = Array.isArray(result.messages[0].content)
            ? result.messages[0].content[0].text
            : result.messages[0].content;
        expect(firstContent).toBe('Start');
    });

    it('연속 동일 역할 메시지 병합', () => {
        const msgs = [
            mkMsg('user', 'Part 1'),
            mkMsg('user', 'Part 2'),
            mkMsg('assistant', 'Reply'),
        ];
        const result = formatToAnthropic(msgs);
        // 두 user 메시지가 하나로 병합
        expect(result.messages[0].role).toBe('user');
        if (Array.isArray(result.messages[0].content)) {
            expect(result.messages[0].content.length).toBeGreaterThanOrEqual(2);
        }
    });

    it('cachePoint → cache_control 추가', () => {
        const msgs = [
            mkMsg('user', 'Hello', { cachePoint: true }),
            mkMsg('assistant', 'Reply'),
        ];
        const result = formatToAnthropic(msgs);
        const firstMsg = result.messages[0];
        const lastBlock = Array.isArray(firstMsg.content)
            ? firstMsg.content[firstMsg.content.length - 1]
            : null;
        if (lastBlock) {
            expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
        }
    });

    it('빈 메시지 → 최소 user "Start" 메시지', () => {
        const result = formatToAnthropic([]);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
    });

    it('여러 선두 system → 합침', () => {
        const msgs = [
            mkMsg('system', 'Part A'),
            mkMsg('system', 'Part B'),
            mkMsg('user', 'Hello'),
        ];
        const result = formatToAnthropic(msgs);
        expect(result.system).toContain('Part A');
        expect(result.system).toContain('Part B');
    });

    it('멀티모달 이미지 → Anthropic source 형식', () => {
        const msgs = [mkMsg('user', 'Look', { multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc123' }] })];
        const result = formatToAnthropic(msgs);
        const content = result.messages[0].content;
        expect(Array.isArray(content)).toBe(true);
        const imagePart = content.find(p => p.type === 'image');
        if (imagePart) {
            expect(imagePart.source).toBeDefined();
            expect(imagePart.source.type).toBe('base64');
        }
    });

    it('_origSources 내부 프로퍼티가 최종 결과에서 제거됨', () => {
        const result = formatToAnthropic(basicConversation);
        for (const msg of result.messages) {
            expect(msg).not.toHaveProperty('_origSources');
        }
    });
});

// ═══════════════════════════════════════
// formatToGemini
// ═══════════════════════════════════════
describe('formatToGemini', () => {
    it('기본 변환 — contents 배열 + systemInstruction', () => {
        const result = formatToGemini(basicConversation, { preserveSystem: true });
        expect(result.systemInstruction).toHaveLength(1);
        expect(result.systemInstruction[0]).toContain('helpful assistant');
        expect(result.contents.length).toBeGreaterThanOrEqual(2);
    });

    it('role 정규화: assistant/model → model, 나머지 → user', () => {
        const msgs = [mkMsg('user', 'A'), mkMsg('assistant', 'B')];
        const result = formatToGemini(msgs);
        expect(result.contents[0].role).toBe('user');
        expect(result.contents[1].role).toBe('model');
    });

    // BUG-Q5 회귀 테스트: 비선두 system 포맷
    it('BUG-Q5: 비선두 system → "system: content" 접두사 (태그 아님)', () => {
        const msgs = [
            mkMsg('system', 'Leading system'),
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Depth prompt'),
            mkMsg('assistant', 'Reply'),
        ];
        const result = formatToGemini(msgs, { preserveSystem: true });
        // 비선두 system은 user role로 변환되고 "system: " 접두사
        const allTexts = result.contents
            .flatMap(c => c.parts.map(p => p.text || ''))
            .join(' ');
        expect(allTexts).toContain('system: Depth prompt');
        // XML 태그 사용 안 함 확인
        expect(allTexts).not.toContain('[System]');
        expect(allTexts).not.toContain('[/System]');
    });

    it('preserveSystem: true → systemInstruction에 보존', () => {
        const msgs = [mkMsg('system', 'Keep me'), mkMsg('user', 'Hi')];
        const result = formatToGemini(msgs, { preserveSystem: true });
        expect(result.systemInstruction).toContain('Keep me');
    });

    it('preserveSystem: false → system을 첫 user에 인라인', () => {
        const msgs = [mkMsg('system', 'Inline me'), mkMsg('user', 'Hi')];
        const result = formatToGemini(msgs, { preserveSystem: false });
        expect(result.systemInstruction).toHaveLength(0);
        const firstParts = result.contents[0].parts.map(p => p.text || '').join(' ');
        expect(firstParts).toContain('system: Inline me');
    });

    it('첫 메시지가 model이면 user "Start" 삽입', () => {
        const msgs = [mkMsg('assistant', 'I go first')];
        const result = formatToGemini(msgs);
        expect(result.contents[0].role).toBe('user');
        expect(result.contents[0].parts[0].text).toContain('Start');
    });

    it('연속 동일 역할 → 같은 entry의 parts에 추가', () => {
        const msgs = [mkMsg('user', 'A'), mkMsg('user', 'B'), mkMsg('assistant', 'C')];
        const result = formatToGemini(msgs);
        const userEntries = result.contents.filter(c => c.role === 'user');
        // A와 B가 하나의 entry에 속해야 함
        expect(userEntries.length).toBe(1);
        expect(userEntries[0].parts.length).toBeGreaterThanOrEqual(2);
    });

    it('멀티모달 → inlineData 변환', () => {
        const msgs = [mkMsg('user', 'Image', { multimodals: [{ type: 'image', base64: 'data:image/png;base64,abc' }] })];
        const result = formatToGemini(msgs);
        const parts = result.contents[0].parts;
        const datapart = parts.find(p => p.inlineData);
        expect(datapart).toBeDefined();
        expect(datapart.inlineData.mimeType).toContain('image');
    });

    it('빈 메시지 배열 → 빈 contents', () => {
        const result = formatToGemini([]);
        expect(result.contents).toHaveLength(0);
    });
});

// ═══════════════════════════════════════
// stripThoughtDisplayContent
// ═══════════════════════════════════════
describe('stripThoughtDisplayContent', () => {
    it('<Thoughts> 블록 제거', () => {
        const input = '<Thoughts>\nSome thinking\n</Thoughts>\nActual response';
        const result = stripThoughtDisplayContent(input);
        expect(result).not.toContain('Thoughts');
        expect(result).toContain('Actual response');
    });

    it('빈값/null → 그대로 반환', () => {
        expect(stripThoughtDisplayContent('')).toBe('');
        expect(stripThoughtDisplayContent(null)).toBeNull();
    });

    it('사고 블록 없는 텍스트 → 그대로', () => {
        expect(stripThoughtDisplayContent('Normal text')).toBe('Normal text');
    });

    it('여러 줄바꿈 축소', () => {
        const input = 'line1\n\n\n\n\nline2';
        const result = stripThoughtDisplayContent(input);
        expect(result).not.toMatch(/\n{3,}/);
    });
});

// ═══════════════════════════════════════
// C-2: altrole 연속 동일 역할 병합
// ═══════════════════════════════════════
describe('formatToOpenAI — altrole merge (C-2)', () => {
    it('altrole: 연속 model 역할 메시지 병합', () => {
        const msgs = [
            mkMsg('user', 'Q1'),
            mkMsg('assistant', 'A1'),
            mkMsg('assistant', 'A2'),
            mkMsg('user', 'Q2'),
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        // assistant→model로 변환 후 연속 model 병합
        const modelMsgs = result.filter(m => m.role === 'model');
        expect(modelMsgs.length).toBe(1);
        expect(modelMsgs[0].content).toContain('A1');
        expect(modelMsgs[0].content).toContain('A2');
    });

    it('altrole 없으면 병합 안 됨', () => {
        const msgs = [mkMsg('assistant', 'A1'), mkMsg('assistant', 'A2')];
        const result = formatToOpenAI(msgs, {});
        const assistantMsgs = result.filter(m => m.role === 'assistant');
        expect(assistantMsgs.length).toBe(2);
    });
});

// ═══════════════════════════════════════
// M-5: 오디오 MIME 파싱 개선
// ═══════════════════════════════════════
describe('formatToOpenAI — audio MIME parsing (M-5)', () => {
    it('wav MIME 타입 감지', () => {
        const msgs = [mkMsg('user', 'Audio', {
            multimodals: [{ type: 'audio', base64: 'data:audio/wav;base64,UklGR' }],
        })];
        const result = formatToOpenAI(msgs);
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('wav');
    });

    it('ogg MIME 타입 감지', () => {
        const msgs = [mkMsg('user', 'Audio', {
            multimodals: [{ type: 'audio', base64: 'data:audio/ogg;base64,T2dn' }],
        })];
        const result = formatToOpenAI(msgs);
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('ogg');
    });

    it('MIME 없으면 mp3 기본값', () => {
        const msgs = [mkMsg('user', 'Audio', {
            multimodals: [{ type: 'audio', base64: 'rawbase64data' }],
        })];
        const result = formatToOpenAI(msgs);
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart.input_audio.format).toBe('mp3');
    });
});

// ═══════════════════════════════════════
// C-3: Anthropic Array content else 분기
// ═══════════════════════════════════════
describe('formatToAnthropic — array content else branch (C-3)', () => {
    it('배열 content가 새 메시지로 push (이전 같은 role 없을 때)', () => {
        const msgs = [
            mkMsg('user', [
                { type: 'text', text: 'Hello' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
            ]),
        ];
        const result = formatToAnthropic(msgs);
        // 배열 content가 정상적으로 파싱됨
        expect(result.messages.length).toBeGreaterThan(0);
        const firstMsg = result.messages.find(m => m.role === 'user');
        expect(firstMsg).toBeDefined();
    });
});

// ═══════════════════════════════════════
// M-6: mustuser placeholder 변경
// ═══════════════════════════════════════
describe('formatToOpenAI — mustuser placeholder (M-6)', () => {
    it('첫 메시지가 assistant일 때 공백 user 메시지 삽입', () => {
        const msgs = [mkMsg('assistant', 'Response')];
        const result = formatToOpenAI(msgs, { mustuser: true });
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe(' ');
    });
});

// ═══════════════════════════════════════
// temp_repo 이식: 추가 엣지 케이스
// ═══════════════════════════════════════
describe('formatToOpenAI — additional edge cases (ported from temp_repo)', () => {
    it('비배열 입력 → 빈 배열 반환', () => {
        expect(formatToOpenAI(null)).toEqual([]);
        expect(formatToOpenAI('string')).toEqual([]);
        expect(formatToOpenAI(undefined)).toEqual([]);
    });

    it('mustuser: 첫 메시지가 user/system이면 삽입 안 함', () => {
        const msgs = [mkMsg('user', 'Hello')];
        const result = formatToOpenAI(msgs, { mustuser: true });
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    it('name 속성 보존', () => {
        const msgs = [mkMsg('user', 'Hello', { name: 'Alice' })];
        const result = formatToOpenAI(msgs);
        expect(result[0].name).toBe('Alice');
    });

    it('null 메시지 필터링', () => {
        const msgs = [mkMsg('user', 'Hello'), null, mkMsg('user', 'World')];
        const result = formatToOpenAI(msgs);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('Hello');
        expect(result[1].content).toBe('World');
    });

    it('mergesys: 여러 system → 하나의 user 메시지에 병합', () => {
        const msgs = [
            mkMsg('system', 'System A'),
            mkMsg('system', 'System B'),
            mkMsg('user', 'Hello'),
        ];
        const result = formatToOpenAI(msgs, { mergesys: true });
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toContain('System A');
        expect(result[0].content).toContain('System B');
        expect(result[0].content).toContain('Hello');
    });

    it('altrole: 연속 같은 역할 user도 병합', () => {
        const msgs = [
            mkMsg('user', 'User turn 1'),
            mkMsg('user', 'User turn 2'),
        ];
        const result = formatToOpenAI(msgs, { altrole: true });
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe('User turn 1\nUser turn 2');
    });
});

describe('formatToAnthropic — additional edge cases (ported from temp_repo)', () => {
    it('빈 content 메시지 필터링', () => {
        const msgs = [
            mkMsg('user', 'Valid'),
            mkMsg('assistant', ''),
            mkMsg('user', 'Also valid'),
        ];
        const result = formatToAnthropic(msgs);
        const validAssistant = result.messages.filter(m => m.role === 'assistant');
        for (const msg of validAssistant) {
            if (Array.isArray(msg.content)) {
                expect(msg.content.length).toBeGreaterThan(0);
            }
        }
    });

    it('content는 항상 [{type: "text", text}] 배열 형식', () => {
        const msgs = [mkMsg('user', 'Hello world')];
        const result = formatToAnthropic(msgs);
        expect(Array.isArray(result.messages[0].content)).toBe(true);
        expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('비선두 system → user 변환 후 같은 역할과 병합', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Context update'),
            mkMsg('assistant', 'Response'),
        ];
        const result = formatToAnthropic(msgs);
        expect(result.system).toBe('');
        const firstMsg = result.messages[0];
        expect(firstMsg.role).toBe('user');
        const textContent = Array.isArray(firstMsg.content)
            ? firstMsg.content.map(b => b.text).join(' ')
            : firstMsg.content;
        expect(textContent).toContain('Hello');
        expect(textContent).toContain('system:');
        expect(textContent).toContain('Context update');
    });
});

describe('formatToGemini — additional edge cases (ported from temp_repo)', () => {
    it('model-first → user Start placeholder 삽입', () => {
        const msgs = [mkMsg('assistant', 'Model first')];
        const result = formatToGemini(msgs);
        // v4: model-first 시 Start user를 앞에 삽입
        expect(result.contents[0].role).toBe('user');
        expect(result.contents[0].parts[0].text).toBe('Start');
        expect(result.contents[1].role).toBe('model');
        expect(result.contents[1].parts[0].text).toBe('Model first');
    });

    it('Thoughts 블록을 model 메시지에서 제거', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('assistant', '<Thoughts>thinking...</Thoughts>\nActual response'),
        ];
        const result = formatToGemini(msgs);
        const modelText = result.contents.find(c => c.role === 'model')?.parts[0].text || '';
        expect(modelText).not.toContain('<Thoughts>');
        expect(modelText).toContain('Actual response');
    });

    it('비선두 system → user parts에 "system:" 접두사', () => {
        const msgs = [
            mkMsg('user', 'Hello'),
            mkMsg('system', 'Context update'),
            mkMsg('assistant', 'Response'),
        ];
        const result = formatToGemini(msgs);
        const allTexts = result.contents
            .flatMap(c => c.parts.map(p => p.text || ''))
            .join(' ');
        expect(allTexts).toContain('system: Context update');
    });

    it('preserveSystem + system-only → contents는 비어있고 systemInstruction에 보존', () => {
        const msgs = [mkMsg('system', 'Only system content')];
        const result = formatToGemini(msgs, { preserveSystem: true });
        // v4: system-only 시 systemInstruction에 내용 보존, contents는 비어있음
        expect(result.systemInstruction).toContain('Only system content');
        expect(result.contents).toHaveLength(0);
    });

    it('빈 메시지 → 빈 contents + 빈 systemInstruction', () => {
        const result = formatToGemini([]);
        expect(result.contents).toHaveLength(0);
        expect(result.systemInstruction).toHaveLength(0);
    });
});

// ═══════════════ Coverage boost: uncovered branches ═══════════════

describe('formatToOpenAI — audio MIME: flac and webm', () => {
    it('flac MIME 타입 감지', () => {
        const msgs = [mkMsg('user', 'test', {
            multimodals: [{ type: 'audio', base64: 'data:audio/flac;base64,AAAA' }],
        })];
        const result = formatToOpenAI(msgs);
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('flac');
    });

    it('webm MIME 타입 감지', () => {
        const msgs = [mkMsg('user', 'test', {
            multimodals: [{ type: 'audio', base64: 'data:audio/webm;base64,AAAA' }],
        })];
        const result = formatToOpenAI(msgs);
        const audioPart = result[0].content.find(p => p.type === 'input_audio');
        expect(audioPart).toBeDefined();
        expect(audioPart.input_audio.format).toBe('webm');
    });
});

describe('formatToAnthropic — prev.content non-array merge', () => {
    it('병합 시 prev.content가 배열이 아니면 배열로 변환', () => {
        // 이것은 연속된 같은 역할 메시지에서 prev.content이 string인 경우를 테스트
        // 실제로 formatToAnthropic은 항상 배열을 만들지만, 이 브랜치를 확인
        const msgs = [
            mkMsg('user', 'First'),
            mkMsg('user', 'Second'),
        ];
        const result = formatToAnthropic(msgs);
        // 연속 user → 병합
        expect(result.messages[0].role).toBe('user');
        expect(Array.isArray(result.messages[0].content)).toBe(true);
        const texts = result.messages[0].content.map(b => b.text);
        expect(texts).toContain('First');
        expect(texts).toContain('Second');
    });
});

describe('formatToAnthropic — string content cachePoint', () => {
    it('cachePoint가 있는 단독 메시지에 cache_control 추가', () => {
        const msgs = [
            { role: 'user', content: 'Cached content', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs);
        const firstMsg = result.messages[0];
        expect(Array.isArray(firstMsg.content)).toBe(true);
        const lastBlock = firstMsg.content[firstMsg.content.length - 1];
        expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('cachePoint가 병합된 메시지에서도 동작', () => {
        const msgs = [
            mkMsg('user', 'Normal'),
            { role: 'user', content: 'Cached', cachePoint: true },
        ];
        const result = formatToAnthropic(msgs);
        const firstMsg = result.messages[0];
        const lastBlock = firstMsg.content[firstMsg.content.length - 1];
        expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });
});

describe('formatToGemini — object content fallback', () => {
    it('content가 object(non-string, non-array)이면 JSON.stringify로 변환', () => {
        const msgs = [
            { role: 'user', content: { custom: 'data', nested: { x: 1 } } },
        ];
        const result = formatToGemini(msgs);
        expect(result.contents.length).toBeGreaterThan(0);
        const text = result.contents[0].parts[0].text;
        expect(text).toContain('custom');
        expect(text).toContain('data');
    });

    it('systemInstruction에서 object content도 JSON.stringify', () => {
        const msgs = [
            { role: 'system', content: { instruction: 'be helpful' } },
            mkMsg('user', 'Hello'),
        ];
        const result = formatToGemini(msgs, { preserveSystem: true });
        expect(result.systemInstruction[0]).toContain('instruction');
    });

    it('비선두 system이 이전 user parts에 병합', () => {
        const msgs = [
            mkMsg('system', 'initial system'),
            mkMsg('user', 'Question'),
            mkMsg('system', 'mid system note'),
            mkMsg('assistant', 'Answer'),
        ];
        const result = formatToGemini(msgs, { preserveSystem: true });
        // mid system note should be merged into user parts
        const userEntry = result.contents.find(c => c.role === 'user');
        const allParts = userEntry?.parts.map(p => p.text) || [];
        const hasSystemNote = allParts.some(t => t.includes('system:') && t.includes('mid system note'));
        expect(hasSystemNote).toBe(true);
    });
});
