# 자동 업데이터 시스템 종합 분석 보고서

> **대상**: cupcake-provider-v4_IPC/src/shared/auto-updater.js + safe-db-writer.js  
> **교차검증**: Risuai-main (database.svelte.ts, plugins.ts)  
> **작성일**: 2025-06-11  
> **핵심 관심사**: DB 부하 문제 — 플러그인 다수 동시 업데이트 시 대용량 DB 사용자 영향

---

## 1. 자동 업데이트 흐름 전체 분석

### 1.1 `checkVersionsQuiet` — 버전 확인 프로세스

```
흐름:
  1. 설정된 쿨다운(10분)을 확인하여 재반복 호출 방지
  2. versionsUrl에서 버전 매니페스트 fetch (타임아웃: 15초)
  3. 매니페스트에서 pluginName 항목 추출
  4. compareVersions()로 현재 버전과 원격 버전 비교
  5. 업데이트 필요 시:
     - rememberPendingUpdate() 호출 (업데이트 마커 저장)
     - safeMainPluginUpdate() 시작
```

**특징:**
- Quiet 모드: 에러가 발생해도 사일런트 처리
- 플러그인스토리지에 마지막 확인 시간 저장
- 타임아웃 보호: 15초 제한

### 1.2 `checkMainPluginVersionQuiet` — JS 폴백 버전 확인

```
흐름:
  1. 매니페스트 경로 확인이 이미 완료되었는지 검사
  2. mainUpdateUrl에서 직접 JS 파일 fetch
  3. 코드의 //@version 태그 파싱 (처음 512바이트 내에서만)
  4. SHA-256 integrity 검증 (선택적: 버전 매니페스트에서 획득)
  5. 버전 비교 후 필요 시 validateAndInstall 직접 호출
```

**특징:**
- 매니페스트 방식 실패 시 폴백
- nativeFetch → risuFetch 우선순위 체인
- 부분 다운로드 (Range: bytes=0-512) 최적화

### 1.3 `downloadMainPluginCode` — 다운로드 프로세스

```
우선순위 전략:

┌─ 단계 1: Update Bundle (single source of truth)
│  ├─ updateBundleUrl 요청
│  ├─ JSON 파싱 및 스키마 검증
│  ├─ rawBundle.versions[pluginName] 추출
│  ├─ rawBundle.code[fileName]에서 코드 추출
│  ├─ SHA-256 검증 (필수)
│  └─ 성공 시 반환
│
├─ 단계 2: 폴백 SHA-256 수집 (버전 매니페스트)
│  ├─ versionsUrl fetch
│  └─ expected SHA-256 저장 → 폴백용
│
└─ 단계 3: 직접 다운로드 (최대 3회 재시도)
   ├─ nativeFetch 시도 (20초 타임아웃)
   ├─ nativeFetch 실패 시 risuFetch 폴백
   ├─ Response.text() 읽기 (20초 타임아웃)
   ├─ Content-Length 무결성 검증
   └─ 폴백 SHA-256 검증 (있을 경우)

재시도 정책:
  - 불완전한 다운로드 감지 (actual < expected)
  - 지수 백오프: 1s, 2s, 3s 대기
```

**핵심 발견:**
- Bundle 경로가 "같은 진실의 출처"
- 3계층 무결성 검증 (스키마 → Content-Length → SHA-256)
- ⚠️ 폴백 SHA 미확보 시 검증 없이 진행 (보안 주의)

### 1.4 `validateAndInstall` — 검증 + 설치 프로세스

