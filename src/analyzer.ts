import path from "node:path";
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
  moment: { kb: 67, suggestion: "Remplacer moment.js par dayjs pour réduire la taille du bundle.", alternative: "dayjs" },
  lodash: { kb: 72, suggestion: "Remplacer l'import root de lodash par lodash-es ou des imports ciblés.", alternative: "lodash-es" },
  underscore: { kb: 19, suggestion: "Éviter underscore au profit d'outils plus ciblés ou natifs.", alternative: "fonctions natives" },
  "chart.js": { kb: 65, suggestion: "Charger chart.js uniquement à la demande (dynamic import).", alternative: "lazy loading" },
  firebase: { kb: 170, suggestion: "Découper l'accès Firebase en modules chargés à la demande.", alternative: "imports ciblés" },
  axios: { kb: 15, suggestion: "Vérifier si fetch natif suffit pour ce besoin.", alternative: "fetch" },
  "react-router-dom": { kb: 29, suggestion: "S'assurer que le code de routing est bien lazy-loaded.", alternative: "lazy loading" },
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
    const content = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
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
          title: `Analyse AST impossible pour ${shortFileName(relativeFile)}`,
          description: `Le fichier n'a pas pu être complètement parsé. L'analyse continue avec les heuristiques de base.`,
          file: relativeFile,
          suggestions: ["Vérifier la syntaxe du fichier.", "Corriger les erreurs TypeScript/JSX avant de relancer l'audit."],
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
          const issue = analyzeMapCallback(pathRef.node, content, relativeFile);
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
        title: `React ${packageSnapshot.reactVersion ?? "détecté"}`,
        description: "Le projet semble bien être une application React.",
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
        title: "TypeScript activé",
        description: "Le projet utilise TypeScript ou contient des fichiers .ts/.tsx.",
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
        title: "Architecture trop concentrée",
        description: "Les dossiers métiers (pages, hooks, services, utils) sont peu ou pas séparés.",
        suggestions: ["Créer `src/pages`, `src/hooks`, `src/services` et `src/utils`.", "Séparer la logique métier de l'UI."],
      },
      penalty: 3,
    });
  }

  if (architecture.allComponentsInComponentsDir) {
    allFindings.push({
      finding: {
        id: "architecture-components-only",
        severity: "warning",
        title: "Tous les composants sont regroupés dans src/components",
        description: "Le code métier et les cas d'usage semblent manquer de séparation.",
        suggestions: ["Déplacer la logique métier dans des hooks ou services.", "Créer des pages et des modules métier dédiés."],
      },
      penalty: 3,
    });
  }

  if (largeComponentCount > 0) {
    allFindings.push({
      finding: {
        id: "large-components",
        severity: "warning",
        title: `${largeComponentCount} composant(s) trop volumineux détecté(s)`,
        description: "Certains composants dépassent le seuil recommandé de 300 lignes.",
        suggestions: ["Extraire des sous-composants.", "Déplacer la logique métier dans des hooks.", "Séparer l'affichage de la logique."],
      },
      penalty: largeComponentCount * 2,
    });
  }

  if (useEffectIssueCount > 0) {
    allFindings.push({
      finding: {
        id: "use-effect-issues",
        severity: "warning",
        title: `${useEffectIssueCount} useEffect potentiellement problématique(s)`,
        description: "Des dépendances manquantes ou des synchronisations de props vers state ont été détectées.",
        suggestions: ["Vérifier les dépendances des useEffect.", "Éviter de recopier directement une prop dans un state local.", "Préférer les valeurs dérivées quand c'est possible."],
      },
      penalty: useEffectIssueCount * 2,
    });
  }

  if (mapCallbackWithoutKeyCount > 0) {
    allFindings.push({
      finding: {
        id: "missing-keys",
        severity: "warning",
        title: `${mapCallbackWithoutKeyCount} rendu(s) listé(s) sans key`,
        description: "Des éléments générés via map semblent manquer d'une clé stable.",
        suggestions: ["Ajouter key={item.id} ou une clé stable.", "Éviter d'utiliser l'index sauf en dernier recours."],
      },
      penalty: mapCallbackWithoutKeyCount * 2,
    });
  }

  if (anyCount > 0) {
    allFindings.push({
      finding: {
        id: "typescript-any",
        severity: anyCount > 20 ? "critical" : "warning",
        title: `${anyCount} utilisation(s) de any détectée(s)`,
        description: "L'usage de any peut masquer des erreurs de type et réduire la confiance dans le code.",
        suggestions: ["Remplacer any par des interfaces ou types explicites.", "Utiliser unknown lorsque la structure exacte n'est pas connue."],
      },
      penalty: Math.min(10, Math.ceil(anyCount / 10)),
    });
  }

  if (unusedDependencies.length > 0) {
    allFindings.push({
      finding: {
        id: "unused-dependencies",
        severity: "info",
        title: `${unusedDependencies.length} dépendance(s) runtime non importée(s)`,
        description: "Certaines dépendances déclarées dans package.json ne semblent pas utilisées dans le code source.",
        suggestions: ["Supprimer les dépendances inutilisées.", "Vérifier les imports dynamiques ou les usages côté build si nécessaire."],
      },
      penalty: Math.min(5, unusedDependencies.length),
    });
  }

  if (bundleEstimateKb > 0) {
    const title = bundleEstimateKb >= 60 ? `Bundle estimé : ${bundleEstimateKb} KB` : `Bundle estimé : ${bundleEstimateKb} KB`;
    allFindings.push({
      finding: {
        id: "bundle-estimate",
        severity: bundleEstimateKb >= 60 ? "warning" : "info",
        title,
        description: "Le projet contient des dépendances connues pour impacter la taille du bundle.",
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
        architecture.hasDedicatedFolders ? "Structure de dossiers suffisante" : "Séparation métier/UI à améliorer",
        architecture.allComponentsInComponentsDir ? "Tous les composants sont concentrés dans src/components" : "Répartition des composants correcte",
      ],
    },
    {
      name: "Performance",
      score: performanceScore,
      maxScore: 20,
      notes: [
        useEffectIssueCount > 0 ? `${useEffectIssueCount} useEffect à vérifier` : "useEffect globalement corrects",
        mapCallbackWithoutKeyCount > 0 ? `${mapCallbackWithoutKeyCount} liste(s) sans key` : "keys présentes sur les listes",
      ],
    },
    {
      name: "Tests",
      score: testsScore,
      maxScore: 20,
      notes: [
        `${testFiles.length} fichier(s) de test détecté(s)`,
        `Couverture estimée : ${Math.round(testCoverageEstimate)}%`,
      ],
    },
    {
      name: "TypeScript",
      score: typescriptScore,
      maxScore: 20,
      notes: [
        packageSnapshot.hasTypeScript ? "TypeScript détecté" : "Pas de TypeScript détecté",
        anyCount > 0 ? `${anyCount} any à réduire` : "Pas d'usage any notable",
      ],
    },
    {
      name: "Maintenabilité",
      score: maintainabilityScore,
      maxScore: 20,
      notes: [
        largeComponentCount > 0 ? `${largeComponentCount} composant(s) trop gros` : "Composants de taille raisonnable",
        unusedDependencies.length > 0 ? `${unusedDependencies.length} dépendance(s) inutilisée(s)` : "Dépendances runtime utiles",
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
        description: "Ce composant dépasse le seuil recommandé de 300 lignes.",
        file,
        line: startLine,
        suggestions: ["Extraire les hooks métier.", "Séparer l'UI et la logique.", "Découper en sous-composants plus petits."],
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
        title: "useEffect sans tableau de dépendances",
        description: "Le hook useEffect n'a pas de second argument et peut se ré-exécuter de manière imprévisible.",
        file,
        suggestions: ["Ajouter un tableau de dépendances explicite.", "Vérifier si l'effet peut être remplacé par une valeur dérivée."],
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
        title: "useEffect probablement utilisé pour synchroniser une prop vers le state",
        description: "Le code semble recopier une valeur dérivée depuis props vers un state local.",
        file,
        suggestions: ["Utiliser directement la prop lorsque c'est possible.", "Extraire une valeur dérivée au lieu de la stocker dans un state."] ,
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
        title: "Dépendances possiblement manquantes dans useEffect",
        description: `Des références semblent utilisées dans l'effet sans apparaître dans le tableau de dépendances : ${missing.slice(0, 4).join(", ")}.`,
        file,
        suggestions: ["Ajouter les dépendances manquantes.", "Refactoriser la logique pour réduire les dépendances capturées.", "Utiliser useMemo/useCallback si la valeur est calculée."],
      },
      penalty: 2,
    });
    issueCount += 1;
  }

  return issueCount;
}

