# temp_repo → cupcake-provider-v4 엄격 재감사 보고서 (2026-03-09)

## 목적

`_temp_repo`에서 `cupcake-provider-v4`로 이관 가능한 기능/테스트/UX가 실제로 얼마나 옮겨졌는지,
그리고 `Risuai-main`의 실제 V3 플러그인 API/런타임 구조에서 현재 v4가 무리 없이 동작하는지 다시 엄격하게 검증했다.

이번 감사는 단순 파일 존재 확인이 아니라 다음 3축으로 수행했다.

1. `temp_repo` ↔ `cupcake-provider-v4` 기능/구조 비교
2. `temp_repo/tests` ↔ `cupcake-provider-v4/tests` 테스트 이관 상태 비교
3. `Risuai-main` 실제 구현 ↔ `cupcake-provider-v4` 사용 API 정합성 검증

---

## 최종 결론

### 판정 요약

- **핵심 provider 기능 이관:** 대체로 완료
- **공용 formatter/parser/sanitize/token/key/signer 계열:** 완료
- **동적 모델 IPC:** 구현은 되어 있었으나, **실제 RisuAI V3 채널 구현과 충돌하는 치명적 버그 1건 발견 및 수정 완료**
- **Custom Model 기능:** 전반적으로 이관됐지만, `Responses API Mode` UI/설정이 누락되어 있었고 **복구 완료**
- **RisuAI V3 호환성:** 구조 자체는 유효함. 다만 일부 undocumented API 의존 및 테스트 공백이 남아 있음
- **테스트 이관:** **전부 이관된 것은 아님**. 순수 shared 모듈 테스트는 많이 옮겨졌지만, manager 내부 통합/UX/Copilot/API log 계열은 아직 부족함

### 현재 상태 한 줄 요약

`cupcake-provider-v4`는 **실사용 가능한 수준으로 이관되어 있고 현재 구조는 V3 플러그인으로 구현 가능한 것이 맞다.**
다만 **모든 테스트가 이관된 것은 아니며**, 특히 manager 내부 로직과 UI 회귀 테스트는 아직 미비하다.

---

## 이번 감사에서 실제로 발견한 문제와 즉시 수정한 사항

### 1. 치명적 버그: 동적 모델 새로고침 IPC가 실제 RisuAI V3 채널 구현과 충돌

#### 문제
`Risuai-main`의 `addPluginChannelListener()`는 같은 플러그인 + 같은 채널에 대해 **리스너 하나만 저장**한다.
즉 멀티 리스너가 아니라 마지막 등록이 이전 것을 덮어쓴다.

그런데 v4 각 provider는:
- `CH.CONTROL`에 동적 모델 요청 리스너를 등록하고
- `registerWithManager()` 내부에서도 `CH.CONTROL` ACK 리스너를 또 등록하고 있었다.

이 구조에서는 ACK 리스너가 동적 모델 리스너를 덮어써서,
**초기 등록은 되더라도 이후 manager의 `DYNAMIC_MODELS_REQUEST`가 provider에 도달하지 않을 가능성**이 높았다.

#### 근거
- `Risuai-main/src/ts/plugins/apiV3/v3.svelte.ts`
- `cupcake-provider-v4/src/shared/ipc-protocol.js`
- `cupcake-provider-v4/src/providers/openai.js`
- `cupcake-provider-v4/src/providers/anthropic.js`
- `cupcake-provider-v4/src/providers/gemini.js`
- `cupcake-provider-v4/src/providers/vertex.js`
- `cupcake-provider-v4/src/providers/aws.js`
- `cupcake-provider-v4/src/providers/deepseek.js`
- `cupcake-provider-v4/src/providers/openrouter.js`

#### 조치
- `registerWithManager()`에 `onControlMessage` 훅을 추가
- 각 provider가 **단일 `CH.CONTROL` 리스너**만 사용하도록 수정
- 관련 회귀 테스트 추가

#### 결과
동적 모델 새로고침 경로가 이제 RisuAI V3의 실제 채널 구현과 충돌하지 않음.

---

### 2. 기능 누락: Custom Model `Responses API Mode` 설정 유실

#### 문제
`temp_repo`에는 커스텀 모델 편집기에서 `responsesMode: auto/on/off`를 저장하고,
manual `/responses` endpoint 또는 Copilot 계열에서 해당 값을 반영하는 로직이 있었다.

v4에서는:
- UI 필드가 사라졌고
- 저장 필드도 사라졌으며
- 사실상 `Copilot + GPT-5.4+` 자동 전환만 남아 있었다.

즉 **수동 `/responses` endpoint 또는 강제 on/off 조절 능력**이 일부 퇴화해 있었다.

