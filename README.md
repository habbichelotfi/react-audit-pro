# react-audit-pro

CLI audit tool for React projects that analyzes architecture, performance, tests, and TypeScript. Generates an overall score with actionable recommendations.

## Features

- React AST analysis via Babel
- Detection of oversized components (>300 lines)
- `useEffect` and missing dependency checks
- Detection of lists without a `key`
- TypeScript analysis (excessive `any` usage)
- Heuristic bundle estimation
- Test and maintainability analysis
- Text, JSON, and HTML reports
- Optional AI suggestions (OpenAI / Azure OpenAI)
- Overall score out of 100

## Installation

```bash
npm install react-audit-pro
```

## Usage

### Analyze the current project

```bash
npx react-audit
```

### Analyze a specific directory

```bash
npx react-audit ./mon-projet
```

### Generate an HTML report

```bash
npx react-audit . --format html
```

The report is saved to `report.html`.

### Generate a JSON report

```bash
npx react-audit . --format json
```

### Set an explicit output file

```bash
npx react-audit . --format html --output mon-rapport.html
```

### Enable AI suggestions

```bash
npx react-audit . --ai
```

Requires an OpenAI or Azure OpenAI API key.

## AI configuration

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o-mini"  # optionnel

npx react-audit . --ai
```

Available variables:
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (optional, default: `gpt-4o-mini`)
- `OPENAI_BASE_URL` (optional)

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://..."
export AZURE_OPENAI_DEPLOYMENT="..."

npx react-audit . --ai --ai-provider azure
```

Available variables:
- `AZURE_OPENAI_API_KEY` (required)
- `AZURE_OPENAI_ENDPOINT` (required)
- `AZURE_OPENAI_DEPLOYMENT` (required)
- `AZURE_OPENAI_API_VERSION` (optional)

## CLI options

```
Usage: react-audit [options] [target]

Analyze a React project and generate a quality score with recommendations.

Arguments:
  target                        Project directory to analyze (default: ".")

Options:
  -f, --format <format>         Output format: text | json | html | sarif (default: "text")
  -o, --output <file>           Output file for the report
  --config <file>               Configuration file (default: .react-audit.json)
  --min-score <score>           Fail when the score is below this value (0-100)
  --ci                          Enable CI exit status
  --baseline <file>             Ignore findings already present in a baseline
  --update-baseline <file>      Write current findings to a baseline file
  --ai                          Enable AI suggestions
  --ai-provider <provider>      openai | azure | auto (default: "auto")
  --ai-model <model>            AI model to use
  --ai-base-url <url>           OpenAI base URL (optional)
  --ai-api-key <key>            API key (optional, uses env otherwise)
  --ai-deployment <deployment>  Azure OpenAI deployment
  --ai-api-version <version>    Azure OpenAI API version
  -h, --help                    Display help
```

## Configuration

An optional `.react-audit.json` in the project root can tune the audit. Paths are relative to the project root; ignore patterns support `*`, `**`, and `?`.

```json
{
  "ignorePaths": ["src/generated/**", "legacy/**"],
  "disabledRules": ["missing-keys", "unused-dependencies"],
  "thresholds": {
    "componentLines": 400,
    "minScore": 75,
    "maxBundleKb": 500
  },
  "bundleMetadata": "dist/.vite/manifest.json"
}
```

Supported rule identifiers: `architecture`, `large-components`, `use-effect`, `missing-keys`, `bundle-size`, `typescript-any`, `unused-dependencies`, and `parse-error`. A `maxBundleKb` value of `0` disables the measured-bundle size limit. `--config <file>` selects a different configuration file. Invalid JSON or invalid option types stop the audit with exit code 1.

## CI and regression baselines

Use `--min-score` to enforce a score threshold; the command exits with code 1 when the score is lower. The same threshold can be stored as `thresholds.minScore`. In CI, `--ci` enables failure on a regression when paired with a baseline. The baseline records fingerprints for non-informational findings, so existing findings are omitted from the report and new findings cause a non-zero exit code.

```bash
# Capture the current findings as the accepted baseline
npx react-audit . --update-baseline .react-audit-baseline.json

# Fail the job if the score falls below 80 or new findings appear
npx react-audit . --ci --min-score 80 --baseline .react-audit-baseline.json --format sarif --output results.sarif
```

