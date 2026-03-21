# CPM Migration Gap Report: _temp_repo → cupcake-provider-v4_IPC
> 작성일: 2025-03-20 | v2.0.3 기준

## 교차검증 결과 요약

### ✅ IPC에 이미 이관 완료된 기능

| 카테고리 | 기능 | IPC 상태 |
|----------|------|----------|
| Settings UI | Global 탭 (온도/토큰/TopP/Penalty/스트리밍/호환성) | ✅ 동일 |
| Settings UI | Aux Slots 4탭 (번역/감정/메모리/기타) | ✅ 동일 |
| Settings UI | Provider 동적 탭 | ✅ 동일 |
| Settings UI | Custom Models Manager | ✅ 동일 |
| Settings UI | Export/Import Settings | ✅ 동일 |
| Settings UI | Sidebar + 모바일 메뉴 | ✅ 동일 |
| Core | Router + handleRequest | ✅ IPC 아키텍처로 재구현 |
| Core | fetchCustom (3포맷 API 호출) | ✅ handleCustomModel()로 통합 |
| Core | Smart Fetch (3전략) | ✅ helpers.js |
| Core | Key Pool (키 회전) | ✅ key-pool.js |
| Core | AWS V4 Signer | ✅ aws-signer.js |
| Core | Vertex Auth (JWT/OAuth) | ✅ vertex-auth.js |
| Core | Copilot Token + Headers | ✅ copilot-token.js + copilot-headers.js |
| Core | SSE Parsers (전 프로바이더) | ✅ sse-parser.js |
| Core | Message Format (3포맷) | ✅ message-format.js |
| Core | Sanitize | ✅ sanitize.js |
| Core | Schema Validation | ✅ schema.js |
| Core | Settings Backup | ✅ settings-backup.js |
| Core | API Request Log | ✅ api-request-log.js |
| Core | Token Usage + Toast | ✅ token-usage.js + token-toast.js |
| Core | Model Helpers | ✅ model-helpers.js |
| Core | Dynamic Models | ✅ dynamic-models.js |
| Core | Slot Inference | ✅ slot-inference.js |
| Core | Custom Model Serialization | ✅ custom-model-serialization.js |
| Tool-Use | Layer 1 MCP Bridge | ✅ tool-mcp-bridge.js |
| Tool-Use | Layer 2 Loop | ✅ tool-loop.js |
| Tool-Use | Tool Definitions (5개) | ✅ tool-definitions.js |
| Tool-Use | Tool Executor | ✅ tool-executor.js |
| Tool-Use | Tool Parsers (3포맷) | ✅ tool-parsers.js |
| Tool-Use | Tool Config | ✅ tool-config.js |
| Tool-Use | Prefetch Search | ✅ prefetch-search.js |
| Provider | OpenAI/Anthropic/Gemini/Vertex/AWS/DeepSeek/OpenRouter | ✅ 7개 IPC 프로바이더 |
| Feature | Chat Navigation | ✅ navigation.js |
| Feature | Chat Resizer | ✅ resizer.js (v2.0.1에서 position:fixed 수정) |
| Feature | Translation Cache | ✅ transcache.js |
| Feature | Copilot Token Manager | ✅ copilot.js |
| Auto-Update | Main plugin auto-update | ✅ auto-updater.js + update-toast.js |
| Auto-Update | Sub-plugin version check | ✅ checkVersionsQuiet() |
| Auto-Update | Per-plugin auto-update toggle | ✅ sub-plugin-toggle-ui.js |
| Auto-Update | Sequential auto-apply | ✅ runSequentialSubPluginUpdates() |

### ❌ IPC에 없는 기능 (GAP)

| # | 기능 | 중요도 | 설명 |
|---|------|--------|------|
| **1** | **Tool Use 설정 UI 탭 (`tab-tools`)** | 🔴 HIGH | 17개 컨트롤: 마스터 토글, 개별 도구 5개 체크박스, 웹 검색 프로바이더/URL/키/CX, 프리페치 설정 5개, 고급 설정 2개. **백엔드 로직은 모두 이관 완료**이지만 UI가 없어 사용자가 설정 불가 |

### ✅ IPC에만 있는 기능 (temp_repo에 없음)

| # | 기능 | 설명 |
|---|------|------|
| 1 | `tab-copilot` 🔑 Copilot Token 관리 탭 | 전용 탭으로 분리 |
| 2 | `tab-subplugins` 🧩 개별 자동 업데이트 토글 | 플러그인별 ON/OFF |
| 3 | `tab-operations` 🧹 운영/복구 | CPM 데이터 퍼지 |
| 4 | `tab-diagnostics` 🔍 진단 | 시스템 전체 진단 + Export |
| 5 | `tab-apilog` 📡 API 요청 로그 | 최근 50개 요청 상세 |
| 6 | Global auto-update 마스터 토글 | 전역 + 개별 레벨 |
| 7 | `//@update-url` RisuAI 네이티브 업데이트 | v2.0.3에서 추가 |
| 8 | GitHub raw URL 엔드포인트 | Vercel API → GitHub raw |
| 9 | IPC 4채널 프로토콜 | control/response/fetch/abort |
| 10 | Companion Installer | 서브 플러그인 자동 설치 |

## 자동 업데이트 아키텍처 비교

### _temp_repo (non-IPC)
- 메인 자동업데이트: Vercel `/api/versions` 매니페스트 → 수동 체크/적용
- 서브플러그인: Toast 알림만 → 사용자 수동 클릭
- Global toggle: `cpm_disable_autoupdate` (반전 로직)
- `//@update-url`: 없음

### IPC-test (v2.0.3)
- 메인 자동업데이트: GitHub raw `update-bundle.json` → 자동 체크+적용
- 서브플러그인: 개별 토글 → 자동 다운로드+설치 (`runSequentialSubPluginUpdates`)
- Global toggle: `cpm_auto_update_enabled` (기본 ON, opt-out)
- Per-plugin toggle: `cpm_sub_autoupdate_{name}` (기본 ON)
- `//@update-url`: ✅ (v2.0.3에서 추가, RisuAI 네이티브 + 아이콘)
- 치킨에그 문제: v2.0.0 → v2.0.3은 수동 설치 필요 (한 번만)

## 구현 우선순위

1. 🔴 **Tool Use 설정 UI 탭 추가** — `tab-tools`. temp_repo의 settings-ui.js에서 Tool Use 섹션 참조하여 IPC index.js에 추가
