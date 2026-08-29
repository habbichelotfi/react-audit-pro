import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analyzer.js";
import { renderHtmlReport, renderTextReport } from "../src/reporters.js";

async function createFixtureProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "react-health-check-"));
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "utils"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });

  const packageJson = {
    name: "fixture-app",
    private: true,
    dependencies: {
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      moment: "^2.30.1",
      lodash: "^4.17.21",
    },
    devDependencies: {
      typescript: "^5.9.2",
    },
  };

  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }, null, 2), "utf8");

  const fillerLines = Array.from({ length: 320 }, (_, index) => `  // filler ${index + 1}`).join("\n");
  const dashboard = `import React, { useEffect } from "react";

interface Props {
  value: string;
}

export function Dashboard(props: Props) {
${fillerLines}
  const items = [1, 2, 3];
  const local: any = props.value;

  useEffect(() => {
    console.log(props.value);
  }, []);

  return (
    <section>
      <h1>{local}</h1>
      <ul>
        {items.map((item) => (
          <li>{item}</li>
        ))}
      </ul>
    </section>
  );
}
`;

  const utils = `export const formatDate = (input: any) => input;\n`;
  const testFile = `import { describe, it, expect } from "vitest";\ndescribe("smoke", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});\n`;

  await fs.writeFile(path.join(root, "src", "components", "Dashboard.tsx"), dashboard, "utf8");
  await fs.writeFile(path.join(root, "src", "utils", "formatDate.ts"), utils, "utf8");
  await fs.writeFile(path.join(root, "tests", "smoke.test.ts"), testFile, "utf8");

  return root;
}

describe("analyzeProject", () => {
  it("detecte les principaux problèmes React et génère des rapports", async () => {
    const root = await createFixtureProject();
    const analysis = await analyzeProject(root);

    expect(analysis.packageSnapshot.isReactProject).toBe(true);
    expect(analysis.packageSnapshot.hasTypeScript).toBe(true);
    expect(analysis.stats.components).toBeGreaterThan(0);
    expect(analysis.stats.largeComponents).toBeGreaterThan(0);
    expect(analysis.stats.useEffectIssues).toBeGreaterThan(0);
    expect(analysis.stats.mapCallbacksWithoutKeys).toBeGreaterThan(0);
    expect(analysis.stats.anyCount).toBeGreaterThan(0);
    expect(analysis.stats.bundleEstimateKb).toBeGreaterThan(0);
    expect(analysis.findings.some((finding) => finding.id === "bundle-moment")).toBe(true);
    expect(analysis.score).toBeGreaterThanOrEqual(0);
    expect(analysis.score).toBeLessThan(100);

    const textReport = renderTextReport(analysis);
    expect(textReport).toContain("Score global");
    expect(textReport).toContain("React");
    expect(textReport).toContain("useEffect");

    const htmlReport = renderHtmlReport(analysis);
    expect(htmlReport).toContain("<!doctype html>");
    expect(htmlReport).toContain("React Health Check");
  });
});