Commit the baseline to track regressions over time. Updating it accepts the current findings; review the diff before committing. Baseline fingerprints use rule, relative file, line, and title, so moving or renaming code can appear as a new finding.

`--format sarif` emits SARIF 2.1.0 for GitHub Code Scanning. The SARIF report contains non-informational findings, rule identifiers, severity levels, and source locations when available. For GitHub Actions, upload `results.sarif` with the `github/codeql-action/upload-sarif` action and grant the workflow `security-events: write` permission.

## Build bundle measurements

The default dependency-size figure is only a heuristic based on a small list of known packages; it is not the compiled application bundle size. To report measured JavaScript output sizes, build the project first and point `bundleMetadata` to one of these files:

- **Vite:** its generated manifest JSON (for example `dist/.vite/manifest.json`); referenced JavaScript files are read from disk.
- **Webpack:** a stats JSON containing an `assets` array with asset `name` and `size` fields. Generate it with `webpack --profile --json > webpack-stats.json`.
- **esbuild:** a metafile JSON containing `outputs` entries and byte sizes. Generate it with `--metafile=meta.json`.

The result reports the sum of JavaScript output bytes and file count. It does not calculate gzip/brotli sizes, distinguish initial chunks from lazy chunks, or determine whether those files are actually delivered to users. Set `thresholds.maxBundleKb` to add a finding when the measured total exceeds a project-specific limit. This limit is in KiB (1024 bytes).

## Analysis limits, JSON output, and privacy

Most checks are static heuristics, not a substitute for ESLint, type-checking, runtime tests, or a real coverage tool. React findings depend on syntax patterns, project structure checks assume common folder conventions, the test score is based on a test-file/component ratio rather than execution coverage, and dependency usage can be missed when imports are generated or indirect. The default bundle figure is an estimate; only configured build metadata produces a measured output size. Treat the overall score as a trend indicator, not a standardized quality measurement.

`--format json` writes one complete `AnalysisResult` JSON document to stdout, with no human-readable banner mixed into it. It includes project/package summaries, file and aggregate statistics, findings, recommendations, score breakdown, and—when applicable—`ci`, `baseline`, `ai`, and measured bundle fields. Use `--output report.json` to write the JSON document to a file; status messages go to stderr. JSON mode does not implicitly enable AI.

AI is opt-in (`--ai`). The request sends the score, whether React and TypeScript were detected, aggregate component/useEffect/`any`/estimated-bundle counts, up to eight finding titles and descriptions, and the generated recommendations. It does not send source file contents or API keys in the prompt. However, finding text can include names derived from the project, so review the report data before enabling AI for private repositories. The request is sent to the configured OpenAI or Azure OpenAI endpoint under that provider's data-handling terms. Without `--ai`, no project data is sent over the network by this tool.

## Example output

```text
Analyzing project...

[OK] React 19 detected
[OK] TypeScript enabled

[WARN] Detected issues:

1. 3 oversized component(s) detected
   File: src/components/Dashboard.tsx:1
   Some components exceed the recommended limit of 300 lines.
   Suggestions:
   - Extract domain hooks.
   - Separate UI from logic.

2. 1 potentially problematic useEffect
   useEffect may be synchronizing a prop to state
   Suggestions:
   - Use the prop directly when possible.
   - Extract a derived value instead of storing it in state.

Score breakdown:
- Architecture: 20/20
- Performance: 20/20
- Tests: 20/20
- TypeScript: 18/20
- Maintainability: 18/20

Overall score: 96/100

Priority recommendations:
1. Reduce any usage with explicit interfaces or generic types.
```

## Development

```bash
npm install
npm run build
npm run test
npm run typecheck
```

### Release checklist

```bash
npm run release
npm version patch
npm publish --access public
```

See `RELEASE.md` for the complete procedure.

## Use cases

- **CI/CD**: Integrate it into your pipelines to monitor React quality
- **Code review**: Use it as a quality standard for pull requests
- **Codebase audit**: Quickly assess the state of a React project
- **Refactoring**: Identify components to split and hooks to optimize
- **Training**: Help teams learn React best practices

## License

MIT

---

Questions? Need a feature? Open an issue on GitHub.