```
단계별 검증 및 설치:

입력 검증:
  1. 코드 길이 확인 (< 100자 거부)
  2. 헤더 파싱:
     //@name, //@version, //@api, //@arg, //@link, //@update-url
  3. 메타데이터 추출:
     parseArgs, defaultRealArg, argMeta, customLink

정책 검증:
  1. 플러그인 이름 일치 (DB_PLUGIN_NAME 또는 pluginName)
  2. API 버전 확인 (반드시 3.0)
  3. 원격 버전과 다운로드 코드의 버전 일치 검증
  4. 다운그레이드 차단 (compareVersions < 0)
  5. 다운로드 완전성 검증 (95% 이상)

설정 보존:
  - 기존 realArg (사용자 설정)
  - 신규 버전의 arguments와 기존 realArg 병합

DB 저장:
  - updatedPlugin 객체 구성
  - db.plugins[existingIdx] 교체
  - safeSetDatabaseLite(Risu, { plugins: nextPlugins }) 호출
  - 3.5초 대기 (RisuAI autosave flush 대기)

사후 검증:
  - getDatabase() 재호출
  - 메모리상 버전 확인
  - cpm_last_main_update_flush 타임스탬프 저장
```

---

## 2. DB 저장 메커니즘 분석

### 2.1 RisuAI의 getDatabase/setDatabaseLite 동작 방식

#### `getDatabase()` 구현 (Risuai-main):

```typescript
export function getDatabase(options?: { snapshot?: boolean }): Database {
    if (options.snapshot) {
        return $state.snapshot(DBState.db) as Database
    }
    return DBState.db as Database  // ← 직접 참조 반환!
}
```

**동작 특징:**
- `$state.snapshot()` 미사용 시: DBState.db 객체 **직접 참조** 반환
- 메모리상 전체 DB 로드 (characters, pluginCustomStorage 등 포함)
- Svelte store 직접 접근 (반응성 유지)

#### `setDatabaseLite()` 구현 (Risuai-main):

```typescript
export function setDatabaseLite(data: Database) {
    DBState.db = data
}
```

**동작 특징:**
- DBState.db에 직접 할당
- 부분 업데이트가 아닌 **완전 교체**
- 함수 인자로 받은 data 객체 전체 설정

### 2.2 플러그인 스크립트가 DB에 저장되는 구조

```
DBState.db (전체 데이터베이스)
├── characters[]          (수십~수백 개, 각 1~5MB)
├── plugins[]             (플러그인 배열)
│   ├── [0] { name, script: "... 전체 JS 코드 (200~500KB) ...", ... }
│   ├── [1] { name, script: "... 전체 JS 코드 (150~400KB) ...", ... }
│   └── [N] { name, script: "... 전체 JS 코드 (100~300KB) ...", ... }
├── botPresets[]          (프리셋 배열)
├── customCSS: string
├── guiHTML: string
└── ... 기타 설정 필드들
```

### 2.3 safe-db-writer의 역할

```
safeSetDatabaseLite(Risu, patch)
    ↓
validateDbPatch(patch: { plugins: [...] })
    ├─ 차단 키 검사: guiHTML, customCSS, characters 쓰기 불가
    ├─ 허용 키 검사: 'plugins'만 허용
    ├─ 플러그인별 필수 필드 검증 (name, script, version)
    ├─ version === '3.0' 확인
    └─ updateURL HTTPS 확인
    ↓
검증 통과 시 → risu.setDatabaseLite(patch) 호출
```

**중요:** safe-db-writer는 **검증만 수행**하고, 실제 쓰기는 `risu.setDatabaseLite()`에 위임.

---

## 3. 💥 DB 부하 문제 분석 (핵심)

### 3.1 메모리 부하 구조

**시나리오: 대용량 DB 사용자 (캐릭터 300개) + 플러그인 3개 업데이트**

```
사용자 DB 구성:
  - characters[]: 300개 × 3MB = ~900MB
  - plugins[]: 5개 × 300KB = ~1.5MB
  - botPresets[]: 50개 = ~25MB
  - 기타: ~50MB
  ──────────────────
  전체 DB: ~1GB

플러그인 업데이트 시 메모리 흐름:

T1: Plugin#1 auto-update 시작
  ├─ const db = await Risu.getDatabase()   → DB 직접 참조 (추가 메모리 없음)
  ├─ const nextPlugins = db.plugins.slice() → 얕은 복사 (~5MB)
  ├─ code1 (300KB) 문자열 로드
  ├─ safeSetDatabaseLite({ plugins: nextPlugins })
  │   → patch 검증 + setDatabaseLite 호출
  ├─ 3.5초 대기 (autosave flush)
  └─ getDatabase() 재확인 → 직접 참조

실제 추가 메모리: ~5.3MB (플러그인 배열 shallow copy + 새 코드)
```

