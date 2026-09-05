import path from "node:path";
import fs from "node:fs/promises";
import { parse } from "@babel/parser";
import * as traverseModule from "@babel/traverse";
import type { AnalysisResult, AiSummary, Finding, FileSummary, PackageSnapshot, ScoreSection } from "./types.js";
import {
  clamp,
  countLines,
  dedupeStrings,
  getPackageNameFromImport,
  isSourceFile,
  isTestFile,
  normalizeRelativePath,
  pathExists,
  readJson,
  relativeFrom,
  shortFileName,
  walkFiles,
} from "./utils.js";

export interface AnalyzeOptions {
  ai?: boolean;
  aiProvider?: "openai" | "azure" | "auto" | undefined;
  aiModel?: string | undefined;
  aiBaseUrl?: string | undefined;
  aiApiKey?: string | undefined;
  aiDeployment?: string | undefined;
  aiApiVersion?: string | undefined;
}

type JsonRecord = Record<string, unknown>;

const traverse = (traverseModule as any).default?.default ?? (traverseModule as any).default;

interface InternalFinding {
  finding: Finding;
  penalty: number;
}

const KNOWN_BUNDLE_IMPACTS: Record<string, { kb: number; suggestion: string; alternative?: string }> = {
  moment: { kb: 67, suggestion: "Replace moment.js with dayjs to reduce bundle size.", alternative: "dayjs" },
  lodash: { kb: 72, suggestion: "Replace the root lodash import with lodash-es or targeted imports.", alternative: "lodash-es" },
  underscore: { kb: 19, suggestion: "Avoid underscore in favor of more targeted or native utilities.", alternative: "native functions" },
  "chart.js": { kb: 65, suggestion: "Load chart.js on demand (dynamic import).", alternative: "lazy loading" },
  firebase: { kb: 170, suggestion: "Split Firebase access into modules loaded on demand.", alternative: "targeted imports" },
  axios: { kb: 15, suggestion: "Check whether native fetch is sufficient for this use case.", alternative: "fetch" },
  "react-router-dom": { kb: 29, suggestion: "Ensure routing code is properly lazy-loaded.", alternative: "lazy loading" },
};

const DANGEROUS_GLOBALS = new Set([
  "console",
  "Math",
  "Date",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Promise",
  "Intl",
  "RegExp",
  "Reflect",
]);

const IGNORED_NODE_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

