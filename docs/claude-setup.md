# Thiết lập Claude Code cho FB_AI

Mục tiêu: **mọi phiên làm việc mở ra là chạy được ngay** — dependencies đã cài, test/typecheck
chạy được, plugin và MCP tự nạp, và Claude biết kiến trúc repo mà không phải đọc lại toàn bộ.

Toàn bộ cấu hình nằm trong repo nên nó theo cả phiên local lẫn Claude Code on the web
(container web bị xoá sau mỗi phiên — cấu hình ở `~/.claude/` sẽ mất, cấu hình trong repo thì không).

| File | Vai trò |
| --- | --- |
| `CLAUDE.md` | Bộ nhớ dự án: lệnh, kiến trúc, quy ước. Nạp vào mọi phiên. |
| `.claude/settings.json` | Khai báo marketplace + plugin + SessionStart hook. |
| `.claude/hooks/session-start.sh` | Cài dependencies, cài plugin dự phòng, xuất `PATH`, in tóm tắt trạng thái. |
| `.mcp.json` | MCP server dùng chung cho repo (Playwright). |

**Lần đầu mở repo** Claude Code sẽ hỏi tin cậy thư mục và duyệt MCP server — bấm đồng ý một lần.
Sau đó hook chạy khoảng **1 giây** khi mọi thứ đã sẵn (đo thực tế), và ~10 giây ở container trắng.

---

## 1. Đã cài — plugin (HARNESS + SKILLS)

Khai báo trong `.claude/settings.json`, Claude Code tự tải về ở phiên đầu tiên.

| Plugin | Marketplace | Dùng để | Token luôn nạp |
| --- | --- | --- | --- |
| `superpowers` | `obra/superpowers` | Lập kế hoạch trước khi gõ: brainstorming, writing-plans, executing-plans, TDD, systematic-debugging, git worktrees, subagent-driven dev (14 skill) | ~688 |
| `feature-dev` | `anthropics/claude-code` | Quy trình phát triển tính năng: khám phá codebase → plan → implement | ~238 |
| `code-review` | `anthropics/claude-code` | Review đa agent có chấm độ tin cậy | ~20 |
| `commit-commands` | `anthropics/claude-code` | Lệnh commit / push / tạo PR | ~103 |
| `security-guidance` | `anthropics/claude-code` | Hook cảnh báo rủi ro bảo mật khi sửa file | ~0 |
| `claude-api` | `anthropics/skills` | Tra cứu Claude API/SDK: model id, giá, caching, tool use, token counting | ~471 |

**Tổng chi phí luôn nạp: ~1.5k token/phiên.**

Cơ chế nạp có hai tầng, để không phiên nào bị thiếu:

1. `extraKnownMarketplaces` + `enabledPlugins` trong `.claude/settings.json` — đây là cách chính
   thức để "team members có sẵn plugin cần thiết" khi mở repo.
2. Dự phòng trong `session-start.sh`: nếu chưa thấy plugin, hook tự `marketplace add` +
   `plugin install` (mỗi lệnh giới hạn 120s, lỗi thì bỏ qua chứ không chặn phiên).
   Đã kiểm chứng: xoá sạch `~/.claude/plugins` rồi chạy hook thì cả 6 plugin được cài lại.
   Lưu ý plugin cài bằng đường dự phòng chỉ có hiệu lực từ **phiên kế tiếp** — nhưng container
   web được cache lại sau khi hook chạy xong, nên thực tế chỉ tốn một lần.

Kiểm tra lại bất cứ lúc nào:

```bash
claude plugin list
claude plugin details superpowers@superpowers-dev   # xem inventory + token cost
```

## 2. Đã cài — MCP (CÔNG CỤ)