#### 근거
- `_temp_repo/src/lib/settings-ui-custom-models.js`
- `_temp_repo/src/lib/fetch-custom.js`
- `cupcake-provider-v4/src/manager/index.js`

#### 조치
- manager의 Custom Model editor에 `Responses API Mode` 필드 복구
- `openEditor()` / save path에 `responsesMode` 저장 복구
- custom fetch path에서 `useResponsesAPI` 계산을 temp_repo 수준으로 복원

#### 결과
커스텀 OpenAI 호환 모델의 `/responses` 사용 제어가 다시 가능해짐.

---

### 3. 호환성 리스크 완화: `risuFetch` 미존재 시 즉시 실패 가능성

#### 문제
`Risuai-main` 런타임에는 `risuFetch`가 존재하지만, V3 문서 surface 기준으로는 `nativeFetch`가 더 정식에 가깝다.
manager와 standalone Copilot feature는 일부 경로에서 `Risu.risuFetch(...)`를 바로 호출하고 있었다.

#### 조치
- manager의 Copilot fetch helper에 `typeof Risu.risuFetch === 'function'` 가드 추가
- standalone Copilot feature에도 동일 가드 추가
- 미존재 시 `nativeFetch` fallback 사용

#### 결과
호환성 여유가 증가했고 undocumented API 의존도가 다소 낮아짐.

---

## 1. 기능 이관 상태 (엄격 판정)

## A. 거의 완전 이관

### Provider 계열
- OpenAI
- Anthropic
- Gemini
- Vertex
- AWS
- DeepSeek
- OpenRouter

판정: **완료**

사유:
- 독립 V3 plugin 엔트리로 존재
- manager와 IPC registration/fetch/abort 흐름 보유
- provider별 dynamic model fetch 구현 존재

관련 파일:
- `cupcake-provider-v4/src/providers/*.js`
- `cupcake-provider-v4/src/shared/ipc-protocol.js`
- `cupcake-provider-v4/src/shared/dynamic-models.js`

### Shared 처리 계열
- message formatting
- SSE parsing / non-streaming parsing
- sanitize
- token usage
- key rotation
- model helper
- AWS signer

판정: **완료**

관련 파일:
- `cupcake-provider-v4/src/shared/message-format.js`
- `cupcake-provider-v4/src/shared/sse-parser.js`
- `cupcake-provider-v4/src/shared/sanitize.js`
- `cupcake-provider-v4/src/shared/token-usage.js`
- `cupcake-provider-v4/src/shared/key-pool.js`
- `cupcake-provider-v4/src/shared/model-helpers.js`
- `cupcake-provider-v4/src/shared/aws-signer.js`

### Translation Cache / Navigation
판정: **실사용 기준 완료**

관련 파일:
- `cupcake-provider-v4/src/features/transcache.js`
- `cupcake-provider-v4/src/features/navigation.js`

---

## B. 부분 이관 / 보완 필요

### Custom Models
판정: **부분 완료 → 이번 감사에서 주요 누락 복구**

현재 상태:
- CRUD / import / export 존재
- formatter flags / thinking / cache / reasoning 존재
- `Responses API Mode` 누락은 이번 감사에서 복구

남은 점:
- 여전히 dedicated integration test가 없음

관련 파일:
- `cupcake-provider-v4/src/manager/index.js`

### Chat Resizer
판정: **부분 이관**

사유:
- 핵심 resize 기능은 존재
- temp_repo의 사용자 on/off 토글 UI는 v4에 없음

관련 파일:
- `_temp_repo/cpm-chat-resizer.js`
- `cupcake-provider-v4/src/features/resizer.js`

### Copilot 기능
판정: **기능은 대체로 존재, 테스트는 부족**

사유:
- manager 내 Copilot token handling 존재
- standalone feature도 존재
- quota/model list/device flow UI도 존재
- 하지만 edge case test coverage는 얕음

관련 파일:
- `cupcake-provider-v4/src/manager/index.js`
- `cupcake-provider-v4/src/features/copilot.js`

---

## C. 구조상 비이관이 맞는 것

다음 항목은 `temp_repo` 구조의 산물이므로 v4에서 안 옮긴 것이 오히려 정상이다.

- sub-plugin manager
- csp-exec
- cupcake-api runtime layer
- settings-ui-plugins
- sub-plugin integrity / install / update / hot reload 시스템

판정: **비이관 정상**

사유:
- temp_repo는 “플러그인 안의 플러그인” 구조
- v4는 “독립 V3 플러그인 + IPC 허브” 구조
- 아키텍처 자체가 다르므로 동일 개념 유지가 불필요

---

## 2. 테스트 이관 상태