export async function analyzeProject(rootDir: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const resolvedRoot = path.resolve(rootDir);
  const packageJsonPath = path.join(resolvedRoot, "package.json");
  const packageJson = (await readJson<JsonRecord>(packageJsonPath)) ?? {};
  const files = await walkFiles(resolvedRoot);
  const sourceFiles = files.filter(isSourceFile);
  const testFiles = files.filter(isTestFile);

  const importedPackages = new Set<string>();
  const declaredRuntimeDeps = new Set<string>();
  const declaredDevDeps = new Set<string>();
  const declaredPeerDeps = new Set<string>();

  const packageSnapshot: PackageSnapshot = {
    name: typeof packageJson.name === "string" ? packageJson.name : undefined,
    reactVersion: detectReactVersion(packageJson),
    isReactProject: false,
    hasTypeScript: false,
    dependencies: [],
    devDependencies: [],
    peerDependencies: [],
  };

  const dependencies = asRecord(packageJson.dependencies);
  const devDependencies = asRecord(packageJson.devDependencies);
  const peerDependencies = asRecord(packageJson.peerDependencies);

  for (const dep of Object.keys(dependencies)) {
    declaredRuntimeDeps.add(dep);
  }
  for (const dep of Object.keys(devDependencies)) {
    declaredDevDeps.add(dep);
  }
  for (const dep of Object.keys(peerDependencies)) {
    declaredPeerDeps.add(dep);
  }

  packageSnapshot.dependencies = [...declaredRuntimeDeps];
  packageSnapshot.devDependencies = [...declaredDevDeps];
  packageSnapshot.peerDependencies = [...declaredPeerDeps];
  packageSnapshot.hasTypeScript = (await pathExists(path.join(resolvedRoot, "tsconfig.json"))) || declaredDevDeps.has("typescript") || sourceFiles.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

  const rootImports = new Set<string>();
  const allFindings: InternalFinding[] = [];
  const fileSummaries: FileSummary[] = [];
  const componentFiles = new Set<string>();
  const componentsOutsideDedicatedFolder = new Set<string>();
  const sourceFilesByDir = new Map<string, number>();

  let componentCount = 0;
  let largeComponentCount = 0;
  let useEffectCount = 0;
  let useEffectIssueCount = 0;
  let mapCallbackCount = 0;
  let mapCallbackWithoutKeyCount = 0;
  let useMemoCount = 0;
  let useCallbackCount = 0;
  let anyCount = 0;
  let bundleEstimateKb = 0;

  const packageHasComponentsDir = files.some((file) => normalizeRelativePath(relativeFrom(resolvedRoot, file)).startsWith("src/components/"));
  const packageHasPagesDir = files.some((file) => normalizeRelativePath(relativeFrom(resolvedRoot, file)).startsWith("src/pages/"));
  const packageHasHooksDir = files.some((file) => normalizeRelativePath(relativeFrom(resolvedRoot, file)).startsWith("src/hooks/"));
  const packageHasServicesDir = files.some((file) => normalizeRelativePath(relativeFrom(resolvedRoot, file)).startsWith("src/services/"));
  const packageHasUtilsDir = files.some((file) => normalizeRelativePath(relativeFrom(resolvedRoot, file)).startsWith("src/utils/"));

  for (const file of sourceFiles) {
    const content = await fs.readFile(file, "utf8");
    const relativeFile = relativeFrom(resolvedRoot, file);
    const lineCount = countLines(content);
    sourceFilesByDir.set(path.dirname(relativeFile), (sourceFilesByDir.get(path.dirname(relativeFile)) ?? 0) + 1);

    const summary: FileSummary = {
      file: relativeFile,
      lines: lineCount,
      components: 0,
      useEffects: 0,
      useMemo: 0,
      useCallback: 0,
      anyCount: 0,
    };

    let ast;
    try {
      ast = parse(content, {
        sourceType: "module",
        errorRecovery: true,
        plugins: [
          "jsx",
          "typescript",
          "classProperties",
          "classPrivateProperties",
          "classPrivateMethods",
          "decorators-legacy",
          "dynamicImport",
          "importMeta",
          "topLevelAwait",
          "optionalChaining",
          "nullishCoalescingOperator",
        ],
      });
    } catch (error) {
      allFindings.push({
        finding: {
          id: "parse-error",
          severity: "warning",
          title: `AST analysis failed for ${shortFileName(relativeFile)}`,
          description: `The file could not be fully parsed. Analysis continues with basic heuristics.`,
          file: relativeFile,
          suggestions: ["Check the file syntax.", "Fix TypeScript/JSX errors before running the audit again."],
        },
        penalty: 1,
      });
      continue;
    }

    traverse(ast, {
      ImportDeclaration(pathRef: any) {
        const source = pathRef.node.source.value;
        const packageName = getPackageNameFromImport(source);
        if (packageName) {
          importedPackages.add(packageName);
          rootImports.add(packageName);
        }
      },
      CallExpression(pathRef: any) {
        if (pathRef.node.callee?.type === "Import") {
          const source = pathRef.node.arguments?.[0];
          const packageName = source?.type === "StringLiteral" ? getPackageNameFromImport(source.value) : undefined;
          if (packageName) {
            importedPackages.add(packageName);
            rootImports.add(packageName);
          }
        }

        const calleeName = getCalleeName(pathRef.node.callee);
        if (calleeName === "useEffect") {
          useEffectCount += 1;
          summary.useEffects += 1;
          useEffectIssueCount += analyzeUseEffectCall(pathRef.node, content, relativeFile, allFindings);
        }

        if (calleeName === "useMemo") {
          useMemoCount += 1;
          summary.useMemo += 1;
        }

        if (calleeName === "useCallback") {
          useCallbackCount += 1;
          summary.useCallback += 1;
        }

        if (calleeName === "map") {
          mapCallbackCount += 1;
          const issue = analyzeMapCallback(pathRef.node, relativeFile, allFindings.length);
          if (issue) {
            mapCallbackWithoutKeyCount += 1;
            allFindings.push({ finding: issue, penalty: 2 });
          }
        }
      },
      TSAnyKeyword(pathRef: any) {
        anyCount += 1;
        summary.anyCount += 1;
      },
      TSAsExpression(pathRef: any) {
        if (pathRef.node.typeAnnotation.type === "TSAnyKeyword") {
          anyCount += 1;
          summary.anyCount += 1;
        }
      },
      FunctionDeclaration(pathRef: any) {
        const name = pathRef.node.id?.name;
        if (name && isComponentCandidate(name, pathRef.node.body)) {
          const isLarge = registerComponentCandidate({
            name,
            file: relativeFile,
            node: pathRef.node,
            content,
            allFindings,
            componentFiles,
            componentsOutsideDedicatedFolder,
            summary,
          });
          componentCount += 1;
          if (isLarge) {
            largeComponentCount += 1;
          }
        }
      },
      VariableDeclarator(pathRef: any) {
        const id = pathRef.node.id;
        const init = pathRef.node.init;
        if (!init || !id || id.type !== "Identifier") {
          return;
        }

        if ((init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") && isComponentCandidate(id.name, init.body)) {
          const isLarge = registerComponentCandidate({
            name: id.name,
            file: relativeFile,
            node: init,
            content,
            allFindings,
            componentFiles,
            componentsOutsideDedicatedFolder,
            summary,
          });
          componentCount += 1;
          if (isLarge) {
            largeComponentCount += 1;
          }
        }
      },
      ExportDefaultDeclaration(pathRef: any) {
        const declaration = pathRef.node.declaration;
        if ((declaration.type === "FunctionDeclaration" || declaration.type === "FunctionExpression" || declaration.type === "ArrowFunctionExpression") && isComponentCandidate(declaration.type === "FunctionDeclaration" ? declaration.id?.name ?? "DefaultExport" : "DefaultExport", declaration.body)) {
          const isLarge = registerComponentCandidate({
            name: declaration.type === "FunctionDeclaration" ? declaration.id?.name ?? "DefaultExport" : "DefaultExport",
            file: relativeFile,
            node: declaration,
            content,
            allFindings,
            componentFiles,
            componentsOutsideDedicatedFolder,
            summary,
          });
          componentCount += 1;
          if (isLarge) {
            largeComponentCount += 1;
          }
        }
      },
    });

    fileSummaries.push(summary);
  }

  const runtimeDependencyNames = [...declaredRuntimeDeps];
  const unusedDependencies = runtimeDependencyNames.filter((dep) => !rootImports.has(dep) && dep !== "react" && dep !== "react-dom");

  const bundleFindings = buildBundleFindings(runtimeDependencyNames, rootImports);
  for (const finding of bundleFindings) {
    allFindings.push({ finding, penalty: 3 });
  }
  bundleEstimateKb = bundleFindings.reduce((sum, finding) => sum + extractBundleImpactKb(finding.title), 0);

  const architecture: AnalysisResult["architecture"] = {
    hasComponentsDir: packageHasComponentsDir,
    hasPagesDir: packageHasPagesDir,
    hasHooksDir: packageHasHooksDir,
    hasServicesDir: packageHasServicesDir,
    hasUtilsDir: packageHasUtilsDir,
    allComponentsInComponentsDir: componentFiles.size > 0 && [...componentFiles].every((file) => relativeFrom(resolvedRoot, file).startsWith("src/components/")),
    hasDedicatedFolders: [packageHasPagesDir, packageHasHooksDir, packageHasServicesDir, packageHasUtilsDir].some(Boolean),
  };

  packageSnapshot.isReactProject = detectReactProject(packageJson, rootImports, sourceFiles);

  const testCoverageEstimate = componentCount > 0 ? (testFiles.length / componentCount) * 100 : testFiles.length > 0 ? 100 : 0;
  const hasReactBundleSignals = bundleEstimateKb > 0 || packageSnapshot.isReactProject;

  const stats = {
    totalFiles: files.length,
    sourceFiles: sourceFiles.length,
    testFiles: testFiles.length,
    components: componentCount,
    largeComponents: largeComponentCount,
    useEffects: useEffectCount,
    useEffectIssues: useEffectIssueCount,
    mapCallbacks: mapCallbackCount,
    mapCallbacksWithoutKeys: mapCallbackWithoutKeyCount,
    useMemoCount,
    useCallbackCount,
    anyCount,
    bundleEstimateKb,
    unusedDependencyCount: unusedDependencies.length,
  };

  if (packageSnapshot.isReactProject) {
    allFindings.push({
      finding: {
        id: "react-detected",
        severity: "info",
        title: `React ${packageSnapshot.reactVersion ?? "detected"}`,
        description: "The project appears to be a React application.",
        suggestions: [],
      },
      penalty: 0,
    });
  }

  if (packageSnapshot.hasTypeScript) {
    allFindings.push({
      finding: {
        id: "typescript-detected",
        severity: "info",
        title: "TypeScript enabled",
        description: "The project uses TypeScript or contains .ts/.tsx files.",
        suggestions: [],
      },
      penalty: 0,
    });
  }

  if (!architecture.hasDedicatedFolders && componentCount >= 5) {
    allFindings.push({
      finding: {
        id: "architecture-flat",
        severity: "warning",
        title: "Overly concentrated architecture",
        description: "Domain folders (pages, hooks, services, utils) are poorly separated or missing.",
        suggestions: ["Create `src/pages`, `src/hooks`, `src/services`, and `src/utils`.", "Separate business logic from the UI."],
      },
      penalty: 3,
    });
  }

  if (architecture.allComponentsInComponentsDir) {
    allFindings.push({
      finding: {
        id: "architecture-components-only",
        severity: "warning",
        title: "All components are grouped in src/components",
        description: "Business logic and use cases appear to lack separation.",
        suggestions: ["Move business logic into hooks or services.", "Create dedicated pages and domain modules."],
      },
      penalty: 3,
    });
  }

  if (largeComponentCount > 0) {
    allFindings.push({
      finding: {
        id: "large-components",
        severity: "warning",
        title: `${largeComponentCount} oversized component(s) detected`,
        description: "Some components exceed the recommended limit of 300 lines.",
        suggestions: ["Extract subcomponents.", "Move business logic into hooks.", "Separate presentation from logic."],
      },
      penalty: largeComponentCount * 2,
    });
  }

  if (useEffectIssueCount > 0) {
    allFindings.push({
      finding: {
        id: "use-effect-issues",
        severity: "warning",
        title: `${useEffectIssueCount} potentially problematic useEffect(s)`,
        description: "Missing dependencies or prop-to-state synchronizations were detected.",
        suggestions: ["Check useEffect dependencies.", "Avoid copying a prop directly into local state.", "Prefer derived values when possible."],
      },
      penalty: useEffectIssueCount * 2,
    });
  }

  if (mapCallbackWithoutKeyCount > 0) {
    allFindings.push({
      finding: {
        id: "missing-keys",
        severity: "warning",
        title: `${mapCallbackWithoutKeyCount} list render(s) without a key`,
        description: "Elements generated through map appear to be missing a stable key.",
        suggestions: ["Add key={item.id} or another stable key.", "Avoid using the index except as a last resort."],
      },
      penalty: mapCallbackWithoutKeyCount * 2,
    });
  }

  if (anyCount > 0) {
    allFindings.push({
      finding: {
        id: "typescript-any",
        severity: anyCount > 20 ? "critical" : "warning",
        title: `${anyCount} use(s) of any detected`,
        description: "Using any can hide type errors and reduce confidence in the code.",
        suggestions: ["Replace any with explicit interfaces or types.", "Use unknown when the exact structure is not known."],
      },
      penalty: Math.min(10, Math.ceil(anyCount / 10)),
    });
  }

  if (unusedDependencies.length > 0) {
    allFindings.push({
      finding: {
        id: "unused-dependencies",
        severity: "info",
        title: `Unused runtime dependencies: ${unusedDependencies.length}`,
        description: "Some dependencies declared in package.json do not appear to be used in the source code.",
        suggestions: ["Remove unused dependencies.", "Check dynamic imports or build-time usage if needed."],
      },
      penalty: Math.min(5, unusedDependencies.length),
    });
  }

  if (bundleEstimateKb > 0) {
    const title = `Estimated bundle: ${bundleEstimateKb} KB`;
    allFindings.push({
      finding: {
        id: "bundle-estimate",
        severity: bundleEstimateKb >= 60 ? "warning" : "info",
        title,
        description: "The project contains dependencies known to impact bundle size.",
        suggestions: dedupeStrings(bundleFindings.flatMap((finding) => finding.suggestions)),
      },
      penalty: Math.min(8, Math.ceil(bundleEstimateKb / 20)),
    });
  }

  const architectureScore = scoreArchitecture(architecture, componentCount);
  const performanceScore = scorePerformance(stats, hasReactBundleSignals);
  const testsScore = scoreTests(testCoverageEstimate, testFiles.length);
  const typescriptScore = scoreTypescript(anyCount, packageSnapshot.hasTypeScript);
  const maintainabilityScore = scoreMaintainability(largeComponentCount, unusedDependencies.length, useEffectIssueCount, componentCount);

  const scoreBreakdown: ScoreSection[] = [
    {
      name: "Architecture",
      score: architectureScore,
      maxScore: 20,
        notes: [
        architecture.hasDedicatedFolders ? "Sufficient folder structure" : "Business/UI separation needs improvement",
        architecture.allComponentsInComponentsDir ? "All components are concentrated in src/components" : "Components are distributed appropriately",
      ],
    },
    {
      name: "Performance",
      score: performanceScore,
      maxScore: 20,
      notes: [
        useEffectIssueCount > 0 ? `${useEffectIssueCount} useEffect(s) to review` : "useEffect usage is generally sound",
        mapCallbackWithoutKeyCount > 0 ? `${mapCallbackWithoutKeyCount} list(s) without keys` : "Keys are present on lists",
      ],
    },
    {
      name: "Tests",
      score: testsScore,
      maxScore: 20,
      notes: [
        `${testFiles.length} test file(s) detected`,
        `Estimated coverage: ${Math.round(testCoverageEstimate)}%`,
      ],
    },
    {
      name: "TypeScript",
      score: typescriptScore,
      maxScore: 20,
      notes: [
        packageSnapshot.hasTypeScript ? "TypeScript detected" : "TypeScript not detected",
        anyCount > 0 ? `${anyCount} any usage(s) to reduce` : "No notable any usage",
      ],
    },
    {
      name: "Maintainability",
      score: maintainabilityScore,
      maxScore: 20,
      notes: [
        largeComponentCount > 0 ? `${largeComponentCount} oversized component(s)` : "Components are reasonably sized",
        unusedDependencies.length > 0 ? `Unused runtime dependencies: ${unusedDependencies.length}` : "Runtime dependencies are useful",
      ],
    },
  ];

  const score = scoreBreakdown.reduce((sum, section) => sum + section.score, 0);

  const recommendations = buildRecommendations({
    architecture,
    componentCount,
    largeComponentCount,
    useEffectIssueCount,
    mapCallbackWithoutKeyCount,
    anyCount,
    bundleEstimateKb,
    unusedDependencies,
    testCoverageEstimate,
  });

  const ai = await maybeGenerateAiSummary({
    enabled: Boolean(options.ai),
    provider: options.aiProvider,
    model: options.aiModel,
    baseUrl: options.aiBaseUrl,
    apiKey: options.aiApiKey,
    deployment: options.aiDeployment,
    apiVersion: options.aiApiVersion,
  }, {
    score,
    recommendations,
    stats,
    packageSnapshot,
    findings: allFindings.map((entry) => entry.finding),
  });

  const findings = allFindings
    .sort((a, b) => severityWeight(b.finding.severity) - severityWeight(a.finding.severity))
    .map((entry) => entry.finding);

  return {
    rootDir: resolvedRoot,
    packageSnapshot,
    architecture,
    files: fileSummaries,
    stats,
    findings,
    recommendations,
    scoreBreakdown,
    score,
    ai,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function detectReactVersion(packageJson: JsonRecord): string | undefined {
  const candidates = [packageJson.dependencies, packageJson.devDependencies, packageJson.peerDependencies];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (typeof record["react"] === "string") {
      return record["react"];
    }
  }
  return undefined;
}

function detectReactProject(packageJson: JsonRecord, imports: Set<string>, sourceFiles: string[]): boolean {
  const deps = asRecord(packageJson.dependencies);
  const devDeps = asRecord(packageJson.devDependencies);
  const peerDeps = asRecord(packageJson.peerDependencies);
  if ("react" in deps || "react" in devDeps || "react" in peerDeps || "react-dom" in deps || "react-dom" in devDeps || "react-dom" in peerDeps) {
    return true;
  }
  if (imports.has("react") || imports.has("react-dom")) {
    return true;
  }
  return sourceFiles.some((file) => file.endsWith(".jsx") || file.endsWith(".tsx"));
}

function getCalleeName(callee: unknown): string | undefined {
  if (!callee || typeof callee !== "object") {
    return undefined;
  }
  const node = callee as { type?: string; name?: string; property?: { type?: string; name?: string }; object?: unknown };
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression") {
    const property = node.property;
    if (property?.type === "Identifier") {
      return property.name;
    }
  }
  return undefined;
}

function isComponentCandidate(name: string, body: unknown): boolean {
  return /^[A-Z]/.test(name) && nodeContainsJSX(body);
}

function nodeContainsJSX(node: unknown): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((value) => nodeContainsJSX(value));
  }

  const current = node as Record<string, unknown> & { type?: string };
  if (current.type === "JSXElement" || current.type === "JSXFragment") {
    return true;
  }

  for (const [key, value] of Object.entries(current)) {
    if (IGNORED_NODE_KEYS.has(key)) {
      continue;
    }
    if (nodeContainsJSX(value)) {
      return true;
    }
  }

  return false;
}

