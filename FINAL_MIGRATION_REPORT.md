# CPM (Cupcake Provider Manager) v4 — IPC 마이그레이션 최종 보고서

> **프로젝트**: cupcake-provider-v4_IPC  
> **기준일**: 2025년 6월  
> **마이그레이션 원본**: _temp_repo (CPM v1.21.2)  
> **아키텍처**: RisuAI V3 Plugin Channel IPC

---

## 1. 마이그레이션 요약

### 1.1 완료 작업 (12/12)
| # | 작업 | 상태 |
|---|------|------|
| 1 | IPC 프로토콜 (ipc-protocol.js) | ✅ |
| 2 | 매니저 인덱스 (manager/index.js) | ✅ |
| 3 | OpenAI 프로바이더 | ✅ |
| 4 | Anthropic 프로바이더 | ✅ |
| 5 | Gemini 프로바이더 | ✅ |
| 6 | AWS Bedrock 프로바이더 | ✅ |
| 7 | Vertex AI 프로바이더 | ✅ |
| 8 | DeepSeek 프로바이더 | ✅ |
| 9 | OpenRouter 프로바이더 | ✅ |
| 10 | Shared 유틸리티 (helpers, sanitize, schema 등) | ✅ |
| 11 | SSE/스트리밍 파서 | ✅ |
| 12 | 빌드 시스템 (Rollup 12 IIFE 번들) | ✅ |

### 1.2 아키텍처
- **12개 IIFE 번들**: 1 매니저 + 7 프로바이더 + 4 기능 플러그인
- **Plugin Channel IPC**: `postPluginChannelMessage` / `addPluginChannelListener`
- **26개 검증된 RisuAI V3 API**: 모든 시그니처 확인 완료
- **빌드 스택**: Rollup + @rollup/plugin-terser, ESM → IIFE

---

## 2. 보안 분석

### 2.1 setDatabaseLite 취약점 (Task 1)
**심각도**: 높음

`setDatabaseLite`는 실질적으로 `DBState.db = data` 1줄로 구현되며 유효성 검증이 없습니다.

**핵심 취약점**:
- `allowedDbKeys` 24개 키 중 `plugins`, `characters`, `guiHTML`, `customCSS` 포함
- `handlePluginInstallViaPlugin` 보안 게이트 완전 우회 가능
- 악성 플러그인이 `setDatabaseLite({ plugins: [...] })`로 무단 플러그인 설치 가능

**6가지 공격 시나리오**:
1. 무단 플러그인 설치 (보안 게이트 우회)
2. `guiHTML` / `customCSS` 주입 (XSS)
3. `characters` 배열 조작 (데이터 변조)
4. 기존 플러그인 스크립트 교체
5. 설정값 대량 변경
6. 자동 업데이트 URL 변조

**CPM의 방어**: SHA-256 무결성 검증 + 이름/버전 검증으로 부분적 보호

### 2.2 pluginChannel 메모리 누수 (Task 2)
**심각도**: 중간

`pluginChannel = new Map()`은 모듈 스코프에 존재하며 정리 메커니즘이 없습니다.

**문제 상세**:
- `unloadV3Plugin`이 `pluginChannel.delete()`를 호출하지 않음
- `setupChannelCleanup`이 구현/테스트되었으나 프로덕션에서 **호출되지 않았음**
- CPM 23개 채널 엔트리 → 영구 누적

**수정 완료**: 
8개 프로덕션 파일에 `setupChannelCleanup` 통합:
- 7개 프로바이더: `setupChannelCleanup(Risu, [CH.ABORT, CH.FETCH])` (registerWithManager 후)
- 1개 매니저: `setupChannelCleanup(Risu, [CH.CONTROL, CH.RESPONSE])` (setupControlChannel/setupResponseListener 후)

**효과**: 리스너 콜백 ~99% 클로저 방지, 키 제거 0% (~7KB 고정 오버헤드 허용)

---

## 3. 테스트 커버리지

### 3.1 전체 현황
| 지표 | 초기값 | 최종값 | 변화 |
|------|--------|--------|------|
| **Test Files** | 48 | 51 | +3 |
| **Tests** | 1519 | 1740 | +221 |
| **Statements** | 91.07% | 92.41% | +1.34% |
| **Branches** | 82.07% | 83.19% | +1.12% |
| **Functions** | 95.23% | 97.27% | +2.04% |
| **Lines** | 93.89% | 94.55% | +0.66% |

### 3.2 100% 달성 파일
- update-toast.js ✅ (76% → 100%)
- model-helpers.js ✅ (86% → 100%)
- schema.js, copilot-headers.js, copilot-token.js
- deserialization.js, companion-installer.js
- api-request-log.js, token-toast.js, endpoints.js

