import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths let the same production build run from a local Electron file URL.
  base: "./",
});
