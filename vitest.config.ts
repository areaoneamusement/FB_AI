import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/compliance-checker.test.ts",
      "test/topic-scorer.test.ts",
    ],
    passWithNoTests: false,
  },
});
