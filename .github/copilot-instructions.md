# Copilot Instructions

## ⚠️ CRITICAL: 레포 분리 규칙 — 절대 위반 금지

이 프로젝트(`cupcake-provider-v4_IPC`)는 **IPC 테스트 전용** 프로젝트입니다.

- **이 레포**: `ruyari-cupcake/cupcake-plugin-manager-IPC-test` (origin)
- **prod 레포**: `ruyari-cupcake/cupcake-plugin-manager` ← **절대 push 금지**

### 완전히 별개인 프로젝트들
| 폴더 | 프로젝트 | 레포 |
|---|---|---|
| `_temp_repo/` | CPM 원본 (non-IPC) | `cupcake-plugin-manager` (prod) |
| `cupcake-provider-v4_IPC/` | CPM IPC 버전 | `cupcake-plugin-manager-IPC-test` |

### 절대 금지 사항
- ❌ IPC 코드를 prod 레포(`cupcake-plugin-manager`)에 push
- ❌ `_temp_repo` 코드를 IPC-test 레포에 push
- ❌ 두 프로젝트를 혼동하여 크로스-커밋
- ❌ "prod로도 push 할까요?" 같은 제안

### Git Remote 확인
작업 전 반드시 `git remote -v`로 origin이 `cupcake-plugin-manager-IPC-test.git`인지 확인할 것.

---

## Suggested Questions UI

After every response, always end with follow-up questions that trigger 
VS Code's "Suggested questions" button UI. Do NOT write suggestions as 
plain text or bullet points. Generate them in a format that renders as 
clickable suggestion buttons in VS Code.