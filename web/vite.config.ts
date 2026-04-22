import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

const excludeWasm = {
  name: "exclude-wasm",
  closeBundle() {
    for (const f of ["dist/privy-core.wasm", "dist/wasm-exec.js"]) {
      try { fs.unlinkSync(path.resolve(__dirname, f)); } catch {}
    }
  },
};

export default defineConfig({
  base: "./",
  plugins: [react(), cssInjectedByJsPlugin(), excludeWasm],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "esnext",
  },
  server: {
    proxy: {
      "/eth-rpc": {
        target: "http://127.0.0.1:8545",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/eth-rpc/, ""),
      },
    },
  },
});