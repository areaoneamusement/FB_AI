# CLAUDE.md — FB_AI

Nền tảng sản xuất & xuất bản nội dung AI (human-in-the-loop) cho Facebook Page/Group và YouTube.

## Bắt đầu phiên

`SessionStart` hook (`.claude/hooks/session-start.sh`) tự cài dependencies, nên các lệnh dưới
chạy được ngay:

| Việc | Lệnh |
| --- | --- |
| Type check | `npm run typecheck` |
| Toàn bộ test | `npm test` (vitest + `node --test`) |
| Chỉ vitest | `npm run test:vitest` |
| Test UI dashboard | `npm run test:ui` |
| Dev dashboard | `npm run dev:dashboard` |
| Đóng gói context repo | `npm run context` (repomix → `repomix-output.xml`) |

Không có linter riêng — `npm run typecheck` (tsc strict, ESM) đóng vai trò đó.
CI (`.github/workflows/ci.yml`) chạy đúng `npm ci` → `npm run typecheck` → `npm test` trên mọi PR,
nên chạy được ở máy nghĩa là chạy được trên CI.

## Spec là nguồn sự thật

Đặc tả nằm ở `.kiro/specs/fb-ai/` và **đi trước code**:

- `requirements.md` — 11 nhóm yêu cầu viết theo EARS
- `design.md` — kiến trúc, state machine, data models, **33 correctness properties**
- `tasks.md` — kế hoạch Phase 1 (MVP); mọi task hiện đã `[x]`
- `change-requests/CR-*.md` — thay đổi so với spec gốc

Khi sửa hành vi: cập nhật spec trước hoặc mở một CR, rồi mới sửa code và test.

## Kiến trúc

Pipeline tuần tự, mỗi bước là một component thuần, I/O ngoài nằm sau adapter:

```
source-collector → topic-scorer → research-aggregator → content-generator
→ verification-engine (2 model kiểm chứng chéo) → compliance-checker
→ content-pipeline (state machine) → review dashboard → copy-ready-exporter
```

- `src/domain/` — kiểu dữ liệu & enum (Stage, TargetPlatform, ContentDraft, …). Không I/O.
- `src/adapters/ports.ts` — interface cho `SourceFetcher`, model client, persistence, `OutputPort`.
  `fakes.ts` + `in-memory-repository.ts` là bản test double.
- `src/pipeline/` — logic nghiệp vụ, thuần, nhận port qua tham số.
- `src/persistence/` — SQLite (`better-sqlite3`), migration ở `migrations/`.
- `src/dashboard/` — API + SPA React 19 (`web/`).
- `src/output/` — `copy-ready-exporter.ts` và `phase2-output-seam.ts`.
- `src/app/mvp-composition-root.ts` — nơi duy nhất ráp nối các thành phần thật.

## Quy ước cần giữ

- **Phase 1 không tự đăng bài.** Auto-publish (Req 9), đăng nhóm (Req 10), lưu credential mã hoá
  (Req 11) thuộc Phase 2. Mọi thứ đi ra ngoài phải qua `OutputPort`; hiện chỉ nối tới
  `CopyReadyExporter` để người vận hành copy tay.
- **Revision & artifact là bất biến.** Duyệt gắn với hash cụ thể; đừng render lại nội dung
  đã duyệt. Chỉ `PipelineRun` giữ trạng thái thay đổi được (`WorkflowStage`, `WorkStatus`).
- **Chuyển stage có bảo vệ**: dùng expected version/stage + idempotency key, ghi record liên
  kết trong cùng một transaction.
- **33 correctness properties** được kiểm bằng `fast-check`, tối thiểu 100 vòng, đánh dấu
  `// Feature: fb-ai, Property N: ...` trong `test/*.property.test.ts`. Sửa logic pipeline thì
  chạy lại property test tương ứng.
- Logic nghiệp vụ mới đi kèm test; ưu tiên viết test trước (xem skill `test-driven-development`).

## Công cụ Claude có sẵn trong repo

Plugin/MCP được khai báo ở `.claude/settings.json` và `.mcp.json` nên phiên nào cũng có.
Chi tiết và các tuỳ chọn thêm: `docs/claude-setup.md`.