function registerComponentCandidate(input: {
  name: string;
  file: string;
  node: { loc?: { start: { line: number }; end: { line: number } } };
  content: string;
  allFindings: InternalFinding[];
  componentFiles: Set<string>;
  componentsOutsideDedicatedFolder: Set<string>;
  summary: FileSummary;
}): boolean {
  const { name, file, node, content, allFindings, componentFiles, componentsOutsideDedicatedFolder, summary } = input;
  const startLine = node.loc?.start.line ?? 1;
  const endLine = node.loc?.end.line ?? startLine;
  const lineCount = Math.max(1, endLine - startLine + 1);
  summary.components += 1;
  componentFiles.add(file);

  if (!file.startsWith("src/components/")) {
    componentsOutsideDedicatedFolder.add(file);
  }

  if (lineCount > 300) {
    allFindings.push({
      finding: {
        id: `large-component-${file}-${name}`,
        severity: "warning",
        title: `${name} — ${lineCount} lignes`,
        description: "This component exceeds the recommended limit of 300 lines.",
        file,
        line: startLine,
        suggestions: ["Extract domain hooks.", "Separate UI from logic.", "Split into smaller subcomponents."],
      },
      penalty: 4,
    });
    return true;
  }

  return false;
}

function analyzeUseEffectCall(node: { arguments: unknown[] }, content: string, file: string, allFindings: InternalFinding[]): number {
  const [callback, deps] = node.arguments as [unknown, unknown];
  const callbackText = sliceNodeText(callback, content);
  const depsText = sliceNodeText(deps, content);

  if (!callbackText) {
    return 0;
  }

  let issueCount = 0;

  if (!deps) {
    allFindings.push({
      finding: {
        id: `use-effect-missing-deps-${file}-${allFindings.length}`,
        severity: "warning",
        title: "useEffect without a dependency array",
        description: "The useEffect hook has no second argument and may re-run unpredictably.",
        file,
        suggestions: ["Add an explicit dependency array.", "Check whether the effect can be replaced with a derived value."],
      },
      penalty: 2,
    });
    return 1;
  }

  const bodyUsesProps = /\bprops\.[A-Za-z_$][\w$]*/.test(callbackText);
  const bodyUsesStateSetter = /\bset[A-Z][A-Za-z0-9_$]*\s*\(/.test(callbackText);
  const dependencyChains = extractDependencyChains(deps);
  const bodyChains = extractMemberChains(callbackText);
  const missing = bodyChains.filter((chain) => !dependencyChains.includes(chain) && !isSafeGlobalChain(chain));

  if (depsText === "[]" && (bodyUsesProps || bodyUsesStateSetter)) {
    allFindings.push({
      finding: {
        id: `use-effect-derived-state-${file}-${allFindings.length}`,
        severity: "warning",
        title: "useEffect may be synchronizing a prop to state",
        description: "The code appears to copy a derived value from props into local state.",
        file,
        suggestions: ["Use the prop directly when possible.", "Extract a derived value instead of storing it in state."] ,
      },
      penalty: 2,
    });
    issueCount += 1;
  }

  if (missing.length > 0) {
    allFindings.push({
      finding: {
        id: `use-effect-deps-${file}-${allFindings.length}`,
        severity: "warning",
        title: "Possibly missing useEffect dependencies",
        description: `References appear to be used in the effect without appearing in the dependency array: ${missing.slice(0, 4).join(", ")}.`,
        file,
        suggestions: ["Add the missing dependencies.", "Refactor the logic to reduce captured dependencies.", "Use useMemo/useCallback if the value is computed."],
      },
      penalty: 2,
    });
    issueCount += 1;
  }

  return issueCount;
}

function analyzeMapCallback(node: { arguments: unknown[] }, file: string, findingIndex: number): Finding | undefined {
  const callback = node.arguments[0];
  if (!isFunctionLike(callback)) {
    return undefined;
  }

  const jsxNodes = getReturnedJsxNodes(callback);
  if (jsxNodes.length === 0) {
    return undefined;
  }

  const missingKey = jsxNodes.some((jsxNode) => jsxNode.type === "JSXFragment" || !hasKeyAttribute(jsxNode));
  if (!missingKey) {
    return undefined;
  }

  return {
    id: `missing-key-${file}-${findingIndex}`,
    severity: "warning",
    title: "List rendered without a stable key",
    description: "A map appears to return JSX elements without a stable key.",
    file,
    suggestions: ["Add key={item.id} or another stable domain key.", "Avoid using the index as a key unless the list is strictly immutable."],
  };
}

function isFunctionLike(node: unknown): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  const type = (node as { type?: string }).type;
  return type === "ArrowFunctionExpression" || type === "FunctionExpression";
}

