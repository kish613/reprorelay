import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "virtual:reprorelay-data-source": fileURLToPath(new URL("./src/showcase/data-source.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts?(x)"],
  },
});