## 전체 수치

### temp_repo
- 감사 대상 테스트 파일: **30개**

### v4 현재
- 테스트 파일: **14개**
- 테스트 수: **373 passed**

검증 결과:
- `npm test` ✅
- `npm run typecheck` ✅
- `npm run build` ✅
- `npm run verify` ✅

---

## A. 잘 이관된 테스트

- `aws-signer.test.js`
- `key-pool.test.js`
- `model-helpers.test.js`
- `sanitize.test.js`
- `stream-utils.test.js`
- `token-usage.test.js`
- `v3-pipeline-simulation.test.js`
- format/parser 관련 temp 테스트들은 `message-format.test.js`, `sse-parser.test.js`, `gemini-helpers.test.js`로 상당 부분 통합 이관됨

판정: **shared/data-transform 계열은 대체로 양호**

---

## B. 부분 이관만 된 테스트

- `init-boot-failure.test.js` → `boot-recovery.test.js`
- `settings-backup.test.js`
- `shared-state.test.js`
- `slot-inference.test.js`
- `init-bootstrap-di.test.js`
- `init.integration.test.js`
- `helpers.test.js` 일부

판정: **아이디어는 살아 있으나 direct coverage는 얕아짐**

---

## C. 아직 없는 테스트 (중요)

다음은 **아직 이관 완료라고 보기 어렵다.**

### 1) API Request Log
- temp: `api-request-log.test.js`
- v4: 전용 테스트 없음

현재 코드 존재:
- manager inline storage / export / clear / render 로직 있음

부족한 검증:
- 최대 50개 eviction
- clear 동작
- export redaction
- update semantics

### 2) Copilot Token
- temp: `copilot-token.test.js`
- v4: 전용 테스트 없음

부족한 검증:
- token exchange cache
- sanitize
- dynamic API base
- error modes

### 3) smartFetch
- temp: `smart-fetch.test.js`
- v4: 전용 테스트 없음

부족한 검증:
- fallback order
- duplicate replay guard
- bridge serialization 안전성
- 4xx pass-through

### 4) Router / Manager Request Handling
- temp: `router.test.js`, `router.integration.test.js`
- v4: 직접 대응 테스트 없음

부족한 검증:
- `handleRequest()`
- slot override/fallback param
- malformed result normalization
- stream collection branch

### 5) Custom Model Fetch / E2E
- temp: `fetch-custom.test.js`, `fetch-e2e.test.js`
- v4: dedicated successor 없음

부족한 검증:
- custom openai/anthropic/google
- streaming / non-streaming
- Copilot `/responses`
- reasoning/token usage

### 6) UI Regression
- temp: `ui-regression.test.js`
- v4: 없음

부족한 검증:
- settings tabs
- diagnostics tab
- API log tab
- Copilot tab
- custom model editor persistence

### 엄격 결론
**테스트는 모두 이관되지 않았다.**

shared 모듈 테스트는 많이 들어왔지만,
**manager 내부 runtime / Copilot / custom fetch / UI / API log**는 아직 부족하다.

---

## 3. RisuAI-main 기반 V3 호환성 감사

## 확인된 호환 API

다음은 `Risuai-main` 실제 구현에서 확인된 유효한 API이며,
`cupcake-provider-v4`의 사용 방식이 구조적으로 맞다.

- `registerSetting()`
- `showContainer('fullscreen')`
- `hideContainer()`
- `getRootDocument()`
- `addPluginChannelListener()`
- `postPluginChannelMessage()`
- `nativeFetch()`
- `getArgument()` / `setArgument()`
- `pluginStorage`
- `addProvider()` 경유 모델 등록 흐름

판정: **v4 아키텍처 자체는 V3 API 위에서 성립한다.**

---

## 실제 호환성 리스크

### 1) `risuFetch` 의존
- 런타임에는 존재하지만 문서상 핵심 public surface는 `nativeFetch`가 더 확실함
- 이번 감사에서 guard를 넣어 완화했지만, 여전히 일부 경로는 `risuFetch`가 있을수록 더 풍부한 fallback을 사용함

판정: **리스크 완화됨, 완전 제거는 아님**

### 2) `pluginStorage`는 문서상 plugin-specific처럼 보이지만 실제 구현은 shared backing store
- v4는 prefix를 사용하고 있어 충돌 가능성은 낮음
- 하지만 절대 isolation은 아님

판정: **주의 필요, 즉시 문제는 아님**

### 3) `getRootDocument()`는 permission gate 의존
- user가 `mainDom` 권한을 거부하면 일부 UI/DOM 기능은 degrade 가능

영향 기능:
- navigation
- resizer
- token toast
- 일부 manager hotkey/gesture