function getReturnedJsxNodes(node: unknown): Array<{ type?: string; openingElement?: { attributes?: unknown[] } }> {
  if (!node || typeof node !== "object") {
    return [];
  }
  const current = node as Record<string, unknown> & { type?: string };
  if (current.type === "ArrowFunctionExpression") {
    const body = current.body as { type?: string } | undefined;
    if (body?.type === "JSXElement" || body?.type === "JSXFragment") {
      return [body as { type?: string; openingElement?: { attributes?: unknown[] } }];
    }
    if (body?.type === "BlockStatement") {
      return collectReturnedJsx(body as Record<string, unknown>);
    }
  }
  if (current.type === "FunctionExpression") {
    return collectReturnedJsx(current.body as Record<string, unknown>);
  }
  return [];
}

function collectReturnedJsx(block: Record<string, unknown>): Array<{ type?: string; openingElement?: { attributes?: unknown[] } }> {
  const results: Array<{ type?: string; openingElement?: { attributes?: unknown[] } }> = [];
  const body = block.body;
  if (!Array.isArray(body)) {
    return results;
  }
  for (const statement of body) {
    if (!statement || typeof statement !== "object") {
      continue;
    }
    const stmt = statement as Record<string, unknown> & { type?: string };
    if (stmt.type === "ReturnStatement") {
      const argument = stmt.argument as { type?: string; openingElement?: { attributes?: unknown[] } } | undefined;
      if (argument && (argument.type === "JSXElement" || argument.type === "JSXFragment")) {
        results.push(argument);
      }
    }
  }
  return results;
}

