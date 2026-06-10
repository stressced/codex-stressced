import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codexRsRoot = path.resolve(__dirname, "../..");
const preferredTargetRoot = "D:\\codex-stressced-cargo-target";
const targetDir =
  process.env.CODEX_STRESSCED_CARGO_TARGET_DIR ||
  (existsSync("D:\\") ? preferredTargetRoot : path.join(tmpdir(), "codex-stressced-cargo-target"));
const exeName = process.platform === "win32" ? "codexstressced.exe" : "codexstressced";

const result = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    path.join(codexRsRoot, "Cargo.toml"),
    "-p",
    "codex-cli",
    "--features",
    "stressced",
    "--bin",
    "codexstressced",
  ],
  {
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const builtExe = path.join(targetDir, "debug", exeName);
if (!existsSync(builtExe)) {
  throw new Error(`Expected backend binary was not produced: ${builtExe}`);
}

const outDir = path.join(__dirname, "dist-backend");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(builtExe, path.join(outDir, exeName));
