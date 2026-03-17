# CPM v4 IPC — 2차 정밀 디버깅 리포트
**생성일:** 2026-03-17 (2차 패스)  
**분석 범위:** `src/` 전체 37파일 재검토  
**방법:** 서브에이전트 THOROUGH 탐색 + 수동 교차검증

---

## 2차 분석 결과 요약

| 서브에이전트 발견 | 수동 검증 결과 |
|------------------|---------------|
| 11건 | **실제 버그 1건** / 오탐 10건 |

---

## 🔵 BUG-5: Vertex.js — Gemini thought 스트리핑 후 빈 parts (수정누락)

### 파일
`src/providers/vertex.js` (L351-361)

### 문제
1차 패스에서 `gemini.js`의 동일 버그(BUG-3)를 수정했으나, `vertex.js`의 Gemini-on-Vertex 경로에 동일한 패턴이 있었고 수정이 누락되었음.

```javascript
// vertex.js L351-361 (수정 전)
if (isThinkingModel && gc.contents) {
    gc.contents = gc.contents.map(content => ({
        ...content,
        parts: content.parts.map(part => {
            const { thought, ...rest } = part;
            return rest;  // ← {thought: true} only part → 빈 {} 잔류
        }),
    }));
}
```

### 수정
`.filter(p => Object.keys(p).length > 0)` 추가 (gemini.js와 동일).

### RisuAI 교차검증
Gemini thought stripping은 CPM 고유 기능. RisuAI-main에서는 요청 body에 thought 속성을 스트리핑하지 않음.

---

## ✅ 오탐 판정 내역

| # | 서브에이전트 발견 | 판정 | 검증 근거 |
|---|------------------|------|----------|
| 1 | innerHTML XSS (escHtml 불완전) | **오탐** | `escHtml`이 `&<>"` 이스케이프 → 텍스트 콘텐츠 + 쌍따옴표 속성에 충분. `escAttr`은 추가로 `'`도 이스케이프 (L1840). 동적 값은 태그 내부 텍스트로만 삽입됨 |
| 2 | Event listener leak (설정 재오픈) | **오탐** | V3 런타임에서 설정 패널 재렌더링 시 이전 DOM 엘리먼트가 교체되어 리스너도 GC됨 |
| 3 | Stream state race condition | **오탐** | JS 싱글스레드 → `addPluginChannelListener` 콜백은 이벤트 루프에서 순차 실행. STREAM_CHUNK/STREAM_END 동시 도착 불가 |
| 4 | postPluginChannelMessage throws | **극저위험** | 45초 타임아웃이 커버. postPluginChannelMessage는 fire-and-forget 메시징이므로 throw 가능성 극히 낮음 |
| 5 | Temperature 0 fallback | **오탐** | `0 ?? 0.7` = `0`. `??` 연산자는 null/undefined만 nullish로 취급. 0은 유효한 값으로 반환됨 |
| 6 | Copilot version override cache | **오탐** | `setVal` 함수(L1832-1836)에서 `setCopilotVersionOverrides()` + `clearCopilotTokenCache()` 이미 처리됨 |
| 7 | Vertex OAuth cache 미삭제 | **오탐** | `_tokenCaches.delete(cacheKey)`가 `res.text()` 이전에 실행되므로 text() 예외와 무관하게 캐시 삭제됨 |
| 8 | SSE thought closure on error | **오탐** | AbortError 시 closing tag 생략은 의도적 설계 (`/* skip enqueue on error */` 코멘트). 에러 상태에서 추가 데이터 enqueue는 무의미 |
| 9 | Deep clone memory waste | **최적화** | 기능 버그가 아닌 메모리 최적화 사항. 대부분 메시지 배열은 512KB 미만 |
| 10 | Missing status code in error | **코스메틱** | 로깅 개선 사항일 뿐 기능에 영향 없음 |

---

## 종합: 전체 버그 수정 현황

| 패스 | 버그 ID | 심각도 | 파일 | 상태 |
|------|---------|--------|------|------|
| 1차 | BUG-1 | 🔴 Critical | openrouter.js | ✅ 수정완료 |
| 1차 | BUG-2 | 🟡 Major | message-format.js | ✅ 수정완료 |
| 1차 | BUG-3 | 🔵 Minor | gemini.js | ✅ 수정완료 |
| 1차 | BUG-4 | 🔵 Minor | custom-model-serialization.js | ✅ 수정완료 |
| 2차 | BUG-5 | 🔵 Minor | vertex.js | ✅ 수정완료 |

**총 5건 버그 수정, 1773개 테스트 전부 통과, 12개 번들 빌드 성공.**
