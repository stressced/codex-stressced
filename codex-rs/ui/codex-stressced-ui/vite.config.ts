// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ command, mode }) => {
  const isBuild = command === "build";

  return {
    plugins: [react()],
    root: __dirname,
    base: "./",
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
        },
      },
      emptyOutDir: true,
    },
    esbuild: {
      loader: "tsx",
      include: /\/src\/.+\.tsx?$/,
    },
    css: {
      modules: {
        localsConvention: "camelCase",
      },
    },
    server: {
      port: 5174,
      strictPort: true,
      watch: {
        usePolling: true,
      },
    },
  };
});
