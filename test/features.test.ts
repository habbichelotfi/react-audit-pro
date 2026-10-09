import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseline, findingFingerprint, readBaseline, writeBaseline } from "../src/baseline.js";
import { measureBundleMetadata } from "../src/bundle-metadata.js";
import { loadConfig, matchesIgnorePath } from "../src/config.js";
import { analyzeProject } from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import { renderSarifReport } from "../src/sarif.js";
import type { Finding } from "../src/types.js";

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "react-audit-features-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }), "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "App.tsx"), "export function App() {\n  return <div>{[1].map((item) => <span>{item}</span>)}</div>;\n}\n", "utf8");
  return root;
}

function finding(id: string, file: string, title = id): Finding {
  return { id, ruleId: "missing-keys", severity: "warning", title, description: "test", file, line: 2, suggestions: [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("configuration and rule filtering", () => {
  it("loads defaults, validates settings, and matches ignored paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "react-audit-config-"));
    expect((await loadConfig(root)).thresholds.componentLines).toBe(300);
    await fs.writeFile(path.join(root, ".react-audit.json"), JSON.stringify({
      ignorePaths: ["src/generated/**"],
      disabledRules: ["missing-keys"],
      thresholds: { componentLines: 42, minScore: 75 },
      bundleMetadata: "build/meta.json",
    }), "utf8");
    const config = await loadConfig(root);
    expect(config.thresholds).toMatchObject({ componentLines: 42, minScore: 75 });
    expect(config.disabledRules).toEqual(["missing-keys"]);
    expect(config.bundleMetadata).toBe("build/meta.json");
    expect(matchesIgnorePath("src/generated/Widget.tsx", config.ignorePaths)).toBe(true);
    expect(matchesIgnorePath("src/Widget.tsx", config.ignorePaths)).toBe(false);
    await fs.writeFile(path.join(root, ".react-audit.json"), "{bad", "utf8");
    await expect(loadConfig(root)).rejects.toThrow("Invalid JSON");
  });

  it("ignores configured source paths, applies size thresholds and disables rules", async () => {
    const root = await makeProject();
    await fs.mkdir(path.join(root, "src", "generated"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "generated", "Ignored.tsx"), "export const Ignored = () => <div />;", "utf8");
    const result = await analyzeProject(root, { config: {
      ignorePaths: ["src/generated/**"],
      disabledRules: ["missing-keys"],
      thresholds: { componentLines: 1, minScore: 0, maxBundleKb: 0 },
    } });
    expect(result.files.some((file) => file.file.includes("generated"))).toBe(false);
    expect(result.findings.some((item) => item.id.startsWith("large-component"))).toBe(true);
    expect(result.findings.some((item) => item.ruleId === "missing-keys" || item.id === "missing-keys")).toBe(false);
  });
});

describe("baseline regression tracking", () => {
  it("writes, reads and distinguishes known findings from regressions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "react-audit-baseline-"));
    const known = finding("missing-key-a", "src/A.tsx");
    const added = finding("missing-key-b", "src/B.tsx");
    const file = path.join(root, "nested", "baseline.json");
    await writeBaseline(file, [known]);
    const baseline = await readBaseline(file);
    const compared = applyBaseline([known, added], baseline);
    expect(compared.findings.map((item) => item.file)).toEqual(["src/B.tsx"]);
    expect(compared.ignoredCount).toBe(1);
    expect(baseline.fingerprints).toContain(findingFingerprint(known));
  });
});

describe("build metadata and SARIF", () => {
  it("measures esbuild, Webpack and Vite JavaScript output sizes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "react-audit-bundle-"));
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "app.js"), "123456", "utf8");
    const esbuild = path.join(root, "esbuild.json");
    await fs.writeFile(esbuild, JSON.stringify({ outputs: { "dist/app.js": { bytes: 12 }, "dist/app.js.map": { bytes: 900 } } }), "utf8");
    expect(await measureBundleMetadata(root, esbuild)).toMatchObject({ tool: "esbuild", bytes: 12, files: 1 });
    const webpack = path.join(root, "webpack.json");
    await fs.writeFile(webpack, JSON.stringify({ assets: [{ name: "app.js", size: 24 }, { name: "app.css", size: 8 }] }), "utf8");
    expect(await measureBundleMetadata(root, webpack)).toMatchObject({ tool: "webpack", bytes: 24, files: 1 });
    const vite = path.join(root, "dist", "manifest.json");
    await fs.writeFile(vite, JSON.stringify({ "src/main.ts": { file: "app.js", isEntry: true } }), "utf8");
    expect(await measureBundleMetadata(root, vite)).toMatchObject({ tool: "vite", bytes: 6, files: 1 });
    await fs.writeFile(path.join(root, "bad.json"), "{}", "utf8");
    await expect(measureBundleMetadata(root, "bad.json")).rejects.toThrow("Unsupported bundle metadata");
  });

  it("adds measured bundle statistics and enforces the configured limit", async () => {
    const root = await makeProject();
    await fs.writeFile(path.join(root, "meta.json"), JSON.stringify({ outputs: { "dist/app.js": { bytes: 4096 } } }), "utf8");
    const atLimit = await analyzeProject(root, { config: {
      bundleMetadata: "meta.json", thresholds: { maxBundleKb: 4 },
    } });
    expect(atLimit.findings.some((item) => item.id === "bundle-size-threshold")).toBe(false);
    const result = await analyzeProject(root, { config: {
      ignorePaths: [], disabledRules: [], bundleMetadata: "meta.json",
      thresholds: { componentLines: 300, minScore: 0, maxBundleKb: 2 },
    } });
    expect(result.stats.realBundleBytes).toBe(4096);
    expect(result.stats.realBundleKb).toBe(4);
    expect(result.findings.some((item) => item.id === "bundle-size-threshold")).toBe(true);
  });

  it("generates SARIF 2.1.0 with file locations", async () => {
    const root = await makeProject();
    const analysis = await analyzeProject(root);
    const report = JSON.parse(renderSarifReport(analysis));
    expect(report.version).toBe("2.1.0");
    expect(report.runs[0].tool.driver.name).toBe("react-audit-pro");
    expect(report.runs[0].results.some((result: { locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string } } }> }) =>
      result.locations?.[0]?.physicalLocation?.artifactLocation?.uri === "src/App.tsx")).toBe(true);
  });
});

