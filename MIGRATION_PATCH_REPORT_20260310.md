# temp_repo → cupcake-provider-v4 완전 패치 마이그레이션 보고서

**작성일**: 2026-03-10  
**분석 범위**: `_temp_repo` v1.19.6 전체 소스 ↔ `cupcake-provider-v4` 전체 소스  
**RisuAI V3 API 구현 가능성**: Risuai-main 소스 검증 완료  

---

## 요약

`_temp_repo`는 852개 테스트를 통과하는 성숙한 코드베이스로, 다양한 안정성/보안 패치가 적용되어 있다. `cupcake-provider-v4`는 13개 품질 버그 수정(Q1-Q13)과 IPC 아키텍처 전환은 완료했으나, 아직 적용되지 않은 패치가 **28건** 발견되었다.

### 분류 요약

| 분류 | 건수 | 구현 가능 여부 |
|------|------|---------------|
| **보안 패치 (SECURITY)** | 4건 | 모두 구현 가능 |
| **안정성 패치 (STABILITY)** | 10건 | 모두 구현 가능 |
| **기능 누락 (FEATURE)** | 8건 | 모두 구현 가능 |
| **테스트 부족 (TEST)** | 6건 | 모두 구현 가능 |

---

## PART 1: 보안 패치 (SECURITY)

### SEC-1: `escHtml()` XSS 방지 헬퍼 누락 ★★★
- **위치**: `shared/helpers.js`
- **현황**: temp_repo에는 `escHtml(str)` (HTML 특수문자 이스케이프: `& < > "`)이 존재하여 모든 설정 UI innerHTML에서 XSS를 방지함. v4에는 **완전히 누락**.
- **영향**: manager의 설정 UI에서 사용자 입력이 HTML로 직접 삽입될 경우 XSS 취약점 가능
- **구현**: `helpers.js`에 `escHtml()` 추가, manager UI에서 사용자 입력 이스케이프 적용
- **V3 API 제약**: 없음 (순수 유틸리티 함수)

### SEC-2: `schema.js` 데이터 유효성 검증 체계 누락 ★★★
- **위치**: v4 전체에 해당 모듈 없음
- **현황**: temp_repo는 `validateSchema()`, `parseAndValidate()`로 pluginStorage/원격 데이터의 구조 검증 (타입 체크, 필수 필드, maxItems/maxLength 제한). v4는 `JSON.parse()` 결과를 직접 신뢰.
- **영향**: 손상된 pluginStorage 데이터나 악의적 원격 응답이 런타임 크래시 유발. `settings-backup.js` load 시 무검증.
- **구현**: `shared/schema.js` 신규 생성, `settings-backup.js`에 통합
- **V3 API 제약**: 없음

### SEC-3: `_stripNonSerializable()` 재귀 직렬화 안전 누락 ★★
- **위치**: `shared/helpers.js` (smartFetch 관련)
- **현황**: temp_repo는 `_stripNonSerializable(obj, depth)`로 function, Symbol, BigInt 등을 재귀적으로 제거 (최대 15뎁스). v4의 `sanitizeBodyForBridge()`는 JSON round-trip만 수행.
- **영향**: 직렬화 불가능한 필드가 postMessage 경계에서 DataCloneError 유발 가능
- **구현**: `sanitizeBodyForBridge()` 강화 또는 별도 유틸리티 추가
- **V3 API 제약**: 없음

### SEC-4: Copilot `data.data` 모델 리스트 토큰 폴백 누락 ★★
- **위치**: `shared/copilot-token.js`
- **현황**: temp_repo는 Copilot API 응답이 `data.data` 배열(새 형식)인 경우 OAuth 토큰을 직접 사용하는 폴백 로직 존재. v4는 `data.token` 없으면 빈 문자열 반환.
- **영향**: 새로운 Copilot API 형식에서 토큰 교환 실패
- **구현**: `ensureCopilotApiToken()`에 `data.data` 배열 폴백 추가
- **V3 API 제약**: 없음

---

## PART 2: 안정성 패치 (STABILITY)

### STB-1: Vertex AI 리전 폴백 재시도 ★★★
- **위치**: `providers/vertex.js`
- **현황**: temp_repo는 404/400 시 `us-central1` → `us-east4` → `europe-west1` → `asia-northeast1` 자동 재시도. v4는 오류 메시지에 리전 제안만 하고 1번 시도 후 실패.
- **영향**: 첫 요청 리전이 잘못됐을 때 사용자가 수동으로 변경해야 함
- **구현**: `handleFetch()`에 자동 리전 폴백 루프 추가
- **V3 API 제약**: 없음 (`nativeFetch`/`risuFetch` 다중 호출 가능)

