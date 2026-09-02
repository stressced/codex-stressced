import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSource } from "./bundle.mjs";

const { localImageToDataUrl } = await loadSource("../electron/image-attachment.ts");

test("local images preserve every source byte and resolve relative to cwd", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stressced-image-"));
  try {
    const bytes = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(2_500_000, 0xa5),
    ]);
    fs.writeFileSync(path.join(directory, "captura.png"), bytes);

    const result = localImageToDataUrl("captura.png", directory);

    assert.equal(result, `data:image/png;base64,${bytes.toString("base64")}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
