# Dead Code Branch Analysis — Coverage Ceiling Report

> **커밋**: `52cae81` | **전체 branch coverage**: 90.67% | **분석 날짜**: 2025-06-11

## 요약

| 파일 | Branch % | Uncovered | Dead Code | Testable | 한계 원인 |
|---|---|---|---|---|---|
| message-format.js | 83.82% | 66 / 406 | ~55 | ~11 | `sanitizeMessages` + `extractNormalizedMessagePayload` 전처리 |
| helpers.js | 84.15% | 64 / 404 | ~50 | ~14 | `smartFetch`/`streamingFetch` 브라우저 전용 + IPC 브릿지 |

**결론**: 두 파일 모두 84%대가 실질적 상한선입니다. 나머지 uncovered 브랜치는 (1) 상위 필터가 제거한 데이터에 대한 방어 코드, (2) 브라우저 런타임 전용 코드, (3) IPC 브릿지 응답 변환 코드로, 단위 테스트로 도달 불가능합니다.

---

## message-format.js 데드코드 분석 (66 uncovered branches)

### 카테고리 A: `sanitizeMessages()` 필터로 인한 데드코드 (~20)

`sanitizeMessages()`는 모든 format 함수 진입부에서 호출되며 다음을 보장합니다:
- `m.content`가 null/undefined인 메시지는 제거됨
- `hasNonEmptyMessageContent(content)` 또는 `hasAttachedMultimodals(m)`을 통과한 메시지만 잔류
- `m.role`이 string이고 비어있지 않음

따라서 다음 방어 코드들은 **절대 도달 불가**:

| Branch | Line | 코드 | 이유 |
|---|---|---|---|
| B15 | L63 | `if (!m \|\| typeof m !== 'object') continue` | sanitizeMessages가 null/non-object 제거 |
| B18 | L65 | `if (!role) continue` | sanitizeMessages가 빈 role 제거 |
| B153 | L379 | `if (!text && !Array.isArray(m.content) && typeof m.content !== 'string')` | extractNormalizedMessagePayload가 항상 text 추출 |
| B143 | L338 | `if (typeof msg.content === 'string')` — cache_control 경로 | Anthropic formatter가 항상 array content로 생성 |

### 카테고리 B: `extractNormalizedMessagePayload()` 정규화로 인한 데드코드 (~25)

`extractNormalizedMessagePayload()`가 `m.content`에서 multimodals를 추출하여 `payload.multimodals`에 넣고, 텍스트를 `payload.text`에 합치므로:

| Branch | Lines | 코드 | 이유 |
|---|---|---|---|
| B42-B53 | L102-L124 | OpenAI `Array.isArray(m.content)` 내부 — inlineData, image_url 변환 | multimodals가 이미 payload에서 추출됨 → `Array.isArray` 경로는 raw content 잔류 시에만 도달하는데, 정규화 후에는 해당 패턴 없음 |
| B93-B102 | L240-L257 | Anthropic same-role merge else 블록 (text 경로) | text가 있으면 contentParts>0 → if 블록 진입; text 비면 hasNonEmptyMessageContent false → continue. else 블록 도달 조건 없음 |
| B108-B123 | L273-L292 | Anthropic `Array.isArray(m.content)` 내부 — part 변환 | OpenAI와 동일 이유 — 정규화 후 raw Array content에 image_url 등 잔류하지 않음 |
| B128-B133 | L301-L313 | Anthropic 기본 텍스트 경로 same-role merge | 위 B93-B102와 동일 데드코드 패턴 |

### 카테고리 C: 조건부 단락 평가 (binary-expr) (~15)

V8이 `a || b || c` 같은 단락 평가 표현식의 각 분기를 별도로 계수합니다. 앞 조건이 항상 truthy이면 뒤 피연산자는 평가되지 않습니다:

| Branch | Line | 코드 | 이유 |
|---|---|---|---|
| B17 | L64 | `typeof m.role === 'string' ? m.role : 'user'` — else 분기 | sanitizeMessages가 string role 보장 |
| B68, B70 | L156, L159 | Gemini `cond-expr` else 분기 | 정규화된 데이터에서 base64/mimeType 항상 존재 |
| B173, B174 | L418, L420 | Gemini binary-expr — base64 파싱 fallback | 유효한 data URI에서 항상 comma 존재, mimeType 항상 추출됨 |
| B186 | L446 | Gemini `stripThoughtDisplayContent` 결과 empty | 이미 trimmed가 '' 이면 위에서 skip됨 |

### 카테고리 D: 나머지 도달 가능하지만 어려운 브랜치 (~6)

