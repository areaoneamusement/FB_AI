# Chạy thật FB_AI (Phase 1)

Phase 1 **không tự đăng bài**. "Chạy thật" ở đây nghĩa là chuỗi này chạy với nguồn thật và
model thật:

```
nguồn thật → chấm điểm → research → Claude viết → Gemini kiểm chứng chéo
→ kiểm tra tuân thủ → bảng duyệt → bạn bấm duyệt → xuất nội dung copy-ready
```

Bước cuối vẫn là bạn tự copy sang Facebook. Tự đăng qua API là Phase 2 (Req 9–11).

---

## 1. Chuẩn bị

| Thứ cần | Lấy ở đâu | Ghi chú |
| --- | --- | --- |
| Node.js 22+ | nodejs.org | `node --version` |
| Anthropic API key | platform.claude.com/settings/keys | Model A — viết nội dung |
| Gemini API key | aistudio.google.com/apikey | Model B — kiểm chứng chéo |
| GitHub token (tuỳ chọn) | github.com/settings/tokens | Nâng GitHub search từ 10 → 30 request/phút |

Hai model **cố ý khác nhà cung cấp**: hai model cùng họ chia sẻ điểm mù, nên một câu cả hai
cùng bịa ra sẽ lọt qua vòng kiểm chứng.

## 2. Cài đặt

```bash
npm install
cp .env.example .env
```

Mở `.env` và điền tối thiểu 3 dòng:

```bash
FB_AI_OPERATOR_TOKEN=$(openssl rand -hex 24)   # mật khẩu vào bảng duyệt
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

> `GEMINI_MODEL` mặc định là `gemini-2.5-pro`. Nếu key của bạn không truy cập được model đó,
> đặt lại bằng tên model bạn thực sự có — sai tên sẽ lỗi ở bước kiểm chứng chứ không phải lúc
> khởi động.

## 3. Kiểm tra cấu hình nguồn

`config/fb-ai.config.json` quyết định đọc gì và chấm điểm thế nào. Mặc định gồm 2 nguồn
GitHub và 2 blog; nguồn VnExpress để `active: false` cho bạn tự bật.

Nên xác nhận từng URL còn sống trước lần chạy đầu:

```bash
curl -sI https://huggingface.co/blog/feed.xml | head -1
curl -s "https://api.github.com/search/repositories?q=topic:llm+stars:>500&per_page=1" | head -c 200
```

Các mục đáng chỉnh:

- `scoring.minScore` — ngưỡng để một chủ đề được viết thành bài. Mặc định 60. Không có bài
  nào qua vòng đầu thì hạ xuống 40–50 rồi tăng dần.
- `scoring.relevanceKeywords` — từ khoá xác định "đúng chủ đề". Ảnh hưởng trực tiếp tới điểm.
- `compliance.bannedKeywords` — cụm từ không bao giờ được xuất hiện trong bài đã duyệt.
- `sources[].filterMode` — `Best` (≥1000 sao), `High` (≥200), `All` (không lọc).

## 4. Chạy

Hai tiến trình tách rời — một chu kỳ model có thể mất vài phút và không nên chặn bảng duyệt:

```bash
npm run build     # build SPA một lần (và mỗi khi sửa src/dashboard/web)
npm run cycle     # sinh bài: thu thập → viết → kiểm chứng → chờ duyệt
npm start         # mở bảng duyệt tại http://127.0.0.1:4173
```

Đăng nhập bảng duyệt bằng `FB_AI_OPERATOR_TOKEN` (gửi qua header `Authorization: Bearer`).

`npm run cycle` in ra kết quả dạng:

```
Thu thập: 12 mục (bỏ qua 3, lỗi 0)
  chờ duyệt: 2
  dưới ngưỡng điểm: 8
  kiểm chứng chặn: 2
