import fs from "node:fs/promises";
import path from "node:path";

export interface AuditConfig {
  ignorePaths: string[];
  disabledRules: string[];
  thresholds: {
    componentLines: number;
    minScore: number;
    maxBundleKb: number;
  };
  bundleMetadata?: string;
}

export interface AuditConfigOverrides {
  ignorePaths?: string[];
  disabledRules?: string[];
  thresholds?: Partial<AuditConfig["thresholds"]>;
  bundleMetadata?: string;
}

export const DEFAULT_CONFIG: AuditConfig = {
  ignorePaths: [],
  disabledRules: [],
  thresholds: { componentLines: 300, minScore: 0, maxBundleKb: 0 },
};

const SUPPORTED_RULES = new Set([
  "architecture", "large-components", "use-effect", "missing-keys", "bundle-size",
  "typescript-any", "unused-dependencies", "parse-error",
]);

export async function loadConfig(rootDir: string, configPath?: string): Promise<AuditConfig> {
  const filePath = configPath ? path.resolve(rootDir, configPath) : path.join(rootDir, ".react-audit.json");
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!configPath && (error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Cannot read configuration file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in configuration file ${filePath}.`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Configuration in ${filePath} must be a JSON object.`);
  }

  const raw = input as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((key) => !["ignorePaths", "disabledRules", "thresholds", "bundleMetadata"].includes(key));
  if (unknownKeys.length > 0) throw new Error(`Unknown configuration option(s): ${unknownKeys.join(", ")}.`);
  const thresholds = raw.thresholds === undefined ? {} : raw.thresholds;
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
    throw new Error('Configuration "thresholds" must be an object.');
  }
  const thresholdInput = thresholds as Record<string, unknown>;
  const unknownThresholds = Object.keys(thresholdInput).filter((key) => !["componentLines", "minScore", "maxBundleKb"].includes(key));
  if (unknownThresholds.length > 0) throw new Error(`Unknown threshold(s): ${unknownThresholds.join(", ")}.`);
  const result: AuditConfig = {
    ignorePaths: stringArray(raw.ignorePaths, "ignorePaths"),
    disabledRules: stringArray(raw.disabledRules, "disabledRules"),
    thresholds: { ...DEFAULT_CONFIG.thresholds },
    ...(typeof raw.bundleMetadata === "string" ? { bundleMetadata: raw.bundleMetadata } : {}),
  };
  const unsupportedRules = result.disabledRules.filter((rule) => !SUPPORTED_RULES.has(rule));
  if (unsupportedRules.length > 0) throw new Error(`Unknown disabled rule(s): ${unsupportedRules.join(", ")}.`);

  for (const key of ["componentLines", "minScore", "maxBundleKb"] as const) {
    const value = thresholdInput[key];
    if (value !== undefined) {
      const minimum = key === "minScore" ? 0 : 1;
      const maximum = key === "minScore" ? 100 : Number.MAX_SAFE_INTEGER;
      if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error(`Configuration threshold "${key}" must be a number between ${minimum} and ${maximum}.`);
      }
      result.thresholds[key] = value;
    }
  }
  if (raw.bundleMetadata !== undefined && (typeof raw.bundleMetadata !== "string" || !raw.bundleMetadata.trim())) {
    throw new Error('Configuration "bundleMetadata" must be a non-empty file path string.');
  }
  return result;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Configuration "${name}" must be an array of non-empty strings.`);
  }
  return [...new Set(value as string[])];
}

export function matchesIgnorePath(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const glob = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!glob) return false;
    const expression = glob
      .split(/(\*\*|\*|\?)/g)
      .map((part) => part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join("");
    return new RegExp(`^(?:${expression})(?:/.*)?$`).test(normalized);
  });
}