**⚠️ 핵심 발견: getDatabase()는 직접 참조를 반환하므로, 메모리 복사 부하는 예상보다 작음**

**하지만 setDatabaseLite는 전체 DB 객체를 교체**하므로:
- RisuAI의 autosave가 트리거되면 **전체 DB를 직렬화**
- JSON.stringify(DBState.db) → ~1GB 문자열 생성 → 그 후 저장
- 이 직렬화 과정에서 **전체 DB 크기만큼 추가 메모리 사용**

### 3.2 IO 부하 구조

```
setDatabaseLite({ plugins: nextPlugins }) 호출
    ↓
DBState.db = { ...기존DB, plugins: nextPlugins }  [참조 교체]
    ↓
Svelte 반응성 감지 → autosave 트리거
    ↓
전체 DB 직렬화 (JSON/msgpack)
  └─ 직렬화 크기: ~1GB (characters 포함 전체)
    ↓
IndexedDB / 파일 시스템에 기록
  └─ 디스크 I/O: ~1GB
```

**플러그인 3개 업데이트 시:**
- 직렬화 3회 × ~1GB = ~3GB I/O
- SSD 쓰기 수명 단축

### 3.3 대용량 DB 사용자 영향

| DB 크기 | 직렬화 시간 | I/O 부하/업데이트 | 플러그인 3개 총 부하 |
|---------|-----------|-----------------|-------------------|
| 100MB   | ~100ms    | 100MB           | ~300MB            |
| 500MB   | ~500ms    | 500MB           | ~1.5GB            |
| 1GB     | ~1초      | 1GB             | ~3GB              |
| 2GB     | ~2초      | 2GB             | ~6GB              |

### 3.4 플러그인 script 필드의 구조적 문제

```javascript
// 현재: 전체 JS 코드가 DB에 문자열로 저장
db.plugins[0] = {
    name: "Cupcake_Provider_Manager",
    script: "// === CPM v2.0.5 === ... [300~500KB의 JS 코드] ...",
    version: "3.0",
    versionOfPlugin: "2.0.5",
    // ...
}
```

**문제점:**
1. 플러그인 5개 × 300KB = 1.5MB가 DB에 상시 포함
2. DB 백업/내보내기 시 불필요한 코드 데이터 포함
3. 자동 업데이트마다 전체 DB 직렬화에 포함
4. 클라우드 동기화 시 코드도 함께 전송

---

## 4. 경쟁 상태(Race Condition) 위험

### 4.1 동시 업데이트 시나리오

```
T0: checkVersionsQuiet() 호출 → 3개 플러그인 업데이트 필요함을 감지

T1: Plugin#1 safeMainPluginUpdate 시작
    ├─ getDatabase() → db1 (직접 참조)
    ├─ db1.plugins[0] = updatedPlugin1
    └─ nextPlugins1 = [updatedPlugin1, Plugin2(old), Plugin3(old)]

T2: Plugin#2 safeMainPluginUpdate 시작 (T1의 setDatabaseLite 전에)
    ├─ getDatabase() → db2 (같은 참조이지만 T1이 아직 저장 안함)
    ├─ db2.plugins[1] = updatedPlugin2
    └─ nextPlugins2 = [Plugin1(old), updatedPlugin2, Plugin3(old)]

T3: Plugin#2 safeSetDatabaseLite 호출
    └─ DB = { plugins: [Plugin1(old), updatedPlugin2, Plugin3(old)] }

T4: Plugin#1 safeSetDatabaseLite 호출
    └─ DB = { plugins: [updatedPlugin1, Plugin2(old), Plugin3(old)] }
         ⚠️ Plugin#2의 업데이트 손실!
```

