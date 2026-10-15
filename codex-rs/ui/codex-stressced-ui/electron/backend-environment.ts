import path from "node:path";

export function backendEnvironment(binary: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...inherited,
    CODEXSTRESSCED_EXE: path.resolve(binary),
    CODEX_HOME: inherited.CODEX_HOME || path.join(inherited.USERPROFILE || inherited.HOME || "", ".llmlocal"),
    RUST_BACKTRACE: inherited.RUST_BACKTRACE ?? "1",
    RUST_LOG: inherited.RUST_LOG ?? "warn",
  };
}
