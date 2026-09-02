import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function loadSource(relativePath) {
  const entry = fileURLToPath(new URL(relativePath, import.meta.url));
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