### STB-2: DeepSeek max_tokens 클램핑 누락 ★★★
- **위치**: `providers/deepseek.js`
- **현황**: temp_repo는 deepseek-reasoner: 65536, deepseek-chat: 8192 클램핑. v4는 **클램핑 없음**.
- **영향**: API 오류 (max_tokens 초과) 또는 과도한 토큰 사용
- **구현**: `handleFetch()`에 모델별 max_tokens 클램핑 추가
- **V3 API 제약**: 없음

### STB-3: `extractNormalizedMessagePayload()` 문자열 image_url 처리 누락 ★★
- **위치**: `shared/sanitize.js`
- **현황**: temp_repo는 `typeof part.image_url === 'string'` 형태도 처리. v4는 `{ url: string }` 객체 형태만 처리.
- **영향**: 문자열 형태의 image_url 파트가 무시되어 이미지 누락
- **구현**: `extractNormalizedMessagePayload()`에 문자열 분기 추가
- **V3 API 제약**: 없음

### STB-4: AWS `normalizeAwsAnthropicModelId` 모델 ID 정규화 누락 ★★
- **위치**: `providers/aws.js` 또는 `shared/dynamic-models.js`
- **현황**: temp_repo에는 크로스 리전 모델 ID 프리픽스 정규화 (`global.`/`us.` 자동 프리픽스) 존재. v4에는 동적 모델 검색에만 있고 실제 요청 시에는 적용 안 됨.
- **영향**: 특정 리전에서 모델 ID가 달라 API 요청 실패 가능
- **구현**: `aws.js`의 `handleFetch()`에 모델 ID 정규화 단계 추가
- **V3 API 제약**: 없음

### STB-5: Settings Backup 스키마 유효성 검증 누락 ★★
- **위치**: `shared/settings-backup.js`
- **현황**: temp_repo는 `parseAndValidate(schemas.settingsBackup)`로 로드 시 검증. v4는 `JSON.parse()` 후 바로 사용.
- **영향**: 손상된 백업 데이터가 설정 복원 시 크래시 유발
- **구현**: SEC-2 (schema.js) 구현 후, `load()`에 통합
- **V3 API 제약**: 없음

### STB-6: SmartFetch AbortSignal DataCloneError 복구 ★★
- **위치**: `shared/helpers.js` smartFetch 내부
- **현황**: temp_repo는 `callNativeFetchWithAbortFallback()`로 DataCloneError 발생 시 signal 없이 재시도. v4는 signal을 아예 제거해서 전달 (다른 접근이지만, risuFetch 경로에서는 signal 전달 시 여전히 문제 가능).
- **영향**: v4의 접근이 이미 방어적이므로 **LOW** — 하지만 risuFetch에 signal이 전달되는 경우 DataCloneError 가능
- **구현**: risuFetch 호출 전 signal 제거 보장
- **V3 API 제약**: 없음

### STB-7: Chat Resizer 활성화/비활성화 토글 누락 ★
- **위치**: `features/resizer.js`
- **현황**: temp_repo는 `cpm_enable_chat_resizer` 설정으로 ON/OFF. v4는 항상 활성화.
- **영향**: 사용자가 불필요한 리사이저를 끌 수 없음
- **구현**: `@arg` 설정 추가 + 체크 로직
- **V3 API 제약**: 없음 (`getArgument` 사용)

### STB-8: Settings Backup BASE_SETTING_KEYS 완전성 ★★
- **위치**: `shared/settings-backup.js`
- **현황**: temp_repo는 ~50개 설정 키를 하드코딩 포함. v4는 ~10개만 하드코딩 + 프로바이더 동적 등록에 의존.
- **영향**: 로드 안 된 프로바이더의 설정 키가 백업에서 누락 가능
- **구현**: temp_repo의 키 목록을 v4에 포팅
- **V3 API 제약**: 없음

### STB-9: API 요청 로그 스트림 콘텐츠 추적 ★
- **위치**: `shared/sse-parser.js` 및 manager
- **현황**: temp_repo 스트림 빌더는 `_accumulatedContent`로 스트림 전체 내용을 API 요청 로그에 기록. v4는 스트리밍 응답 내용을 로그하지 않음.
- **영향**: 디버깅 시 스트리밍 응답 내용 확인 불가
- **구현**: 스트림 완료 콜백에서 축적된 콘텐츠를 `updateApiRequest()`에 전달
- **V3 API 제약**: 없음

### STB-10: OpenAI `stream_options` include_usage 누락 ★★
- **위치**: `providers/openai.js`
- **현황**: temp_repo는 스트리밍 + 토큰 표시 시 `stream_options: { include_usage: true }` 포함. v4에서는 누락.
- **영향**: OpenAI 스트리밍 시 토큰 사용량이 SSE에 포함되지 않아 표시 불가
- **구현**: body 구성에 `stream_options` 추가
- **V3 API 제약**: 없음 (body JSON 필드)

