import { createServer } from "node:http";

import { bootstrap } from "./bootstrap.js";
import type { ServerEnvironment } from "./bootstrap.js";

/**
 * Phase 1 review dashboard. Serves the approval UI and its API; it never publishes —
 * approved content leaves through `CopyReadyExporter` for an operator to post by hand.
 *
 * Drafts are produced by the separate pipeline CLI (`npm run cycle`), so a long model run
 * cannot block the dashboard an operator is reviewing in.
 */
export interface StartedServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function startServer(env: ServerEnvironment = process.env): Promise<StartedServer> {
  const { app, host, port } = await bootstrap(env);

  const server = createServer((request, response) => {
    void app.dashboardHttpHandler(request, response);
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    app.close();
    throw error;
  }

  let closed = false;
  return {
    url: `http://${host}:${port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      app.close();
    },
  };
}

// Only run when executed directly, so tests can import `startServer` without listening.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then(({ url, close }) => {
      process.stdout.write(`Bảng duyệt FB_AI đang chạy tại ${url}\n`);
      process.stdout.write("Sinh bài mới bằng: npm run cycle\n");

      const shutdown = (signal: string): void => {
        process.stdout.write(`\nNhận ${signal}, đang đóng...\n`);
        void close().then(() => process.exit(0));
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