### 4.2 safe-db-writer의 한계

| 기능 | 지원 여부 |
|------|---------|
| 입력 검증 (필수 필드, 타입) | ✅ |
| XSS 벡터 차단 (guiHTML/CSS) | ✅ |
| 경쟁 상태 검사 | ❌ |
| 락 메커니즘 | ❌ |
| 원자성 보장 | ❌ |

**현재 CPM의 auto-updater에서는 checkVersionsQuiet가 단일 메인 플러그인만 업데이트하므로 실질적으로 동시 업데이트가 발생하지 않음. 하지만 구조적으로는 취약점이 존재.**

---

## 5. 개선 권고사항

### Phase 1: 즉시 구현 가능 (1~3시간)

#### 1) 업데이트 직렬화 (Queue)

```javascript
let _updateQueueInFlight = Promise.resolve();

async function safeMainPluginUpdate(remoteVersion, changes) {
    await _updateQueueInFlight;
    _updateQueueInFlight = (async () => {
        // ... 기존 로직 ...
    })();
    return await _updateQueueInFlight;
}
```

- Data loss 완전 방지
- 구현 난이도: ★☆☆

#### 2) Read-Modify-Write 재검증

```javascript
async function validateAndInstall(code, remoteVersion) {
    const db = await Risu.getDatabase();
    // ... 검증 및 설치 로직 ...
    
    // 저장 후 재확인
    const dbAfter = await Risu.getDatabase();
    if (dbAfter.plugins[idx].versionOfPlugin !== parsedVersion) {
        console.warn('[CPM] 저장 검증 실패 — 동시 쓰기 충돌 가능');
    }
}
```

### Phase 2: 구조 개선 (1~2주)

#### 1) 플러그인 코드/메타 분리

```javascript
// 현재: DB에 전체 코드 저장
db.plugins[0].script = "... 300KB ..."

// 개선: IndexedDB에 별도 저장
await idb.put('plugin_scripts', { id: 'cpm', code: "... 300KB ..." });
db.plugins[0].scriptRef = 'cpm';  // 참조만 저장
```

#### 2) 부분 업데이트 지원 (RisuAI 협력 필요)

```typescript
// 제안: setDatabaseLitePartial
export function setDatabaseLitePartial(patch: Partial<Database>) {
    Object.assign(DBState.db, patch);  // 병합 (전체 교체 아님)
}
```

### Phase 3: 장기 (1개월+)

- RisuAI 차원의 트랜잭션/락 지원
- 플러그인 마켓플레이스 CDN 연동
- autosave 차분(diff) 저장 지원

---

## 6. 결론

| 항목 | 현황 | 위험도 |
|------|------|--------|
| 다운로드 무결성 | SHA-256 + Content-Length + 스키마 | ✅ 양호 |
| 設定 보존 | realArg 병합 로직 | ✅ 양호 |
| 단일 플러그인 업데이트 | 안정적 작동 | ✅ 양호 |
| 대용량 DB I/O 부하 | 전체 직렬화 3회 | ⚠️ 주의 |
| 동시 업데이트 경쟁 조건 | 구조적 취약 (실발생 낮음) | ⚠️ 주의 |
| 메모리 스파이크 | 직렬화 시 DB 크기만큼 추가 | ⚠️ 주의 |

**핵심 메시지:** 현재 CPM auto-updater는 **단일 메인 플러그인**만 업데이트하므로 동시성 문제가 실질적으로 발생하지 않습니다. 하지만 **대용량 DB 사용자의 I/O 부담**은 RisuAI의 autosave 전체 직렬화 구조에서 기인하며, 이는 CPM 단독으로 해결할 수 없는 아키텍처 제약입니다. **Phase 1 개선**(업데이트 큐 + 재검증)은 즉시 적용 가능합니다.
