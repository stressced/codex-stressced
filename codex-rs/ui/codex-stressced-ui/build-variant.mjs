import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const variant = process.argv[2];
if (variant !== "lite" && variant !== "full") {
  console.error("Usage: node build-variant.mjs <lite|full>");
  process.exit(1);
}

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const releaseDir = `release-${variant}`;
const productName = variant === "lite" ? "Codex Stressced Lite" : "Codex Stressced Full";
const appId = variant === "lite" ? "local.codexstressced.ui.lite" : "local.codexstressced.ui.full";
const cargoBin = path.join(process.env.USERPROFILE || "", ".cargo", "bin");
const env = {
  ...process.env,
  CODEX_STRESSCED_UI_VARIANT: variant,
  PATH: existsSync(cargoBin) ? `${cargoBin}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH,
};

function bin(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(bin("npm"), ["run", "typecheck"]);
run(process.execPath, ["build-backend.mjs"]);
run(path.join(root, "node_modules", ".bin", bin("vite")), ["build"]);
run(process.execPath, ["build-electron.mjs"]);
run(
  process.execPath,
  [
    path.join(root, "node_modules", "electron-builder", "cli.js"),
    `--config.directories.output=${releaseDir}`,
    `--config.productName=${productName}`,
    `--config.appId=${appId}`,
  ],
);

console.log(`\nCodex Stressced ${variant} build complete -> ${releaseDir}`);
