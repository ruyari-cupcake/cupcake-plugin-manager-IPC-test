# pluginChannel.delete() 패치 설계 문서

> **대상**: RisuAI V3 Plugin Engine (`v3.svelte.ts`)  
> **작성일**: 2025-06-13  
> **심각도**: 중간 (메모리 누수)  
> **관련**: FINAL_MIGRATION_REPORT.md §2.2

---

## 1. 문제 정의

### 현상
`pluginChannel` (`Map<string, Function>`)에 등록된 리스너가 플러그인 언로드 시 제거되지 않아
Map 엔트리가 무한 누적됩니다.

### 원인 코드
```typescript
// v3.svelte.ts:39
const pluginChannel = new Map<string, Function>();

// v3.svelte.ts:1027 — 리스너 등록
addPluginChannelListener: (channelName: string, callback: Function) => {
    pluginChannel.set(plugin.name + channelName, callback);
},

// v3.svelte.ts:481-507 — 언로드 함수에 delete 호출 누락
const unloadV3Plugin = async (pluginName: string) => {
    // ✅ v3PluginInstances.splice → 인스턴스 제거
    // ✅ pluginUnloadCallbacks.delete → 콜백 제거
    // ✅ host.terminate() → 샌드박스 종료
    // ❌ pluginChannel.delete() → 누락!
};
```

### 영향
| 항목 | 현재 상태 |
|------|-----------|
| 리로드 1회당 누적 키 | CPM: 23개 (9 플러그인 × ~2.5 채널) |
| 키당 크기 | ~300B (키 문자열 + Function 참조) |
| 100회 리로드 시 | ~690KB 누적 (GC 불가) |
| stale 콜백 실행 | CPM은 `setupChannelCleanup`으로 no-op 처리 → 안전 |
| 다른 플러그인 | no-op 처리 없음 → stale 콜백 실행 가능 |

---

## 2. 패치 사양

### 2.1 핵심 변경: `unloadV3Plugin`에 채널 정리 추가

```typescript
// v3.svelte.ts — unloadV3Plugin 수정
const unloadV3Plugin = async (pluginName: string) => {
    const callbacks = pluginUnloadCallbacks.get(pluginName);
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    
    if(instance){
        const index = v3PluginInstances.findIndex(p => p.name === pluginName);
        if(index !== -1){
            v3PluginInstances.splice(index, 1);
        }
    }

    // ═══════════════════════════════════════════════════
    // [PATCH] pluginChannel 정리 — 해당 플러그인의 모든 채널 키 제거
    // ═══════════════════════════════════════════════════
    for (const key of [...pluginChannel.keys()]) {
        if (key.startsWith(pluginName)) {
            pluginChannel.delete(key);
        }
    }
    // ═══════════════════════════════════════════════════

    if(callbacks){
        pluginUnloadCallbacks.delete(pluginName);
        let promises: Promise<void>[] = [];
        for(const callback of callbacks){
            const result = callback();
            if(result instanceof Promise){
                promises.push(result);
            }
        }
        await Promise.any([
            Promise.all(promises),
            sleep(1000)
        ])
    }
    try {
        instance?.host?.terminate();
    } catch (error) {
        console.error(`Error terminating plugin ${pluginName}:`, error);
    }
}
```

### 2.2 패치 위치

채널 정리는 **onUnload 콜백 실행 전**에 배치합니다:
- onUnload 콜백에서 `postPluginChannelMessage`를 사용할 수도 있으므로,
  채널 정리를 콜백 실행 전에 하면 혼란 가능
- **대안**: onUnload 콜백 실행 **후**, `host.terminate()` **전**에 배치

```typescript
    // Alternative: 콜백 실행 후, 터미네이트 전
    if(callbacks){
        // ... 기존 콜백 실행 코드 ...
    }

    // [PATCH] 콜백 실행 완료 후 채널 정리
    for (const key of [...pluginChannel.keys()]) {
        if (key.startsWith(pluginName)) {
            pluginChannel.delete(key);
        }
    }

    try {
        instance?.host?.terminate();
    } catch (error) { ... }
```

**권장**: 후자 (onUnload 콜백 실행 후). 이유:
- onUnload 콜백이 마지막 채널 메시지를 보낼 수 있음
- 타이밍 안전성: 1초 timeout 후 강제 진행하므로 무한 대기 없음

### 2.3 엣지 케이스 처리