function hasKeyAttribute(node: { openingElement?: { attributes?: unknown[] } }): boolean {
  const attributes = node.openingElement?.attributes ?? [];
  return attributes.some((attribute) => {
    if (!attribute || typeof attribute !== "object") {
      return false;
    }
    const attr = attribute as { type?: string; name?: { type?: string; name?: string } };
    return attr.type === "JSXAttribute" && attr.name?.name === "key";
  });
}

function sliceNodeText(node: unknown, content: string): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const current = node as { start?: number; end?: number };
  if (typeof current.start !== "number" || typeof current.end !== "number") {
    return "";
  }
  return content.slice(current.start, current.end);
}

function extractDependencyChains(node: unknown): string[] {
  const text = sliceNodeText(node, "");
  const current = node as { type?: string } | undefined;
  if (!current || current.type !== "ArrayExpression") {
    return text ? [text] : [];
  }

  const values = node as { elements?: unknown[] };
  const result: string[] = [];
  for (const element of values.elements ?? []) {
    const expression = expressionToChain(element);
    if (expression) {
      result.push(expression);
    }
  }
  return result;
}

function expressionToChain(node: unknown): string | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const current = node as { type?: string; name?: string; object?: unknown; property?: unknown; value?: unknown; argument?: unknown; expression?: unknown; callee?: unknown };
  switch (current.type) {
    case "Identifier":
      return current.name;
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return String(current.value);
    case "MemberExpression": {
      const objectPart = expressionToChain(current.object);
      const propertyPart = expressionToChain(current.property);
      if (!objectPart || !propertyPart) {
        return undefined;
      }
      return `${objectPart}.${propertyPart}`;
    }
    case "OptionalMemberExpression": {
      const objectPart = expressionToChain(current.object);
      const propertyPart = expressionToChain(current.property);
      if (!objectPart || !propertyPart) {
        return undefined;
      }
      return `${objectPart}.${propertyPart}`;
    }
    case "TSAsExpression":
      return expressionToChain(current.expression);
    case "CallExpression":
      return expressionToChain(current.callee);
    default:
      return undefined;
  }
}

