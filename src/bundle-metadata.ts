import fs from "node:fs/promises";
import path from "node:path";

export interface BundleMeasurement {
  bytes: number;
  kilobytes: number;
  tool: "esbuild" | "webpack" | "vite";
  files: number;
}

export async function measureBundleMetadata(rootDir: string, metadataPath: string): Promise<BundleMeasurement> {
  const resolvedPath = path.resolve(rootDir, metadataPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read bundle metadata ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unsupported bundle metadata in ${resolvedPath}: expected a JSON object.`);
  }
  const data = parsed as Record<string, unknown>;
  const viteEntries = Object.values(data).filter(isRecord);
  let tool: BundleMeasurement["tool"];
  let sizes: number[];

  const esbuildMetadata = isRecord(data.metafile) ? data.metafile : data;
  if (isRecord(esbuildMetadata.outputs)) {
    tool = "esbuild";
    sizes = Object.entries(esbuildMetadata.outputs)
      .filter(([name]) => /\.(?:m?js|cjs)$/i.test(name) && !name.endsWith(".map"))
      .map(([, output]) => isRecord(output) ? output.bytes : undefined)
      .filter(isValidSize);
  } else if (Array.isArray(data.assets)) {
    tool = "webpack";
    sizes = data.assets
      .filter(isRecord)
      .filter((asset) => typeof asset.name === "string" && /\.(?:m?js|cjs)$/i.test(asset.name))
      .map((asset) => asset.size)
      .filter(isValidSize);
  } else if (viteEntries.length === Object.keys(data).length && viteEntries.some((entry) => typeof entry.file === "string")) {
    tool = "vite";
    const outputFiles = new Set(viteEntries
      .map((entry) => entry.file)
      .filter((file): file is string => typeof file === "string" && /\.(?:m?js|cjs)$/i.test(file)));
    sizes = await Promise.all([...outputFiles].map(async (file) => {
      const candidates = [
        path.resolve(path.dirname(resolvedPath), file),
        path.resolve(path.dirname(resolvedPath), "..", file),
        path.resolve(rootDir, file),
      ];
      for (const candidate of [...new Set(candidates)]) {
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile()) return stat.size;
        } catch {
          // Try the next common Vite output directory.
        }
      }
      return undefined;
    })).then((values) => values.filter(isValidSize));
    if (sizes.length === 0 && outputFiles.size > 0) {
      throw new Error(`Vite manifest references JavaScript output files that could not be read relative to ${resolvedPath}.`);
    }
  } else {
    throw new Error(`Unsupported bundle metadata format in ${resolvedPath}. Expected esbuild metafile, Webpack stats assets, or Vite manifest.`);
  }

  if (sizes.length === 0) throw new Error(`No JavaScript bundle sizes found in ${resolvedPath}.`);
  const bytes = sizes.reduce((total, size) => total + size, 0);
  return { bytes, kilobytes: Math.round((bytes / 1024) * 10) / 10, tool, files: sizes.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}



