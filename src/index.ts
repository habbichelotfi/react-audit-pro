export { analyzeProject } from "./analyzer.js";
export { applyBaseline, findingFingerprint, readBaseline, writeBaseline } from "./baseline.js";
export type { AuditBaseline } from "./baseline.js";
export { measureBundleMetadata } from "./bundle-metadata.js";
export type { BundleMeasurement } from "./bundle-metadata.js";
export { DEFAULT_CONFIG, loadConfig, matchesIgnorePath } from "./config.js";
export type { AuditConfig, AuditConfigOverrides } from "./config.js";
export { renderHtmlReport, renderTextReport } from "./reporters.js";
export { renderSarifReport } from "./sarif.js";
export type { AnalysisResult, AiSummary, Finding, ScoreSection } from "./types.js";

