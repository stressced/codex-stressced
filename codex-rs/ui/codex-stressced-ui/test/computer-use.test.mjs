import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../electron/computer-use.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "no-desktop-access", setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
      export const screen = { getPrimaryDisplay() { throw new Error("Unexpected desktop access"); } };
      export const desktopCapturer = { getSources() { throw new Error("Unexpected capture"); } };
    ` }));
  } }],
});
const { executeComputerTool } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("invalid computer actions explain the actual API before reading coordinates or the desktop", async () => {
  for (const args of [{ action: "left_click", x: 400, y: 152 }, { action: "left_click" }]) {
    assert.deepEqual(await executeComputerTool("computer", args), {
      contentItems: [{ type: "inputText", text:
        'Unsupported computer action: left_click. Valid actions: screenshot, move, click, double_click, drag, type, key, scroll, wait. ' +
        'For a left click use {"action":"click","button":"left","x":100,"y":100}, replacing x/y with the target coordinates from the screenshot.' }],
      success: false,
    });
  }
});
