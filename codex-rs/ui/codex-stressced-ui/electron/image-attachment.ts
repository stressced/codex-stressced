import fs from "fs";
import path from "path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);

export function localImageToDataUrl(filePath: string, cwd?: string): string | null {
  const requestedPath = String(filePath || "").trim().replace(/^["']|["']$/g, "");
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(String(cwd || process.cwd()), requestedPath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return null;
  if (!fs.existsSync(resolvedPath)) return null;

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) return null;

  const mime = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".webp"
      ? "image/webp"
      : extension === ".bmp"
        ? "image/bmp"
        : extension === ".gif"
          ? "image/gif"
          : "image/png";
  return `data:${mime};base64,${fs.readFileSync(resolvedPath).toString("base64")}`;
}
