#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { analyzeProject } from "./analyzer.js";
import { renderHtmlReport, renderTextReport } from "./reporters.js";

const program = new Command();

program
  .name("react-audit")
  .description("Analyze a React project and generate a quality score with recommendations.")
  .argument("[target]", "Project directory to analyze", ".")
  .option("-f, --format <format>", "text | json | html", "text")
  .option("-o, --output <file>", "Output file for the report")
  .option("--ai", "Enable AI suggestions")
  .option("--ai-provider <provider>", "openai | azure | auto", "auto")
  .option("--ai-model <model>")
  .option("--ai-base-url <url>")
  .option("--ai-api-key <key>")
  .option("--ai-deployment <deployment>")
  .option("--ai-api-version <version>")
  .action(async (target: string, options: Record<string, string | boolean | undefined>) => {
    const rootDir = path.resolve(process.cwd(), target);
    const format = String(options.format ?? "text").toLowerCase();
    const wantsHtml = format === "html";
    const outputPath = options.output
      ? path.resolve(process.cwd(), String(options.output))
      : wantsHtml
        ? path.join(rootDir, "report.html")
        : undefined;

    try {
      const analysis = await analyzeProject(rootDir, {
        ai: Boolean(options.ai),
        aiProvider: options.aiProvider as "openai" | "azure" | "auto" | undefined,
        aiModel: options.aiModel ? String(options.aiModel) : undefined,
        aiBaseUrl: options.aiBaseUrl ? String(options.aiBaseUrl) : undefined,
        aiApiKey: options.aiApiKey ? String(options.aiApiKey) : undefined,
        aiDeployment: options.aiDeployment ? String(options.aiDeployment) : undefined,
        aiApiVersion: options.aiApiVersion ? String(options.aiApiVersion) : undefined,
      });

      let output = "";
      if (format === "json") {
        output = JSON.stringify(analysis, null, 2) + "\n";
      } else if (format === "html") {
        output = renderHtmlReport(analysis);
      } else {
        output = renderTextReport(analysis);
      }

      if (outputPath) {
        await fs.writeFile(outputPath, output, "utf8");
        if (format === "html") {
          console.log(`HTML report generated: ${outputPath}`);
        } else {
          console.log(output);
          console.log(`\nReport written to: ${outputPath}`);
        }
      } else {
        process.stdout.write(output);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`react-audit encountered an error: ${message}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