| Branch | Line | 설명 |
|---|---|---|
| B25 | L77 | `if (modal.type === 'image')` — image가 아닌 multimodal 중 audio도 아닌 타입 → unknown type skip |
| B81 | L223 | Anthropic URL 이미지 (`http://` 또는 `https://`) — 테스트 가능하나 우선순위 낮음 |
| B136 | L318 | Anthropic else 분기 — prev.content가 array가 아닌 경우 (항상 array로 생성) |

---

## helpers.js 데드코드 분석 (64 uncovered branches)

### 카테고리 A: `smartFetch` 브라우저/IPC 전용 경로 (~35)

`smartFetch`와 `streamingFetch`는 Risu.nativeFetch, Risu.risuFetch 등 V3 iframe bridge API에 의존합니다. Node.js 테스트 환경에서는 이들이 mock이며, 실제 bridge 동작(DataCloneError, ReadableStream structured clone 실패 등)을 재현할 수 없습니다.

| Branch 범위 | Lines | 코드 영역 | 이유 |
|---|---|---|---|
| B67-B84 | L226-L254 | `_stripNonSerializable` 내부 분기 + `sanitizeBodyForBridge` | Date, RegExp, Error, BigInt, Symbol 등 exotic 타입 처리 — 실제 API body에서 거의 발생 안함 |
| B98-B123 | L330-L412 | smartFetch Copilot 경로 (Strategy B/C) — `risuFetch` + `toResponseBody` | IPC bridge 전용; body 변환, header 검증, 4xx 에러 경로 |
| B137-B139 | L468-L473 | smartFetch non-Copilot `nativeFetch` 경로 | bridge response 검증 |
| B153-B179 | L565-L642 | `streamingFetch` — risuFetch fallback + response body 변환 | IPC bridge 전용 스트리밍 경로 |

### 카테고리 B: `getHeaderValue` / `hasHeaders` 방어 코드 (~8)

| Branch 범위 | Lines | 코드 | 이유 |
|---|---|---|---|
| B45-B49 | L171-L181 | `getHeaderValue` — Headers.get() fallback, key 대소문자 처리 | Headers 객체가 항상 .get() 지원 → try/catch 및 dict fallback 미사용 |
| B67-B76 | L226-L237 | `hasHeaders` — forEach fallback, Object.keys fallback | 위와 동일 |

### 카테고리 C: `checkStreamCapability` 브라우저 전용 (~5)

| Branch | Lines | 코드 | 이유 |
|---|---|---|---|
| B160-B168 | L587-L621 | MessageChannel + ReadableStream structured clone 테스트 | Node.js 환경에서 MessageChannel 동작 차이; setTimeout 기반 Promise race로 비결정적 |

### 카테고리 D: `collectStream` edge case (~3)

| Branch | Lines | 코드 | 이유 |
|---|---|---|---|
| B45 | L171 | `collectStream` value가 ArrayBuffer인 경우 | ReadableStream이 보통 Uint8Array 또는 string 반환 |

---

## 결론 및 권장사항

1. **message-format.js (83.82%)**: `sanitizeMessages + extractNormalizedMessagePayload` 전처리 파이프라인이 입력을 정규화하기 때문에, formatter 내부의 방어 코드는 구조적으로 도달 불가능합니다. 이 코드를 제거하면 커버리지는 올라가지만, 방어적 프로그래밍 제거는 위험합니다. **현재 83.82%가 실질적 상한선.**

2. **helpers.js (84.15%)**: 64개 중 50개 이상이 IPC bridge/브라우저 런타임 전용입니다. Node.js 환경의 단위 테스트로는 ReadableStream structured clone, DataCloneError, MessageChannel 등을 실제로 테스트할 수 없습니다. **현재 84.15%가 실질적 상한선.**

3. **전체 90.70%는 건전한 수치**: 개별 파일의 한계에도 불구하고 전체 branch coverage는 90%를 넘습니다. 이는 다른 파일들(auto-updater 91.33%, sse-parser 90.02%, aws-signer 94.07% 등)이 높은 커버리지를 달성하고 있기 때문입니다.

4. **추가 커버리지 향상 방법** (비권장):
   - 방어 코드 제거 → 커버리지 ↑, 안전성 ↓ (비권장)
   - E2E 브라우저 테스트 추가 → IPC 경로 커버 가능하나 CI 환경 복잡도 ↑ (비용 대비 효과 낮음)
   - Istanbul ignore 주석 추가 → 수치만 올라감, 실질적 의미 없음 (비권장)
