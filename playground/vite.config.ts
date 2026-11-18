import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The API gateway answers the CORS preflight with 401, so the browser talks to it through this
// dev server: /svc/dev → api.dev.tao.com (testnet), /svc/prod → api.tao.com (mainnet).
const proxy = (target: string, prefix: string) => ({
  target,
  changeOrigin: true,
  rewrite: (path: string) => path.slice(prefix.length),
});

export default defineConfig({
  plugins: [react()],
  // The SDK from source, so a change to ../src shows here without a build.
  resolve: { alias: { "@tao.com/orders-sdk": fileURLToPath(new URL("../src/index.ts", import.meta.url)) } },
  server: {
    proxy: {
      "/svc/dev": proxy("https://api.dev.tao.com", "/svc/dev"),
      "/svc/prod": proxy("https://api.tao.com", "/svc/prod"),
    },
  },
});
