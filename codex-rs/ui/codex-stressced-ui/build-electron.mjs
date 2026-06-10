// build-electron.mjs: compile electron/ to dist-electron/ using esbuild as CommonJS
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const outDir = "dist-electron";
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

async function build(entry, outFile) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    mainFields: ["module", "main"],
    outfile: outFile,
    external: ["electron"],
    format: "cjs",
    sourcemap: true,
    loader: { ".ts": "ts", ".tsx": "tsx" },
  });
}

await build("electron/main.ts", join(outDir, "main.cjs"));
await build("electron/preload.ts", join(outDir, "preload.cjs"));

// Copy public assets if present
if (existsSync("public")) {
  const files = readdirSync("public");
  for (const f of files) {
    copyFileSync(join("public", f), join(outDir, f));
  }
}

console.log("Electron build complete →", outDir);