### 3.3 추가된 테스트 파일
1. **coverage-boost-95.test.js** (128 tests)
   - update-toast: showUpdateToast, showMainAutoUpdateResult
   - model-helpers: supports*, needs*, should* 30+ 분기 테스트
   - helpers: _raceWithAbortSignal, extractImageUrlFromPart, collectStream
   - message-format: 오디오 모달, Anthropic cachePoint, Gemini 시스템 메시지
   - sse-parser: Anthropic redacted_thinking, parseGeminiSSELine
   - auto-updater: validateAndInstall 메타데이터 파싱
   - sanitize, slot-inference, key-pool, settings-backup

2. **coverage-boost-round2.test.js** (82 tests)
   - helpers: _stripNonSerializable 엣지 케이스 (Date/RegExp/Error/BigInt/Symbol)
   - helpers: smartFetch/streamingFetch JSON 파싱 실패, risuFetch 폴백 경로
   - message-format: 멀티모달 병합, image_url data URI, Gemini thought 스트리핑
   - sse-parser: Anthropic SSE 스트림 (thinking/redacted_thinking/error/usage)
   - auto-updater: validateAndInstall (@arg/@link/@api 파싱, 다운그레이드 차단)

3. **coverage-boost-msgfmt.test.js** (11 tests)
   - OpenAI webm 오디오, Anthropic 콘텐츠 배열 병합, Gemini thought strip

### 3.4 커버리지 개선 한계
잔여 미커버 코드(~5.5% Stmts):
- **helpers.js** (84.96%): `checkStreamCapability` MessageChannel 테스트 불가, `smartFetch` 일부 폴백 경로
- **message-format.js** (87.85%): 방어적 데드 코드 (prev.content가 항상 배열이므로 string 분기 도달 불가)
- **auto-updater.js** (89.88%): 네트워크 통합 경로, nativeFetch→risuFetch 폴백
- **sse-parser.js** (90.04%): SSE 스트림 cancel/error 내부 핸들러

---

## 4. 빌드 상태

```
Rollup Build: 12/12 IIFE 번들 생성 ✅
Lint: 0 errors, 53 warnings
TypeScript: 228 pre-existing errors (JSDoc 기반, 기존 이슈)
Tests: 51 files, 1740 tests ALL PASSING ✅
```

---

## 5. 파일 구조

```
cupcake-provider-v4_IPC/
├── src/
│   ├── manager/
│   │   └── index.js          # 매니저 (3875줄) - IPC 허브
│   ├── providers/
│   │   ├── anthropic.js       # Claude 프로바이더
│   │   ├── aws.js             # AWS Bedrock
│   │   ├── deepseek.js        # DeepSeek
│   │   ├── gemini.js          # Google Gemini
│   │   ├── openai.js          # OpenAI/GitHub Copilot
│   │   ├── openrouter.js      # OpenRouter
│   │   └── vertex.js          # Google Vertex AI
│   └── shared/
│       ├── ipc-protocol.js    # IPC 프로토콜 + setupChannelCleanup
│       ├── helpers.js         # Fetch, 직렬화, 유틸리티
│       ├── message-format.js  # OpenAI/Anthropic/Gemini 포맷 변환
│       ├── sse-parser.js      # SSE 스트리밍 파서
│       ├── auto-updater.js    # 자동 업데이트 (SHA-256 검증)
│       ├── sanitize.js        # 메시지 정화, extractNormalizedMessagePayload
│       └── ... (15개 추가 공유 모듈)
├── tests/                     # 51 test files, 1740 tests
├── rollup.config.js           # 12 IIFE 번들 빌드
└── package.json               # vitest, eslint, rollup
```

---

## 6. 알려진 이슈 및 권장사항

### 즉시 조치 필요
1. **setDatabaseLite 보안**: `allowedDbKeys`에서 `plugins`, `guiHTML`, `customCSS` 제거 또는 별도 검증 추가 권장
2. **pluginChannel.delete()**: RisuAI 본체에 플러그인 언로드 시 채널 키 정리 로직 추가 필요

### 모니터링
3. **TypeScript 228 errors**: JSDoc 기반 타입 오류 — 점진적 수정 권장
4. **ESLint 53 warnings**: 대부분 unused variables — 코드 정리 시 해결
5. **auto-updater nativeFetch 폴백**: 네트워크 오류 시 risuFetch 폴백 경로 모니터링

---

*이 보고서는 전체 마이그레이션, 보안 분석, 메모리 누수 수정, 커버리지 부스트 작업의 최종 요약입니다.*
