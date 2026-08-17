# FB_AI

Nền tảng sản xuất và xuất bản nội dung tự động (human-in-the-loop) cho kênh AI trên Facebook Page/Group và YouTube.

Hệ thống tự dò nguồn uy tín (repo GitHub điểm cao, trang công nghệ, forum), chấm điểm chủ đề, tổng hợp research có trích dẫn, sinh nội dung đa định dạng (bài Facebook, cẩm nang có hình, kịch bản video), cho hai mô hình AI kiểm chứng chéo, kiểm tra tiêu chuẩn cộng đồng và bản quyền, rồi đưa vào bảng duyệt để người vận hành phê duyệt.

## Đặc tả (spec)

Tài liệu đặc tả nằm trong `.kiro/specs/fb-ai/`:

- `requirements.md` — Yêu cầu (EARS, 11 nhóm)
- `design.md` — Thiết kế kỹ thuật (kiến trúc, pipeline, 33 correctness properties)
- `tasks.md` — Kế hoạch triển khai Phase 1 (MVP)

## Phân kỳ

- **Phase 1 (MVP):** thu thập → chấm điểm → research → sinh nội dung → hai model kiểm chứng chéo → kiểm tra tuân thủ → bảng duyệt → xuất nội dung copy-ready để đăng thủ công.
- **Phase 2 (sau):** tự động xuất bản qua API, tự đăng nhóm, lưu token mã hóa.

## Thiết lập Claude Code

Repo đã cấu hình sẵn để mọi phiên Claude Code (local hoặc trên web) chạy được ngay: xem `CLAUDE.md`
và `docs/claude-setup.md`.

## Chạy thật

Hướng dẫn go-live (biến môi trường, cấu hình nguồn, chạy chu kỳ, đọc kết quả, giới hạn):
`docs/golive.md`.
