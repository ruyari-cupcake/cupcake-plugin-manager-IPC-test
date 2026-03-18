# 서브 플러그인 자동 업데이트 기능 추가 — 실현 가능성 보고서

> **작성일**: 2025-06-12  
> **범위**: CPM (Cupcake Provider Manager) 서브 플러그인 자동 업데이트  
> **교차검증 대상**: RisuAI-main 오픈소스 (plugins.svelte.ts, v3.svelte.ts, database.svelte.ts)

---

## 1. 현재 상태 요약

### 1.1 CPM 아키텍처
| 구성요소 | 설명 |
|---------|------|
| **Manager** (`Cupcake Provider Manager`) | 메인 플러그인. auto-updater 내장 |
| **Sub-plugins** (7+ 플러그인) | CPM Provider - Anthropic, OpenAI, Gemini, Vertex, AWS, DeepSeek, OpenRouter, CPM Copilot, Chat Resizer, Chat Navigation, Translation Cache |
| **IPC** | `postPluginChannelMessage` / `addPluginChannelListener`로 통신 |

### 1.2 현재 자동 업데이트 범위
- ✅ **메인 플러그인** (Manager) → `auto-updater.js`로 자동 업데이트 가능
- ❌ **서브 플러그인** → 수동 업데이트만 가능

---

## 2. RisuAI 플러그인 API 교차검증

### 2.1 RisuAI의 플러그인 업데이트 메커니즘

**`checkPluginUpdate(plugin)`** — plugins.svelte.ts L65-102:
- `updateURL`에서 Range 헤더(`bytes=0-512`)로 첫 512바이트만 가져옴
- `//@version` 태그를 파싱하여 버전 비교
- ❌ **RisuAI가 자동으로 호출하지 않음** — UI에서 사용자가 수동 클릭해야 함

**`updatePlugin(plugin)`** — plugins.svelte.ts L108-120:
- `updateURL`에서 전체 코드 다운로드
- `importPlugin(code, { isUpdate: true, originalPluginName: plugin.name })` 호출
- ✅ 완전한 업데이트 파이프라인 (파싱 → 검증 → DB 교체)

### 2.2 V3 플러그인의 DB 접근 권한

**allowedDbKeys** (plugins.svelte.ts L464-490):
```
✅ 'plugins'              → 다른 플러그인 목록 접근 가능
✅ 'pluginCustomStorage'  → 커스텀 저장소 접근 가능
```

**접근 흐름**:
1. `getDatabase(['plugins'])` → 사용자 동의 필수 (3일마다 재확인)
2. 반환값은 `$state.snapshot()` (깊은 복사) — 원본 DB에 직접 영향 없음
3. `setDatabaseLite(db)` → plugins 배열 수정 가능

### 2.3 importPlugin() 내부 로직 — 핵심 발견

```
importPlugin(code, { isUpdate: true, originalPluginName }) 호출 시:
  1. 코드 헤더 파싱 (@name, @version, @api, @arg, @update-url)
  2. updateURL 있으면 @version 필수 (512바이트 내에 위치해야 함)
  3. HTTPS 프로토콜 검증
  4. 기존 플러그인 검색 (name 기준)
  5. ⚠️ 사용자 확인 다이얼로그: "기존 플러그인을 덮어쓸까요?"
  6. DB 교체 + 플러그인 재로드
```

> ⚠️ **핵심 제약**: `isUpdate: true + originalPluginName` 전달 시에도 **사용자 확인 다이얼로그**가 표시됨 (L420-422). 이건 RisuAI UI 레벨 코드이므로 V3 플러그인이 우회 불가.

---

## 3. CPM이 할 수 있는 것 vs 할 수 없는 것

### 3.1 ✅ 가능한 것 (CPM 레벨)

| 기능 | 방법 | 난이도 |
|------|------|--------|
| 서브 플러그인 버전 확인 | `getDatabase(['plugins'])`로 설치된 서브 플러그인 목록 + 버전 읽기 | 쉬움 |
| 원격 버전 매니페스트 확인 | 기존 `versions.json`에 서브 플러그인 항목 추가 | 쉬움 |
| 업데이트 가능 알림 UI | 토스트/배지로 "N개 서브 플러그인 업데이트 가능" 표시 | 중간 |
| 서브 플러그인 코드 다운로드 | `nativeFetch` / `risuFetch`로 새 코드 가져오기 | 쉬움 |
| SHA-256 무결성 검증 | 기존 `computeSHA256` 재사용 | 쉬움 |
| DB 직접 교체 (plugins 배열) | `getDatabase` → plugins[idx] 교체 → `setDatabaseLite` | 가능하지만 위험 |
| IPC로 서브에 업데이트 알림 | `postPluginChannelMessage`로 각 서브에 메시지 전송 | 중간 |

### 3.2 ❌ 불가능한 것 (RisuAI 변경 필요)

| 기능 | 이유 | 대안 |
|------|------|------|
| **조용한 자동 설치** (사용자 확인 없이) | `importPlugin()`이 항상 사용자 확인 요청 (L420-422) | DB 직접 교체로 우회 가능하지만 `loadPlugins()` 재호출 불가 |
| **플러그인 재로드** | `loadPlugins()`는 V3 API 미노출. import 후 자동 호출됨 | 페이지 새로고침 유도 (새 코드는 DB에 저장, 다음 로드 시 반영) |
| **능동적 업데이트 트리거** | V3 API에 `importPlugin()` 직접 호출 방법 없음 | `setDatabaseLite`로 script 필드 교체 |
| **사용자 동의 스킵** | `getDatabase` 호출 시 3일마다 동의 재확인 | CPM이 이미 DB 접근 동의 받으면 유지됨 |

