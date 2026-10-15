import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function loadSource(relativePath) {
  const entry = fileURLToPath(new URL(relativePath, import.meta.url));
  const require = createRequire(import.meta.url);
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    loader: { ".css": "empty" },
    plugins: [{ name: "shared-react", setup(build) {
      build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
