import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const showcase = mode === "showcase";
  const dataSource = fileURLToPath(new URL(
    showcase ? "./src/showcase/data-source.ts" : "./src/live/data-source.ts",
    import.meta.url,
  ));

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "virtual:reprorelay-data-source": dataSource,
      },
    },
    build: {
      outDir: showcase ? "dist-showcase" : "dist",
    },
    server: {
      port: showcase ? 5174 : 5173,
    },
  };
});
