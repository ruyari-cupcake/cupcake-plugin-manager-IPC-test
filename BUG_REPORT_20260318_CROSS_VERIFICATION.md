# CPM ↔ RisuAI 교차검증 & 버그 리포트

**Date:** 2026-03-18  
**Scope:** CPM IPC Plugin (`src/shared/`) vs RisuAI Main (`Risuai-main/`)  
**Commit Base:** `466f16d` + Phase 4 Settings Tab + Coverage Push  

---

## 이번 라운드 작업 요약

### 1. 브랜치 커버리지 90% 추진
- **전체**: 87.32% → **87.66%** (2650 → 2670 tests, 67 files)
- **key-pool.js**: 87.09% → **90.32%** ✅ (콤마 구분 JSON, withRotation 옵션)
- **sub-plugin-toggle-ui.js**: 88.46% → **96.15%** ✅ (click handler re-render)
- **auto-updater.js**: 81.53% → **82.18%** (20 tests: readPendingUpdate, writePendingUpdate, clearPendingUpdate, getInstalledVersion, downloadMainPluginCode, validateAndInstall, safeMainPluginUpdate, checkVersionsQuiet)
- 20/25 모듈이 90% 이상 달성
- 나머지 5개 모듈은 구조적 한계 (dead code, deep integration, v8 vs Istanbul 차이)

### 2. Sub-plugin Phase 4: Settings Tab 통합
- `createSubPluginToggleUI` import 추가 (manager/index.js)
- 사이드바 Features 섹션에 `🧩 서브 플러그인` 탭 버튼 추가
- `tab-subplugins` 콘텐츠 패널 구현:
  - AutoUpdater.getSubPluginToggleStates() 로 현재 상태 로딩
  - 각 서브 플러그인별 토글 스위치 (emerald/gray 색상)
  - 클릭 핸들러 → AutoUpdater.setSubPluginAutoUpdateEnabled() 호출 → 패널 리렌더링
  - 새로고침 버튼
- 빌드 검증: manager 번들에 tab-subplugins 관련 코드 확인됨

### 3. Rollup 빌드 검증
- 12개 IIFE 번들 전부 성공
- Manager 번들: 535KB (sub-plugin-toggle-ui 포함)
- 2670 tests 전부 통과

---

## 교차검증 결과

### CRITICAL Issues: 0건
치명적 버그 발견 없음.

### WARNING Issues: 4건

#### W-1: `<Thoughts>` 태그 공백 불일치 (코스메틱)
| | CPM | RisuAI |
|---|---|---|
| 여는 태그 | `<Thoughts>\n\n` (이중 줄바꿈) | `<Thoughts>\n` (단일 줄바꿈) |
| 닫는 태그 | `\n</Thoughts>\n\n` | `</Thoughts>\n` (OpenAI) |

- **위치**: sse-parser.js (10개소)
- **영향**: RisuAI 파서는 regex `/<Thoughts>(.+?)<\/Thoughts>/gms`로 처리하므로 기능 영향 없음
- **비고**: Thoughts 블록 내부에 빈 줄 하나가 더 표시됨. 일관성을 위해 향후 `<Thoughts>\n`으로 통일 권장
- **심각도**: LOW — 순수 코스메틱

#### W-2: `setDatabaseLite` 주석 부정확
- **위치**: safe-db-writer.js
- **내용**: 주석에 "setDatabaseLite는 유효성 검증이 전혀 없다"고 기술하지만, 실제 V3 API의 setDatabaseLite는 `allowedDbKeys` 체크 후 merge 동작
- **영향**: 코드 자체는 정상 — CPM의 추가 검증은 오히려 더 안전한 방어적 코딩
- **심각도**: LOW — 동작 영향 없음, 주석만 부정확

#### W-3: 플러그인 이름 언더스코어 변환 불필요
- **위치**: auto-updater.js L166 — `DB_PLUGIN_NAME = pluginName.replace(/\s+/g, '_')`
- **내용**: RisuAI DB는 플러그인 이름을 공백 포함 그대로 저장함. 언더스코어 변환은 불필요한 fallback
- **영향**: 양쪽 이름 모두 검색하므로 버그는 아니지만 dead logic
- **심각도**: LOW

