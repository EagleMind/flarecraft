import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The local server holds the Cloudflare token; the browser only ever talks
    // to this proxy, so no credential is reachable from page JavaScript.
    proxy: {
      "/api": {
        target: process.env["FLARECRAFT_API"] ?? "http://127.0.0.1:8798",
        changeOrigin: true,
      },
    },
  },
});
