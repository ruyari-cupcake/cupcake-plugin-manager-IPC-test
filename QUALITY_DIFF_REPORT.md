# CPM v4 응답 품질 차이 분석 리포트
**Date:** 2026-03-05  
**증상:** 동일 설정 (temp 1.7, top_p 0.65) 사용 시 — 네이티브 RisuAI > LBI ≈ CPM v4 순으로 응답 품질 차이 발생  
**범위:** RisuAI-main 네이티브 ↔ CPM v4 ↔ LBI 3자 비교

---

## 1. 파라미터 전달 경로 (temperature, top_p 등)

### RisuAI → 플러그인 전달 과정
```
db.temperature = 170 (정수 저장)
    ↓ applyParameters()
args.temperature = 170 / 100 = 1.7 (float 변환)
    ↓ V3 addProvider callback  
Plugin receives 1.7
```
✅ temperature, top_p, frequency_penalty, presence_penalty 모두 **이미 변환된 float** 상태로 전달됨.  
CPM은 이 값을 그대로 API body에 넣으므로 **파라미터 자체는 정상 전달됨.**

### LBI의 파라미터 처리
- `top_p`를 2자리 반올림 (`Math.round(top_p * 100) / 100`) — 사용자 오버라이드 전이라 실효성 낮음
- Claude: `temperature > 1` 시 `1`로 클램핑 (!) 
- Gemini: `temperature > 2` 시 `1`로 클램핑
- OpenAI GPT-5: `forceDisableSamplingParams` — temperature/top_p 완전 삭제

---

## 2. 품질 차이의 진짜 원인 — 메시지 포맷의 차이

### 2.1 Claude (Anthropic) — 3가지 핵심 차이

#### BUG-Q1 [CRITICAL]: Content Structure — Plain String vs Structured Blocks

| | 네이티브 RisuAI | LBI | CPM v4 (수정 전) |
|---|---|---|---|
| 메시지 content 형식 | `[{type:'text', text:'...'}]` | `[{type:'text', text:'...'}]` | `"plain string"` ❌ |

**영향:** Anthropic API는 두 형식 모두 수용하지만, 내부 처리가 다를 수 있음.  
특히 cache_control 적용 시 structured block 단위로 작동하므로, plain string에서는 캐싱이 비효율적.

#### BUG-Q2 [CRITICAL]: 시스템 메시지 위치 손실

| | 네이티브 RisuAI | LBI | CPM v4 (수정 전) |
|---|---|---|---|
| 선두 system | top-level `system` 필드 | top-level `system` 필드 | top-level `system` 필드 |
| **비선두 system** (depth prompt 등) | **위치 유지** — `"system: content"` user msg | **위치 유지** ✅ | **전부 추출하여 top-level system에 합침** ❌ |

**영향:** 대화 중간에 삽입된 depth prompt, 상황 설명, 감정 지시 등이 원래 위치에서 빠져나와 system 필드에 합쳐짐.  
→ Claude가 대화 컨텍스트 내에서 해당 지시를 인식하지 못함  
→ 특히 temperature 1.7 같은 고온에서는 시스템 프롬프트의 **위치 기반 영향력**이 약해져 무시될 가능성 높음

#### BUG-Q3 [LOW]: 첫 메시지 플레이스홀더

| 네이티브 | LBI | CPM v4 (수정 전) |
|---|---|---|
| `"Start"` | `"Start"` | `"(Continue)"` |

### 2.2 OpenAI (GPT-5.x) — Developer Role 누락

#### BUG-Q4 [HIGH]: system → developer 역할 변환 미적용

| | 네이티브 RisuAI | LBI | CPM v4 (수정 전) |
|---|---|---|---|
| GPT-5 system 역할 | `developer` ✅ | `system` ❌ | `system` ❌ |

**영향:** OpenAI GPT-5 계열은 `developer` 역할을 system 대신 사용하도록 설계됨.  
`system` 역할 사용 시 모델이 시스템 프롬프트를 다르게 가중치 부여할 수 있음.

### 2.3 Gemini (Google) — 시스템 프롬프트 포맷 차이

#### BUG-Q5 [HIGH]: 시스템 메시지 래핑 형식 차이

| | 네이티브 RisuAI | LBI | CPM v4 (수정 전) |
|---|---|---|---|
| 선두 system | user msg + `"system: content"` 접두사 | `systemInstruction` API 필드 | `[System Content]\ncontent\n[/System Content]` ❌ |
| 비선두 system | user msg + `"system: content"` 접두사 | user msg 인라인 삽입 | `[System]\ncontent\n[/System]` ❌ |