#### W-4: setDatabaseLite → handlePluginInstallViaPlugin 보안 게이트 우회
- **위치**: safe-db-writer.js → setDatabaseLite 사용
- **내용**: RisuAI의 setDatabase는 plugins 키 변경 시 사용자 확인 다이얼로그를 표시하지만, setDatabaseLite는 이를 건너뜀
- **영향**: CPM auto-updater가 사일런트 설치 가능 (의도적 설계)
- **비고**: CPM은 자체 검증(safe-db-writer) + SHA-256 + 크기 검증으로 보안 보장
- **심각도**: INFO — by design

### INFO Notes: 7건

1. **Anthropic 시스템 프롬프트**: CPM ↔ RisuAI 동일 동작 ✅
2. **Gemini non-leading system**: 사소한 차이 (`system: ` vs `system:` — 공백 하나), 기능 영향 없음
3. **OpenAI DeveloperRole**: 동일 동작 ✅
4. **Version Range Header**: CPM //@version이 항상 상단에 위치하므로 호환 ✅
5. **Copilot 토큰**: CPM 전용 기능, RisuAI에 없음 — 충돌 없음
6. **IPC Channel**: `addPluginChannelListener` + `postPluginChannelMessage` 완벽 호환 ✅
7. **Responses API**: CPM 전용 GPT-5.4+ 지원, RisuAI에 없음 — 추가 기능

### Confirmed Compatible: 12건
| 영역 | 상태 |
|------|------|
| risuFetch / nativeFetch | ✅ |
| pluginStorage API | ✅ |
| ReadableStream 스트리밍 | ✅ |
| 플러그인 헤더 regex | ✅ |
| safe-db-writer 검증 | ✅ |
| 버전 비교 | ✅ |
| AbortSignal | ✅ |
| Anthropic delta types | ✅ |
| Gemini safety block reasons | ✅ |
| SHA-256 무결성 | ✅ |
| TOCTOU 보호 | ✅ |
| addProvider return type | ✅ |

---

## 커버리지 현황 (최종)

| 모듈 | Branch% | 상태 |
|-------|---------|------|
| key-pool | 90.32% | ✅ |
| sub-plugin-toggle-ui | 96.15% | ✅ |
| slot-inference | 100% | ✅ |
| model-helpers | 100% | ✅ |
| schema | 100% | ✅ |
| api-request-log | 100% | ✅ |
| copilot-headers | 100% | ✅ |
| copilot-token | 97.56% | ✅ |
| ipc-protocol | 96.42% | ✅ |
| gemini-helpers | 98.5% | ✅ |
| aws-signer | 94.07% | ✅ |
| companion-installer | 94% | ✅ |
| dynamic-models | 92.7% | ✅ |
| custom-model-serialization | 91.01% | ✅ |
| safe-db-writer | 91.48% | ✅ |
| sanitize | 93.44% | ✅ |
| settings-backup | 93.65% | ✅ |
| token-toast | 90.9% | ✅ |
| token-usage | 96.87% | ✅ |
| update-toast | 96.66% | ✅ |
| **auto-updater** | **82.18%** | ⚠️ |
| **message-format** | **78.67%** | ⚠️ |
| **helpers** | **82.67%** | ⚠️ |
| **endpoints** | **85.71%** | ⚠️ |
| **sse-parser** | **87.63%** | ⚠️ |

**전체**: 94.67% stmts / **87.66% branch** / 96.87% funcs / 96.58% lines  
**테스트**: 2670 passed / 67 files / 0 failures

---

## 향후 개선 사항
1. `<Thoughts>\n\n` → `<Thoughts>\n` 통일 (10개소 + 관련 테스트 assertion 업데이트)
2. safe-db-writer.js 주석을 실제 V3 setDatabaseLite 동작에 맞게 업데이트
3. message-format.js 나머지 브랜치 (dead code paths 정리 또는 테스트)
4. sse-parser.js 87.63% → 90% 추가 푸시 (Responses API + createSSEStream abort paths)