describe("empty, malformed and AI-failure projects", () => {
  it("returns a valid result for an empty project and reports parse errors", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "react-audit-empty-"));
    const result = await analyzeProject(empty);
    expect(result.stats.sourceFiles).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);

    const malformed = await makeProject();
    await fs.writeFile(path.join(malformed, "src", "broken.tsx"), "export const = <>", "utf8");
    const parsed = await analyzeProject(malformed);
    expect(parsed.findings.some((item) => item.id === "parse-error")).toBe(true);

    await fs.writeFile(path.join(malformed, "package.json"), "{ invalid", "utf8");
    const invalidManifest = await analyzeProject(malformed);
    expect(invalidManifest.packageSnapshot.name).toBeUndefined();
    expect(invalidManifest.packageSnapshot.isReactProject).toBe(true);
  });

  it("reports AI network failures without failing the audit", async () => {
    const root = await makeProject();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await analyzeProject(root, { ai: true, aiProvider: "openai", aiApiKey: "test-key" });
    expect(result.ai?.enabled).toBe(false);
    expect(result.ai?.skippedReason).toContain("offline");
  });

  it("surfaces provider HTTP failures as a skipped AI summary", async () => {
    const root = await makeProject();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const result = await analyzeProject(root, { ai: true, aiProvider: "openai", aiApiKey: "test-key" });
    expect(result.ai?.enabled).toBe(false);
    expect(result.ai?.skippedReason).toContain("429");
  });

  it("skips AI cleanly when an API key is missing", async () => {
    const root = await makeProject();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await analyzeProject(root, { ai: true, aiProvider: "openai", aiApiKey: "" });
    expect(result.ai?.skippedReason).toContain("No API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("CLI", () => {
  it("writes machine-readable JSON and returns a failing CI status below the score threshold", async () => {
    const root = await makeProject();
    const output = path.join(root, "audit.json");
    await runCli(["node", "react-audit", root, "--format", "json", "--output", output, "--min-score", "100"]);
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    expect(report.ci.scorePassed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("rejects missing project paths with a non-zero exit code", async () => {
    await runCli(["node", "react-audit", "/path/that/does/not/exist"]);
    expect(process.exitCode).toBe(1);
  });

  it("fails CI for new baseline findings and emits SARIF through the CLI", async () => {
    const root = await makeProject();
    const baselineFile = path.join(root, "baseline.json");
    const sarifFile = path.join(root, "results.sarif");
    await writeBaseline(baselineFile, []);
    await runCli(["node", "react-audit", root, "--ci", "--baseline", baselineFile, "--format", "sarif", "--output", sarifFile]);
    expect(process.exitCode).toBe(1);
    const sarif = JSON.parse(await fs.readFile(sarifFile, "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.length).toBeGreaterThan(0);
  });
});