function extractMemberChains(content: string): string[] {
  const matches = content.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g) ?? [];
  return dedupeStrings(matches).filter((chain) => !chain.startsWith("React."));
}

function isSafeGlobalChain(chain: string): boolean {
  const [root] = chain.split(".");
  return DANGEROUS_GLOBALS.has(root ?? "");
}

function buildBundleFindings(runtimeDependencyNames: string[], imports: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const dep of runtimeDependencyNames) {
    const impact = KNOWN_BUNDLE_IMPACTS[dep];
    if (!impact) {
      continue;
    }
    if (dep === "lodash" && !imports.has("lodash") && !imports.has("lodash-es")) {
      continue;
    }
    findings.push({
      id: `bundle-${dep}`,
      severity: "warning",
      title: `${dep} (${impact.kb} KB)`,
      description: impact.suggestion,
      suggestions: [impact.alternative ? `Recommended alternative: ${impact.alternative}` : impact.suggestion],
    });
  }
  return findings;
}

function extractBundleImpactKb(title: string): number {
  const match = title.match(/\((\d+) KB\)/);
  return match ? Number(match[1]) : 0;
}

function buildRecommendations(input: {
  architecture: AnalysisResult["architecture"];
  componentCount: number;
  largeComponentCount: number;
  useEffectIssueCount: number;
  mapCallbackWithoutKeyCount: number;
  anyCount: number;
  bundleEstimateKb: number;
  unusedDependencies: string[];
  testCoverageEstimate: number;
}): string[] {
  const recommendations: string[] = [];
  if (!input.architecture.hasDedicatedFolders && input.componentCount >= 5) {
    recommendations.push("Introduce a clear separation between UI, hooks, and business logic.");
  }
  if (input.largeComponentCount > 0) {
    recommendations.push("Split oversized components into subcomponents and dedicated hooks.");
  }
  if (input.useEffectIssueCount > 0) {
    recommendations.push("Review useEffect calls to avoid missing dependencies and unnecessary state synchronization.");
  }
  if (input.mapCallbackWithoutKeyCount > 0) {
    recommendations.push("Add stable keys to all list renders.");
  }
  if (input.anyCount > 0) {
    recommendations.push("Reduce any usage with explicit interfaces or generic types.");
  }
  if (input.bundleEstimateKb > 0) {
    recommendations.push("Reduce bundle size with lazy loading and targeted imports.");
  }
  if (input.unusedDependencies.length > 0) {
    recommendations.push("Remove unused runtime dependencies.");
  }
  if (input.testCoverageEstimate < 50) {
    recommendations.push("Add more tests for critical components and domain hooks.");
  }
  if (recommendations.length === 0) {
    recommendations.push("The project is generally healthy: keep the current patterns and monitor component growth.");
  }
  return dedupeStrings(recommendations);
}

