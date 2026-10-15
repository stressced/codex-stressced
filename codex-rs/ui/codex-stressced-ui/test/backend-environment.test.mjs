import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadSource } from "./bundle.mjs";

const { backendEnvironment } = await loadSource("../electron/backend-environment.ts");

test("portable backend supplies its actual executable to shell wrappers, replacing stale paths", () => {
  const binary = path.resolve("portable resources", "codexstressced.exe");
  const inherited = { USERPROFILE: path.resolve("user"), CODEXSTRESSCED_EXE: "deleted-build/codexstressced.exe", APPLY_PATCH: "custom-wrapper.bat" };
  assert.deepEqual(backendEnvironment(binary, inherited), {
    ...inherited,
    CODEXSTRESSCED_EXE: binary,
    CODEX_HOME: path.join(inherited.USERPROFILE, ".llmlocal"),
    RUST_BACKTRACE: "1",
    RUST_LOG: "warn",
  });
  assert.equal(inherited.CODEXSTRESSCED_EXE, "deleted-build/codexstressced.exe");
});

test("custom backend home and logging configuration survive launch", () => {
  const inherited = { CODEX_HOME: "custom-home", RUST_BACKTRACE: "0", RUST_LOG: "debug" };
  assert.deepEqual(backendEnvironment("custom-backend.exe", inherited), {
    ...inherited, CODEXSTRESSCED_EXE: path.resolve("custom-backend.exe"),
  });
});