function analyzeMapCallback(node: { arguments: unknown[] }, content: string, file: string): Finding | undefined {
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
    id: `missing-key-${file}-${content.length}`,
    severity: "warning",
    title: "Rendu de liste sans key stable",
    description: "Un map semble retourner des éléments JSX sans clé stable.",
    file,
    suggestions: ["Ajouter key={item.id} ou une clé métier stable.", "Éviter l'index comme key sauf si la liste est strictement immuable."],
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
      suggestions: [impact.alternative ? `Alternative recommandée : ${impact.alternative}` : impact.suggestion],
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
    recommendations.push("Introduire une séparation claire entre UI, hooks et logique métier.");
  }
  if (input.largeComponentCount > 0) {
    recommendations.push("Découper les composants trop volumineux en sous-composants et hooks dédiés.");
  }
  if (input.useEffectIssueCount > 0) {
    recommendations.push("Réviser les useEffect pour éviter les dépendances manquantes et les synchronisations de state inutiles.");
  }
  if (input.mapCallbackWithoutKeyCount > 0) {
    recommendations.push("Ajouter des keys stables à tous les rendus de listes.");
  }
  if (input.anyCount > 0) {
    recommendations.push("Réduire les any avec des interfaces explicites ou des types génériques.");
  }
  if (input.bundleEstimateKb > 0) {
    recommendations.push("Alléger le bundle avec du lazy loading et des imports ciblés.");
  }
  if (input.unusedDependencies.length > 0) {
    recommendations.push("Supprimer les dépendances runtime inutilisées.");
  }
  if (input.testCoverageEstimate < 50) {
    recommendations.push("Ajouter davantage de tests pour les composants critiques et les hooks métier.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Le projet est globalement sain : conserver les patterns actuels et surveiller la croissance des composants.");
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
    return { enabled: false, provider, skippedReason: "Aucune clé API détectée pour l'analyse IA." };
  }

  const model = options.model ?? envLookup(["OPENAI_MODEL", "AZURE_OPENAI_MODEL"]) ?? "gpt-4o-mini";
  const prompt = buildAiPrompt(payload);

  try {
    if (provider === "azure") {
      const endpoint = options.baseUrl ?? envLookup(["AZURE_OPENAI_ENDPOINT"]);
      const deployment = options.deployment ?? envLookup(["AZURE_OPENAI_DEPLOYMENT"]);
      const apiVersion = options.apiVersion ?? envLookup(["AZURE_OPENAI_API_VERSION"]) ?? "2024-02-15-preview";
      if (!endpoint || !deployment) {
        return { enabled: false, provider, model, skippedReason: "Configuration Azure OpenAI incomplète (endpoint ou deployment manquant)." };
      }

      const response = await fetch(`${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "Tu es un expert React/TypeScript qui produit des recommandations courtes et actionnables." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 400,
        }),
      });
      if (!response.ok) {
        return { enabled: false, provider, model, skippedReason: `Azure OpenAI a répondu avec le statut ${response.status}.` };
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
          { role: "system", content: "Tu es un expert React/TypeScript qui produit des recommandations courtes et actionnables." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      return { enabled: false, provider, model, skippedReason: `OpenAI a répondu avec le statut ${response.status}.` };
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
      skippedReason: error instanceof Error ? `Analyse IA indisponible : ${error.message}` : "Analyse IA indisponible.",
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
    `Score global: ${payload.score}/100`,
    `Projet React: ${payload.packageSnapshot.isReactProject ? "oui" : "non"}`,
    `TypeScript: ${payload.packageSnapshot.hasTypeScript ? "oui" : "non"}`,
    `Composants: ${payload.stats.components}`,
    `useEffect problématiques: ${payload.stats.useEffectIssues}`,
    `any détectés: ${payload.stats.anyCount}`,
    `Bundle estimé: ${payload.stats.bundleEstimateKb} KB`,
    "",
    "Findings:",
    topFindings || "- aucun",
    "",
    "Recommendations internes:",
    recommendations || "- aucune",
    "",
    "Donne 3 à 5 recommandations hiérarchisées, pragmatiques et actionnables.",
  ].join("\n");
}




