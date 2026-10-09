#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { analyzeProject } from "./analyzer.js";
import { applyBaseline, readBaseline, writeBaseline } from "./baseline.js";
import { loadConfig } from "./config.js";
import { renderHtmlReport, renderTextReport } from "./reporters.js";
import { renderSarifReport } from "./sarif.js";

function createProgram(): Command {
  const program = new Command();
  program
  .name("react-audit")
  .description("Analyze a React project and generate a quality score with recommendations.")
  .argument("[target]", "Project directory to analyze", ".")
  .option("-f, --format <format>", "text | json | html | sarif", "text")
  .option("-o, --output <file>", "Output file for the report")
  .option("--config <file>", "Configuration file (default: .react-audit.json)")
  .option("--min-score <score>", "Fail CI when the score is below this value", (value) => Number(value))
  .option("--ci", "Use CI exit status (fail on score threshold or new baseline findings)")
  .option("--baseline <file>", "Compare findings against a baseline")
  .option("--update-baseline <file>", "Write current findings to a baseline file")
  .option("--ai", "Enable AI suggestions")
  .option("--ai-provider <provider>", "openai | azure | auto", "auto")
  .option("--ai-model <model>")
  .option("--ai-base-url <url>")
  .option("--ai-api-key <key>")
  .option("--ai-deployment <deployment>")
  .option("--ai-api-version <version>")
  .action(async (target: string, options: Record<string, string | number | boolean | undefined>) => {
    const rootDir = path.resolve(process.cwd(), target);
    const format = String(options.format ?? "text").toLowerCase();
    const wantsHtml = format === "html";
    const outputPath = options.output
      ? path.resolve(process.cwd(), String(options.output))
      : wantsHtml
        ? path.join(rootDir, "report.html")
        : undefined;

    try {
      if (!["text", "json", "html", "sarif"].includes(format)) {
        throw new Error(`Unsupported format "${format}". Use text, json, html, or sarif.`);
      }

      const targetStats = await fs.stat(rootDir).catch(() => undefined);
      if (!targetStats?.isDirectory()) {
        throw new Error(`Target directory does not exist or is not a directory: ${rootDir}`);
      }

      const config = await loadConfig(rootDir, options.config ? String(options.config) : undefined);
      if (options.minScore !== undefined && (typeof options.minScore !== "number" || !Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 100)) {
        throw new Error("--min-score must be a number between 0 and 100.");
      }
      if (options.minScore !== undefined) config.thresholds.minScore = options.minScore;

      const analysis = await analyzeProject(rootDir, {
        config,
        ai: Boolean(options.ai),
        aiProvider: options.aiProvider as "openai" | "azure" | "auto" | undefined,
        aiModel: options.aiModel ? String(options.aiModel) : undefined,
        aiBaseUrl: options.aiBaseUrl ? String(options.aiBaseUrl) : undefined,
        aiApiKey: options.aiApiKey ? String(options.aiApiKey) : undefined,
        aiDeployment: options.aiDeployment ? String(options.aiDeployment) : undefined,
        aiApiVersion: options.aiApiVersion ? String(options.aiApiVersion) : undefined,
      });

      if (options.updateBaseline) {
        await writeBaseline(path.resolve(rootDir, String(options.updateBaseline)), analysis.findings);
      }

      let newFindings = analysis.findings.filter((finding) => finding.severity !== "info").length;
      if (options.baseline) {
        const baselinePath = path.resolve(rootDir, String(options.baseline));
        const baseline = await readBaseline(baselinePath);
        const compared = applyBaseline(analysis.findings, baseline);
        newFindings = compared.findings.filter((finding) => finding.severity !== "info").length;
        analysis.baseline = { ignoredFindings: compared.ignoredCount };
        analysis.findings = compared.findings;
      }

      const minScore = config.thresholds.minScore;
      const scorePassed = analysis.score >= minScore;
      const ciPassed = scorePassed && (!options.baseline || newFindings === 0);
      analysis.ci = { passed: ciPassed, minScore, scorePassed, newFindings };

      let output = "";
      if (format === "json") {
        output = JSON.stringify(analysis, null, 2) + "\n";
      } else if (format === "html") {
        output = renderHtmlReport(analysis);
      } else if (format === "sarif") {
        output = renderSarifReport(analysis);
      } else {
        output = renderTextReport(analysis);
      }

      if (outputPath) {
        await fs.writeFile(outputPath, output, "utf8");
        console.error(`Report written to: ${outputPath}`);
      } else {
        process.stdout.write(output);
      }
      if (options.updateBaseline) console.error(`Baseline updated: ${path.resolve(rootDir, String(options.updateBaseline))}`);
      const enforceCi = Boolean(options.ci || options.minScore !== undefined || options.baseline || config.thresholds.minScore > 0);
      if (enforceCi && !ciPassed) process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`react-audit encountered an error: ${message}`);
      process.exitCode = 1;
    }
    });
  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}

