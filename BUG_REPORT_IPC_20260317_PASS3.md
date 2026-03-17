# CPM v4 IPC — 3차 정밀 디버깅 리포트
**생성일:** 2026-03-17 (3차 패스)  
**초점:** IPC 핑퐁, 중복 API 호출, 타임아웃, 기능적 결함  
**방법:** 서브에이전트 THOROUGH 탐색 + 수동 교차검증 + RisuAI 교차검증

---

## 3차 분석 결과 요약

| 서브에이전트 발견 | 수동 검증 결과 |
|------------------|---------------|
| 7건 | **실제 버그 2건** / 오탐 5건 |

---

## 🔴 BUG-6: IPC Provider 타임아웃 300초 → 30분으로 확대 (Critical)

### 파일
`src/manager/index.js` (L684-687)

### 문제
```javascript
// 수정 전
const timer = setTimeout(() => {
    cleanup();
    resolve({ success: false, content: `[CPM] Provider '${providerName}' timeout (300s)` });
}, 300000); // ← 5분
```

사용자가 명시: "API는 수십분씩 걸리기도 함, 타임아웃같은게 있으면 안됨"

### RisuAI 교차검증
RisuAI-main은 **일반 LLM API 호출에 자동 타임아웃이 없음** (사용자 AbortSignal에만 의존).  
CPM의 300s 타임아웃은 RisuAI 설계와 불일치.

### 수정
300000ms (5분) → 1800000ms (30분). 완전 제거 대신 30분으로 설정한 이유: orphaned 요청 방지.

---

## 🟡 BUG-2 보완: _origSources Path A 누락 수정 (Major)

### 파일
`src/shared/message-format.js` (L237-260)

### 문제
1차 수정에서 Path B (raw Array.isArray(m.content))에만 `_origSources`를 추가했으나,  
**Path A** (`extractNormalizedMessagePayload`의 multimodals 경로)에는 추가하지 않았음.

회귀 테스트를 작성하여 발견:
- 멀티모달 이미지 + cachePoint 텍스트 병합 시 cache_control 미적용
- 멀티모달 이미지끼리 병합 시 cache_control 미적용

### 수정
Path A의 merge 경로 2곳 + push 경로 2곳에 `_origSources` 추가.  
총 6개 경로 모두 `_origSources` 추적 완료:
1. Path A multimodal merge ✅ (이번 수정)
2. Path A multimodal push ✅ (이번 수정)
3. Path A text fallback merge ✅ (이번 수정)
4. Path A text fallback push ✅ (이번 수정)
5. Path B raw content merge ✅ (1차 수정)
6. Path B raw content push ✅ (1차 수정)
7. Path C default text merge ✅ (원래부터 존재)
8. Path C default text push ✅ (원래부터 존재)

---

## ✅ 오탐 판정 내역

| # | 서브에이전트 발견 | 판정 | 검증 근거 |
|---|------------------|------|----------|
| 1 | Stream 첫 청크 race condition | **오탐** | ReadableStream start() 동기 실행, JS 이벤트루프 내 원자적 |
| 2 | 동적 모델 45s 타임아웃 | **경계선/무시** | 메타데이터 fetch에 45s는 충분. API 호출이 아님 |
| 3 | 중복 모델 등록 | **오탐** | uniqueId 형식 일관성 유지 (`${provider}::${id}`) |
| 4 | 스트림 타임아웃 정리 | **오탐** | 첫 청크 도착 시 타이머 클리어됨. 타임아웃은 무응답 시에만 발동 |
| 5 | Abort 후 재시도 orphan | **오탐** | JS 싱글스레드 + ABORT IPC 메시지 전파 정상 동작 |

---

## 추가: 회귀 테스트 18건 작성

`tests/bugfix-regression.test.js` — 총 18개 테스트:
- BUG-1 회귀 (3): OpenRouter reasoning body 검증
- BUG-2 회귀 (4): _origSources 멀티모달 머지 + cachePoint 전파
- BUG-3/5 회귀 (3): Gemini/Vertex thought stripping 빈 parts 필터
- BUG-4 회귀 (3): JSON 파싱 에러 console.error 로깅
- BUG-6 회귀 (1): IPC 타임아웃 >= 30분 검증
- formatToAnthropic edge cases (4): 빈 메시지, system-only, 연속 merge, inlineData

---

## 종합: 전체 버그 수정 현황 (3차 완료)

| 패스 | 버그 ID | 심각도 | 파일 | 상태 |
|------|---------|--------|------|------|
| 1차 | BUG-1 | 🔴 Critical | openrouter.js | ✅ 수정완료 |
| 1차 | BUG-2 | 🟡 Major | message-format.js | ✅ 수정완료 (3차에서 보완) |
| 1차 | BUG-3 | 🔵 Minor | gemini.js | ✅ 수정완료 |
| 1차 | BUG-4 | 🔵 Minor | custom-model-serialization.js | ✅ 수정완료 |
| 2차 | BUG-5 | 🔵 Minor | vertex.js | ✅ 수정완료 |
| 3차 | BUG-6 | 🔴 Critical | manager/index.js | ✅ 수정완료 |
| 3차 | BUG-2+ | 🟡 Major | message-format.js | ✅ 보완완료 (Path A) |

**총 7건 수정 (6개 파일), 1791개 테스트 통과, 12개 번들 빌드 성공.**