**영향:**  
- XML-like 태그(`[System Content]`, `[/System Content]`)는 모델에게 익숙하지 않은 형식  
- 네이티브는 단순 `"system: content"` 접두사 사용 — 모델이 더 자연스럽게 인식  
- 특히 고온(1.7)에서 모델이 `[System Content]...[/System Content]` 태그를 콘텐츠의 일부로 해석하거나, 시스템 지시의 가중치를 잘못 부여할 가능성

### 2.4 모든 프로바이더 — RisuAI `reformater()` 플래그 차이

| | 네이티브 Claude | CPM 플러그인 |
|---|---|---|
| 모델 등록 플래그 | `hasFirstSystemPrompt` (7) | `hasFullSystemPrompt` (6) |
| reformater 동작 | 선두 system 추출 → 나머지 system→user 변환 | 모든 system 유지 (변환 없음) |

| | 네이티브 Gemini | CPM 플러그인 |
|---|---|---|
| reformater `requiresAlternateRole` | ✅ 있음 → 연속 동일역할 `\n` 병합 | ❌ 없음 → 병합 안됨 |

**영향:** 플러그인이 받는 메시지 구조가 네이티브 핸들러가 받는 것과 근본적으로 다름.  
플러그인은 raw 메시지를 받아 자체 포맷팅을 해야 하는데, 이 과정에서 네이티브와 다르게 처리됨.

---

## 3. 수정 내용

### FIX-Q1/Q2: Claude formatToAnthropic 전면 재작성
**파일:** `src/shared/message-format.js`

변경사항:
1. **Structured content blocks 사용**: 모든 Claude 메시지를 `[{type:'text', text:'...'}]` 형식으로 전송 (네이티브/LBI와 동일)
2. **선두-only 시스템 추출**: 선두(leading) 시스템 메시지만 top-level `system` 필드로 추출. 비선두 시스템 메시지는 위치 유지하여 `"system: content"` user 메시지로 변환 (네이티브 reformater와 동일)
3. **플레이스홀더 변경**: `"(Continue)"` → `"Start"` (네이티브/LBI와 동일)

### FIX-Q4: OpenAI developer 역할 변환
**파일:** `src/shared/message-format.js`, `src/providers/openai.js`

변경사항:
- `formatToOpenAI`에 `config.developerRole` 옵션 추가
- GPT-5.x 모델 감지 시 `system` → `developer` 자동 변환
- OpenAI 프로바이더에서 `/^gpt-5/` 패턴으로 자동 적용

### FIX-Q5: Gemini 시스템 메시지 포맷 수정
**파일:** `src/shared/message-format.js`

변경사항:
- 비선두 시스템 래핑: `[System]\n...\n[/System]` → `"system: content"` (네이티브와 동일)
- 선두 시스템 인젝션: `[System Content]\n...\n[/System Content]` → `"system: content"` (네이티브와 동일)
- 플레이스홀더: `"(Continue)"` → `"Start"`

### FIX-Q6: provider별 model flags 네이티브 정렬
**파일:** `src/manager/index.js`

변경사항:
- 기존 고정값 `[0,6,8]` 제거
- Claude 계열: `[0,7,8]` (`hasFirstSystemPrompt`)
- Gemini 계열: `[0,7,8,9]` (`hasFirstSystemPrompt`, `requiresAlternateRole`)
- OpenAI/OpenRouter/DeepSeek: `[0,6,8]` (`hasFullSystemPrompt`)
- GPT-5 계열: `DeveloperRole(14)` 추가

### FIX-Q7: Google/Vertex tokenizer 오등록 수정
**파일:** `src/manager/index.js`

변경사항:
- `GoogleAI`, `VertexAI` tokenizer: `Gemma(9)` → `GoogleCloud(10)` 수정

### FIX-Q8: Claude thinking 파라미터 네이티브 정렬
**파일:** `src/providers/anthropic.js`, `src/providers/aws.js`, `src/providers/vertex.js`

변경사항:
- Anthropic direct/Vertex Claude: thinking 사용 시 `temperature` 삭제 로직 제거 (네이티브와 동일)
- AWS Bedrock Claude: thinking 사용 시 `temperature=1.0`, `top_p/top_k` 제거 (네이티브 Bedrock 경로와 동일)

### FIX-Q9: Gemini preserveSystem 기본값 네이티브 정렬
**파일:** `src/providers/gemini.js`, `src/providers/vertex.js`

변경사항:
- `chat_gemini_preserveSystem`, `chat_vertex_preserveSystem` 기본값을 `true`로 변경
- 설정 미지정 시도 `preserveSystem=true`로 처리

---

## 4. LBI에도 해당되는 이슈 (참고)

