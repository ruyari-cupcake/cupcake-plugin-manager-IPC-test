# Cupcake Provider Manager (CPM) v2.0.0

> RisuAI V3 Plugin Channel IPC 기반 AI 프로바이더 허브

[![Tests](https://img.shields.io/badge/tests-3109%20passed-brightgreen)](#테스트)
[![Coverage](https://img.shields.io/badge/branch%20coverage-90.7%25-brightgreen)](#커버리지)
[![TypeScript](https://img.shields.io/badge/TS%20errors-0-blue)](#타입-체크)
[![ESLint](https://img.shields.io/badge/ESLint-0%20errors-blue)](#린트--포맷)

## 아키텍처

```
┌─────────────────────────────────────────────────────┐
│  RisuAI V3 Host (Svelte)                            │
│  ┌───────────────────────────────────────────────┐  │
│  │  Plugin Channel API                           │  │
│  │  postPluginChannelMessage / addListener       │  │
│  └─────┬──────────┬──────────┬──────────┬────────┘  │
│        │          │          │          │            │
│   ┌────▼────┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐       │
│   │ Manager │ │OpenAI │ │Claude │ │Gemini │ ...    │
│   │ (허브)  │ │Provider│ │Provider│ │Provider│       │
│   └────┬────┘ └───────┘ └───────┘ └───────┘       │
│        │  IPC: fetch-request / response / abort     │
│        └────────────────────────────────────────    │
└─────────────────────────────────────────────────────┘
```

**구성:**
- **Manager** (`src/manager/index.js`) — 설정 UI, 모델 등록, 요청 라우팅
- **Providers** (`src/providers/`) — OpenAI, Anthropic, Gemini, Vertex AI, AWS Bedrock, DeepSeek, OpenRouter
- **Features** (`src/features/`) — Copilot Manager, Translation Cache, Chat Resizer, Navigation
- **Shared** (`src/shared/`) — 메시지 포맷, SSE 파서, 키 풀, IPC 프로토콜, 헬퍼

## 시작하기

```bash
# 의존성 설치
npm install

# 빌드 (dist/ 에 12개 IIFE 번들 생성)
npm run build

# 감시 모드 빌드
npm run build:watch
```

## 개발

### 테스트

```bash
# 전체 테스트
npm test

# 감시 모드
npm run test:watch

# 커버리지 보고서
npm run test:coverage
```

**커버리지 현황 (v8):**

| 모듈 | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| **All files** | 96.04% | **90.70%** | 97.18% | 97.68% |
| auto-updater.js | 98.07% | 91.33% | 100% | 98.20% |
| message-format.js | 90.28% | 83.82% | 100% | 92.70% |
| sse-parser.js | 97.15% | 90.02% | 100% | 97.71% |
| helpers.js | 86.71% | 84.15% | 86.48% | 93.67% |

### 린트 & 포맷

```bash
# ESLint 검사
npm run lint

# 자동 수정
npm run lint:fix

# Prettier 포맷
npm run format

# 포맷 검사 (CI용)
npm run format:check
```

### 타입 체크

```bash
# JSDoc 기반 TypeScript 타입 검사
npm run typecheck
```

### 전체 CI 파이프라인 (로컬)

```bash
npm run ci
```

## 프로젝트 구조

```
src/
├── shared/                  # 공유 유틸리티 (모든 플러그인에 인라인)
│   ├── types.d.ts           # TypeScript 타입 정의
│   ├── ipc-protocol.js      # IPC 채널/메시지 상수, 등록 로직
│   ├── message-format.js    # OpenAI/Anthropic/Gemini 메시지 변환
│   ├── sse-parser.js        # SSE 스트리밍 파서 (3 프로바이더)
│   ├── sanitize.js          # 메시지 정화, 태그 제거
│   ├── key-pool.js          # API 키 로테이션 풀
│   ├── gemini-helpers.js    # Gemini 전용 유틸리티
│   ├── helpers.js           # smartFetch, streamingFetch, 범용 헬퍼
│   ├── aws-signer.js        # AWS V4 서명
│   ├── safe-db-writer.js    # setDatabaseLite 보안 래퍼
│   ├── auto-updater.js      # 메인 플러그인 자동 업데이트
│   ├── companion-installer.js # 서브플러그인 설치
│   ├── token-toast.js       # 토큰 사용량 토스트
│   └── settings-backup.js   # 설정 백업/복원
├── manager/
│   └── index.js             # 매니저 허브 (설정 UI + IPC 라우터)
├── providers/
│   ├── anthropic.js         # Claude 프로바이더
│   ├── openai.js            # OpenAI/GPT 프로바이더
│   ├── gemini.js            # Google Gemini 프로바이더
│   ├── vertex.js            # Vertex AI 프로바이더
│   ├── aws.js               # AWS Bedrock 프로바이더
│   ├── deepseek.js          # DeepSeek 프로바이더
│   └── openrouter.js        # OpenRouter 프로바이더
└── features/
    ├── copilot.js            # GitHub Copilot 토큰 관리
    ├── transcache.js         # 번역 캐시
    ├── resizer.js            # 채팅 리사이저
    └── navigation.js         # 채팅 네비게이션

tests/                        # Vitest 테스트 (70+ 파일, 3109 테스트)
├── *.test.js                 # 유닛 테스트
├── *.integration.test.js     # 통합 테스트
├── coverage-*.test.js        # 커버리지 푸시 테스트
├── safe-db-writer.test.js    # setDatabaseLite 보안 검증
└── security-integration.test.js  # 보안 통합 시나리오

dist/                         # Rollup IIFE 빌드 출력
```

## 빌드 시스템

**Rollup v4** — 각 진입점을 독립 IIFE 번들로 생성. `src/shared/` 모듈은 각 번들에 인라인됨 (런타임 의존성 없음).

| 번들 | 진입점 | 설명 |
|---|---|---|
| `cupcake-provider-manager.js` | `src/manager/index.js` | 매니저 허브 |
| `cpm-provider-*.js` | `src/providers/*.js` | 7개 프로바이더 |
| `cpm-*.js` | `src/features/*.js` | 4개 기능 모듈 |

## 새 프로바이더 추가

1. `src/providers/` 에 새 파일 생성 (예: `my-provider.js`)
2. `registerWithManager()` 로 매니저에 등록
3. `CH.FETCH` 리스너에서 요청 처리
4. `rollup.config.js` 에 진입점 추가

```javascript
// src/providers/my-provider.js
import { MANAGER_NAME, CH, MSG, safeUUID, getRisu } from '../shared/ipc-protocol.js';
import { registerWithManager } from '../shared/ipc-protocol.js';
import { smartFetch } from '../shared/helpers.js';

const Risu = getRisu();

Risu.addPluginChannelListener(CH.FETCH, async (msg) => {
    if (msg.type !== MSG.FETCH_REQUEST) return;
    try {
        const result = await myApiFetch(msg);
        Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
            type: MSG.RESPONSE, requestId: msg.requestId, ...result
        });
    } catch (e) {
        Risu.postPluginChannelMessage(MANAGER_NAME, CH.RESPONSE, {
            type: MSG.ERROR, requestId: msg.requestId,
            success: false, content: `[Error] ${e.message}`
        });
    }
});

await registerWithManager(Risu, 'My Provider', {
    name: 'my-provider',
    models: ['my-model-1', 'my-model-2'],
});
```

## CI/CD

GitHub Actions 워크플로우 (`.github/workflows/ci.yml`):
- **트리거:** push/PR to `main`, `dev`
- **매트릭스:** Node.js 20, 22
- **파이프라인:** lint → typecheck → test:coverage → build → verify

## 기술 스택

| 도구 | 버전 | 용도 |
|---|---|---|
| Rollup | 4.34 | IIFE 번들러 |
| Vitest | 4.x | 테스트 프레임워크 |
| ESLint | 9.x | 린터 (flat config) |
| Prettier | 3.x | 코드 포맷터 |
| TypeScript | 5.x | JSDoc 타입 체크 (checkJs) |

## 보안

### setDatabaseLite 보안 래퍼

RisuAI의 `setDatabaseLite`는 입력 검증 없이 DB에 직접 기록합니다. CPM은 `safe-db-writer.js`를 통해 다음을 방어합니다:

| 공격 벡터 | 방어 |
|-----------|------|
| `guiHTML` / `customCSS` 주입 (XSS) | **BLOCKED_KEYS**로 차단 |
| `characters` 배열 조작 | **BLOCKED_KEYS**로 차단 |
| 무단 플러그인 설치 | `plugins` 배열 내 각 플러그인 구조 검증 |
| http:// updateURL 변조 | https:// only 강제 |
| API 버전 변조 | `version === '3.0'` 필수 |

```javascript
import { safeSetDatabaseLite } from './shared/safe-db-writer.js';
const result = await safeSetDatabaseLite(Risu, { plugins: [...] });
if (!result.ok) console.error(result.error);
```

### pluginChannel 메모리 누수 대응

`setupChannelCleanup()`으로 플러그인 언로드 시 IPC 리스너를 no-op으로 교체합니다.
완전한 수정은 RisuAI 본체의 `unloadV3Plugin()`에 `pluginChannel.delete()` 추가가 필요합니다.

## 향후 계획

### 매니저 모듈 분할
`manager/index.js` (2,100+ LOC)를 다음과 같이 분할 예정:
- `manager/state.js` — 공유 상태, 상수
- `manager/copilot-helpers.js` — GitHub Copilot 토큰 관리
- `manager/request-handler.js` — handleRequest, handleCustomModel
- `manager/settings-ui.js` — openCpmSettings UI 함수
- `manager/model-registry.js` — 모델 등록/관리
- `manager/index.js` — 초기화 오케스트레이터

**전제조건:** 매니저 수준 통합 테스트 구축 후 안전하게 진행

### innerHTML → DOM API 전환
설정 UI의 `innerHTML` 사용을 `createElement` + `textContent` 기반으로 전환하여 XSS 위험 제거.
현재 `escAttr()`이 HTML 인젝션을 방지하고 있으므로 우선순위는 낮지만, 보안 심층 방어 관점에서 권장.

### Tailwind CSS 로컬 번들링
CDN 의존(`play.tailwindcss.com`)을 Tailwind CLI 로컬 빌드로 전환하여 오프라인 지원 및 CSP 호환성 개선.
