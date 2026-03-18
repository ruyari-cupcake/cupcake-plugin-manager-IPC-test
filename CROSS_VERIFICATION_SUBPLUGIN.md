# 서브 플러그인 자동 업데이트 — 교차검증 보고서

**날짜**: 2026-03-18  
**대상**: `auto-updater.js` 서브 플러그인 인프라 (Phase 1+2 + ON/OFF 토글)  
**테스트 기준**: 2506 tests / 63 files / all passing

---

## 1. DB Corruption 방지

### 1.1 순차 큐 (`runSequentialSubPluginUpdates`)
| 항목 | 검증 결과 |
|------|----------|
| 직렬 실행 보장 | ✅ `_subUpdateQueueInFlight` 프로미스로 동시 실행 방지 |
| 중복 큐 방지 | ✅ 이미 큐 실행 중이면 `await`으로 대기 후 진행 |
| 업데이트 간 딜레이 | ✅ 성공 시 1000ms 대기 (autosave settling) |
| 실패 시 계속 진행 | ✅ 한 서브 플러그인 실패해도 나머지 계속 처리 |
| 결과 리포트 | ✅ `{total, success, failed, results}` 반환 |

### 1.2 TOCTOU 보호 (`validateAndInstallSubPlugin`)
| 항목 | 검증 결과 |
|------|----------|
| DB 이중 조회 | ✅ 1차 `getDatabase`(상태 확인) → 2차 `getDatabase`(재검증) |
| 동시 업데이트 감지 | ✅ `freshPlugin.versionOfPlugin !== currentInstalledVersion` 체크 |
| 다운그레이드 차단 | ✅ `compareVersions` 결과 < 0이면 거부 |
| 같은 버전 차단 | ✅ `compareVersions` 결과 === 0이면 거부 |
| fresh DB index 재탐색 | ✅ 2차 DB에서 `findIndex` 재실행, 없으면 거부 |

### 1.3 `safeSetDatabaseLite` 안전 계층
| 항목 | 검증 결과 |
|------|----------|
| 플러그인 배열 검증 | ✅ `validatePlugin()` — version, name, script 등 확인 |
| URL 보안 검증 | ✅ HTTPS only + 길이 2048자 제한 |
| write 실패 시 롤백 | ✅ `{ok: false, error}` 반환, DB 미수정 |

---

## 2. SHA-256 무결성 검증

| 항목 | 검증 결과 |
|------|----------|
| 다운로드 코드 해시 검증 | ✅ `safeSubPluginUpdate`에서 `computeSHA256(bundledCode) !== sha256` 시 거부 |
| 해시 없을 때 처리 | ✅ `sha256` 미제공 시에도 나머지 검증 (이름, 버전, API) 정상 수행 |
| 메인 플러그인 동일 적용 | ✅ `downloadMainPluginCode`에서도 동일한 SHA-256 검증 |

---

## 3. 코드 파싱 안전성

| 헤더 | 파싱 방식 | 검증 |
|------|----------|------|
| `@name` | 정규식 매칭 → 공백→언더스코어 변환 후 DB 비교 | ✅ |
| `@version` | 정규식 매칭 → expectedVersion과 비교 | ✅ |
| `@api` | 정규식 매칭 → 3.0만 허용 | ✅ |
| `@arg` / `@risu-arg` | V3 메타데이터 템플릿(`{{label::...}}`) 파싱 | ✅ |
| `@link` | URL + 설명 분리 파싱 | ✅ |
| `@display-name` | 선택적 파싱, 없으면 name 사용 | ✅ |
| `@update-url` | 파싱 후 기존 URL 보존 우선 | ✅ |

---

## 4. Per-Plugin ON/OFF 토글