| 이슈 | LBI 해당 여부 |
|------|-------------|
| OpenAI developer role 누락 | ✅ LBI도 미지원 |
| Claude temperature > 1 클램핑 | ✅ LBI가 `1`로 클램핑 — 네이티브는 클램핑 안함 |
| GPT-5 sampling params 강제 삭제 | ✅ LBI의 `forceDisableSamplingParams` — 네이티브는 각각 조건부 처리 |

**참고:** LBI의 Claude temperature 클램핑은 별도 이슈. 네이티브 RisuAI는 `temperature: 1.7`을 그대로 Claude에 전송하지만, LBI는 `1.0`으로 클램핑합니다. Claude API의 공식 범위는 0~1이므로 LBI의 클램핑이 맞지만, 네이티브 사용 시 1.7이 그대로 전달되어 다른 결과가 나옵니다.

---

## 5. temp_repo 비교 결과 (추가 검증)

`_temp_repo/provider-manager.js` 기준 확인:

1. **LLMFlags enum 오프셋 불일치 흔적**
    - 주석/실사용 값이 `hasFullSystemPrompt=9`, `hasStreaming=10` 전제로 작성됨
    - 최신 RisuAI enum에서는 `hasFullSystemPrompt=6`, `hasStreaming=8`
    - 결과적으로 reformater가 의도와 다르게 동작할 가능성 존재

2. **고정 modelFlags 사용**
    - 모든 모델에 동일 플래그를 적용하는 구조
    - provider별(Claude/Gemini/OpenAI) 전처리 차이를 반영하지 못함

3. **CPM v4와 공통 문제였던 부분**
    - provider별 분기 없는 단일 등록 경로
    - 네이티브 대비 system 처리 경로 차이를 유발

위 문제를 v4에서 FIX-Q6/Q7로 보정 완료.

추가로 `_temp_repo/provider-manager.js`에도 동일 오프셋 수정 적용:
- model flags: `[0,9,10]` → `[0,6,8]`

---

## 6. 빌드 검증

- **12개 번들 모두 정상 빌드** (0 errors, 0 warnings)
- 모든 수정 태그 (BUG-Q1~Q9) 번들에 확인됨
- 영향 받는 번들: 매니저, anthropic, openai, gemini, vertex, aws, deepseek, openrouter

---

## 7. 3차 검증 — 추가 발견 (BUG-Q10 ~ Q13)

### BUG-Q10 [HIGH] — OpenAI GPT-5 dated 모델 sampling 파라미터 삭제

| 항목 | 네이티브 RisuAI | CPM v4 (수정 전) |
|------|----------------|-----------------|
| **GPT-5 dated 모델** 파라미터 | `GPT5Parameters` = temperature, top_p, freq_pen, pres_pen, reasoning_effort, verbosity — **전부 전송** | `disableSampling = isReasoning \|\| isGpt5Dated` — **temperature/top_p/freq/pres 전부 삭제** |
| **대상 모델** | gpt-5-2025-08-07, gpt-5.1-2025-11-13, gpt-5.2-2025-12-11 | 동일 모델에서 사용자 설정 무시 |
| **실제 영향** | 사용자가 temp=1.7 설정 → 1.7 그대로 전송 | temp=1.7 설정 → **삭제됨**, API 기본값 사용 |

**원인**: `isGpt5Dated` 플래그가 `disableSampling`에 포함됨. 네이티브 RisuAI는 `forceDisableSamplingParams`를 GPT-5에 사용하지 않음 (o-시리즈만 해당).

**수정**: `disableSampling = isReasoning` (isGpt5Dated 제거)
- [src/providers/openai.js](src/providers/openai.js) line 57

### BUG-Q11 [MEDIUM] — Gemini 안전 설정 threshold 불일치

| 항목 | 네이티브 RisuAI | CPM v4 (수정 전) |
|------|----------------|-----------------|
| **기본 threshold** | `BLOCK_NONE` | `OFF` |
| **`OFF` 적용 조건** | `geminiBlockOff` 플래그가 있는 모델만 | 전체 모델 무조건 |

**대상 모델 (CPM v4가 제공하는 안정 모델)**:
- `gemini-2.5-pro`, `gemini-2.5-flash`: 네이티브에 `geminiBlockOff` **없음** → `BLOCK_NONE` 사용
- `gemini-3-*-preview`, `gemini-3.1-pro-preview`: 네이티브에 `geminiBlockOff` **없음** → `BLOCK_NONE` 사용

**영향**: `OFF`는 최신 API에서만 지원. 미지원 모델/리전에서 API 오류 또는 기본 필터링 Fallback 가능.

