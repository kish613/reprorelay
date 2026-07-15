import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const worktreeExclude = [".claude/worktrees/**"];

export default defineConfig({
  resolve: {
    alias: {
      "virtual:reprorelay-data-source": fromRoot("./apps/dashboard/src/showcase/data-source.ts"),
      "@reprorelay/shared/fixtures": fromRoot("./packages/shared/src/fixtures.ts"),
      "@reprorelay/shared": fromRoot("./packages/shared/src/index.ts"),
      "@reprorelay/agent-adapters": fromRoot("./packages/agent-adapters/src/index.ts"),
      "@reprorelay/github": fromRoot("./packages/github/src/index.ts"),
      "@reprorelay/worker": fromRoot("./apps/worker/src/index.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "browser-sdk",
          environment: "jsdom",
          include: ["packages/browser-sdk/test/**/*.test.ts"],
          exclude: worktreeExclude,
          setupFiles: ["./packages/browser-sdk/test/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard",
          environment: "jsdom",
          include: ["apps/dashboard/test/**/*.test.ts?(x)"],
          exclude: worktreeExclude,
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "apps/api/test/**/*.test.ts",
            "apps/worker/test/**/*.test.ts",
            "packages/github/test/**/*.test.ts",
            "packages/shared/test/**/*.test.ts",
          ],
          exclude: worktreeExclude,
        },
      },
    ],
  },
});
