import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite config tuned for the Tauri 2.x dev loop.
//
// Two Tauri-specific constraints worth knowing about:
//
//   1. `server.port` must match the `build.devUrl` in
//      src-tauri/tauri.conf.json. We've pinned both to 1420 (the
//      Tauri scaffold default) — if you ever change this, change
//      both at the same time.
//
//   2. `clearScreen: false` keeps Rust compile errors from being
//      wiped off the terminal when Vite hot-reloads. Without this,
//      a Rust-side panic during dev becomes hard to diagnose because
//      Vite's HMR redraw scrolls the cargo output away.

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Output directory consumed by Tauri's build step. Matches the
  // `frontendDist: "../dist"` setting in src-tauri/tauri.conf.json.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Tauri's bundled WebView is Wry (WebKit on macOS / WebView2 on
    // Windows / WebKitGTK on Linux). All three support modern ES,
    // so we can ship esnext and skip legacy polyfills.
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },

  clearScreen: false,

  // Vite dev server. Tauri spawns this via `beforeDevCommand` in
  // tauri.conf.json. The strictPort flag makes Vite fail loudly
  // instead of silently falling back to a different port when 1420
  // is already in use — without it, Tauri's webview ends up pointed
  // at a port that doesn't exist.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // src-tauri is owned by cargo; ignore it from Vite's watcher
      // so Rust file edits don't trigger frontend HMR cycles.
      ignored: ["**/src-tauri/**"],
    },
  },
});
