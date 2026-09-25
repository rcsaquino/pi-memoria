/**
 * Configuration and path resolution for memoria.
 *
 * A store root has this shape:
 *
 *   memoria/
 *   ├── MEMORY.md        curated memory injected into every session (<= hotLimit chars)
 *   ├── config.json      optional config overrides
 *   ├── .index/          derived index data (never indexed)
 *   ├── .trash/          soft-deleted memories
 *   └── library/         categorized markdown memories
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileOrUndefined } from "./util.ts";
import type { MemoriaConfig } from "./types.ts";

export const INDEX_DIR = ".index";
export const TRASH_DIR = ".trash";
export const LIBRARY_DIR = "library";
export const HOT_FILE = "MEMORY.md";
export const CONFIG_FILE = "config.json";
export const INDEX_FILE = "index.json";
export const INDEX_BIN_FILE = "index.bin";
export const USAGE_FILE = "usage.json";
export const SYNONYMS_FILE = "synonyms.json";

export const DEFAULT_CONFIG: MemoriaConfig = {
	version: 1,
	rootDir: "$AGENT_DIR/memoria",
	projectRoot: "",
	extraRoots: [],
	hotLimit: 5000,
	snippetChars: 280,
	autoRecall: true,
	autoRecallLimit: 3,
	autoRecallMinRatio: 0.3,
	autoRecallMinScore: 1.4,
	autoRecallMaxChars: 2400,
	autoRecallLastTurns: 1,
	autoRecallPriorWeight: 0.4,
	bodyCacheBytes: 8 * 1024 * 1024,
	scanIntervalMs: 2000,
	exclude: [],
	defaultCategory: "inbox",
	topicMaxWords: 6,
	topicMaxChars: 8000,
	usageTracking: true,
	lastUsedWriteIntervalMs: 21_600_000,
	staleAfterDays: 365,
	promoteAfterWrites: 3,
	dedupeThreshold: 0.62,
	relatedHits: 3,
	relatedBoost: 0.35,
	synonyms: {},
	synonymWeight: 0.6,
	timeHints: true,
	searchCacheSize: 32,
	rerank: false,
	rerankModel: "",
	rerankTopK: 12,
	rerankTimeoutMs: 2500,
	watcherSettleMs: 300,
	indexFormat: "auto",
	sessionSearch: true,
	sessionRoots: [],
	sessionFallback: true,
	sessionScanMs: 1500,
	sessionExcerptChars: 400,
	sessionCacheBytes: 32 * 1024 * 1024,
	sessionIncludeTools: false,
	sessionRipgrep: true,
};

/** Filesystem context used to resolve store paths. */
export interface PathContext {
	home: string;
	/** Pi's user config directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`). */
	agentDir: string;
}

export interface ResolvedRoots {
	/** The main user-level store: `<agent dir>/memoria` by default. */
	primary: string;
	/** Optional per-project store (writable). Empty string when disabled. */
	project: string;
	/** Additional read-only store roots declared in config. */
	extras: string[];
}

/**
 * Expand `$AGENT_DIR`, a leading `~`, absolute paths and cwd-relative paths.
 * Returns undefined for an empty value.
 */
