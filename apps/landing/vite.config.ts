import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/reprorelay/" : "/",
  plugins: [react()],
  publicDir: "../dashboard/public",
  server: {
    port: 5175,
  },
});
