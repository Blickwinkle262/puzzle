import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        proxyTimeout: 300_000,
        timeout: 300_000,
      },
      "/content/stories": {
        target: "http://localhost:8787",
        changeOrigin: true,
        proxyTimeout: 300_000,
        timeout: 300_000,
      },
    },
  },
});
