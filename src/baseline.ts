import fs from "node:fs/promises";
import path from "node:path";
import type { Finding } from "./types.js";

export interface AuditBaseline {
  version: 1;
  fingerprints: string[];
}

export function findingRuleId(finding: Finding): string {
  if (finding.ruleId) return finding.ruleId;
  if (finding.id.startsWith("large-component") || finding.id === "large-components") return "large-components";
  if (finding.id.startsWith("use-effect")) return "use-effect";
  if (finding.id.startsWith("missing-key") || finding.id === "missing-keys") return "missing-keys";
  if (finding.id.startsWith("bundle-")) return "bundle-size";
  if (finding.id.startsWith("architecture-")) return "architecture";
  if (finding.id === "typescript-any") return "typescript-any";
  if (finding.id === "unused-dependencies") return "unused-dependencies";
  if (finding.id === "parse-error") return "parse-error";
  return finding.id;
}

export function findingFingerprint(finding: Finding): string {
  return JSON.stringify([
    findingRuleId(finding),
    finding.file?.replaceAll("\\", "/") ?? "",
    finding.line ?? 0,
    finding.title,
  ]);
}

export async function readBaseline(filePath: string): Promise<AuditBaseline> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read baseline ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid baseline in ${filePath}: expected an object.`);
  const input = parsed as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.fingerprints) || input.fingerprints.some((value) => typeof value !== "string")) {
    throw new Error(`Invalid baseline in ${filePath}: expected version 1 and a fingerprints array.`);
  }
  return { version: 1, fingerprints: [...new Set(input.fingerprints as string[])] };
}

export async function writeBaseline(filePath: string, findings: Finding[]): Promise<void> {
  const baseline: AuditBaseline = {
    version: 1,
    fingerprints: [...new Set(findings.filter((finding) => finding.severity !== "info").map(findingFingerprint))].sort(),
  };
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export function applyBaseline(findings: Finding[], baseline: AuditBaseline): { findings: Finding[]; ignoredCount: number } {
  const known = new Set(baseline.fingerprints);
  const remaining = findings.filter((finding) => finding.severity === "info" || !known.has(findingFingerprint(finding)));
  return { findings: remaining, ignoredCount: findings.length - remaining.length };
}