| 케이스 | 처리 |
|--------|------|
| 플러그인 A의 키가 플러그인 AB의 prefix인 경우 | `pluginName`이 정확히 `//@name` 값이므로 공백/특수문자 포함 허용. 실제 충돌 가능성 극히 낮음. 완전 안전하려면 구분자 추가 필요 (§2.4) |
| 채널이 0개인 플러그인 | `for...of`가 빈 이터레이터 → no-op |
| 동시 언로드 | splice로 인스턴스 먼저 제거 → 동시 접근 안전 |

### 2.4 (선택) 키 구분자 도입

현재 키 형식: `pluginName + channelName` (구분자 없음)

플러그인명 `"A"`와 채널명 `"BC"`의 키 = `"ABC"`
플러그인명 `"AB"`와 채널명 `"C"`의 키 = `"ABC"` (충돌!)

**해결**: 키에 구분자 추가

```typescript
// 변경 전
pluginChannel.set(plugin.name + channelName, callback);

// 변경 후
const CHANNEL_SEP = '\x00';  // null byte — 플러그인/채널명에 사용 불가
pluginChannel.set(plugin.name + CHANNEL_SEP + channelName, callback);

// unloadV3Plugin에서
const prefix = pluginName + CHANNEL_SEP;
for (const key of [...pluginChannel.keys()]) {
    if (key.startsWith(prefix)) {
        pluginChannel.delete(key);
    }
}
```

**이 변경은 breaking change**이므로 신규 버전에서만 적용 권장.

---

## 3. 하위 호환성

| 항목 | 영향 |
|------|------|
| 기존 플러그인 | 영향 없음 — delete 전에 onUnload 콜백 실행 완료 |
| CPM setupChannelCleanup | 계속 동작하지만 불필요해짐 (no-op 교체 → Map 자체에서 제거) |
| postPluginChannelMessage | 삭제된 키에 메시지 전송 시 `pluginChannel.get()` → undefined → 무시 (기존 동작과 동일) |
| 성능 | O(N) keys 순회, N ≤ 100 수준 → 무시 가능 |

---

## 4. 테스트 계획

```typescript
// v3.test.ts (새 테스트 케이스)

describe('unloadV3Plugin - pluginChannel cleanup', () => {
    it('should delete all channel entries for the unloaded plugin', async () => {
        // Setup: 플러그인 "TestPlugin" 로드 + 3개 채널 등록
        pluginChannel.set('TestPluginCH_A', () => {});
        pluginChannel.set('TestPluginCH_B', () => {});
        pluginChannel.set('TestPluginCH_C', () => {});
        // 다른 플러그인의 채널 (제거되면 안 됨)
        pluginChannel.set('OtherPluginCH_X', () => {});

        await unloadV3Plugin('TestPlugin');

        expect(pluginChannel.has('TestPluginCH_A')).toBe(false);
        expect(pluginChannel.has('TestPluginCH_B')).toBe(false);
        expect(pluginChannel.has('TestPluginCH_C')).toBe(false);
        expect(pluginChannel.has('OtherPluginCH_X')).toBe(true);
    });

    it('should not throw when plugin has no channels', async () => {
        await expect(unloadV3Plugin('NonExistentPlugin')).resolves.not.toThrow();
    });
});
```

---

## 5. CPM 측 후속 조치

패치가 RisuAI에 반영되면:
1. `setupChannelCleanup`은 여전히 안전하게 유지 (no-op 교체 → 이미 삭제된 키에 무해)
2. 별도 변경 불필요 — 하위 호환
3. CPM 릴리스 노트에 "RisuAI vX.Y.Z 이상에서 채널 메모리 누수 해결됨" 기재

---

## 6. 최소 diff (복사-붙여넣기용)

```diff
--- a/src/ts/plugins/apiV3/v3.svelte.ts
+++ b/src/ts/plugins/apiV3/v3.svelte.ts
@@ -481,6 +481,13 @@ const unloadV3Plugin = async (pluginName: string) => {
 
         await Promise.any([
             Promise.all(promises),
             sleep(1000) //timeout after 1 second
         ])
     }
+
+    // Clean up pluginChannel entries for the unloaded plugin
+    for (const key of [...pluginChannel.keys()]) {
+        if (key.startsWith(pluginName)) {
+            pluginChannel.delete(key);
+        }
+    }
+
     try {
         instance?.host?.terminate();        
     } catch (error) {
```