function scoreArchitecture(architecture: AnalysisResult["architecture"], componentCount: number): number {
  let score = 20;
  if (!architecture.hasDedicatedFolders && componentCount >= 5) {
    score -= 4;
  }
  if (architecture.allComponentsInComponentsDir) {
    score -= 4;
  }
  if (!architecture.hasHooksDir && componentCount >= 10) {
    score -= 3;
  }
  if (!architecture.hasServicesDir && componentCount >= 10) {
    score -= 2;
  }
  return clamp(score, 0, 20);
}

function scorePerformance(stats: { useEffectIssues: number; mapCallbacksWithoutKeys: number; bundleEstimateKb: number }, _hasReactBundleSignals: boolean): number {
  let score = 20;
  score -= Math.min(8, stats.useEffectIssues * 2);
  score -= Math.min(4, stats.mapCallbacksWithoutKeys * 2);
  score -= Math.min(8, Math.floor(stats.bundleEstimateKb / 25));
  return clamp(score, 0, 20);
}

function scoreTests(testCoverageEstimate: number, testFiles: number): number {
  let score = Math.round((clamp(testCoverageEstimate, 0, 100) / 100) * 20);
  if (testFiles === 0) {
    score = 0;
  } else if (score < 4) {
    score = Math.min(4, testFiles);
  }
  return clamp(score, 0, 20);
}