| 항목 | 구현 | 검증 |
|------|------|------|
| 저장 키 | `cpm_sub_autoupdate_{name}` (pluginStorage) | ✅ |
| 기본값 | `true` (ON) — 메인 토글이 전역 차단 역할 | ✅ |
| 비활성 판정 | `'false'`, `'0'`, `'off'`, `'no'` → disabled | ✅ |
| 에러 시 기본값 | storage 에러 → `true` (ON) | ✅ |
| 공백 이름 처리 | `name.replace(/\s+/g, '_')` 정규화 | ✅ |
| 전체 조회 | `getSubPluginToggleStates()` → DB 내 모든 서브 플러그인 상태 | ✅ |
| 메인 플러그인 제외 | `pluginName` / `DB_PLUGIN_NAME` 필터링 | ✅ |
| checkVersionsQuiet 필터링 | 비활성 서브 플러그인은 `runSequentialSubPluginUpdates`에서 제외 | ✅ |

---

## 5. 업데이트 흐름 전체 검증

```
checkVersionsQuiet()
  ├── _isAutoUpdateEnabled() → false면 전체 중단
  ├── 쿨다운 체크 (VERSION_CHECK_COOLDOWN)
  ├── 매니페스트 fetch + 파싱
  ├── 메인 플러그인 업데이트 처리
  └── _checkSubPluginVersions(manifest)
       ├── DB 조회 → 설치된 플러그인과 매니페스트 비교
       ├── 미설치 플러그인 스킵
       └── 업데이트 필요한 항목 반환
            ├── _lastSubPluginUpdates에 저장 (전체 감지 결과)
            ├── isSubPluginAutoUpdateEnabled() 필터링
            │   └── 비활성 플러그인 로그 출력 후 제외
            └── runSequentialSubPluginUpdates(enabledUpdates)
                 └── 각 서브플러그인에 대해:
                      ├── safeSubPluginUpdate()
                      │   ├── 번들 다운로드 + 파싱
                      │   ├── SHA-256 검증
                      │   └── validateAndInstallSubPlugin()
                      │        ├── 코드 헤더 파싱
                      │        ├── TOCTOU 재검증
                      │        ├── realArg 보존
                      │        └── safeSetDatabaseLite 쓰기
                      └── 1000ms 대기 (autosave settling)
```

---

## 6. 에지 케이스 커버리지

| 시나리오 | 테스트 | 결과 |
|----------|--------|------|
| DB에 plugins 배열 없음 | `_checkSubPluginVersions` | ✅ 빈 배열 반환 |
| DB getDatabase 에러 | `_checkSubPluginVersions` | ✅ 빈 배열 반환 |
| 매니페스트에 version 없는 항목 | `_checkSubPluginVersions` | ✅ 스킵 |
| 동시 큐 실행 방지 | `runSequentialSubPluginUpdates` | ✅ dedup |
| 번들에 파일 없음 | `safeSubPluginUpdate` | ✅ 에러 반환 |
| 빈 업데이트 배열 | `runSequentialSubPluginUpdates` | ✅ 즉시 완료 |
| 서브 플러그인 코드에 @name 없음 | `validateAndInstallSubPlugin` | ✅ 거부 |
| 이름 불일치 | `validateAndInstallSubPlugin` | ✅ 거부 |
| DB 쓰기 실패 | `validateAndInstallSubPlugin` | ✅ `{ok: false}` |
| TOCTOU 동시 업데이트 | `validateAndInstallSubPlugin` | ✅ 감지 후 거부 |
| TOCTOU 플러그인 삭제됨 | `validateAndInstallSubPlugin` | ✅ 감지 후 거부 |

---

## 7. 결론

- **DB Corruption 위험**: ✅ 순차 큐 + TOCTOU + safeSetDatabaseLite 3중 보호
- **무결성 검증**: ✅ SHA-256 + 이름/버전/API 검증
- **사용자 제어**: ✅ 전역 ON/OFF (메인) + 개별 ON/OFF (서브 플러그인)
- **테스트 커버리지**: 41개 서브 플러그인 전용 테스트 (toggle 10개 포함)
- **총 테스트**: 2506 tests / 63 files / all passing
