<h1 align="center">Codex Stressced</h1>

<p align="center">
  Local/offline AI coding workflow derived from OpenAI Codex, adapted for llama.cpp and a dedicated desktop UI.
</p>

> This is an independent derivative project based on OpenAI Codex. It is not an official OpenAI product or distribution.

## Summary

Codex Stressced keeps the upstream OpenAI Codex source foundation and adapts it for a local-first workflow. The goal is to run a Codex-style coding agent against a local `llama.cpp` server, with no cloud model dependency in Stressced mode, and to provide a dedicated Electron desktop UI for that workflow.

At a high level:

- The Rust backend is based on OpenAI Codex and includes a `codexstressced` binary built from `codex-rs/cli`.
- Stressced mode configures Codex for local/offline inference through a `llama.cpp` OpenAI-compatible API, typically `http://127.0.0.1:8080/v1`.
- The Electron UI in `codex-rs/ui/codex-stressced-ui` launches or connects to the local app-server flow and communicates with it through RPC/WebSocket plumbing.
- The UI is packaged with the generated `codexstressced` backend binary during release builds, but generated binaries are not tracked in git.
- Source code, lockfiles, manifests, scripts, licenses, and build configuration are tracked so the project can be rebuilt from source.

## Relationship To OpenAI Codex

Codex Stressced is a derivative work of OpenAI Codex. It preserves the original Apache-2.0 license and notices in `LICENSE` and `NOTICE`, while adding local/offline behavior and a separate UI focused on llama.cpp usage.

This repository should not be presented as an official OpenAI repository, release, package, or support channel. The upstream Codex README is preserved below for reference because much of the base architecture, CLI, app-server, protocol, and workspace structure still comes from OpenAI Codex.

## Build Notes

The repository is intended to track source code and reproducible build configuration only. Generated artifacts such as `target/`, `node_modules/`, `dist*/`, `release/`, `.exe`, `.dll`, `.asar`, `.pak`, and local Cargo caches should stay outside git.