function scoreTypescript(anyCount: number, hasTypeScript: boolean): number {
  if (!hasTypeScript) {
    return 0;
  }
  return clamp(20 - Math.min(20, Math.floor(anyCount / 5)), 0, 20);
}

function scoreMaintainability(largeComponentCount: number, unusedDependenciesCount: number, useEffectIssueCount: number, componentCount: number): number {
  let score = 20;
  score -= Math.min(8, largeComponentCount * 2);
  score -= Math.min(4, unusedDependenciesCount * 2);
  score -= Math.min(4, useEffectIssueCount);
  if (componentCount >= 15) {
    score -= 2;
  }
  return clamp(score, 0, 20);
}

function severityWeight(severity: Finding["severity"]): number {
  switch (severity) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

async function maybeGenerateAiSummary(options: {
  enabled: boolean;
  provider?: "openai" | "azure" | "auto" | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  deployment?: string | undefined;
  apiVersion?: string | undefined;
}, payload: {
  score: number;
  recommendations: string[];
  stats: AnalysisResult["stats"];
  packageSnapshot: PackageSnapshot;
  findings: Finding[];
}): Promise<AiSummary | undefined> {
  if (!options.enabled) {
    return undefined;
  }

  const provider = resolveAiProvider(options);
  const apiKey = options.apiKey ?? envLookup(provider === "azure" ? ["AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"] : ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"]);
  if (!apiKey) {
    return { enabled: false, provider, skippedReason: "No API key detected for AI analysis." };
  }

  const model = options.model ?? envLookup(["OPENAI_MODEL", "AZURE_OPENAI_MODEL"]) ?? "gpt-4o-mini";
  const prompt = buildAiPrompt(payload);

  try {
    if (provider === "azure") {
      const endpoint = options.baseUrl ?? envLookup(["AZURE_OPENAI_ENDPOINT"]);
      const deployment = options.deployment ?? envLookup(["AZURE_OPENAI_DEPLOYMENT"]);
      const apiVersion = options.apiVersion ?? envLookup(["AZURE_OPENAI_API_VERSION"]) ?? "2024-02-15-preview";
      if (!endpoint || !deployment) {
        return { enabled: false, provider, model, skippedReason: "Incomplete Azure OpenAI configuration (missing endpoint or deployment)." };
      }

      const response = await fetch(`${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "You are a React/TypeScript expert who provides short, actionable recommendations." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 400,
        }),
      });
      if (!response.ok) {
        return { enabled: false, provider, model, skippedReason: `Azure OpenAI responded with status ${response.status}.` };
      }
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return {
        enabled: true,
        provider,
        model: deployment,
        summary: json.choices?.[0]?.message?.content?.trim() || undefined,
      };
    }

    const baseUrl = (options.baseUrl ?? envLookup(["OPENAI_BASE_URL"]) ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a React/TypeScript expert who provides short, actionable recommendations." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      return { enabled: false, provider, model, skippedReason: `OpenAI responded with status ${response.status}.` };
    }

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return {
      enabled: true,
      provider,
      model,
      summary: json.choices?.[0]?.message?.content?.trim() || undefined,
    };
  } catch (error) {
    return {
      enabled: false,
      provider,
      model,
      skippedReason: error instanceof Error ? `AI analysis unavailable: ${error.message}` : "AI analysis unavailable.",
    };
  }
}

function resolveAiProvider(options: { provider?: "openai" | "azure" | "auto" | undefined }): "openai" | "azure" {
  if (options.provider === "azure") {
    return "azure";
  }
  if (options.provider === "openai") {
    return "openai";
  }
  if (envLookup(["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY"])) {
    return "azure";
  }
  return "openai";
}

function envLookup(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildAiPrompt(payload: {
  score: number;
  recommendations: string[];
  stats: AnalysisResult["stats"];
  packageSnapshot: PackageSnapshot;
  findings: Finding[];
}): string {
  const topFindings = payload.findings.slice(0, 8).map((finding) => `- ${finding.title}: ${finding.description}`).join("\n");
  const recommendations = payload.recommendations.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return [
    `Overall score: ${payload.score}/100`,
    `React project: ${payload.packageSnapshot.isReactProject ? "yes" : "no"}`,
    `TypeScript: ${payload.packageSnapshot.hasTypeScript ? "yes" : "no"}`,
    `Components: ${payload.stats.components}`,
    `Problematic useEffect calls: ${payload.stats.useEffectIssues}`,
    `any usages detected: ${payload.stats.anyCount}`,
    `Estimated bundle: ${payload.stats.bundleEstimateKb} KB`,
    "",
    "Findings:",
    topFindings || "- none",
    "",
    "Internal recommendations:",
    recommendations || "- none",
    "",
    "Provide 3 to 5 prioritized, pragmatic, actionable recommendations.",
  ].join("\n");
}