---

## PART 3: 기능 누락 (FEATURE)

### FEAT-1: 프로바이더별 Model Override 설정 ★★★
- **위치**: 모든 프로바이더 (`providers/*.js`)
- **현황**: temp_repo는 `cpm_anthropic_model`, `cpm_openai_model`, `cpm_gemini_model`, `cpm_deepseek_model`, `cpm_openrouter_model`, `cpm_vertex_model` 으로 모델 ID 오버라이드 가능. v4에는 **전부 누락**.
- **영향**: 새 모델 출시 시 플러그인 업데이트 전까지 사용 불가
- **구현**: 각 프로바이더에 `safeGetArg('cpm_*_model')` 체크 + 비어있지 않으면 오버라이드
- **V3 API 제약**: 없음 (`getArgument` 사용, `@arg` 선언 필요)

### FEAT-2: 커스텀 API URL 설정 (Anthropic, Gemini) ★★
- **위치**: `providers/anthropic.js`, `providers/gemini.js`
- **현황**: temp_repo는 `cpm_anthropic_url`, Gemini 관련 URL 설정 존재. v4는 하드코딩.
- **영향**: 프록시/미러 사용 불가
- **구현**: url 설정 읽기 + 기본값 폴백
- **V3 API 제약**: 없음

### FEAT-3: `extractImageUrlFromPart()` 유틸리티 누락 ★
- **위치**: `shared/helpers.js`
- **현황**: temp_repo에서 메시지 파트에서 이미지 URL을 추출하는 공유 유틸리티. v4에서는 각 포맷터가 로컬로 구현.
- **영향**: 코드 중복, 불일치 가능성
- **구현**: 공유 유틸리티로 추출 + 포맷터에서 import
- **V3 API 제약**: 없음

### FEAT-4: OpenRouter 모델 오버라이드 필수 체크 ★★
- **위치**: `providers/openrouter.js`
- **현황**: temp_repo는 `cpm_openrouter_model` 비어있으면 한국어 오류 메시지 반환 (필수). v4는 체크 없이 기본 모델 ID 사용.
- **영향**: OpenRouter는 특정 모델 지정이 필수이므로 기본값으로 요청하면 실패 가능
- **구현**: FEAT-1과 함께 모델 오버라이드 + 빈 값 체크 추가
- **V3 API 제약**: 없음

### FEAT-5: OpenAI `service_tier`, `prompt_cache_retention` 파라미터 ★
- **위치**: `providers/openai.js`
- **현황**: temp_repo에서 지원. v4에서 누락.
- **영향**: 서비스 티어/캐시 제어 불가
- **구현**: 설정 읽기 + body에 조건부 포함
- **V3 API 제약**: 없음

### FEAT-6: OpenRouter `reasoning.max_tokens` ★
- **위치**: `providers/openrouter.js`
- **현황**: temp_repo는 reasoning 객체에 `max_tokens` 포함. v4는 누락.
- **영향**: reasoning 모델에서 토큰 제한 불가
- **구현**: reasoning 객체 구성 시 `max_tokens` 추가
- **V3 API 제약**: 없음

### FEAT-7: KeyPool `withJsonRotation()` 편의 메서드 ★
- **위치**: `shared/key-pool.js`
- **현황**: temp_repo에만 존재하는 JSON 자격증명 로테이션 편의 메서드.
- **영향**: Vertex AI JSON 키 로테이션 코드가 길어짐
- **구현**: KeyPool 클래스에 `withJsonRotation()` 추가
- **V3 API 제약**: 없음

### FEAT-8: Gemini `usePlainFetch` 설정 ★
- **위치**: `providers/gemini.js`
- **현황**: temp_repo에서 `chat_gemini_usePlainFetch` 지원 (특정 환경에서 plainFetch 강제). v4에서 누락.
- **영향**: plainFetch가 필요한 환경에서 요청 실패 가능
- **구현**: 설정 읽기 + fetch 옵션에 반영
- **V3 API 제약**: 없음

---

## PART 4: 테스트 부족 (TEST)

### TEST-1: SmartFetch 3단계 전략 테스트 ★★★
- **현황**: v4의 `smart-fetch.test.js`는 Copilot replay guard만 테스트. 3단계 전략 (direct → risuFetch → nativeFetch) 미테스트.
- **구현**: temp_repo `smart-fetch-strategies.test.js` 패턴 포팅

### TEST-2: Max Tokens 클램핑 구조/통합 테스트 ★★★
- **현황**: v4에 **완전 누락**. 프로바이더별 max_tokens 클램핑이 실제로 적용되는지 확인하는 테스트 없음.
- **구현**: temp_repo `max-tokens-clamping.test.js` 패턴 포팅

