import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/standalone.ts", import.meta.url)),
      name: "ReproRelayBrowserBundle",
      formats: ["iife"],
      fileName: () => "reprorelay.iife.js",
    },
    // Vite 8's default minifier (oxc). "esbuild" requires a separately
    // installed esbuild package, which is absent on Vercel and broke deploys.
    minify: true,
    sourcemap: false,
  },
});
