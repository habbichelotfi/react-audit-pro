import type { AnalysisResult, Finding } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scoreEmoji(score: number): string {
  if (score >= 80) {
    return "🟢";
  }
  if (score >= 60) {
    return "🟡";
  }
  return "🔴";
}

function severityIcon(severity: Finding["severity"]): string {
  switch (severity) {
    case "critical":
      return "❌";
    case "warning":
      return "⚠️";
    case "info":
      return "ℹ️";
    default:
      return "•";
  }
}

function formatFileLocation(finding: Finding): string {
  if (!finding.file) {
    return "";
  }
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

export function renderTextReport(analysis: AnalysisResult): string {
  const lines: string[] = [];
  lines.push("🔍 Analyzing project...");
  lines.push("");

  if (analysis.packageSnapshot.isReactProject) {
    lines.push(`✅ React ${analysis.packageSnapshot.reactVersion ?? "detected"}`);
  } else {
    lines.push("⚠️ No clear React project detected");
  }

  if (analysis.packageSnapshot.hasTypeScript) {
    lines.push("✅ TypeScript enabled");
  } else {
    lines.push("ℹ️ TypeScript not detected");
  }

  lines.push("");
  lines.push("⚠️ Detected issues:");
  lines.push("");

  const problemFindings = analysis.findings.filter((finding) => finding.severity !== "info");
  if (problemFindings.length === 0) {
    lines.push("No major issues detected.");
  } else {
    problemFindings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.title}`);
      if (finding.file) {
        lines.push(`   File: ${formatFileLocation(finding)}`);
      }
      lines.push(`   ${finding.description}`);
      if (finding.suggestions.length > 0) {
        lines.push("   Suggestions:");
        for (const suggestion of finding.suggestions) {
          lines.push(`   - ${suggestion}`);
        }
      }
      lines.push("");
    });
  }

  const infoFindings = analysis.findings.filter((finding) => finding.severity === "info");
  if (infoFindings.length > 0) {
    lines.push("ℹ️ Information:");
    lines.push("");
    for (const finding of infoFindings) {
      lines.push(`${severityIcon(finding.severity)} ${finding.title}`);
    }
    lines.push("");
  }

  lines.push("📊 Score breakdown:");
  for (const section of analysis.scoreBreakdown) {
    lines.push(`- ${section.name}: ${section.score}/${section.maxScore}`);
  }
  lines.push("");
  lines.push(`📊 Overall score: ${analysis.score}/100 ${scoreEmoji(analysis.score)}`);

  if (analysis.recommendations.length > 0) {
    lines.push("");
    lines.push("Priority recommendations:");
    analysis.recommendations.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  }

  if (analysis.ai?.enabled && analysis.ai.summary) {
    lines.push("");
    lines.push(`🤖 IA (${analysis.ai.provider}${analysis.ai.model ? ` / ${analysis.ai.model}` : ""}) :`);
    lines.push(analysis.ai.summary);
  } else if (analysis.ai?.skippedReason) {
    lines.push("");
    lines.push(`🤖 AI not used: ${analysis.ai.skippedReason}`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

function scoreClass(score: number): string {
  if (score >= 80) {
    return "good";
  }
  if (score >= 60) {
    return "warn";
  }
  return "bad";
}

export function renderHtmlReport(analysis: AnalysisResult): string {
  const findingsHtml = analysis.findings.map((finding) => {
    const suggestions = finding.suggestions.length > 0
      ? `<ul>${finding.suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join("")}</ul>`
      : "";
    return `
      <article class="card finding ${finding.severity}">
        <div class="finding-head">
          <span class="badge ${finding.severity}">${severityIcon(finding.severity)} ${escapeHtml(finding.severity.toUpperCase())}</span>
          <h3>${escapeHtml(finding.title)}</h3>
        </div>
        ${finding.file ? `<p class="muted">${escapeHtml(formatFileLocation(finding))}</p>` : ""}
        <p>${escapeHtml(finding.description)}</p>
        ${suggestions}
      </article>
    `;
  }).join("");

  const scoreRows = analysis.scoreBreakdown
    .map((section) => `<li><span>${escapeHtml(section.name)}</span><strong>${section.score}/${section.maxScore}</strong></li>`)
    .join("");

  const recommendationItems = analysis.recommendations
    .map((item, index) => `<li><strong>${index + 1}.</strong> ${escapeHtml(item)}</li>`)
    .join("");

  const aiBlock = analysis.ai?.enabled && analysis.ai.summary
    ? `<section class="card"><h2>AI suggestion</h2><p class="muted">${escapeHtml(analysis.ai.provider)}${analysis.ai.model ? ` / ${escapeHtml(analysis.ai.model)}` : ""}</p><p>${escapeHtml(analysis.ai.summary)}</p></section>`
    : analysis.ai?.skippedReason
      ? `<section class="card"><h2>AI suggestion</h2><p>${escapeHtml(analysis.ai.skippedReason)}</p></section>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>React Health Check Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #0f172a;
      --panel: #111827;
      --card: #1f2937;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --good: #22c55e;
      --warn: #f59e0b;
      --bad: #ef4444;
      --border: rgba(148, 163, 184, 0.2);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, var(--bg), #020617);
      color: var(--text);
    }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 32px 20px 56px; }
    header { display: grid; gap: 18px; margin-bottom: 24px; }
    .hero {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .card {
      background: rgba(17, 24, 39, 0.9);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
    }
    .score {
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .score .value { font-size: 3rem; font-weight: 800; line-height: 1; }
    .score.good .value { color: var(--good); }
    .score.warn .value { color: var(--warn); }
    .score.bad .value { color: var(--bad); }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 700;
    }
    .badge.warning { background: rgba(245, 158, 11, 0.16); color: #fcd34d; }
    .badge.critical { background: rgba(239, 68, 68, 0.16); color: #fca5a5; }
    .badge.info { background: rgba(59, 130, 246, 0.16); color: #93c5fd; }
    .finding h3 { margin: 0; font-size: 1.05rem; }
    .finding-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
    ul { margin: 10px 0 0 20px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 4px; }
    .list { display: grid; gap: 8px; padding-left: 0; list-style: none; }
    .list li { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.12); padding-bottom: 8px; }
    .stack { display: grid; gap: 12px; }
    .pill { display: inline-flex; padding: 6px 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.14); color: var(--text); font-size: 0.85rem; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; }
    .meta .pill.good { background: rgba(34, 197, 94, 0.18); }
    .meta .pill.warn { background: rgba(245, 158, 11, 0.18); }
    .meta .pill.bad { background: rgba(239, 68, 68, 0.18); }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>React Health Check</h1>
        <p class="muted">Project analysis: ${escapeHtml(analysis.rootDir)}</p>
      </div>
      <div class="hero">
        <section class="card score ${scoreClass(analysis.score)}">
          <div class="muted">Overall score</div>
          <div class="value">${analysis.score}/100</div>
          <div>${scoreEmoji(analysis.score)} Overall quality</div>
        </section>
        <section class="card stack">
          <div class="meta">
            <span class="pill ${analysis.packageSnapshot.isReactProject ? "good" : "bad"}">${analysis.packageSnapshot.isReactProject ? "React detected" : "React not detected"}</span>
            <span class="pill ${analysis.packageSnapshot.hasTypeScript ? "good" : "warn"}">TypeScript ${analysis.packageSnapshot.hasTypeScript ? "enabled" : "not detected"}</span>
            <span class="pill">${analysis.stats.components} components</span>
            <span class="pill">${analysis.stats.testFiles} test files</span>
            <span class="pill">${analysis.stats.anyCount} any</span>
          </div>
          <ul class="list">
            ${scoreRows}
          </ul>
        </section>
      </div>
    </header>

    <section class="stack" style="margin-bottom: 24px;">
      <div class="card">
        <h2>Priority recommendations</h2>
        <ol>${recommendationItems}</ol>
      </div>
      ${aiBlock}
    </section>

    <section>
      <h2>Findings</h2>
      <div class="grid">
        ${findingsHtml || `<div class="card">No major issues detected.</div>`}
      </div>
    </section>
  </div>
</body>
</html>`;
}