판정: **구조적 한계이지만 V3 범위 내 정상**

### 4) V3 bridge API 대부분은 Promise 기반
- 코드 일부는 `setArgument()`, `showContainer()`, `hideContainer()` 등을 즉시 fire-and-forget로 쓰는 곳이 있음
- 대체로 동작하나, race 관점에서는 완전 무위험은 아님

판정: **잠재 리스크는 있으나 현재 blocking 이슈는 아님**

### 5) 모델 ID 안정성
- RisuAI는 plugin model ID를 provider label 기반으로 만들기 때문에
- 표시 이름을 바꾸면 persisted selection이 흔들릴 수 있음

판정: **설계상 주의점**

---

## 4. 현재 미비한 점 (우선순위 포함)

## P1 — 꼭 추가하는 것이 좋은 것

1. `manager-provider.integration.test.js`
   - provider registration → dynamic models → fetch → response → abort roundtrip

2. `custom-model-fetch.integration.test.js`
   - temp의 `fetch-custom.test.js` 핵심 시나리오 이식

3. `copilot-token.test.js`
   - token exchange/cache/error/sanitize 회귀 추가

4. `smart-fetch.test.js`
   - fallback order / duplicate replay guard / non-JSON body 회귀 복구

5. `api-request-log.test.js`
   - log eviction / clear / redaction / lookup 검증

## P2 — 있으면 안정성이 크게 올라가는 것

6. `slot-inference.test.js`
7. `settings-backup.test.js`
8. `ui-regression.test.js`

## P3 — 기능상 작은 회귀/차이

9. Chat Resizer on/off 토글 복원 여부 검토
10. manager 내부 주요 함수 일부 export 또는 pure helper 분리로 테스트 가능성 향상

---

## 5. 현재 판정

### “이관 가능한 것들이 제대로 이관되었는가?”
**대체로 그렇다.**
핵심 기능은 대부분 v4에 있고, provider/runtime/공용 처리층은 실사용 수준으로 충분히 옮겨졌다.

### “오류가 날 만한 부분이나 누락은 없는가?”
**있었다.**
이번 감사에서 가장 위험한 두 가지를 실제로 찾았다.

- `CH.CONTROL` 다중 리스너 가정 버그 → **수정 완료**
- Custom Model `Responses API Mode` 누락 → **복구 완료**

추가로 `risuFetch` 미존재 시 즉시 깨질 여지도 완화했다.

### “테스트들도 모두 이관됐는가?”
**아니다.**
shared 모듈 테스트는 많이 이관됐지만,
manager/Copilot/custom-fetch/UI/API-log/integration 계열은 아직 부족하다.

### “현재 리스에서 원활하게 돌아가는 구조가 맞는가?”
**맞다.**
`Risuai-main` 실제 구현을 기준으로 보면,
현재 v4의 **독립 V3 플러그인 + IPC manager/provider 구조는 유효하다.**

다만 다음 전제가 붙는다.
- plugin channel은 단일 리스너 제약을 지켜야 함 → 이번 감사에서 수정함
- `nativeFetch` 중심으로 생각하는 편이 안전함
- 일부 DOM 기능은 `mainDom` permission에 좌우됨

---

## 6. 감사 후 최종 상태

### 코드 수정 반영
- `src/shared/ipc-protocol.js`
- `src/providers/openai.js`
- `src/providers/anthropic.js`
- `src/providers/gemini.js`
- `src/providers/vertex.js`
- `src/providers/aws.js`
- `src/providers/deepseek.js`
- `src/providers/openrouter.js`
- `src/manager/index.js`
- `src/features/copilot.js`
- `tests/ipc-protocol.test.js`

### 최종 검증
- `npm test` → **14 files / 373 tests passed**
- `npm run typecheck` → **clean**
- `npm run build` → **success**
- `npm run verify` → **72/72 checks passed**

---

## 결론

`cupcake-provider-v4`는 현재 **RisuAI V3 위에서 동작 가능한 구조가 맞고**, 핵심 기능 이관도 전반적으로 잘 되어 있다.

하지만 **“완전히 다 옮겨졌고 테스트까지 완벽히 동일하다”는 평가는 아직 아니다.**
남은 약점은 대부분 manager 내부 통합 테스트와 UI 회귀 테스트 쪽이다.

즉 현재 평가는 다음과 같다.

- **실사용 구조 적합성:** 합격
- **핵심 기능 이관:** 합격
- **치명 버그 존재 여부:** 감사 중 발견, 수정 완료
- **테스트 완전 이관 여부:** 미완료
- **향후 보강 우선순위:** manager/Copilot/custom-fetch/API-log/UI 통합 테스트