Sẵn sàng duyệt: run-abc, run-def
```

Chạy định kỳ thì cắm vào cron:

```cron
0 7,19 * * *  cd /đường/dẫn/FB_AI && npm run cycle >> logs/cycle.log 2>&1
```

## 5. Đọc kết quả

| Kết quả | Nghĩa là | Nên làm gì |
| --- | --- | --- |
| `chờ duyệt` | Qua hết kiểm chứng và tuân thủ | Vào bảng duyệt, đọc, sửa nếu cần, bấm duyệt |
| `dưới ngưỡng điểm` | Chủ đề không đủ điểm | Bình thường. Nếu *mọi* mục đều vậy thì hạ `minScore` |
| `không đủ research` | Không gom đủ dữ liệu để viết có căn cứ | Thêm nguồn, hoặc hạ `research.minItems` |
| `để dành chu kỳ sau (vượt hạn mức mỗi chu kỳ)` | Vượt `maxTopicsPerCycle` | Bình thường. Chủ đề điểm cao đi trước, phần còn lại quay lại ở chu kỳ sau |
| `kiểm chứng chặn` | Gemini thấy câu khẳng định không có căn cứ | **Đây là hệ thống đang làm đúng việc.** Bài bịa số liệu bị chặn tại đây |
| `vi phạm tiêu chuẩn/bản quyền` | Trùng từ cấm, thiếu ghi nguồn, hoặc copy quá nhiều | Kiểm tra `bannedKeywords` và phần trích dẫn |

Duyệt xong, `CopyReadyExporter` xuất nội dung theo từng nền tảng để bạn copy. Bản duyệt gắn
với hash cụ thể — nội dung bạn copy đúng là nội dung bạn đã đọc, không phải bản render lại.

## 6. Giới hạn cần biết trước

- **Chưa có HTTPS.** Server chỉ nghe `127.0.0.1`. Đừng đổi `FB_AI_HOST` thành `0.0.0.0` khi
  chưa đặt sau reverse proxy có TLS — operator token sẽ đi qua mạng ở dạng thô.
- **Một operator.** Xác thực là một token dùng chung, không phải hệ thống tài khoản. Nhiều
  người dùng thuộc Phase 2 (Req 11, lưu credential mã hoá).
- **SQLite một file.** `data/fb-ai.sqlite` là toàn bộ trạng thái. Sao lưu file này.
- **Chi phí bị chặn bởi `maxTopicsPerCycle`** (mặc định 3). Mỗi chủ đề qua ngưỡng điểm sẽ
  gom research (fetch lại *mọi* nguồn) rồi gọi Claude 1 lần/bài (+1 cho mỗi vòng sửa) và
  Gemini 1 lần/vòng kiểm chứng. Không có hạn mức này thì một chu kỳ thu 200 mục sẽ bắn 200
  lượt research và 400 lượt gọi model. Chủ đề được xếp hạng theo điểm nên phần bị hoãn quay
  lại ở chu kỳ sau, không mất.
- **Chưa chạy được với model thật trong môi trường phát triển.** Container tạo ra thay đổi
  này chặn mọi host ngoài GitHub, nên đường đi tới API Anthropic/Gemini và tới các feed RSS
  chỉ được kiểm bằng adapter giả lập, chưa gọi thật. Lần chạy đầu ở máy bạn là lần đầu tiên
  chuỗi này chạm mạng thật — hãy chạy `npm run cycle` với **một** nguồn trước.

## 7. Khi có lỗi

| Thông báo | Nguyên nhân thường gặp |
| --- | --- |
| `Thiếu biến môi trường bắt buộc: X` | Chưa nạp `.env`. Dùng `node --env-file=.env` hoặc export tay |
| `Operator token phải dài ít nhất 16 ký tự` | Token quá ngắn |
| `GitHub search failed with 403` | Hết quota. Đặt `GITHUB_TOKEN` (60 → 5.000 request/giờ), và giảm `maxTopicsPerCycle` |
| `Model A bị cắt ở max_tokens` | Bài quá dài. Tăng `maxTokens` trong `AnthropicModelAClient` |
| `Model B trả về nội dung rỗng` | Sai `GEMINI_MODEL`, hoặc key không có quyền |
| `Blocked by robots.txt` | Nguồn không cho đọc. Bỏ nguồn đó ra khỏi config |

Log chi tiết hơn: chạy `npm run cycle` ở tiền cảnh và đọc stderr.
