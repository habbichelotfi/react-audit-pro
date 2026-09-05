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
  -f, --format <format>         Output format: text | json | html (default: "text")
  -o, --output <file>           Output file for the report
  --ai                          Enable AI suggestions
  --ai-provider <provider>      openai | azure | auto (default: "auto")
  --ai-model <model>            AI model to use
  --ai-base-url <url>           OpenAI base URL (optional)
  --ai-api-key <key>            API key (optional, uses env otherwise)
  --ai-deployment <deployment>  Azure OpenAI deployment
  --ai-api-version <version>    Azure OpenAI API version
  -h, --help                    Display help
```

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