### TEST-3: 모델 플래그(LLMFlags) 테스트 ★★★
- **현황**: v4에 **완전 누락**. addProvider에 전달되는 플래그 (`hasImageInput`, `hasStreaming`, `DeveloperRole` 등) 정확성 미검증.
- **구현**: temp_repo `init-model-flags.test.js` 패턴 포팅

### TEST-4: 라우팅/IPC 파이프라인 통합 테스트 ★★★
- **현황**: v4에 router 통합 테스트 없음. 매니저→IPC→프로바이더→응답 전체 파이프라인 미검증.
- **구현**: temp_repo `router.integration.test.js` + IPC 패턴 결합

### TEST-5: E2E 스트리밍 + 토큰 트래킹 테스트 ★★
- **현황**: v4에 **완전 누락**. SSE → 파싱 → 스트림 빌더 → 토큰 사용량 추적 전체 체인 미검증.
- **구현**: temp_repo `fetch-e2e.test.js` 패턴 포팅

### TEST-6: Settings Backup 라이프사이클 테스트 ★★
- **현황**: v4의 `settings-backup.test.js`는 키 열거만 테스트. 손상 JSON 복구, 저장 검증, 라운드트립 미검증.
- **구현**: temp_repo `settings-backup-lifecycle.test.js` 패턴 포팅

---

## PART 5: 구현 불필요 (아키텍처 차이로 불필요한 항목)

| 항목 | 이유 |
|------|------|
| `sub-plugin-manager.js` | v4는 IPC 기반이므로 sub-plugin 시스템 불필요 |
| `csp-exec.js` | v4는 `<script>` 인젝션 대신 IPC 채널 사용 |
| `cupcake-api.js` (`window.CupcakePM`) | v4는 IPC 프로토콜로 대체 |
| `shared-state.js` 전체 | v4는 `ipc-protocol.js`로 중앙 상태 관리 |
| `init.js` 부트 페이즈 시스템 | v4 매니저가 자체 부트 관리 |
| Phase 2 guest-bridge 스트림 체크 | v4가 이미 결론적 제거 (Phase 1으로 충분) |

---

## PART 6: 구현 계획

### Phase A: 보안 패치 (즉시)
1. SEC-1: `escHtml()` 추가
2. SEC-2: `schema.js` 생성 + settings-backup 통합
3. SEC-3: `_stripNonSerializable()` 추가
4. SEC-4: Copilot `data.data` 폴백

### Phase B: 안정성 패치
5. STB-1: Vertex 리전 폴백
6. STB-2: DeepSeek max_tokens 클램핑
7. STB-3: sanitize 문자열 image_url
8. STB-4: AWS 모델 ID 정규화
9. STB-5: Settings Backup 스키마 검증 (SEC-2 의존)
10. STB-8: BASE_SETTING_KEYS 완전성
11. STB-10: OpenAI stream_options

### Phase C: 기능 패치
12. FEAT-1: Model Override (전 프로바이더)
13. FEAT-2: 커스텀 API URL
14. FEAT-4: OpenRouter 모델 필수 체크
15. FEAT-5: OpenAI service_tier/cache
16. FEAT-6: OpenRouter reasoning.max_tokens
17. FEAT-8: Gemini usePlainFetch

### Phase D: 테스트
18. TEST-1: SmartFetch 전략 테스트
19. TEST-2: Max Tokens 클램핑 테스트
20. TEST-3: 모델 플래그 테스트
21. TEST-4: IPC 파이프라인 통합 테스트
22. TEST-5: E2E 스트리밍 테스트
23. TEST-6: Settings Backup 라이프사이클

### Phase E: 소규모 개선
24. STB-6: risuFetch signal 제거 보장
25. STB-7: Chat Resizer 토글
26. STB-9: 스트림 콘텐츠 로그
27. FEAT-3: extractImageUrlFromPart 공유 유틸
28. FEAT-7: withJsonRotation

---

## V3 API 구현 가능성 종합 판정

**모든 28건 구현 가능**. 사용하는 V3 API:
- `getArgument` / `setArgument` — 설정 읽기/쓰기 (FEAT-1~8, STB-7)
- `nativeFetch` / `risuFetch` — 네트워크 (STB-1, SEC-4)
- `pluginStorage` — 데이터 저장 (SEC-2, STB-5)
- 순수 JavaScript 유틸리티 — 대부분 (SEC-1, SEC-3, STB-2~4 등)

Plugin Channel API (IPC)의 불안정성 위험이 있으나, 이미 v4의 핵심 메커니즘으로 사용 중이며, 이번 패치는 IPC에 새로운 의존을 추가하지 않음.
