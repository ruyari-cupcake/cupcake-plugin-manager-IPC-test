# CPM v4 IPC — 버그 리포트
**생성일:** 2026-03-17  
**분석 범위:** `src/` 전체 (37파일, ~6500줄)  
**교차검증:** `Risuai-main/` 원본 오픈소스와 비교 완료

---

## 분석 결과 요약

| 파일 수 | 분석 줄 수 | 확인된 버그 | 심각도 |
|---------|-----------|------------|--------|
| 37 | ~6500 | 4건 | 🔴 Critical 1 / 🟡 Major 1 / 🔵 Minor 2 |

---

## 🔴 BUG-1: OpenRouter — reasoning.max_tokens 중복 설정 (Critical)

### 파일
`src/providers/openrouter.js` (L82-100)

### 문제
```javascript
// L82: 모델에 따라 max_completion_tokens 설정
const needsMaxCompletion = /(?:^|\/)(?:gpt-(?:4\.5|5)|o[1-9])/.test(actualModel);
if (needsMaxCompletion) {
    body.max_completion_tokens = maxTokens || 16384;
}

// L92: reasoning 활성화 시 같은 값으로 reasoning.max_tokens도 설정
if (reasoning && reasoning !== 'none' && reasoning !== 'off') {
    body.reasoning = { effort: reasoning };
    if (maxTokens) body.reasoning.max_tokens = maxTokens; // ← 🔴 BUG
}
```

### 원인
`body.max_completion_tokens`와 `body.reasoning.max_tokens`가 **동일한 `maxTokens` 값**으로 설정됨.

OpenRouter API에서 `reasoning.max_tokens`는 **추론(thinking) 토큰 예산**이고, `max_completion_tokens`는 **추론 + 실제 응답 토큰 합계 예산**임.

둘 다 16384로 설정하면 → 추론이 16384토큰 모두 사용 → 실제 응답용 토큰 0.

### 영향
- o3, o4-mini 등 추론 모델 사용 시 응답이 비정상적으로 짧거나 빈 응답 반환
- 사용자가 "OpenRouter 추론 모델이 응답을 안 해요" 증상 경험

### 수정 방안
`reasoning.max_tokens` 라인을 제거하여 모델이 추론 예산을 자율 결정하도록 함.

### RisuAI 원본 비교
RisuAI-main은 OpenRouter에 reasoning 매핑 자체가 없음 (파라미터 그대로 전달). CPM만의 기능이므로 원본 참조 불가.

---

## 🟡 BUG-2: Anthropic formatToAnthropic — _origSources 멀티모달 머지 시 누락 (Major)

### 파일
`src/shared/message-format.js` (formatToAnthropic 함수 내부)

### 문제
`formatToAnthropic`에서 연속 동일 role 메시지를 병합할 때, **텍스트 전용 경로**는 `_origSources` 추적이 정상 작동함:

```javascript
// 텍스트 경로 (정상):
formattedMsgs.push({ role, content: [...], _origSources: [m] });
// 머지 시: if (prev._origSources) prev._origSources.push(m); ← ✅
```

그러나 **멀티모달(이미지) 머지 경로 3곳**에서는 `_origSources`를 전혀 초기화/갱신하지 않음:

```javascript
// 멀티모달 머지 경로 (버그):
if (formattedMsgs.length > 0 && formattedMsgs[...].role === role) {
    prev.content.push(...contentParts);
    // ← ❌ _origSources 갱신 없음
}
formattedMsgs.push({ role, content: contentParts });
// ← ❌ _origSources 초기화 없음
```

### 영향
- `cachePoint`가 있는 멀티모달 메시지가 동일 role 메시지와 병합되면, `cache_control: { type: 'ephemeral' }` 적용 누락
- Anthropic 프롬프트 캐싱 미작동으로 **비용 증가** (매 요청마다 전체 프롬프트 재처리)
- 텍스트만 사용하는 경우에는 영향 없음 (이미지 첨부 시에만 발생)