For local Windows builds, the Codex Stressced UI build script uses a Cargo target cache outside the repository at `D:\codex-stressced-cargo-target` when `D:\` is available. This keeps the repo small while avoiding slow builds on `C:\`.

### Codex Stressced UI Builds

The Stressced desktop UI lives in `codex-rs/ui/codex-stressced-ui`.

Install frontend dependencies before building:

```powershell
cd D:\codex\codex\codex-rs\ui\codex-stressced-ui
npm ci
```

Build the default package:

```powershell
npm run build
```

Build the lightweight package:

```powershell
.\build-codexstressced-lite.ps1
```

Build the full Markdown package:

```powershell
.\build-codexstressced-full.ps1
```

Both variant scripts call `build-variant.mjs`, build the Rust backend through `build-backend.mjs`, build the Vite frontend, build the Electron main process, and package with `electron-builder`.

The generated packages are written to:

- `release-lite/` for Lite
- `release-full/` for Full

These directories are generated artifacts and should not be committed.

### Lite vs Full UI

Lite and Full share the same backend, app-server connection, chat state, Full Access behavior, Thinking swap, local image handling, scroll behavior, and error detection. The difference is only the assistant-message renderer selected at build time through `CODEX_STRESSCED_UI_VARIANT`.

- Lite uses `src/assistant-message/lite.tsx`. It renders assistant text directly with preserved whitespace and minimal React work. This is the fastest mode and is recommended for long local-model summaries, high token streaming, and day-to-day llama.cpp usage.
- Full uses `src/assistant-message/full.tsx` and `src/assistant-message/full.css`. It renders Markdown through `react-markdown` with `remark-gfm`, so bold text, headings, lists, code blocks, blockquotes, and tables display more cleanly. It throttles streaming Markdown updates to reduce render cost, but it is still heavier than Lite.

Use Lite when performance is the priority. Use Full when readable Markdown summaries and tables are more important than maximum streaming smoothness.

### Current Stressced Workflow Additions

The current Stressced changes include:

- Additional local-agent guidance for Windows shell behavior, PowerShell syntax, MCP transport failures, and avoiding repeated toolchain loops.
- A repeated-tool-call guard that blocks identical or similar repeated tool calls in one turn, including common repeated build/toolchain families such as `ninja`, `meson setup`, `cl.exe`, `vcvarsall.bat`, and Windows Kits directory listing loops.
- A Stressced shell preflight/guard layer for local-agent tool mistakes. It corrects repeated Windows command mistakes (`head`, `rg -rn`, `--include`), rejects MCP `safe_edit_*` names typed into PowerShell, catches invalid `$env:SAFE_EDIT` / `$env:APPLY_PATCH` invocation and `$env:APPLY_PATCH -` usage, blocks Bash heredocs in PowerShell, blocks broad rewrites of existing source-like files, and refuses destructive `Remove-Item`/`rm`/`del` deletes of source/config/docs. The intent is instructional: use MCP Safe Edit when the tool exists, or `& $env:SAFE_EDIT` / `& $env:APPLY_PATCH` in shell-only sessions.
- UI-side environment error detection for repeated Windows sandbox, MCP transport, PowerShell parser, mixed shell, tool-task, Hashcat/CUDA, and malformed tool-argument failures.
- Best-effort interruption of an active turn before sending a new message, so a stuck local turn is less likely to block the next prompt.
- Chat auto-scroll behavior that follows output while the user is at the bottom, stops following when the user scrolls up manually, and starts loaded chats at the latest message.
- Lite/Full assistant-message renderer variants and build scripts for both packages.

Useful checks:

```powershell
cd D:\codex\codex\codex-rs
just fmt
just test -p codex-cli
```

```powershell
cd D:\codex\codex\codex-rs\ui\codex-stressced-ui
npm ci
npm run build
```

## Upstream Codex README

---

<p align="center"><strong>Codex CLI</strong> is a coding agent from OpenAI that runs locally on your computer.
<p align="center">
  <img src="https://github.com/openai/codex/blob/main/.github/codex-cli-splash.png" alt="Codex CLI splash" width="80%" />
</p>
</br>
If you want Codex in your code editor (VS Code, Cursor, Windsurf), <a href="https://developers.openai.com/codex/ide">install in your IDE.</a>
</br>If you want the desktop app experience, run <code>codex app</code> or visit <a href="https://chatgpt.com/codex?app-landing-page=true">the Codex App page</a>.
</br>If you are looking for the <em>cloud-based agent</em> from OpenAI, <strong>Codex Web</strong>, go to <a href="https://chatgpt.com/codex">chatgpt.com/codex</a>.</p>

---

## Quickstart

### Installing and running Codex CLI

Run the following on Mac or Linux to install Codex CLI:

```shell
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Run the following on Windows to install Codex CLI:

```
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Codex CLI can also be installed via the following package managers:

```shell
# Install using npm
npm install -g @openai/codex
```

```shell
# Install using Homebrew
brew install --cask codex
```

Then simply run `codex` to get started.

<details>
<summary>You can also go to the <a href="https://github.com/openai/codex/releases/latest">latest GitHub Release</a> and download the appropriate binary for your platform.</summary>

Each GitHub Release contains many executables, but in practice, you likely want one of these:

- macOS
  - Apple Silicon/arm64: `codex-aarch64-apple-darwin.tar.gz`
  - x86_64 (older Mac hardware): `codex-x86_64-apple-darwin.tar.gz`
- Linux
  - x86_64: `codex-x86_64-unknown-linux-musl.tar.gz`
  - arm64: `codex-aarch64-unknown-linux-musl.tar.gz`

Each archive contains a single entry with the platform baked into the name (e.g., `codex-x86_64-unknown-linux-musl`), so you likely want to rename it to `codex` after extracting it.

</details>

### Using Codex with your ChatGPT plan

Run `codex` and select **Sign in with ChatGPT**. We recommend signing into your ChatGPT account to use Codex as part of your Plus, Pro, Business, Edu, or Enterprise plan. [Learn more about what's included in your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-in-chatgpt).

You can also use Codex with an API key, but this requires [additional setup](https://developers.openai.com/codex/auth#sign-in-with-an-api-key).

## Docs

- [**Codex Documentation**](https://developers.openai.com/codex)
- [**Contributing**](./docs/contributing.md)
- [**Installing & building**](./docs/install.md)
- [**Open source fund**](./docs/open-source-fund.md)

This repository is licensed under the [Apache-2.0 License](LICENSE).
