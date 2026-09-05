import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  "vendor",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "out",
  "public",
]);

export const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
export const TEST_EXTENSIONS = new Set([".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".test.js", ".test.jsx", ".spec.js", ".spec.jsx"]);

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

export function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

export function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isTestFile(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return Array.from(TEST_EXTENSIONS).some((suffix) => normalized.endsWith(suffix));
}

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(getExtension(filePath));
}

export function getPackageNameFromImport(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".")) {
    return undefined;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }

  const [name] = specifier.split("/");
  return name || undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function dedupeStrings(values: string[]): string[] {
  return unique(values.filter(Boolean));
}

export async function walkFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await visit(path.join(currentDir, entry.name));
        continue;
      }

      results.push(path.join(currentDir, entry.name));
    }
  }

  await visit(rootDir);
  return results;
}

export function shortFileName(filePath: string): string {
  return normalizeRelativePath(filePath).replace(/^.*src\//, "src/");
}

export function relativeFrom(rootDir: string, filePath: string): string {
  return normalizeRelativePath(path.relative(rootDir, filePath));
}