**수정**: `threshold: 'OFF'` → `threshold: 'BLOCK_NONE'`
- [src/shared/gemini-helpers.js](src/shared/gemini-helpers.js) line 4

### BUG-Q12 [MEDIUM] — handleCustomModel Anthropic 포맷: thinking 모드에서 temperature 삭제

| 항목 | 네이티브 RisuAI (Direct API) | CPM v4 handleCustomModel (수정 전) | 네이티브 (Bedrock만) |
|------|---------------------------|----------------------------------|---------------------|
| **adaptive thinking** | temperature 유지 | `delete body.temperature` | temp=1.0 강제, top_k/top_p 삭제 |
| **budget thinking** | temperature 유지 | `delete body.temperature` | 동일 |

**원인**: handleCustomModel이 Bedrock 전용 로직을 직접 API 경로에 잘못 적용.

**수정**: `delete body.temperature` 2개소 제거 (adaptive, budget → 둘 다)
- [src/manager/index.js](src/manager/index.js) lines 733, 737

### BUG-Q13 [MEDIUM] — temp_repo 고정 LLMFlags 미분화

| 항목 | CPM v4 (이전 Q6 수정 완료) | temp_repo (수정 전) |
|------|-------------------------|-------------------|
| **플래그** | provider별 분기: Claude [0,7,8], Gemini [0,7,8,9], OpenAI [0,6,8] | 전체 모델 고정 [0,6,8] |

**수정**: CPM v4와 동일한 per-provider 분기 로직 적용
- [_temp_repo/provider-manager.js](_temp_repo/provider-manager.js) lines 3942-3963

---

## 8. LBI 관련 참고 사항 (별도 코드베이스 — 수정 불가)

| 항목 | 네이티브 RisuAI | LBI | 영향도 |
|------|----------------|-----|--------|
| **OpenAI temperature 범위** | 0~2 그대로 전송 | 0~1 클램핑 (1 초과 → 1.0) | HIGH — temp=1.7 → 1.0으로 잘림 |
| **Claude temperature 범위** | 그대로 전송 (API가 거부 시 에러) | 0~1 클램핑 (위반 → 1.0) | MEDIUM |
| **GPT-5 sampling** | GPT5Parameters 사용 (전부 전송) | `forceDisableSamplingParams` → 전부 삭제 | HIGH |
| **LLMFlags** | 미전달 → 기본값 `[hasFullSystemPrompt]` 적용 | 동일 | 없음 (기본값이 적합) |
| **Tokenizer** | Gemini → `gemma` | Gemini → `gemma` (네이티브는 GoogleCloud) | LOW |

---

## 9. 남은 구조적 차이 (최소화 후 잔여)

| 항목 | 설명 | 영향도 |
|------|------|--------|
| V3 Bridge 직렬화 | 플러그인은 항상 bridge를 통해 메시지를 수신 — structured-clone 과정에서 일부 prototype 정보 손실 가능 | 낮음 |
| provider별 세부 플래그 완전복제 한계 | 네이티브 모델별 세부 플래그(예: geminiBlockOff, claudeAdaptiveThinking 등)를 addProvider에서 1:1 재현하기 어려움 | 낮음~중간 |
| Claude `cache_control.ttl = "1h"` | RisuAI의 1시간 캐싱 설정 미지원 | 낮음 (비용/성능만 영향) |
| `db.systemContentReplacement` 미반영 | 사용자가 커스텀 system content 포맷을 설정한 경우 CPM v4와 다름 (기본값은 동일) | 낮음 |

---

## 10. 수정 이력

| 버그 ID | 심각도 | 수정 파일 | 상태 |
|---------|--------|----------|------|
| Q1 | CRITICAL | message-format.js | ✅ 완료 |
| Q2 | CRITICAL | message-format.js | ✅ 완료 |
| Q3 | LOW | message-format.js | ✅ 완료 |
| Q4 | HIGH | openai.js, message-format.js | ✅ 완료 |
| Q5 | HIGH | message-format.js | ✅ 완료 |
| Q6 | HIGH | manager/index.js | ✅ 완료 |
| Q7 | MEDIUM | manager/index.js | ✅ 완료 |
| Q8 | MEDIUM | anthropic.js, aws.js, vertex.js | ✅ 완료 |
| Q9 | MEDIUM | gemini.js, vertex.js | ✅ 완료 |
| Q10 | HIGH | openai.js | ✅ 완료 (3차) |
| Q11 | MEDIUM | gemini-helpers.js | ✅ 완료 (3차) |
| Q12 | MEDIUM | manager/index.js | ✅ 완료 (3차) |
| Q13 | MEDIUM | _temp_repo/provider-manager.js | ✅ 완료 (3차) |