### 수정 방안
멀티모달 머지 경로 3곳에 `_origSources` 초기화/갱신 로직 추가.

### RisuAI 원본 비교
RisuAI-main은 `_origSources` 메커니즘 자체를 사용하지 않음 (메시지별 직접 `cache_control` 적용). CPM 고유 설계 문제.

---

## 🔵 BUG-3: Gemini thought 스트리핑 후 빈 parts 잔류 (Minor/Defensive)

### 파일
`src/providers/gemini.js` (L118-130)

### 문제
```javascript
if (isThinkingModel && gc.contents) {
    gc.contents = gc.contents.map(content => ({
        ...content,
        parts: content.parts.map(part => {
            const { thought, ...rest } = part; // ← thought 제거
            return rest; // ← 만약 part = {thought: true}면 rest = {} (빈 객체)
        }),
    }));
}
```

### 영향
- 실제로 Gemini thought part는 거의 항상 `{text: "...", thought: true}` 형태라 `rest = {text: "..."}`이 됨
- 그러나 edge case로 `{thought: true}` only part가 존재하면 빈 `{}` 객체가 Gemini API에 전송
- Gemini API가 빈 part를 거부할 수 있음 (400 Bad Request)

### 수정 방안
`.filter(p => Object.keys(p).length > 0)` 추가.

### RisuAI 원본 비교
RisuAI-main은 요청 body에서 thought 속성을 스트리핑하지 않음 (포매터 레이어에서 처리). CPM의 방어적 스트리핑은 양호하나 빈 part 필터 누락.

---

## 🔵 BUG-4: parseCustomModelsValue — JSON 파싱 실패 시 무음 데이터 손실 (Minor/Defensive)

### 파일
`src/shared/custom-model-serialization.js` (L46-48)

### 문제
```javascript
export function parseCustomModelsValue(value) {
    // ...
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter(...) : [];
        } catch {
            return []; // ← 🔵 무음 실패: 사용자의 커스텀 모델 전부 사라짐
        }
    }
}
```

### 영향
- 커스텀 모델 설정이 예상치 못한 이유로 JSON 손상 시 (부트 중 pluginStorage 문제 등), 모든 커스텀 모델이 경고 없이 사라짐
- 사용자가 수 시간에 걸쳐 설정한 커스텀 모델 목록이 무음 제거되어 "모델이 갑자기 사라졌어요" 증상 경험

### 수정 방안
`catch` 블록에 `console.error` 추가하여 최소한 콘솔에 경고.

### RisuAI 원본 비교
RisuAI-main도 파라미터 파싱 실패 시 무음 처리 (line-by-line try-catch). 두 프로젝트 모두 동일한 패턴.

---

## ✅ 검증 완료 — 버그 아닌 항목

| 항목 | 결과 | 이유 |
|------|------|------|
| SSE parser `_inThinking` state 잔류 | ❌ 버그 아님 | config 객체가 호출마다 새로 생성됨 |
| Token estimation CJK 부정확 | ❌ 버그 아님 | 표시 전용 휴리스틱, 정확도 불필요 |
| API request log race condition | ❌ 버그 아님 | JS는 싱글스레드, 동시 접근 불가 |
| Navigation nth-child 경계 | ❌ 버그 아님 | null 체크 이미 존재 |
| Body truncation via IPC | ❌ 버그 아님 | 5MB 경고 이미 구현됨 |
| AbortSignal bridge | ❌ 버그 아님 | ABORT_SIGNAL_REF 메커니즘 정상 작동 |
| Copilot sessionId reuse | ❌ 버그 아님 | Copilot API가 세션 재사용 허용 |

---

## 수정 우선순위

1. **BUG-1** (🔴 Critical) — 즉시 수정 (추론 모델 응답 불가)
2. **BUG-2** (🟡 Major) — 수정 (Anthropic 프롬프트 캐싱 비용 절감)
3. **BUG-3** (🔵 Minor) — 수정 (방어적 코딩)
4. **BUG-4** (🔵 Minor) — 수정 (디버깅 편의)