`.mcp.json` khai báo **Playwright MCP**: Claude tự mở trình duyệt thật để kiểm tra dashboard
React thay vì chỉ đoán qua test. Container web đã có sẵn Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`).

Nếu Playwright báo thiếu browser, thêm `"--executable-path", "/opt/pw-browsers/chromium"` vào `args`
(chỉ đúng trên container web) hoặc chạy `npx playwright install chromium` ở máy local.

GitHub MCP **không cần khai báo**: phiên Claude Code on the web đã có sẵn bộ tool `mcp__github__*`.

## 3. Đã cài — bộ nhớ & context

- `CLAUDE.md` — thứ thay thế việc đọc lại repo mỗi phiên.
- `.kiro/specs/fb-ai/` — spec là nguồn sự thật, đã trỏ tới từ `CLAUDE.md`.
- `npm run context` — chạy **repomix**, đóng gói toàn repo thành một file để dán vào chỗ khác
  (Gemini, ChatGPT, issue…). Dùng `npx`, không thêm dependency.
- Kế hoạch dạng file: dùng skill `writing-plans` / `executing-plans` của superpowers, ghi plan
  ra file trong repo thay vì giữ trong đầu phiên.

---

## 4. Đã rà soát nhưng **không** cài — kèm lý do

Đây là phần quan trọng nhất của mục "CHI PHÍ": cài hết ≠ tốt hơn.

| Repo | Lý do bỏ |
| --- | --- |
| **ECC** (`affaan-m/ECC`) | Đã cài thử và đo: **~40.400 token luôn nạp mỗi phiên** (378 skill, 68 agent, 7 hook). Chiếm ~20% cửa sổ context trước khi bạn kịp gõ chữ nào. Đã gỡ. |
| **pr-review-toolkit** (`anthropics/claude-code`) | ~2.877 token luôn nạp, chỉ hữu ích lúc review PR, và trùng vai trò với `code-review` + `/code-review` có sẵn. Đã gỡ. |
| **wshobson/agents** (95 plugin) | Marketplace hợp lệ nhưng phần lớn không liên quan (Kubernetes, Rust, Terraform…). Cài theo nhu cầu chứ không cài cả bộ — xem mục 5. |
| **claude-mem** (`thedotmack/claude-mem`) | Lưu bộ nhớ vào `~/.claude-mem`, mà container web bị xoá sau mỗi phiên → gần như vô tác dụng ở đây. Đáng cài nếu bạn dùng Claude Code trên máy cá nhân. |
| **document-skills** (`anthropics/skills`) | Tài khoản này đã có sẵn skill `docx`, `pdf`, `pptx`, `xlsx`. Cài nữa là trùng. |
| **gstack** (`garrytan/gstack`) | Là starter stack cho dự án mới (không có `.claude-plugin/`), không phải plugin cài vào repo đang chạy. |
| **firecrawl**, **vibe-kanban**, **cc-switch**, **claude-code-router** | Đều là repo thật nhưng cần API key / chạy server riêng / đổi routing model — không nên bật ngầm trong repo dùng chung. Hướng dẫn ở mục 5. |
| **awesome-mcp-servers**, **awesome-claude-skills**, **system-prompts-ai**, **best-practice**, **claude-code-guide** | Là danh sách/tài liệu để đọc, không phải thứ "cài" được. |

### Không xác minh được

Các link `lnkd.in` trong danh sách không giải được từ môi trường này (proxy chặn redirect), nên
không xác định được repo gốc của: **learn-claude-code, karpathy-skills, ponytail, taste-skill,
claude-plugin, ui-ux-pro-max, codegraph, graphify, multica, codex-plugin-cc, claude-hud, caveman**.

Gửi URL GitHub thật của cái nào cần thì thêm được ngay — quy trình chỉ là:

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install <tên>@<marketplace>
claude plugin details <tên>@<marketplace>   # đo token trước khi giữ lại
```

---

## 5. Tuỳ chọn thêm (bật khi cần)

**Plugin theo nhu cầu từ `wshobson/agents`:**

```bash
claude plugin marketplace add wshobson/agents
claude plugin install llm-application-dev@claude-code-workflows   # RAG, LLM app, agent
claude plugin install unit-testing@claude-code-workflows
```

**Firecrawl MCP** (crawl nguồn cho pipeline — cần `FIRECRAWL_API_KEY`), thêm vào `.mcp.json`:

```json
"firecrawl": {
  "command": "npx",
  "args": ["-y", "firecrawl-mcp"],
  "env": { "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}" }
}
```

**Bộ nhớ giữa các phiên trên máy local:**

```bash
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-mem@thedotmack
```

**Giảm số lần hỏi quyền.** Claude không tự ghi block `permissions` vào settings được (đây là
guardrail cố ý), nên dán tay đoạn này vào `.claude/settings.json` nếu muốn:

```json
"permissions": {
  "allow": [
    "Bash(npm test)",
    "Bash(npm run test:*)",
    "Bash(npm run typecheck)",
    "Bash(npm run build)",
    "Bash(npm install)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)"
  ]
}
```

Hoặc chạy skill `/fewer-permission-prompts` để nó tự đề xuất danh sách dựa trên lịch sử phiên.

---

## 6. Bảo trì

```bash
claude plugin marketplace update      # cập nhật mọi marketplace
claude plugin update <tên>@<mkt>      # cập nhật một plugin
claude plugin details <tên>@<mkt>     # đo lại token cost sau khi update
```

Nguyên tắc: trước khi giữ lại một plugin, chạy `claude plugin details` và nhìn dòng
`Always-on`. Bất kỳ thứ gì vượt ~1k token luôn nạp phải thực sự dùng hằng ngày mới đáng giữ.