---

## 4. 구현 전략 제안

### 4.1 Phase 1 — 업데이트 확인 + 알림 (CPM만으로 완전 구현 가능)

```
[버전 매니페스트 확장]
  기존 versions.json:
    { "Cupcake Provider Manager": { "version": "2.0.5", ...} }

  확장 후:
    {
      "Cupcake Provider Manager": { "version": "2.0.5", ... },
      "CPM Provider - Anthropic": { "version": "2.0.1", "file": "cpm-provider-anthropic.js", "sha256": "..." },
      "CPM Provider - OpenAI": { "version": "2.0.1", "file": "cpm-provider-openai.js", "sha256": "..." },
      ...
    }

[확인 흐름]
  1. checkVersionsQuiet() 실행 시 매니페스트에서 모든 플러그인 버전 확인
  2. getDatabase(['plugins'])로 현재 설치된 서브 플러그인 버전 비교
  3. 업데이트 가능한 항목이 있으면 토스트 알림 표시
  4. 사용자가 "업데이트" 클릭 → Phase 2 실행
```

**구현 난이도**: 쉬움 (auto-updater.js 확장 + 매니페스트 서버 수정)

### 4.2 Phase 2 — DB 직접 교체 방식 (CPM만으로 가능, 제한 있음)

```
[업데이트 실행 흐름]
  1. 서브 플러그인 코드 다운로드 (nativeFetch)
  2. SHA-256 해시 검증
  3. 헤더 파싱 (이름, 버전, API 버전 확인)
  4. getDatabase(['plugins']) → 기존 서브 플러그인 찾기
  5. plugins[idx].script = newCode, plugins[idx].versionOfPlugin = newVersion
  6. setDatabaseLite({ plugins }) → DB에 저장
  7. ⚠️ loadPlugins()는 호출 불가 → "업데이트 완료. 효과 적용을 위해 페이지 새로고침이 필요합니다." 토스트 표시
```

**핵심 제약**: 
- `setDatabaseLite`로 `plugins[].script`를 교체하면 DB에는 저장되지만, **실행 중인 플러그인 인스턴스는 갱신되지 않음**
- RisuAI가 `loadPlugins()`를 재호출해야 새 코드가 실행됨
- 페이지 새로고침이 필요함 (RisuAI가 부팅 시 DB에서 플러그인 로드)

**구현 난이도**: 중간 (기존 validateAndInstall 로직 재사용 가능)

### 4.3 Phase 3 — RisuAI 연동 (RisuAI 변경 필요)

이 단계는 **우리가 할 수 없는** RisuAI 차원의 변경:

| 필요 변경 | 설명 |
|----------|------|
| `importPlugin()` silent 모드 | 사용자 확인 없이 업데이트 허용하는 옵션 추가 |
| `loadPlugins()` V3 API 노출 | 플러그인이 다른 플러그인을 재로드할 수 있게 |
| 자동 업데이트 설정 UI | RisuAI 플러그인 설정에 "자동 업데이트 허용" 체크박스 |
| Range 헤더 지원 강화 | 서버 측에서 Range 요청 지원 |

---

## 5. 위험 분석

### 5.1 DB 직접 교체 방식의 위험

| 위험 | 심각도 | 완화 방안 |
|------|--------|----------|
| 잘못된 코드 주입 | 높음 | SHA-256 해시 검증 필수 |
| 다른 플러그인 데이터 손상 | 높음 | `plugins` 키만 수정, 기존 realArg 보존 |
| DB 동시 쓰기 충돌 | 중간 | safe-db-writer 재사용 |
| 실행 중 코드 불일치 | 중간 | "새로고침 필요" 안내 |
| 사용자 동의 3일 만료 | 낮음 | CPM이 이미 DB 접근 동의 받으면 유지 |

### 5.2 보안 고려사항

- 서브 플러그인 코드도 반드시 **HTTPS + SHA-256** 검증
- 매니페스트 자체의 무결성 (HTTPS 전송)
- 서브 플러그인이 `@name` 변경 시 기존 플러그인 겹침 위험

---

## 6. 권장 사항

### 즉시 구현 가능 (Phase 1)
1. **매니페스트 확장**: `versions.json`에 서브 플러그인 버전 + sha256 추가
2. **버전 체크 확장**: `checkVersionsQuiet()`에서 서브 플러그인 버전도 비교
3. **업데이트 알림**: "N개 서브 플러그인 업데이트 가능" 토스트

### 신중하게 접근 (Phase 2)
4. **DB 직접 교체**: `setDatabaseLite`로 script 필드 교체 (새로고침 필요 안내)
5. **realArg 보존**: 메인 플러그인과 동일한 설정 병합 로직 적용

### RisuAI 협업 필요 (Phase 3) — 우리가 할 수 없는 부분
6. `importPlugin()` silent 업데이트 모드 PR 제안
7. `loadPlugins()` V3 API 노출 논의

---

## 7. 결론

**Phase 1 (알림) + Phase 2 (DB 교체)는 CPM 내에서 완전히 구현 가능합니다.**

가장 큰 제약은 `loadPlugins()` 미노출로 인해 **업데이트 후 페이지 새로고침이 필요**하다는 점입니다. 이는 사용자 경험에 약간의 마찰을 주지만, 메인 플러그인 업데이트와 동일한 패턴이므로 수용 가능합니다.

Phase 1만으로도 "업데이트 가능 알림" 기능은 상당한 가치를 제공합니다. 사용자가 알림을 보고 RisuAI의 기존 플러그인 관리 UI에서 수동 업데이트할 수 있기 때문입니다.
