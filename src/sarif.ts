import path from "node:path";
import { findingRuleId } from "./baseline.js";
import type { AnalysisResult, Finding } from "./types.js";

export interface SarifReport {
  version: "2.1.0";
  $schema: string;
  runs: Array<{
    tool: { driver: { name: string; informationUri: string; rules: Array<{ id: string; shortDescription: { text: string } }> } };
    results: Array<Record<string, unknown>>;
  }>;
}

export function renderSarifReport(analysis: AnalysisResult): string {
  const findings = analysis.findings.filter((finding) => finding.severity !== "info");
  const rules = [...new Set(findings.map(findingRuleId))].map((id) => ({
    id,
    shortDescription: { text: ruleDescription(id) },
  }));
  const results = findings.map((finding) => toSarifResult(finding, analysis.rootDir));
  const report: SarifReport = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "react-audit-pro", informationUri: "https://www.npmjs.com/package/react-audit-pro", rules } },
      results,
    }],
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

function toSarifResult(finding: Finding, rootDir: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ruleId: findingRuleId(finding),
    level: finding.severity === "critical" ? "error" : "warning",
    message: { text: `${finding.title}: ${finding.description}` },
    properties: { suggestions: finding.suggestions },
  };
  if (finding.file) {
    const uri = path.relative(rootDir, path.resolve(rootDir, finding.file)).split(path.sep).join("/");
    result.locations = [{ physicalLocation: {
      artifactLocation: { uri },
      ...(finding.line ? { region: { startLine: finding.line } } : {}),
    } }];
  }
  return result;
}

function ruleDescription(id: string): string {
  const descriptions: Record<string, string> = {
    "large-components": "Component exceeds the configured size threshold",
    "use-effect": "Potentially problematic useEffect usage",
    "missing-keys": "Rendered list may be missing a stable key",
    "bundle-size": "Dependency or bundle size concern",
    architecture: "Architecture organization concern",
    "typescript-any": "TypeScript any usage",
    "unused-dependencies": "Unused runtime dependency",
    "parse-error": "Source file could not be parsed",
  };
  return descriptions[id] ?? id;
}