export function resolveStorePath(input: string, cwd: string, context: PathContext): string | undefined {
	const value = (input ?? "").trim();
	if (!value) return undefined;
	let expanded = value.replace(/\$AGENT_DIR/g, context.agentDir);
	if (expanded === "~") return context.home;
	if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = join(context.home, expanded.slice(2));
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** Resolve the store roots for a working directory. */
export function resolveRoots(cwd: string, config: MemoriaConfig = DEFAULT_CONFIG, context?: Partial<PathContext>): ResolvedRoots {
	const home = context?.home ?? homedir();
	const pathContext: PathContext = { home, agentDir: context?.agentDir ?? join(home, ".pi", "agent") };
	const primary = resolveStorePath(config.rootDir, cwd, pathContext) ?? join(pathContext.agentDir, "memoria");
	const project = resolveStorePath(config.projectRoot ?? "", cwd, pathContext) ?? "";
	const extras = config.extraRoots
		.map((entry) => resolveStorePath(entry, cwd, pathContext))
		.filter((entry): entry is string => Boolean(entry) && entry !== primary && entry !== project);
	return { primary, project, extras: [...new Set(extras)] };
}

function coerceConfig(raw: unknown): Partial<MemoriaConfig> {
	if (!raw || typeof raw !== "object") return {};
	const input = raw as Record<string, unknown>;
	const out: Partial<MemoriaConfig> = {};
	const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
	const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
	if (str(input.rootDir)) out.rootDir = input.rootDir as string;
	if (Array.isArray(input.extraRoots)) out.extraRoots = input.extraRoots.filter((item): item is string => typeof item === "string");
	if (Array.isArray(input.exclude)) out.exclude = input.exclude.filter((item): item is string => typeof item === "string");
	if (number(input.hotLimit) !== undefined) out.hotLimit = Math.max(500, number(input.hotLimit)!);
	if (number(input.snippetChars) !== undefined) out.snippetChars = Math.max(80, number(input.snippetChars)!);
	if (bool(input.autoRecall) !== undefined) out.autoRecall = bool(input.autoRecall);
	if (number(input.autoRecallLimit) !== undefined) out.autoRecallLimit = Math.max(0, Math.min(20, number(input.autoRecallLimit)!));
	if (number(input.autoRecallMinRatio) !== undefined) out.autoRecallMinRatio = Math.max(0, Math.min(1, number(input.autoRecallMinRatio)!));
	if (number(input.autoRecallMinScore) !== undefined) out.autoRecallMinScore = Math.max(0, number(input.autoRecallMinScore)!);
	if (number(input.autoRecallMaxChars) !== undefined) out.autoRecallMaxChars = Math.max(200, number(input.autoRecallMaxChars)!);
	if (number(input.autoRecallLastTurns) !== undefined) out.autoRecallLastTurns = Math.max(0, Math.min(5, number(input.autoRecallLastTurns)!));
	if (number(input.bodyCacheBytes) !== undefined) out.bodyCacheBytes = Math.max(0, number(input.bodyCacheBytes)!);
	if (number(input.scanIntervalMs) !== undefined) out.scanIntervalMs = Math.max(250, number(input.scanIntervalMs)!);
	if (str(input.defaultCategory)) out.defaultCategory = input.defaultCategory as string;
	if (number(input.topicMaxWords) !== undefined) out.topicMaxWords = Math.max(1, Math.min(12, number(input.topicMaxWords)!));
	if (number(input.topicMaxChars) !== undefined) out.topicMaxChars = Math.max(500, number(input.topicMaxChars)!);
	if (str(input.projectRoot)) out.projectRoot = input.projectRoot as string;
	if (number(input.autoRecallPriorWeight) !== undefined) out.autoRecallPriorWeight = Math.max(0, Math.min(1, number(input.autoRecallPriorWeight)!));
	if (bool(input.usageTracking) !== undefined) out.usageTracking = bool(input.usageTracking);
	if (number(input.lastUsedWriteIntervalMs) !== undefined) out.lastUsedWriteIntervalMs = Math.max(60_000, number(input.lastUsedWriteIntervalMs)!);
	if (number(input.staleAfterDays) !== undefined) out.staleAfterDays = Math.max(1, number(input.staleAfterDays)!);
	if (number(input.promoteAfterWrites) !== undefined) out.promoteAfterWrites = Math.max(1, number(input.promoteAfterWrites)!);
	if (number(input.dedupeThreshold) !== undefined) out.dedupeThreshold = Math.max(0.2, Math.min(0.98, number(input.dedupeThreshold)!));
	if (number(input.relatedHits) !== undefined) out.relatedHits = Math.max(0, Math.min(10, number(input.relatedHits)!));
	if (number(input.relatedBoost) !== undefined) out.relatedBoost = Math.max(0, Math.min(2, number(input.relatedBoost)!));
	if (bool(input.timeHints) !== undefined) out.timeHints = bool(input.timeHints);
	if (number(input.searchCacheSize) !== undefined) out.searchCacheSize = Math.max(0, Math.min(512, number(input.searchCacheSize)!));
	if (bool(input.rerank) !== undefined) out.rerank = bool(input.rerank);
	if (str(input.rerankModel)) out.rerankModel = input.rerankModel as string;
	if (number(input.rerankTopK) !== undefined) out.rerankTopK = Math.max(1, Math.min(50, number(input.rerankTopK)!));
	if (number(input.rerankTimeoutMs) !== undefined) out.rerankTimeoutMs = Math.max(250, Math.min(30_000, number(input.rerankTimeoutMs)!));
	if (number(input.synonymWeight) !== undefined) out.synonymWeight = Math.max(0.1, Math.min(1, number(input.synonymWeight)!));
	if (number(input.watcherSettleMs) !== undefined) out.watcherSettleMs = Math.max(0, Math.min(5000, number(input.watcherSettleMs)!));
	if (str(input.indexFormat) && ["auto", "json", "binary"].includes(input.indexFormat as string)) out.indexFormat = input.indexFormat as string;
	if (bool(input.sessionSearch) !== undefined) out.sessionSearch = bool(input.sessionSearch);
	if (bool(input.sessionFallback) !== undefined) out.sessionFallback = bool(input.sessionFallback);
	if (bool(input.sessionIncludeTools) !== undefined) out.sessionIncludeTools = bool(input.sessionIncludeTools);
	if (number(input.sessionScanMs) !== undefined) out.sessionScanMs = Math.max(50, Math.min(60_000, number(input.sessionScanMs)!));
	if (number(input.sessionExcerptChars) !== undefined) out.sessionExcerptChars = Math.max(80, Math.min(4000, number(input.sessionExcerptChars)!));
	if (number(input.sessionCacheBytes) !== undefined) out.sessionCacheBytes = Math.max(0, number(input.sessionCacheBytes)!);
	if (bool(input.sessionRipgrep) !== undefined) out.sessionRipgrep = bool(input.sessionRipgrep);
	if (Array.isArray(input.sessionRoots)) out.sessionRoots = input.sessionRoots.filter((item): item is string => typeof item === "string");
	if (input.synonyms && typeof input.synonyms === "object" && !Array.isArray(input.synonyms)) {
		const table: Record<string, string[]> = {};
		for (const [key, value] of Object.entries(input.synonyms as Record<string, unknown>)) {
			const term = key.trim().toLowerCase();
			if (!term) continue;
			const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
			const cleaned = list.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry && entry !== term);
			if (cleaned.length > 0) table[term] = [...new Set(cleaned)].slice(0, 12);
		}
		out.synonyms = table;
	}
	return out;
}

/** Load `<root>/config.json`, merged over defaults. Malformed files fall back to defaults. */
export async function loadConfig(root: string): Promise<MemoriaConfig> {
	const raw = await readFileOrUndefined(join(root, CONFIG_FILE));
	if (!raw) return { ...DEFAULT_CONFIG };
	try {
		const parsed = JSON.parse(raw) as unknown;
		return { ...DEFAULT_CONFIG, ...coerceConfig(parsed) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
