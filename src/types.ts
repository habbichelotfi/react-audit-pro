export type IssueSeverity = "info" | "warning" | "critical";

export interface Finding {
  id: string;
  ruleId?: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestions: string[];
}

export interface ScoreSection {
  name: string;
  score: number;
  maxScore: number;
  notes: string[];
}

export interface FileSummary {
  file: string;
  lines: number;
  components: number;
  useEffects: number;
  useMemo: number;
  useCallback: number;
  anyCount: number;
}

export interface ArchitectureSummary {
  hasComponentsDir: boolean;
  hasPagesDir: boolean;
  hasHooksDir: boolean;
  hasServicesDir: boolean;
  hasUtilsDir: boolean;
  allComponentsInComponentsDir: boolean;
  hasDedicatedFolders: boolean;
}

export interface PackageSnapshot {
  name?: string | undefined;
  reactVersion?: string | undefined;
  isReactProject: boolean;
  hasTypeScript: boolean;
  dependencies: string[];
  devDependencies: string[];
  peerDependencies: string[];
}

export interface AiSummary {
  enabled: boolean;
  provider: string;
  model?: string | undefined;
  summary?: string | undefined;
  skippedReason?: string | undefined;
}

export interface AnalysisResult {
  rootDir: string;
  packageSnapshot: PackageSnapshot;
  architecture: ArchitectureSummary;
  files: FileSummary[];
  stats: {
    totalFiles: number;
    sourceFiles: number;
    testFiles: number;
    components: number;
    largeComponents: number;
    useEffects: number;
    useEffectIssues: number;
    mapCallbacks: number;
    mapCallbacksWithoutKeys: number;
    useMemoCount: number;
    useCallbackCount: number;
    anyCount: number;
    bundleEstimateKb: number;
    realBundleBytes?: number;
    realBundleKb?: number;
    realBundleTool?: "esbuild" | "webpack" | "vite";
    realBundleFiles?: number;
    unusedDependencyCount: number;
    unusedDependencies: string[];
  };
  findings: Finding[];
  recommendations: string[];
  scoreBreakdown: ScoreSection[];
  score: number;
  baseline?: { ignoredFindings: number };
  ci?: { passed: boolean; minScore: number; scorePassed: boolean; newFindings: number };
  ai?: AiSummary | undefined;
}

