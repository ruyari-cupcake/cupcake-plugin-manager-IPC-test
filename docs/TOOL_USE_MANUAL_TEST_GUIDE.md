# 🛠️ Tool-Use 시스템 — RisuAI 수동 테스트 가이드

> **CPM v2.0.0-alpha (IPC Architecture)**  
> 최종 갱신: 2025-07

---

## 📋 목차

1. [사전 준비](#1--사전-준비)
2. [설정 키 참조표](#2--설정-키-참조표)
3. [Layer 1: MCP 도구 등록 테스트](#3--layer-1-mcp-도구-등록-테스트)
4. [Layer 2: CPM 도구 루프 테스트](#4--layer-2-cpm-도구-루프-테스트)
5. [Prefetch Search 테스트](#5--prefetch-search-테스트)
6. [개별 도구 테스트 시나리오](#6--개별-도구-테스트-시나리오)
7. [에러 케이스 및 엣지 케이스](#7--에러-케이스-및-엣지-케이스)
8. [트러블슈팅](#8--트러블슈팅)

---

## 1. 🔧 사전 준비

### 필수 요건
- RisuAI v166 이상 (V3 Plugin API 필요)
- CPM IPC 매니저 플러그인 설치 완료
- 최소 1개 프로바이더 서브플러그인 활성화
- 브라우저 DevTools 콘솔 접근 가능 (F12)

### 권장 프로바이더 조합
| 테스트 목적 | 권장 프로바이더 |
|------------|--------------|
| Layer 1 (MCP) | OpenAI GPT-4o-mini / Anthropic Claude 3 Haiku |
| Layer 2 (루프) | CPM 커스텀 모델 (OpenAI 포맷) |
| Prefetch | 아무 프로바이더 (도구와 무관) |

### 웹 검색 API 준비 (선택 — web_search / prefetch 테스트 시 필요)
| 프로바이더 | 가입처 | 무료 티어 |
|-----------|--------|----------|
| Brave Search | https://api.search.brave.com | 월 2,000회 |
| SerpAPI | https://serpapi.com | 월 100회 |
| Google CSE | https://programmablesearchengine.google.com | 일 100회 |

---

## 2. 📑 설정 키 참조표

### 도구 사용 (Tool Use)

| 설정 키 | 타입 | 기본값 | 설명 |
|---------|-----|--------|------|
| `cpm_tool_use_enabled` | boolean | false | **마스터 스위치** — 전체 tool-use 기능 on/off |
| `cpm_tool_datetime` | boolean | false | get_current_datetime 도구 활성화 |
| `cpm_tool_calculator` | boolean | false | calculate 도구 활성화 |
| `cpm_tool_dice` | boolean | false | roll_dice 도구 활성화 |
| `cpm_tool_web_search` | boolean | false | web_search 도구 활성화 |
| `cpm_tool_fetch_url` | boolean | false | fetch_url 도구 활성화 |
| `cpm_tool_max_depth` | number | 5 | 도구 루프 최대 라운드 (1~20) |
| `cpm_tool_timeout` | number | 10000 | 도구 실행 타임아웃 (ms, 0~60000) |

### 웹 검색 설정

| 설정 키 | 타입 | 기본값 | 설명 |
|---------|-----|--------|------|
| `cpm_tool_websearch_provider` | string | "brave" | 프로바이더: brave / serpapi / google_cse / custom |
| `cpm_tool_websearch_url` | string | "" | API 엔드포인트 URL (custom일 때 필수) |
| `cpm_tool_websearch_key` | string | "" | API 키 |
| `cpm_tool_websearch_cx` | string | "" | Google CSE ID (google_cse일 때 필수) |

### 프리페치 검색 (Prefetch Search)

| 설정 키 | 타입 | 기본값 | 설명 |
|---------|-----|--------|------|
| `cpm_prefetch_search_enabled` | boolean | false | 프리페치 검색 활성화 |
| `cpm_prefetch_search_position` | string | "after" | 결과 삽입 위치 (before/after 시스템 프롬프트) |
| `cpm_prefetch_search_max_results` | number | 5 | 최대 결과 수 (1~10) |
| `cpm_prefetch_search_snippet_only` | boolean | false | 스니펫만 표시 (URL/제목 숨김) |
| `cpm_prefetch_search_keywords` | string | "" | 트리거 키워드 (쉼표 구분, 빈값 = 항상) |

---

## 3. 🔌 Layer 1: MCP 도구 등록 테스트

> **Layer 1**은 RisuAI의 네이티브 도구 호출 메커니즘을 사용합니다.  
> CPM이 `Risu.registerMCP()`를 통해 도구를 등록하면, RisuAI가 프로바이더에게 도구 목록을 전달하고 응답의 tool_call을 자동 처리합니다.

### 테스트 절차

**Step 1 — 도구 활성화**
1. CPM 설정 열기 (Alt+P 또는 4손가락 터치)
2. Tool Use 탭으로 이동
3. `cpm_tool_use_enabled` = **ON**
4. 원하는 도구 개별 활성화 (예: `cpm_tool_datetime` = ON, `cpm_tool_calculator` = ON)
5. 설정 저장

**Step 2 — MCP 등록 확인**
1. 브라우저 DevTools 콘솔(F12) 열기
2. 콘솔에서 `[CPM Tool-Use] MCP tools registered (Layer 1)` 메시지 확인
3. 에러 확인: `registerMCP failed` 메시지가 없어야 함

**Step 3 — 도구 호출 테스트**

| 프롬프트 예시 | 예상 동작 | 기대 결과 |
|-------------|---------|---------|
| "지금 몇 시야?" | get_current_datetime 호출 | 현재 날짜/시간 표시 (ko-KR 포맷) |
| "√144 + 5 × 3 계산해줘" | calculate 호출 | 27 |
| "주사위 2d6 굴려줘" | roll_dice 호출 | 2~12 사이 합계 + 개별 결과 |
| "오늘 비트코인 가격 검색해줘" | web_search 호출 | 웹 검색 결과 (API 키 필요) |

**Step 4 — 콘솔 로그 확인**
```
[CPM Tool-Use] MCP tools registered (Layer 1)
```

### ✅ 합격 기준
- [ ] MCP 등록 성공 로그 출력
- [ ] 모델이 도구를 호출하고 결과를 응답에 포함
- [ ] 비활성화된 도구는 모델에게 전달되지 않음

---

## 4. 🔄 Layer 2: CPM 도구 루프 테스트

> **Layer 2**는 CPM이 직접 도구 호출을 처리합니다.  
> RisuAI의 requestPlugin에서 `arg.tools`가 무시될 때, CPM이 자체적으로 multi-round 루프를 수행합니다.

### 테스트 절차

**Step 1 — 커스텀 모델로 테스트** (Layer 2 강제 사용)
1. CPM 설정 → 커스텀 모델 탭
2. OpenAI-호환 포맷의 커스텀 모델 추가
   - Format: `openai`
   - URL: 사용 중인 API 서버 (예: OpenAI API, Together AI 등)
3. 해당 모델을 활성 프로바이더로 선택

**Step 2 — 멀티라운드 도구 호출**

| 프롬프트 | 예상 라운드 | 검증 포인트 |
|---------|-----------|-----------|
| "지금 시간 알려줘. 그리고 2^10 계산해줘." | 1~2 라운드 | 여러 도구가 한 라운드에서 호출됨 |
| "오늘 날씨 검색한 다음 그 결과를 요약해줘" | 1~2 라운드 | web_search 결과를 기반으로 텍스트 생성 |
| "주사위 3d6을 5번 굴려서 가장 높은 값 알려줘" | 최대 5 라운드 | 반복 도구 호출 + 결과 비교 |

**Step 3 — 콘솔 로그 확인**
```
[CPM Tool-Use] Layer 2 loop: depth 1/5, calls: 2
[CPM Tool-Use] Executing: get_current_datetime({timezone:"Asia/Seoul"})
[CPM Tool-Use] Executing: calculate({expression:"2**10"})
[CPM Tool-Use] Layer 2 loop: depth 2/5, final text response
```

**Step 4 — 최대 깊이 테스트**
1. `cpm_tool_max_depth` = 2로 설정
2. 여러 도구를 연쇄적으로 사용하도록 유도하는 긴 프롬프트 입력
3. 3라운드 이상 반복되지 않고, 최대 깊이에서 텍스트 응답으로 전환되는지 확인

### ✅ 합격 기준
- [ ] 멀티라운드 루프 정상 동작 (도구 결과 → 재요청)
- [ ] 최대 깊이(max_depth) 도달 시 안전하게 종료
- [ ] 도구 호출 총 10회 제한 동작 확인
- [ ] AbortSignal (채팅 취소) 시 루프 즉시 중단

---

## 5. 🔍 Prefetch Search 테스트

> **Prefetch Search**는 Layer 1/2와 **독립적**으로 동작합니다.  
> 메인 모델 요청 전에 웹 검색을 수행하고 결과를 시스템 프롬프트에 주입합니다.  
> Tool Use가 꺼져 있어도 단독으로 사용 가능합니다.

### 테스트 절차

**Step 1 — 프리페치 활성화**
1. `cpm_prefetch_search_enabled` = ON
2. 웹 검색 API 키 설정 (cpm_tool_websearch_key)
3. 선택: 키워드 설정 (`cpm_prefetch_search_keywords` = "뉴스,오늘,최신,가격")

**Step 2 — 키워드 트리거 테스트**

| 사용자 메시지 | 키워드 설정 | 예상 동작 |
|-------------|-----------|---------|
| "오늘 뉴스 요약해줘" | "뉴스,오늘" | ✅ 검색 실행 |
| "안녕 잘 지내?" | "뉴스,오늘" | ❌ 스킵 (키워드 없음) |
| "파이썬으로 코드 짜줘" | "" (빈값) | ✅ 항상 검색 |
| "a" | 아무 값 | ❌ 스킵 (2자 미만) |

**Step 3 — 삽입 위치 검증**

1. `cpm_prefetch_search_position` = "before" 설정
2. 콘솔에서 `[CPM Prefetch Search] Injecting as system_before` 확인
3. "after"로 변경 후 다시 테스트

**Step 4 — 콘솔 로그 확인**
```
[CPM Prefetch Search] Searching: "오늘 비트코인 가격" (max 5, after)
[CPM Prefetch Search] doWebSearch returned 5 results
[CPM] Prefetch search injected for: "오늘 비트코인 가격"
```

### ✅ 합격 기준
- [ ] 키워드 매칭 시에만 검색 실행
- [ ] 키워드가 비어있으면 항상 검색 실행
- [ ] 검색 결과가 시스템 프롬프트에 정상 주입
- [ ] 검색 실패 시 에러 없이 원래 메시지로 계속 진행
- [ ] Tool Use 꺼져 있어도 Prefetch 단독 동작

---

## 6. 🧪 개별 도구 테스트 시나리오

### 6.1 get_current_datetime

| 입력 | 예상 결과 |
|------|---------|
| timezone: "Asia/Seoul" | 한국 시간 |
| timezone: "America/New_York" | 미국 동부 시간 |
| timezone: (없음) | 기본 로컬 시간 |
| locale: "en-US" | 영어 포맷 |

### 6.2 calculate

| 입력 (expression) | 예상 결과 |
|----------|---------|
| "2 + 3 * 4" | 14 |
| "Math.sqrt(144)" | 12 |
| "Math.PI * 2" | 6.283... |
| "sin(Math.PI/2)" | 1 |
| "" (빈값) | 에러: expression is empty |
| "process.exit()" | 에러 (안전 필터 차단) |
| "fetch('...')" | 에러 (안전 필터 차단) |

### 6.3 roll_dice

| 입력 (notation) | 예상 결과 |
|--------|---------|
| "2d6" | 2~12 합계, 개별 값 |
| "1d20+5" | 6~25 |
| "4d8-2" | 2~30 |
| "" (없음/빈값) | 기본 1d6 |
| "abc" | 에러: invalid notation |

### 6.4 web_search

| 조건 | 예상 결과 |
|------|---------|
| API 키 설정됨 + query 입력 | 검색 결과 배열 (title, url, snippet) |
| API 키 없음 | 에러: "Web search API key not configured" |
| 빈 query | 에러: "Search query is empty" |

### 6.5 fetch_url

| 입력 (url) | 예상 결과 |
|-----------|---------|
| "https://example.com" | HTML→텍스트 변환 (8000자 제한) |
| "http://127.0.0.1:8080" | 에러: Private/localhost URLs are blocked |
| "ftp://server.com/file" | 에러: Only HTTP/HTTPS URLs supported |
| "" | 에러: URL is empty |

---

## 7. ⚠️ 에러 케이스 및 엣지 케이스

### 7.1 도구 타임아웃

1. `cpm_tool_timeout` = 1 (1ms) 설정
2. web_search 호출하는 프롬프트 입력
3. 타임아웃 에러 발생 확인
4. 타임아웃 후에도 대화가 계속되는지 확인 (루프가 깨지지 않아야 함)

### 7.2 채팅 중단 (Abort)

1. 도구를 사용하는 프롬프트 전송
2. 응답 생성 중 "중지" 버튼 클릭
3. 도구 루프가 즉시 중단되는지 확인
4. 이후 새 메시지가 정상 처리되는지 확인

### 7.3 동시 요청

1. 빠르게 2개 메시지 전송
2. 각 요청이 독립적으로 처리되는지 확인
3. 도구 결과가 섞이지 않는지 확인

### 7.4 마스터 스위치 off 상태

1. `cpm_tool_use_enabled` = OFF
2. 도구를 요하는 프롬프트 전송
3. 모델이 도구 없이 텍스트만 응답하는지 확인
4. MCP 등록이 해제되는지 콘솔 확인

### 7.5 보안 테스트

| 프롬프트/입력 | 차단 여부 |
|-------------|---------|
| "http://192.168.1.1 에 접속해줘" (fetch_url) | ✅ 차단됨 (Private IP) |
| "http://[::1]:8080 열어줘" (fetch_url) | ✅ 차단됨 (Localhost IPv6) |
| calculate: "require('child_process')" | ✅ 차단됨 (안전 필터) |
| calculate: "eval('alert(1)')" | ✅ 차단됨 (안전 필터) |

---

## 8. 🔧 트러블슈팅

### MCP 등록 실패

**증상**: `[CPM Tool-Use] registerMCP failed: ...`  
**원인**: RisuAI 버전이 registerMCP를 지원하지 않음  
**해결**: RisuAI를 v166 이상으로 업데이트

### 도구가 호출되지 않음

**증상**: 모델이 도구를 사용하지 않고 텍스트로만 응답  
**확인 사항**:
1. `cpm_tool_use_enabled` = ON인지 확인
2. 개별 도구가 ON인지 확인 (예: `cpm_tool_calculator`)
3. 콘솔에서 MCP 등록 메시지 확인
4. 프로바이더가 tool calling을 지원하는지 확인 (예: GPT-3.5-turbo는 지원하지만 일부 소형 모델은 미지원)

### 웹 검색 실패

**증상**: `Web search API key not configured`  
**해결**: CPM 설정에서 `cpm_tool_websearch_key` 입력  
**증상**: 검색은 되지만 결과가 비어있음  
**확인**: API 프로바이더 대시보드에서 사용량/잔여 쿼터 확인

### Layer 2 루프가 무한 반복

**증상**: 콘솔에서 depth가 계속 증가  
**대응**: 
- 이론적으로 max_depth에서 자동 종료됨 (기본 5)
- 총 10회 호출 하드리밋도 적용됨
- `cpm_tool_max_depth` = 1로 줄여서 테스트

### Prefetch 검색이 동작하지 않음

**확인 사항**:
1. `cpm_prefetch_search_enabled` = ON
2. 웹 검색 API 키 설정됨
3. 키워드가 설정된 경우: 사용자 메시지에 해당 키워드 포함 여부
4. 사용자 메시지 길이 ≥ 2자
5. 콘솔에서 `[CPM Prefetch Search]` 로그 확인

---

## 📝 테스트 결과 기록 템플릿

```markdown
## Tool-Use 수동 테스트 결과

테스트 일자: YYYY-MM-DD  
CPM 버전: 2.0.0-alpha.1  
RisuAI 버전:  
브라우저:  
프로바이더:  

### Layer 1 (MCP)
- [ ] MCP 등록 성공
- [ ] datetime 도구 호출 성공
- [ ] calculate 도구 호출 성공
- [ ] dice 도구 호출 성공
- [ ] web_search 도구 호출 성공
- [ ] fetch_url 도구 호출 성공
- [ ] 비활성 도구 필터링 정상

### Layer 2 (루프)
- [ ] 단일 라운드 동작
- [ ] 멀티라운드 동작 (최소 2라운드)
- [ ] max_depth 제한 동작
- [ ] 10회 호출 제한 동작
- [ ] 취소(abort) 시 루프 중단

### Prefetch Search
- [ ] 키워드 매칭 트리거
- [ ] 빈 키워드 = 항상 트리거
- [ ] before 삽입 위치
- [ ] after 삽입 위치
- [ ] 검색 실패 시 안전 폴백

### 보안
- [ ] Private IP 차단 (fetch_url)
- [ ] 위험 코드 차단 (calculate)

### 비고
(자유 기재)
```
