/**
 * MemoriaRuntime: binds configuration, store roots, in-memory indexes, file
 * watchers and write paths into one object that tools and commands share.
 *
 * Responsibilities beyond the store layer:
 *
 * - Serialize every read-modify-write per root (`KeyedMutex`).
 * - Keep an LRU of recent searches, invalidated by any mutation.
 * - Track hits/writes/last-used (`UsageStore`) outside the search path.
 * - Merge several roots with rank normalization so no store is drowned.
 * - Report health: duplicate topics, contradictions, staleness, promotion.
 * - Export and import the store as JSONL.
 */

import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { DEFAULT_CONFIG, INDEX_DIR, LIBRARY_DIR, loadConfig, resolveRoots, resolveStorePath, type PathContext, type ResolvedRoots } from "./config.ts";
import { MemoryIndex, createIndexSaver, isIgnoredWatchPath } from "./index-engine.ts";
import {
	addHotEntry,
	appendFact,
	categorySummary,
	createMemory,
	deleteMemory,
	deriveSummary,
	ensureStore,
	extendSummary,
	extractFactUnits,
	hotTemplate,
	looksAtomicTopic,
	moveMemory,
	normalizePriority,
	priorityRank,
	readHot,
	recoverJournal,
	removeHotMatches,
	renderLibraryIndexes,
	resolveMemoryRef,
	touchLastUsed,
	trimHot,
	updateMemory,
	writeHot,
	type CreateMemoryInput,
	type CreateMemoryResult,
	type IndexListingDoc,
	type MoveMemoryInput,
	type MoveMemoryResult,
	type UpdateMemoryInput,
} from "./store.ts";
import { SessionStore } from "./sessions.ts";
import { UsageStore } from "./usage.ts";
import { compareDocs, detectContradictions, isComparableTerm, suggestMerges, type SimilarityDoc } from "./similarity.ts";
import { expandSynonymTable, loadSynonymsFile, mergeSynonymTables } from "./synonyms.ts";
import { decodeJsonl, encodeJsonl, writeImportedNote, type ImportedNote } from "./transfer.ts";
import { KeyedMutex, atomicWriteFile, debounce, normalizePath, oneLine, readFileOrUndefined } from "./util.ts";
import type {
	Contradiction,
	HotFileState,
	MemoriaConfig,
	MemoryDoc,
	MergeSuggestion,
	Scope,
	SearchHit,
	SearchOptions,
	SearchResult,
	SessionHit,
	SessionReadResult,
	SessionScanStats,
	SessionSearchOptions,
	SessionSearchResult,
	StoreStats,
	TimeWindow,
} from "./types.ts";

interface StoreState {
	root: string;
	index: MemoryIndex;
	saver: ReturnType<typeof createIndexSaver>;
	usage?: UsageStore;
	usageSaver: ReturnType<typeof debounce<[]>>;
	/** Merged per-store synonym table (config + synonyms.json). */
	synonyms?: { table: Record<string, string[]>; loadedAt: number };
	/** Coalesces watcher bursts into one refresh. */
	settleTimer?: ReturnType<typeof setTimeout>;
	/** Notes whose `last_used` frontmatter still needs refreshing. */
	pendingTouch: Set<string>;
	watcher?: FSWatcher;
	/** Description of a crash-recovered move, surfaced by stats/doctor. */
	recovered?: string;
}

/** Orders candidate ids after an optional model rerank. */
export type Reranker = (query: string, hits: SearchHit[], options: { topK: number; timeoutMs: number; model: string }) => Promise<string[] | undefined>;

export interface RuntimeSearchResult extends SearchResult {
	/** Per-root breakdown, useful for diagnostics. */
	byRoot: Array<{ root: string; hits: number; tookMs: number }>;
	/** True when the result came from the LRU instead of the index. */
	cached?: boolean;
	/** True when a model reranker reordered the hits. */
	reranked?: boolean;
	/**
	 * Excerpts from past conversations, attached only when the library returned
	 * nothing. These are evidence, not curated memory: the caller must label
	 * them and point at `memoria_sessions` for verification.
	 */
	sessionHits?: SessionHit[];
	sessionStats?: SessionScanStats;
}

export interface TopicReportEntry {
	id: string;
	title: string;
	relPath: string;
	root: string;
	category: string;
	/** Number of fact units in the body. */
	facts: number;
	bytes: number;
	updated: number;
	lastUsed: number;
	hits: number;
	writes: number;
	/** True when the note has not been retrieved within `staleAfterDays`. */
	stale: boolean;
}

const SEARCH_CACHE_TTL_MS = 120_000;
/** Most notes touched with `last_used` in one flush, to bound write bursts. */
const MAX_TOUCH_PER_FLUSH = 20;

/**
 * Cheap `{id, path, aliases}` view of the index, used to resolve references
 * without touching the filesystem.
 */
function liveLookup(index: MemoryIndex): Array<{ id: string; path: string; aliases: string[] }> {
	return index.liveDocs().map((entry) => ({ id: entry.meta.id, path: entry.meta.path, aliases: entry.meta.aliases ?? [] }));
}

export class MemoriaRuntime {
	config: MemoriaConfig = { ...DEFAULT_CONFIG };
	roots: ResolvedRoots;
	private stores = new Map<string, StoreState>();
	/** Serializes read-modify-write sequences per store root. */
	private locks = new KeyedMutex();
	private initialized = false;
	private cwd: string;
	private pathContext: PathContext;
	private reranker?: Reranker;
	private searchCache = new Map<string, { result: RuntimeSearchResult; generation: number; at: number }>();
	private cacheGeneration = 0;
	private sessionStore?: SessionStore;
	private sessionStoreKey = "";

	/**
	 * @param cwd  Working directory of the session (only used for relative paths).
	 * @param options.home      Home directory for `~` expansion.
	 * @param options.agentDir  Pi's agent config directory. The extension passes
	 *                          pi's own `getAgentDir()` so `$AGENT_DIR` follows
	 *                          `PI_CODING_AGENT_DIR`; it defaults to `~/.pi/agent`.
	 */
	constructor(cwd: string, options: { home?: string; agentDir?: string } = {}) {
		this.cwd = cwd;
		const home = options.home ?? homedir();
		this.pathContext = { home, agentDir: options.agentDir ?? join(home, ".pi", "agent") };
		this.roots = resolveRoots(cwd, this.config, this.pathContext);
	}

	setCwd(cwd: string): void {
		if (cwd === this.cwd) return;
		this.cwd = cwd;
		this.roots = resolveRoots(cwd, this.config, this.pathContext);
	}

	/** Install (or clear) the optional model reranker. */
	setReranker(reranker: Reranker | undefined): void {
		this.reranker = reranker;
	}

	/** Load config, create stores and start watching. Idempotent. */
	async init(force = false, reloadConfig = true): Promise<void> {
		if (this.initialized && !force) return;
		this.initialized = true;
		this.roots = resolveRoots(this.cwd, this.config, this.pathContext);
		const projectExists = existsSync(this.roots.primary);
		if (reloadConfig) {
			// Only auto-create the project store once memoria is initialized by use;
			// reads fall back to an empty store when it does not exist yet.
			this.config = await safeLoadConfig(this.roots.primary);
		}
		this.roots = resolveRoots(this.cwd, this.config, this.pathContext);
		if (force || projectExists) await ensureStore(this.roots.primary, this.config.hotLimit, this.config.defaultCategory);
		const active = this.activeRoots("all");
		for (const root of active) {
			await this.storeFor(root, true);
		}
		await this.primeSynonyms();
	}

	/** Replace the active configuration and rebuild stores (used when config changes). */
	async reconfigure(config: MemoriaConfig): Promise<void> {
		await this.dispose();
		this.clearSessionCache();
		this.config = config;
		this.roots = resolveRoots(this.cwd, this.config, this.pathContext);
		await this.init(true, false);
	}

	/** Load config + ensure store without starting watchers (used by commands). */
	async prepare(create = true): Promise<void> {
		const projectExists = existsSync(this.roots.primary);
		if (projectExists || !create) this.config = await safeLoadConfig(this.roots.primary);
		this.roots = resolveRoots(this.cwd, this.config, this.pathContext);
		if (create) await ensureStore(this.roots.primary, this.config.hotLimit, this.config.defaultCategory);
	}

	configure(config: MemoriaConfig): void {
		this.config = config;
		this.roots = resolveRoots(this.cwd, this.config, this.pathContext);
	}

	/* ---------------------------------------------------------------- */
	/* Stores                                                            */
	/* ---------------------------------------------------------------- */

	private activeRoots(scope: Scope = "all"): string[] {
		const normalized = normalizeScope(scope);
		const available: string[] = [];
		const push = (root: string | undefined): void => {
			if (root && existsSync(root) && !available.includes(root)) available.push(root);
		};
		if (normalized === "project") {
			push(this.roots.project);
			return available;
		}
		push(this.roots.primary);
		if (normalized === "all") {
			push(this.roots.project);
			for (const extra of this.roots.extras) push(extra);
		}
		return available;
	}

	/**
	 * The root a write should target.
	 *
	 * `primary` is the user-level store; `project` is the optional writable
	 * per-project store; `all` writes to the primary store. `extraRoots` are
	 * read-only additions by design.
	 */
	rootForScope(scope: Scope): string {
		const normalized = normalizeScope(scope);
		if (normalized === "project" && this.roots.project) return this.roots.project;
		return this.roots.primary;
	}

	private async storeFor(root: string, startWatcher = false): Promise<StoreState> {
		let state = this.stores.get(root);
		if (state) {
			if (startWatcher) this.ensureWatcher(state);
			return state;
		}
		const index = new MemoryIndex(root, {
			bodyCacheBytes: this.config.bodyCacheBytes,
			maxScanIntervalMs: this.config.scanIntervalMs,
			exclude: this.config.exclude,
			indexFormat: this.config.indexFormat,
		});
		const saver = createIndexSaver(index);
		state = {
			root,
			index,
			saver,
			usageSaver: debounce(() => {
				void this.flushUsage(root, state!).catch(() => {});
			}, 4000),
			pendingTouch: new Set(),
		};
		this.stores.set(root, state);
		const recovered = await recoverJournal(root).catch(() => undefined);
		if (recovered) state.recovered = recovered;
		await index.load();
		if (this.config.usageTracking) state.usage = await UsageStore.load(root).catch(() => undefined);
		if (startWatcher) this.ensureWatcher(state);
		return state;
	}

	private ensureWatcher(state: StoreState): void {
		if (state.watcher) return;
		try {
			state.watcher = watch(state.root, { recursive: true }, (_event, filename) => {
				const name = filename ? normalizePath(String(filename)) : "";
				if (isIgnoredWatchPath(name)) return;
				state!.index.dirty = true;
				// Coalesce bursts (editors write several files at once, memories are
				// moved in pairs): refresh once the filesystem settles instead of on
				// every event.
				this.scheduleSettle(state!);
			});
			state.watcher.on("error", () => {
				state.watcher?.close();
				state.watcher = undefined;
				state.index.watcherActive = false;
			});
			state.index.watcherActive = true;
		} catch {
			state.index.watcherActive = false;
		}
	}

	private scheduleSettle(state: StoreState): void {
		const delay = this.config.watcherSettleMs;
		if (delay <= 0) return;
		if (state.settleTimer) clearTimeout(state.settleTimer);
		state.settleTimer = setTimeout(() => {
			state.settleTimer = undefined;
			void state.index.refresh(false).then((changed) => {
				if (changed) {
					this.bumpCacheGeneration();
					state.saver.schedule();
				}
			});
		}, delay);
		state.settleTimer.unref?.();
	}

	/** Get an index for a root, loading it lazily. */
	async indexFor(root: string): Promise<MemoryIndex> {
		const state = await this.storeFor(root);
		return state.index;
	}

	/** Invalidate the search LRU (any mutation or external change). */
	private bumpCacheGeneration(): void {
		this.cacheGeneration += 1;
		this.searchCache.clear();
	}

	/* ---------------------------------------------------------------- */
	/* Search                                                            */
	/* ---------------------------------------------------------------- */

	/**
	 * Search every active root and merge the results.
	 *
	 * Scores are rank-normalized *upward* only: a store whose best hit scores
	 * lower purely because its corpus is small is lifted to the global best
	 * (`scale = globalMax / rootMax`, capped at 4). Nothing is ever demoted, so
	 * the raw scale that `autoRecallMinScore` is calibrated against survives.
	 */
	async search(query: string, options: SearchOptions & { scope?: Scope } = {}): Promise<RuntimeSearchResult> {
		const started = performance.now();
		const scope = options.scope ?? "all";
		const roots = this.activeRoots(scope);
		if (roots.length === 0) {
			return { hits: [], total: 0, tookMs: 0, truncated: false, missing: [], byRoot: [] };
		}
		const limit = Math.max(1, options.limit ?? 8);
		const cacheKey = this.searchCacheKey(query, options);
		const cached = this.lookupCache(cacheKey);
		if (cached) {
			if (cached.timeWindow) options.onTimeWindow?.(cached.timeWindow);
			this.recordHits(cached.hits);
			return { ...cached, cached: true, tookMs: Math.round((performance.now() - started) * 1000) / 1000 };
		}

		const perRoot = await Promise.all(
			roots.map(async (root) => {
				const state = await this.storeFor(root);
				const index = state.index;
				const refreshed = options.refresh ? await index.refresh(true) : await index.refresh(false);
				if (refreshed) this.bumpCacheGeneration();
				const synonyms = await this.synonymsFor(root);
				const result = await index.search(query, {
					...options,
					limit: Math.max(limit, 8),
					synonyms,
					synonymWeight: this.config.synonymWeight,
					snippetChars: this.config.snippetChars,
					relatedHits: options.relatedHits ?? this.config.relatedHits,
					relatedBoost: options.relatedBoost ?? this.config.relatedBoost,
					timeHints: options.timeHints ?? this.config.timeHints,
				});
				return { root, result };
			}),
		);

		const globalMax = Math.max(0, ...perRoot.map((entry) => entry.result.hits[0]?.score ?? 0));
		const merged: SearchHit[] = [];
		const seenIds = new Set<string>();
		let total = 0;
		let truncated = false;
		let timeWindow: TimeWindow | undefined;
		const missing = new Set<string>();
		const byRoot: RuntimeSearchResult["byRoot"] = [];
		for (const entry of perRoot) {
			total += entry.result.total;
			truncated = truncated || entry.result.truncated;
			for (const term of entry.result.missing) missing.add(term);
			if (entry.result.timeWindow) timeWindow = entry.result.timeWindow;
			const rootMax = entry.result.hits[0]?.score ?? 0;
			const scale = rootMax > 0 && rootMax < globalMax ? Math.min(4, globalMax / rootMax) : 1;
			for (const hit of entry.result.hits) {
				// Ids are unique per store, not across stores: a note that exists in
				// two roots is returned once (the first root wins).
				if (seenIds.has(hit.doc.id)) continue;
				seenIds.add(hit.doc.id);
				merged.push(scale === 1 ? hit : { ...hit, score: Math.round(hit.score * scale * 1000) / 1000 });
			}
			byRoot.push({ root: entry.root, hits: entry.result.hits.length, tookMs: entry.result.tookMs });
		}
		merged.sort((a, b) => b.score - a.score);
		const result: RuntimeSearchResult = {
			hits: merged.slice(0, limit),
			total,
			tookMs: Math.round((performance.now() - started) * 1000) / 1000,
			truncated,
			missing: [...missing].slice(0, 8),
			timeWindow,
			byRoot,
		};
		this.storeCache(cacheKey, result);
		this.recordHits(result.hits);
		return result;
	}

	/** Search, then optionally reorder the top candidates with the model. */
	async recall(query: string, options: SearchOptions & { scope?: Scope; rerank?: boolean; sessionFallback?: boolean } = {}): Promise<RuntimeSearchResult> {
		const result = await this.search(query, options);
		// "Not in memory" is the case session transcripts exist for: attach a
		// small, clearly-labelled set of excerpts so the model can check what was
		// actually said before claiming it does not know.
		if (result.hits.length === 0 && options.sessionFallback !== false && this.config.sessionFallback) {
			const fallback = await this.sessionSearch(query, {
				limit: 2,
				// The fallback runs inside a prompt, so it gets a small slice of the
				// search budget; the explicit tool call can take longer.
				budgetMs: Math.min(this.config.sessionScanMs, 400),
			}).catch(() => undefined);
			if (fallback) {
				// Stats are kept even with no hits: they carry the ripgrep status the
				// caller warns about, and the renderers only show the excerpts when
				// `sessionHits` is non-empty.
				result.sessionStats = fallback.stats;
				if (fallback.hits.length > 0) result.sessionHits = fallback.hits;
			}
		}
		const wanted = options.rerank ?? this.config.rerank;
		if (!wanted || !this.reranker || result.hits.length < 2) return result;
		const topK = Math.max(2, Math.min(this.config.rerankTopK, result.hits.length));
		const candidates = result.hits.slice(0, topK);
		try {
			const order = await this.reranker(query, candidates, {
				topK,
				timeoutMs: this.config.rerankTimeoutMs,
				model: this.config.rerankModel,
			});
			if (!order || order.length === 0) return result;
			const position = new Map(order.map((id, index) => [id, index]));
			const reordered = [...candidates].sort((a, b) => {
				const pa = position.get(a.doc.id) ?? Number.MAX_SAFE_INTEGER;
				const pb = position.get(b.doc.id) ?? Number.MAX_SAFE_INTEGER;
				return pa - pb || b.score - a.score;
			});
			return { ...result, hits: [...reordered, ...result.hits.slice(topK)], reranked: true };
		} catch {
			// Reranking is best-effort: a failure must never break recall.
			return result;
		}
	}

	private searchCacheKey(query: string, options: SearchOptions & { scope?: Scope }): string {
		const normalized = {
			q: query,
			limit: options.limit ?? 8,
			category: options.category ?? "",
			tags: options.tags ?? [],
			anyTags: options.anyTags ?? [],
			minPriority: options.minPriority ?? "",
			since: options.since ?? 0,
			includeUnfiled: options.includeUnfiled !== false,
			minScore: options.minScore ?? 0,
			prefix: options.prefix !== false,
			fuzzy: options.fuzzy !== false,
			expandRelated: options.expandRelated !== false,
			explain: Boolean(options.explain),
			scope: options.scope ?? "all",
		};
		return `${this.activeRoots(options.scope ?? "all").join("|")}::${JSON.stringify(normalized)}`;
	}

	private lookupCache(key: string): RuntimeSearchResult | undefined {
		if (this.config.searchCacheSize <= 0 || !key) return undefined;
		const entry = this.searchCache.get(key);
		if (!entry) return undefined;
		if (entry.generation !== this.cacheGeneration || Date.now() - entry.at > SEARCH_CACHE_TTL_MS) {
			this.searchCache.delete(key);
			return undefined;
		}
		// Refresh recency.
		this.searchCache.delete(key);
		this.searchCache.set(key, entry);
		return entry.result;
	}

	private storeCache(key: string, result: RuntimeSearchResult): void {
		if (this.config.searchCacheSize <= 0 || !key) return;
		if (this.searchCache.size >= this.config.searchCacheSize) {
			const oldest = this.searchCache.keys().next();
			if (!oldest.done) this.searchCache.delete(oldest.value);
		}
		this.searchCache.set(key, { result, generation: this.cacheGeneration, at: Date.now() });
	}

	/** Count retrieved notes for promotion/staleness tracking (never blocks). */
	private recordHits(hits: SearchHit[]): void {
		if (!this.config.usageTracking) return;
		const now = Date.now();
		for (const hit of hits) {
			const state = this.stores.get(hit.doc.root);
			if (!state?.usage) continue;
			state.usage.record(hit.doc.id, "hit", now);
			state.pendingTouch.add(hit.doc.id);
			state.usageSaver();
		}
	}

	/** Persist usage and refresh `last_used` frontmatter for recently used notes. */
	private async flushUsage(root: string, state: StoreState): Promise<void> {
		const usage = state.usage;
		if (!usage) return;
		await this.locks.run(root, async () => {
			const validIds = new Set(state.index.liveDocs().map((entry) => entry.meta.id));
			if (usage.size > validIds.size * 1.2) usage.prune(validIds);
			let touched = 0;
			for (const id of [...state.pendingTouch]) {
				if (touched >= MAX_TOUCH_PER_FLUSH) break;
				const entry = usage.get(id);
				if (!entry) continue;
				const idx = state.index.idxForId(id);
				if (idx === undefined) continue;
				const doc = await resolveMemoryRef(root, id, liveLookup(state.index));
				state.pendingTouch.delete(id);
				if (!doc) continue;
				if (entry.lastUsed - (doc.lastUsed || 0) < this.config.lastUsedWriteIntervalMs) continue;
				const updated = await touchLastUsed(root, doc, entry.lastUsed).catch(() => undefined);
				if (!updated) continue;
				state.index.removeDoc(idx);
				state.index.addDoc(updated);
				state.saver.schedule();
				touched += 1;
			}
			await usage.save().catch(() => {});
		});
	}

	/** Flush every pending `last_used` update immediately (shutdown). */
	async flushUsageNow(): Promise<void> {
		for (const state of this.stores.values()) {
			state.usageSaver.flush();
			await this.flushUsage(state.root, state).catch(() => {});
		}
	}

	/* ---------------------------------------------------------------- */
	/* Past sessions                                                     */
	/* ---------------------------------------------------------------- */

	/** Roots searched for saved transcripts: config extras first, then pi's own. */
	sessionRoots(): string[] {
		const roots: string[] = [];
		const push = (root: string): void => {
			if (root && !roots.includes(root)) roots.push(root);
		};
		for (const extra of this.config.sessionRoots) {
			const resolved = resolveStorePath(extra, this.cwd, this.pathContext);
			if (resolved) push(resolved);
		}
		push(join(this.pathContext.agentDir, "sessions"));
		push(join(this.pathContext.agentDir, "sessions-archive"));
		return roots;
	}

	/** Lazily create the transcript store (keys on config + agent dir). */
	private sessions(): SessionStore {
		const roots = this.sessionRoots();
		const key = `${roots.join("|")}::${this.config.sessionCacheBytes}::${this.config.sessionExcerptChars}::${this.config.sessionRipgrep}`;
		if (!this.sessionStore || this.sessionStoreKey !== key) {
			this.sessionStore = new SessionStore({
				roots,
				cacheBytes: this.config.sessionCacheBytes,
				excerptChars: this.config.sessionExcerptChars,
				rgPath: this.config.sessionRipgrep ? undefined : null,
				// pi ships ripgrep under <agent dir>/bin and puts it on PATH.
				rgCandidates: [join(this.pathContext.agentDir, "bin", process.platform === "win32" ? "rg.exe" : "rg")],
			});
			this.sessionStoreKey = key;
		}
		return this.sessionStore;
	}

	/**
	 * Search saved session transcripts. Read-only, bounded and always safe to
	 * call: a missing sessions directory yields an empty result.
	 */
	async sessionSearch(query: string, options: SessionSearchOptions = {}): Promise<SessionSearchResult> {
		const empty: SessionSearchResult = {
			hits: [],
			stats: { roots: [], files: 0, messages: 0, bytes: 0, cachedFiles: 0, skipped: 0, partial: false },
			tookMs: 0,
		};
		if (!this.config.sessionSearch) return empty;
		const store = this.sessions();
		const haveRoots = store.roots.some((root) => existsSync(root));
		if (!haveRoots) return { ...empty, stats: { ...empty.stats, roots: store.roots } };
		const result = await store.search(query, {
			...options,
			includeTools: options.includeTools ?? this.config.sessionIncludeTools,
			budgetMs: options.budgetMs ?? this.config.sessionScanMs,
		});
		this.lastSessionSearchMs = result.tookMs;
		return result;
	}

	/** Read a window of a transcript around a hit line (verification step). */
	async sessionRead(path: string, line: number, window = 6): Promise<SessionReadResult | undefined> {
		if (!this.config.sessionSearch) return undefined;
		return this.sessions().readWindow(path, line, window);
	}

	/** Drop the transcript cache (used when config changes). */
	clearSessionCache(): void {
		this.sessionStore?.clear();
		this.sessionStore = undefined;
		this.sessionStoreKey = "";
	}

	/** Milliseconds of the last transcript scan, for status reporting. */
	lastSessionSearchMs = 0;

	/* ---------------------------------------------------------------- */
	/* Writes                                                            */
	/* ---------------------------------------------------------------- */

	async write(input: CreateMemoryInput & { scope?: Scope }): Promise<{ result: CreateMemoryResult; root: string }> {
		const root = this.rootForScope(input.scope ?? "primary");
		await ensureStore(root, this.config.hotLimit, this.config.defaultCategory);
		const written = await this.locks.run(root, () => this.writeLocked(root, input));
		this.bumpCacheGeneration();
		const state = this.stores.get(root);
		if (state?.usage) {
			state.usage.record(written.result.doc.id, "write");
			state.usageSaver();
		}
		return written;
	}

	private async writeLocked(root: string, input: CreateMemoryInput): Promise<{ result: CreateMemoryResult; root: string }> {
		const state = await this.storeFor(root);
		const existingIdx = input.id ? state.index.idxForId(input.id) ?? -1 : -1;
		const existingDoc =
			existingIdx >= 0
				? await resolveMemoryRef(root, input.id!, liveLookup(state.index))
				: undefined;
		const previousByPath = state.index.idxForRelPath(input.id && existingDoc ? existingDoc.relPath : "");
		const result = await createMemory(root, { ...input, existingDoc }, this.config.defaultCategory, {
			topicMaxWords: this.config.topicMaxWords,
			topicMaxChars: this.config.topicMaxChars,
		});
		if (existingIdx >= 0) state.index.removeDoc(existingIdx);
		if (previousByPath >= 0 && previousByPath !== existingIdx) state.index.removeDoc(previousByPath);
		const stale = state.index.idxForRelPath(result.relPath);
		if (stale >= 0) state.index.removeDoc(stale);
		state.index.addDoc(result.doc);
		state.index.builtAt = Date.now();
		state.saver.schedule();
		return { result, root };
	}

	/** Append a fact to an existing note by id (used by session learning). */
	async appendToNote(
		id: string,
		input: { content: string; label?: string; tags?: string[]; summary?: string; priority?: string; confidence?: string; source?: string },
		scope: Scope = "all",
	): Promise<{ doc: MemoryDoc; duplicate: boolean } | undefined> {
		const candidates = scope === "all" ? this.activeRoots("all") : [this.rootForScope(scope)];
		for (const root of candidates) {
			const locked = await this.locks.run(root, async () => this.appendToNoteLocked(root, id, input));
			if (locked) {
				this.bumpCacheGeneration();
				return locked;
			}
		}
		return undefined;
	}

	private async appendToNoteLocked(
		root: string,
		id: string,
		input: { content: string; label?: string; tags?: string[]; summary?: string; priority?: string; confidence?: string; source?: string },
	): Promise<{ doc: MemoryDoc; duplicate: boolean } | undefined> {
		const state = await this.storeFor(root);
		const idx = state.index.idxForId(id);
		if (idx === undefined) return undefined;
		const doc = await resolveMemoryRef(root, id, liveLookup(state.index));
		if (!doc) return undefined;
		const appended = appendFact(doc.body, input.label, input.content);
		if (!appended.changed) return { doc, duplicate: true };
		const tags = input.tags ? [...new Set([...doc.tags, ...input.tags])] : undefined;
		const priority = input.priority && priorityRank(normalizePriority(input.priority)) > priorityRank(doc.priority) ? input.priority : undefined;
		const summary = extendSummary(doc.summary, input.summary ?? deriveSummary(input.content));
		const updated = await updateMemory(root, doc, {
			content: appended.body,
			tags,
			summary,
			priority,
			confidence: input.confidence,
			source: input.source,
		});
		state.index.removeDoc(idx);
		state.index.addDoc(updated);
		state.index.builtAt = Date.now();
		state.saver.schedule();
		if (state.usage) {
			state.usage.record(updated.id, "write");
			state.usageSaver();
		}
		return { doc: updated, duplicate: false };
	}

	async updateMemoryById(
		id: string,
		input: UpdateMemoryInput & { scope?: Scope },
	): Promise<{ doc: MemoryDoc; root: string } | undefined> {
		const candidates = this.activeRoots(input.scope ?? "primary");
		for (const root of candidates) {
			const locked = await this.locks.run(root, async () => this.updateMemoryByIdLocked(root, id, input));
			if (locked) {
				this.bumpCacheGeneration();
				return locked;
			}
		}
		return undefined;
	}

	private async updateMemoryByIdLocked(root: string, id: string, input: UpdateMemoryInput): Promise<{ doc: MemoryDoc; root: string } | undefined> {
		const state = await this.storeFor(root);
		const idx = state.index.idxForId(id);
		if (idx === undefined) return undefined;
		const doc = await resolveMemoryRef(root, id, liveLookup(state.index));
		if (!doc) return undefined;
		const updated = await updateMemory(root, doc, input);
		state.index.removeDoc(idx);
		state.index.addDoc(updated);
		state.index.builtAt = Date.now();
		state.saver.schedule();
		return { doc: updated, root };
	}

	/**
	 * Re-file a note under a better broad topic, merging into the target note
	 * when one already exists there.
	 */
	async move(
		from: string,
		input: MoveMemoryInput,
		scope: Scope = "primary",
	): Promise<{ result: MoveMemoryResult; root: string } | undefined> {
		const candidates = this.activeRoots(scope);
		for (const root of candidates) {
			const locked = await this.locks.run(root, async () => this.moveLocked(root, from, input));
			if (locked) {
				this.bumpCacheGeneration();
				return locked;
			}
		}
		return undefined;
	}

	private async moveLocked(root: string, from: string, input: MoveMemoryInput): Promise<{ result: MoveMemoryResult; root: string } | undefined> {
		const state = await this.storeFor(root);
		const doc = await resolveMemoryRef(root, from, liveLookup(state.index));
		if (!doc) return undefined;
		const sourceIdx = state.index.idxForRelPath(doc.relPath);
		const result = await moveMemory(root, doc, input, this.config.defaultCategory, {
			topicMaxWords: this.config.topicMaxWords,
			topicMaxChars: this.config.topicMaxChars,
		});
		if (sourceIdx >= 0) state.index.removeDoc(sourceIdx);
		// Replacing the target's index entry must happen after removing the source:
		// merging keeps the target's id but the source's path may have been indexed.
		const targetIdx = state.index.idxForRelPath(result.doc.relPath);
		if (targetIdx >= 0) state.index.removeDoc(targetIdx);
		const staleIdx = state.index.idxForId(result.doc.id);
		if (staleIdx !== undefined) state.index.removeDoc(staleIdx);
		state.index.addDoc(result.doc);
		state.index.builtAt = Date.now();
		state.saver.schedule();
		return { result, root };
	}

	async forget(id: string, scope: Scope = "primary"): Promise<{ doc: MemoryDoc; trashPath: string; root: string } | undefined> {
		const candidates = this.activeRoots(scope);
		for (const root of candidates) {
			const locked = await this.locks.run(root, async () => this.forgetLocked(root, id));
			if (locked) {
				this.bumpCacheGeneration();
				return locked;
			}
		}
		return undefined;
	}

	private async forgetLocked(root: string, id: string): Promise<{ doc: MemoryDoc; trashPath: string; root: string } | undefined> {
		const state = await this.storeFor(root);
		const idx = state.index.idxForId(id);
		if (idx === undefined) return undefined;
		const doc = await resolveMemoryRef(root, id, liveLookup(state.index));
		if (!doc) return undefined;
		const trashPath = await deleteMemory(root, doc);
		state.index.removeDoc(idx);
		state.index.builtAt = Date.now();
		state.saver.schedule();
		if (state.usage) {
			state.usage.prune(new Set(state.index.liveDocs().map((entry) => entry.meta.id)));
			state.usageSaver();
		}
		return { doc, trashPath, root };
	}

	async readMemory(ref: string, scope: Scope = "all"): Promise<{ doc: MemoryDoc; root: string } | undefined> {
		const candidates = this.activeRoots(scope);
		for (const root of candidates) {
			const state = await this.storeFor(root);
			const lookup = liveLookup(state.index);
			const doc = await resolveMemoryRef(root, ref, lookup);
			if (doc) return { doc, root };
		}
		return undefined;
	}

	/**
	 * Notes that declare this one superseded, plus the notes it relates to.
	 * Used by `memoria_read` so the agent never acts on a replaced decision.
	 */
	async linksFor(id: string, scope: Scope = "all"): Promise<{ supersededBy: Array<{ id: string; title: string }>; related: Array<{ id: string; title: string; relPath: string }> }> {
		const supersededBy: Array<{ id: string; title: string }> = [];
		const related: Array<{ id: string; title: string; relPath: string }> = [];
		for (const root of this.activeRoots(scope)) {
			const state = await this.storeFor(root);
			const index = state.index;
			const idx = index.idxForId(id);
			if (idx === undefined) continue;
			const meta = index.docs[idx];
			for (const [supersededId, superseding] of index.supersedeMap()) {
				if (supersededId !== id) continue;
				for (const supersedingId of superseding) {
					const at = index.idxForId(supersedingId);
					if (at === undefined) continue;
					supersededBy.push({ id: supersedingId, title: index.docs[at].title });
				}
			}
			for (const target of index.relatedDocs(idx)) {
				const targetMeta = index.docs[target];
				related.push({ id: targetMeta.id, title: targetMeta.title, relPath: targetMeta.relPath });
			}
			for (const ref of meta.supersedes ?? []) {
				const at = index.resolveLink(ref);
				if (at === undefined) continue;
				supersededBy.push({ id: index.docs[at].id, title: index.docs[at].title });
			}
		}
		return { supersededBy, related };
	}

	/* ---------------------------------------------------------------- */
	/* MEMORY.md                                                         */
	/* ---------------------------------------------------------------- */

	async hotState(root = this.roots.primary): Promise<HotFileState> {
		const state = await readHot(root, this.config.hotLimit);
		return { content: state.content, chars: state.chars, limit: state.limit, over: state.over, path: state.path, mtimeMs: 0 };
	}

	async hotAdd(
		text: string,
		topic?: string,
		root = this.roots.primary,
	): Promise<{ before: number; after: number; limit: number; paragraph: string; created: boolean }> {
		return this.locks.run(root, async () => {
			await ensureStore(root, this.config.hotLimit, this.config.defaultCategory);
			const state = await readHot(root, this.config.hotLimit);
			const content = state.exists ? state.content : hotTemplate();
			const added = addHotEntry(content, text, topic);
			if (added.changed) await writeHot(root, added.content);
			return {
				before: state.chars,
				after: added.content.length,
				limit: this.config.hotLimit,
				paragraph: added.paragraph,
				created: added.created,
			};
		});
	}

	async hotRemove(pattern: string, root = this.roots.primary): Promise<{ before: number; after: number; removed: number }> {
		return this.locks.run(root, async () => {
			const state = await readHot(root, this.config.hotLimit);
			const [next, removed] = removeHotMatches(state.content, pattern);
			await writeHot(root, next);
			return { before: state.chars, after: next.length, removed };
		});
	}

	async hotReplace(content: string, root = this.roots.primary): Promise<{ before: number; after: number }> {
		return this.locks.run(root, async () => {
			const state = await readHot(root, this.config.hotLimit);
			await writeHot(root, content);
			return { before: state.chars, after: content.length };
		});
	}

	/** Trim MEMORY.md to the configured budget, reporting what was cut. */
	async hotCompact(root = this.roots.primary): Promise<{ before: number; after: number; removed: string }> {
		return this.locks.run(root, async () => {
			const state = await readHot(root, this.config.hotLimit);
			if (!state.over) return { before: state.chars, after: state.chars, removed: "" };
			const trimmed = trimHot(state.content, this.config.hotLimit);
			await writeHot(root, trimmed.content);
			return { before: state.chars, after: trimmed.content.length, removed: trimmed.removed };
		});
	}

	/* ---------------------------------------------------------------- */
	/* Library maintenance                                               */
	/* ---------------------------------------------------------------- */

	async stats(): Promise<{ roots: StoreStats[]; hot: HotFileState; config: MemoriaConfig; recovered?: string[] }> {
		const roots = this.activeRoots("all");
		const stats: StoreStats[] = [];
		const recovered: string[] = [];
		for (const root of roots) {
			const state = await this.storeFor(root);
			if (state.recovered) recovered.push(`${this.displayPath(root)}: ${state.recovered}`);
			stats.push(state.index.stats(state.index.persistedBytes));
		}
		return { roots: stats, hot: await this.hotState(), config: this.config, ...(recovered.length > 0 ? { recovered } : {}) };
	}

	async rebuild(scope: Scope = "all"): Promise<Array<{ root: string; docs: number; tookMs: number }>> {
		const roots = this.activeRoots(scope);
		const out: Array<{ root: string; docs: number; tookMs: number }> = [];
		for (const root of roots) {
			const index = await this.indexFor(root);
			const started = performance.now();
			const docs = await index.rebuild();
			out.push({ root, docs, tookMs: Math.round((performance.now() - started) * 100) / 100 });
		}
		this.bumpCacheGeneration();
		return out;
	}

	async regenerateIndexes(scope: Scope = "all"): Promise<Array<{ root: string; files: number }>> {
		const roots = this.activeRoots(scope);
		const out: Array<{ root: string; files: number }> = [];
		for (const root of roots) {
			const index = await this.indexFor(root);
			await index.refresh(true);
			const docs: IndexListingDoc[] = index.liveDocs().map(({ meta }) => ({
				relPath: meta.relPath,
				title: meta.title,
				id: meta.id,
				category: meta.category,
				tags: meta.tags,
				summary: meta.summary,
				priority: meta.priority,
				updated: meta.updated,
			}));
			const files = renderLibraryIndexes(docs);
			for (const [relPath, content] of files) {
				const target = join(root, LIBRARY_DIR, relPath);
				const existing = await readFileOrUndefined(target);
				if (existing === content) continue;
				await atomicWriteFile(target, content);
			}
			out.push({ root, files: files.size });
		}
		return out;
	}

	/** Per-store synonym table (config inline table + `synonyms.json`). */
	async synonymsFor(root: string): Promise<Record<string, string[]>> {
		const state = await this.storeFor(root);
		const now = Date.now();
		if (state.synonyms && now - state.synonyms.loadedAt < 30_000 && Object.keys(this.config.synonyms).length === 0) return state.synonyms.table;
		const file = await loadSynonymsFile(root).catch(() => ({}));
		const table = expandSynonymTable(mergeSynonymTables(this.config.synonyms, file));
		state.synonyms = { table, loadedAt: now };
		return table;
	}

	/** Load the synonym table into every active store (called on init). */
	private async primeSynonyms(): Promise<void> {
		for (const root of this.activeRoots("all")) {
			const state = await this.storeFor(root);
			if (state.synonyms) continue;
			const file = await loadSynonymsFile(root).catch(() => ({}));
			state.synonyms = { table: expandSynonymTable(mergeSynonymTables(this.config.synonyms, file)), loadedAt: Date.now() };
		}
	}

	/** Weighted similarity metadata for every live note in a root. */
	private similarityDocs(index: MemoryIndex): SimilarityDoc[] {
		return index.liveDocs().map(({ idx, meta }) => ({
			id: meta.id,
			title: meta.title,
			relPath: meta.relPath,
			category: meta.category,
			aliases: meta.aliases ?? [],
			tokens: index.docTokens(idx),
		}));
	}

	/** IDF function over an index, for similarity scoring. */
	private idfFor(index: MemoryIndex): (term: string) => number {
		const live = Math.max(2, index.aliveCount);
		return (term: string) => {
			const termId = index.termId(term);
			const df = termId >= 0 ? index.documentFrequency(termId) : 1;
			return Math.log(1 + live / (1 + df)) + 0.5;
		};
	}

	/** Note pairs that look like the same subject (suggest `memoria_move`). */
	async mergeSuggestions(limit = 20, scope: Scope = "all"): Promise<MergeSuggestion[]> {
		const out: MergeSuggestion[] = [];
		for (const root of this.activeRoots(scope)) {
			const index = await this.indexFor(root);
			await index.refresh(false);
			out.push(...suggestMerges(this.similarityDocs(index), { threshold: this.config.dedupeThreshold, limit }));
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/**
	 * Notes that look like the same subject as `id`, using only cheap posting
	 * lookups (safe to call on every write, unlike `mergeSuggestions`).
	 */
	async similarNotes(id: string, limit = 2, scope: Scope = "all"): Promise<Array<{ id: string; title: string; relPath: string; score: number; shared: string[]; linked: boolean }>> {
		const out: Array<{ id: string; title: string; relPath: string; score: number; shared: string[]; linked: boolean }> = [];
		for (const root of this.activeRoots(scope)) {
			const index = await this.indexFor(root);
			const idx = index.idxForId(id);
			if (idx === undefined) continue;
			const byIdx = new Map<number, SimilarityDoc>();
			for (const entry of index.liveDocs()) {
				byIdx.set(entry.idx, {
					id: entry.meta.id,
					title: entry.meta.title,
					relPath: entry.meta.relPath,
					category: entry.meta.category,
					aliases: entry.meta.aliases ?? [],
					tokens: index.docTokens(entry.idx),
				});
			}
			const target = byIdx.get(idx);
			if (!target) continue;
			const idfOf = this.idfFor(index);
			const maxDf = Math.max(2, Math.ceil(Math.max(2, index.aliveCount) * 0.2));
			// Candidate generation is posting-driven: only notes that share a
			// distinctive term can be near-duplicates, so this stays cheap enough
			// to run after every write.
			const candidates = new Set<number>();
			for (const term of Object.keys(target.tokens)) {
				if (!isComparableTerm(term)) continue;
				const termId = index.termId(term);
				if (termId < 0 || index.documentFrequency(termId) > maxDf) continue;
				const posting = index.postings[termId];
				for (let k = 0; k + 1 < posting.length; k += 2) {
					const other = posting[k];
					if (other === idx || !index.alive[other]) continue;
					if (index.docs[other].category !== index.docs[idx].category) continue;
					candidates.add(other);
				}
			}
			for (const other of candidates) {
				const otherDoc = byIdx.get(other);
				if (!otherDoc) continue;
				const similarity = compareDocs(target, otherDoc, idfOf, { threshold: this.config.dedupeThreshold });
				if (!similarity.duplicate) continue;
				const meta = index.docs[other];
				out.push({
					id: meta.id,
					title: meta.title,
					relPath: meta.relPath,
					score: Math.round(similarity.score * 1000) / 1000,
					shared: [...new Set(similarity.shared)].slice(0, 6),
					linked: similarity.linked,
				});
			}
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Fact units that appear to disagree, across the store. */
	async contradictions(limit = 20, scope: Scope = "all"): Promise<Contradiction[]> {
		const out: Contradiction[] = [];
		for (const root of this.activeRoots(scope)) {
			const index = await this.indexFor(root);
			await index.refresh(false);
			const units: Array<{ id: string; relPath: string; label?: string; text: string }> = [];
			for (const { idx, meta } of index.liveDocs()) {
				// Reading every body would make doctor O(store). A contradiction needs
				// a negation, so only notes whose preview has one are read.
				if (!/\b(not|never|no longer|stopped|avoid|avoids|dislike|dislikes|deprecated|cancel|instead)\b/i.test(meta.preview)) continue;
				const body = await index.bodyFor(idx);
				for (const unit of extractFactUnits(body)) units.push({ id: meta.id, relPath: meta.relPath, label: unit.label, text: unit.text });
				if (units.length > 4000) break;
			}
			out.push(...detectContradictions(units, { limit }));
		}
		return out.sort((a, b) => b.shared.length - a.shared.length).slice(0, limit);
	}

	/** Notes that have not been retrieved for `staleAfterDays`. */
	async staleNotes(limit = 20, scope: Scope = "all"): Promise<Array<{ id: string; title: string; relPath: string; root: string; idleMs: number; hits: number; writes: number }>> {
		const out: Array<{ id: string; title: string; relPath: string; root: string; idleMs: number; hits: number; writes: number }> = [];
		const threshold = this.config.staleAfterDays * 86_400_000;
		for (const root of this.activeRoots(scope)) {
			const state = await this.storeFor(root);
			if (!state.usage) continue;
			for (const { id, entry, idleMs } of state.usage.stale(threshold, Date.now(), 0)) {
				const idx = state.index.idxForId(id);
				if (idx === undefined) continue;
				const meta = state.index.docs[idx];
				out.push({ id, title: meta.title, relPath: meta.relPath, root, idleMs, hits: entry.hits, writes: entry.writes });
			}
		}
		return out.sort((a, b) => b.idleMs - a.idleMs).slice(0, limit);
	}

	/** Notes written often enough to be worth promoting into MEMORY.md. */
	async promotionCandidates(limit = 10, scope: Scope = "primary"): Promise<Array<{ id: string; title: string; relPath: string; root: string; writes: number; hits: number; priority: string }>> {
		const out: Array<{ id: string; title: string; relPath: string; root: string; writes: number; hits: number; priority: string }> = [];
		for (const root of this.activeRoots(scope)) {
			const state = await this.storeFor(root);
			if (!state.usage) continue;
			const hot = await readHot(root, this.config.hotLimit);
			for (const { id, entry } of state.usage.promotionCandidates(this.config.promoteAfterWrites)) {
				const idx = state.index.idxForId(id);
				if (idx === undefined) continue;
				const meta = state.index.docs[idx];
				if (priorityRank(meta.priority) < priorityRank("high")) continue;
				// Already represented in the always-loaded file? Then say nothing.
				const facts = extractFactUnits(state.index.bodyOrPreview(idx)).map((unit) => unit.text);
				if (hotContains(hot.content, meta.title, meta.aliases, facts)) continue;
				out.push({ id, title: meta.title, relPath: meta.relPath, root, writes: entry.writes, hits: entry.hits, priority: meta.priority });
			}
		}
		return out.sort((a, b) => b.writes - a.writes).slice(0, limit);
	}

	/** Per-topic review data for `/memoria topics`. */
	async topicsReport(scope: Scope = "all"): Promise<TopicReportEntry[]> {
		const out: TopicReportEntry[] = [];
		for (const root of this.activeRoots(scope)) {
			const state = await this.storeFor(root);
			await state.index.refresh(false);
			const staleThreshold = this.config.staleAfterDays * 86_400_000;
			const now = Date.now();
			for (const { idx, meta } of state.index.liveDocs()) {
				const body = await state.index.bodyFor(idx);
				const usage = state.usage?.get(meta.id);
				const lastUsed = Math.max(meta.lastUsed || 0, usage?.lastUsed ?? 0);
				out.push({
					id: meta.id,
					title: meta.title,
					relPath: meta.relPath,
					root,
					category: meta.category,
					facts: extractFactUnits(body).length,
					bytes: meta.size,
					updated: meta.updated,
					lastUsed,
					hits: usage?.hits ?? 0,
					writes: usage?.writes ?? 0,
					stale: lastUsed > 0 && now - lastUsed >= staleThreshold,
				});
			}
		}
		return out.sort((a, b) => a.category.localeCompare(b.category) || b.updated - a.updated);
	}

	/**
	 * What changed in the primary store since the previous session started.
	 *
	 * Advances the session marker as a side effect, so it must be called once
	 * per session (from `session_start`). Returns undefined on the first session.
	 */
	async sessionDelta(limit = 5): Promise<{ since: number; created: DiffEntry[]; updated: DiffEntry[] } | undefined> {
		const root = this.roots.primary;
		const state = await this.storeFor(root);
		const usage = state.usage;
		const previous = usage?.sessionStartedAt() ?? 0;
		usage?.markSessionStart();
		state.usageSaver();
		if (!previous) return undefined;
		const index = state.index;
		await index.refresh(false);
		const created: DiffEntry[] = [];
		const updated: DiffEntry[] = [];
		for (const { meta } of index.liveDocs()) {
			// `>=` on purpose: a note written in the same millisecond as the marker
			// still belongs to this session's summary.
			if (meta.updated < previous && meta.created < previous) continue;
			const entry: DiffEntry = {
				id: meta.id,
				title: meta.title,
				relPath: meta.relPath,
				category: meta.category,
				created: meta.created,
				updated: meta.updated,
			};
			if (meta.created >= previous) created.push(entry);
			else updated.push(entry);
		}
		const byRecency = (a: DiffEntry, b: DiffEntry): number => b.updated - a.updated;
		return { since: previous, created: created.sort(byRecency).slice(0, limit), updated: updated.sort(byRecency).slice(0, limit) };
	}

	/** Notes created and updated within the last `days`. */
	async diffReport(days = 7, scope: Scope = "all"): Promise<{ since: number; created: DiffEntry[]; updated: DiffEntry[] }> {
		const since = Date.now() - Math.max(1, days) * 86_400_000;
		const created: DiffEntry[] = [];
		const updated: DiffEntry[] = [];
		for (const root of this.activeRoots(scope)) {
			const index = await this.indexFor(root);
			await index.refresh(false);
			for (const { meta } of index.liveDocs()) {
				const entry: DiffEntry = {
					id: meta.id,
					title: meta.title,
					relPath: meta.relPath,
					category: meta.category,
					created: meta.created,
					updated: meta.updated,
				};
				if (meta.created >= since) created.push(entry);
				else if (meta.updated >= since) updated.push(entry);
			}
		}
		const byRecency = (a: DiffEntry, b: DiffEntry): number => b.updated - a.updated;
		return { since, created: created.sort(byRecency), updated: updated.sort(byRecency) };
	}

	/* ---------------------------------------------------------------- */
	/* Export / import                                                   */
	/* ---------------------------------------------------------------- */

	/** Serialize the store as JSONL (one record per line, plus MEMORY.md). */
	async exportJsonl(options: { scope?: Scope; includeHot?: boolean; includeTrash?: boolean } = {}): Promise<{ jsonl: string; notes: number }> {
		const roots = this.activeRoots(options.scope ?? "all");
		const lines: string[] = [];
		let notes = 0;
		for (const root of roots) {
			const state = await this.storeFor(root);
			await state.index.refresh(false);
			const hot = await readHot(root, this.config.hotLimit);
			if (options.includeHot !== false && hot.exists && hot.content.trim()) {
				lines.push(encodeJsonl({ type: "hot", root: this.displayPath(root), content: hot.content }));
			}
			for (const { idx, meta } of state.index.liveDocs()) {
				const body = await state.index.bodyFor(idx);
				lines.push(
					encodeJsonl({
						type: "memory",
						id: meta.id,
						relPath: meta.relPath,
						root: this.displayPath(root),
						title: meta.title,
						category: meta.category,
						tags: meta.tags,
						aliases: meta.aliases,
						related: meta.related,
						supersedes: meta.supersedes,
						summary: meta.summary,
						priority: meta.priority,
						confidence: meta.confidence,
						created: meta.created,
						updated: meta.updated,
						body,
					}),
				);
				notes += 1;
			}
		}
		return { jsonl: `${lines.join("\n")}\n`, notes };
	}

	/** Import JSONL produced by `exportJsonl` into the primary (or project) store. */
	async importJsonl(
		text: string,
		options: { mode?: "merge" | "replace" | "skip"; scope?: Scope; dryRun?: boolean } = {},
	): Promise<{ created: string[]; updated: string[]; skipped: number; errors: string[]; hotImported: boolean }> {
		const mode = options.mode ?? "merge";
		const root = this.rootForScope(options.scope ?? "primary");
		await ensureStore(root, this.config.hotLimit, this.config.defaultCategory);
		const state = await this.storeFor(root);
		const records = decodeJsonl(text);
		const result = { created: [] as string[], updated: [] as string[], skipped: 0, errors: records.errors, hotImported: false };
		return this.locks.run(root, async () => {
			for (const record of records.records) {
				if (record.type === "hot") {
					if (options.dryRun) continue;
					// Already inside the root lock: call the store helpers directly.
					await writeHot(root, record.content);
					result.hotImported = true;
					continue;
				}
				const outcome = await this.importNote(root, state, record, mode, options.dryRun === true);
				if (outcome === "created") result.created.push(record.id);
				else if (outcome === "updated") result.updated.push(record.id);
				else result.skipped += 1;
			}
			if (!options.dryRun) {
				state.index.builtAt = Date.now();
				state.saver.schedule();
			}
			return result;
		});
	}

	private async importNote(
		root: string,
		state: StoreState,
		note: ImportedNote,
		mode: "merge" | "replace" | "skip",
		dryRun: boolean,
	): Promise<"created" | "updated" | "skipped"> {
		const existingIdx = state.index.idxForId(note.id);
		const existing = existingIdx !== undefined ? await resolveMemoryRef(root, note.id, liveLookup(state.index)) : undefined;
		if (existing) {
			if (mode === "skip") return "skipped";
			if (dryRun) return "updated";
			if (mode === "replace") {
				const updated = await updateMemory(root, existing, {
					title: note.title,
					content: note.body,
					tags: note.tags,
					aliases: note.aliases,
					related: note.related,
					supersedes: note.supersedes,
					summary: note.summary,
					priority: note.priority,
					confidence: note.confidence,
					category: note.category || existing.category,
				});
				state.index.removeDoc(existingIdx!);
				state.index.addDoc(updated);
				return "updated";
			}
			// merge: fold in the fact units that are not already present.
			let body = existing.body;
			let changed = false;
			for (const unit of extractFactUnits(note.body)) {
				const appended = appendFact(body, unit.label, unit.text);
				if (appended.changed) {
					body = appended.body;
					changed = true;
				}
			}
			const newTags = note.tags.filter((tag) => !existing.tags.includes(tag));
			const newAliases = note.aliases.filter((alias) => !existing.aliases.some((current) => current.toLowerCase() === alias.toLowerCase()));
			const tags = newTags.length > 0 ? [...new Set([...existing.tags, ...newTags])] : undefined;
			const aliases = newAliases.length > 0 ? [...new Set([...existing.aliases, ...newAliases])] : undefined;
			if (!changed && !tags && !aliases) return "skipped";
			const updated = await updateMemory(root, existing, {
				content: changed ? body : undefined,
				tags,
				aliases,
				summary: changed ? extendSummary(existing.summary, note.summary) : undefined,
			});
			state.index.removeDoc(existingIdx!);
			state.index.addDoc(updated);
			return "updated";
		}
		if (dryRun) return "created";
		// `writeImportedNote` avoids the path when it is taken by a different note,
		// so an import can never overwrite an existing memory.
		const written = await writeImportedNote(root, note);
		const stale = state.index.idxForRelPath(written.relPath);
		if (stale >= 0) state.index.removeDoc(stale);
		const staleId = state.index.idxForId(written.id);
		if (staleId !== undefined && staleId !== stale) state.index.removeDoc(staleId);
		state.index.addDoc(written);
		return "created";
	}

	/**
	 * One pass over the store producing both structured findings and the
	 * human-readable list: `/memoria doctor` renders the structure, the tool and
	 * the agent get the strings.
	 */
	async health(): Promise<{
		findings: string[];
		merges: MergeSuggestion[];
		contradictions: Contradiction[];
		stale: Awaited<ReturnType<MemoriaRuntime["staleNotes"]>>;
		promotions: Awaited<ReturnType<MemoriaRuntime["promotionCandidates"]>>;
		recovered: string[];
	}> {
		const findings: string[] = [];
		const recovered: string[] = [];
		const merges: MergeSuggestion[] = [];
		const contradictions: Contradiction[] = [];
		for (const root of this.activeRoots("all")) {
			const state = await this.storeFor(root);
			const index = state.index;
			await index.refresh(true);
			const label = this.displayPath(root);
			if (state.recovered) {
				recovered.push(`${label}: ${state.recovered}`);
				findings.push(`${root}: ${state.recovered}`);
			}
			if (!existsSync(join(root, "MEMORY.md"))) findings.push(`${root}: MEMORY.md is missing`);
			const hot = await readHot(root, this.config.hotLimit);
			if (hot.over) findings.push(`${root}: MEMORY.md over budget (${hot.chars}/${this.config.hotLimit})`);
			const seenIds = new Map<string, string>();
			const seenAliases = new Map<string, string>();
			const negatedUnits: Array<{ id: string; relPath: string; label?: string; text: string }> = [];
			for (const { idx, meta } of index.liveDocs()) {
				if (seenIds.has(meta.id)) findings.push(`${root}: duplicate id ${meta.id} in ${meta.relPath} and ${seenIds.get(meta.id)}`);
				else seenIds.set(meta.id, meta.relPath);
				if (!meta.title) findings.push(`${root}: ${meta.relPath} has no title`);
				if (!meta.summary) findings.push(`${root}: ${meta.relPath} has no summary`);
				if (!meta.tags.length) findings.push(`${root}: ${meta.relPath} has no tags`);
				if (meta.bodyChars < 8) findings.push(`${root}: ${meta.relPath} has an empty body`);
				// Fact- and relation-shaped file names are a legacy pattern; suggest
				// consolidating them under the subject's real name.
				const fileBase = basename(meta.relPath).replace(/\.md$/i, "").replace(/-\d+$/, "").replace(/[-_]+/g, " ");
				if (looksAtomicTopic(fileBase)) {
					findings.push(
						`${root}: ${meta.relPath} is named after a single fact or relationship; re-file it with memoria_move (e.g. under the person's name) so the name in the file stays true`,
					);
				}
				for (const alias of meta.aliases ?? []) {
					const key = alias.toLowerCase();
					const owner = seenAliases.get(key);
					if (owner && owner !== meta.relPath) findings.push(`${root}: alias "${alias}" is claimed by both ${owner} and ${meta.relPath}`);
					else seenAliases.set(key, meta.relPath);
				}
				// Dangling links make `related`/`supersedes` silently useless.
				for (const [field, links] of [
					["related", meta.related ?? []],
					["supersedes", meta.supersedes ?? []],
				] as const) {
					for (const ref of links) {
						if (index.resolveLink(ref) === undefined) findings.push(`${root}: ${meta.relPath} has a ${field} link to "${ref}" that no longer exists`);
					}
				}
				// Contradiction candidates need a body; only notes whose preview
				// carries a negation are read, which keeps doctor off the O(store) path.
				if (/(not|never|no longer|stopped|avoid|avoids|dislike|dislikes|deprecated|cancel|instead)/i.test(meta.preview)) {
					const body = await index.bodyFor(idx);
					for (const unit of extractFactUnits(body)) negatedUnits.push({ id: meta.id, relPath: meta.relPath, label: unit.label, text: unit.text });
				}
			}
			for (const [category] of categorySummary(index.liveDocs().map((entry) => entry.meta))) {
				const dir = category === "(root)" ? join(root, LIBRARY_DIR) : join(root, LIBRARY_DIR, category);
				if (!existsSync(dir)) findings.push(`${root}: missing category directory ${dir}`);
			}
			const rootMerges = suggestMerges(this.similarityDocs(index), { threshold: this.config.dedupeThreshold, limit: 5 });
			for (const suggestion of rootMerges) {
				merges.push(suggestion);
				findings.push(
					`${root}: ${suggestion.a.relPath} and ${suggestion.b.relPath} look like the same subject (${Math.round(suggestion.score * 100)}% overlap: ${suggestion.shared.join(", ")}); consider memoria_move { from: "${suggestion.b.id}", topic: "${suggestion.a.title}", merge: true }`,
				);
			}
			const rootContradictions = detectContradictions(negatedUnits, { limit: 5 });
			for (const contradiction of rootContradictions) {
				contradictions.push(contradiction);
				findings.push(
					`${root}: ${contradiction.a.relPath} may contradict ${contradiction.b.relPath} (${contradiction.shared.join(", ")}): "${oneLine(contradiction.a.text, 80)}" vs "${oneLine(contradiction.b.text, 80)}". If one replaced the other, link them with memoria_write { id: "...", supersedes: ["..."] } or merge with memoria_move.`,
				);
			}
		}
		const stale = await this.staleNotes(5, "all");
		for (const entry of stale) {
			findings.push(`${this.displayPath(entry.root)}: ${entry.relPath} has not been used in over ${this.config.staleAfterDays} days (${entry.hits} hits)`);
		}
		const promotions = await this.promotionCandidates(5, "primary");
		for (const entry of promotions) {
			findings.push(
				`${this.displayPath(entry.root)}: ${entry.relPath} was written ${entry.writes} times with priority ${entry.priority}; consider promoting it into MEMORY.md with memoria_hot`,
			);
		}
		return { findings, merges, contradictions, stale, promotions, recovered };
	}

	/** Check the store for consistency problems (agent-facing string list). */
	async doctor(): Promise<string[]> {
		return (await this.health()).findings;
	}

	/** Aggregated overview across every active root (cheap, for the system section). */
	async overview(recentLimit = 4): Promise<{ docs: number; categories: Array<[string, number]>; recent: Array<{ id: string; title: string; relPath: string }> }> {
		const roots = this.activeRoots("all");
		const counts = new Map<string, number>();
		const recent: Array<{ id: string; title: string; relPath: string; created: number }> = [];
		let docs = 0;
		for (const root of roots) {
			const index = await this.indexFor(root);
			await index.refresh(false);
			const overview = index.overview(recentLimit);
			docs += overview.docs;
			for (const [category, count] of overview.categories) counts.set(category, (counts.get(category) ?? 0) + count);
			recent.push(...overview.recent);
		}
		recent.sort((a, b) => b.created - a.created);
		return {
			docs,
			categories: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
			recent: recent.slice(0, recentLimit).map(({ id, title, relPath }) => ({ id, title, relPath })),
		};
	}

	async listEntries(scope: Scope = "all"): Promise<Array<{ root: string; meta: ReturnType<MemoryIndex["liveDocs"]>[number]["meta"] }>> {
		const roots = this.activeRoots(scope);
		const out: Array<{ root: string; meta: ReturnType<MemoryIndex["liveDocs"]>[number]["meta"] }> = [];
		const seenIds = new Set<string>();
		for (const root of roots) {
			const index = await this.indexFor(root);
			await index.refresh(false);
			for (const { meta } of index.liveDocs()) {
				// Ids are unique per store, not across stores: list a shared note once.
				if (seenIds.has(meta.id)) continue;
				seenIds.add(meta.id);
				out.push({ root, meta });
			}
		}
		return out;
	}

	/** Flush pending index writes and stop watchers. Idempotent. */
	async dispose(): Promise<void> {
		const stores = [...this.stores.values()];
		this.stores = new Map();
		this.initialized = false;
		this.searchCache.clear();
		for (const state of stores) {
			if (state.settleTimer) clearTimeout(state.settleTimer);
			try {
				state.watcher?.close();
			} catch {
				// ignore
			}
			state.watcher = undefined;
			state.index.watcherActive = false;
			state.usageSaver.cancel();
			await this.flushUsage(state.root, state).catch(() => {});
			await state.usage?.save().catch(() => {});
			await state.saver.flush().catch(() => {});
		}
	}

	/** Absolute path helpers used by tools/commands. */
	paths(): { primary: string; project: string; agentDir: string; extras: string[]; library: string; hot: string; indexDir: string; sessions: string[] } {
		return {
			primary: this.roots.primary,
			project: this.roots.project,
			agentDir: this.pathContext.agentDir,
			extras: this.roots.extras,
			library: join(this.roots.primary, LIBRARY_DIR),
			hot: join(this.roots.primary, "MEMORY.md"),
			indexDir: join(this.roots.primary, INDEX_DIR),
			sessions: this.sessionRoots(),
		};
	}

	/** Human-readable relative path for UI messages. */
	displayPath(path: string): string {
		const projectRel = relative(this.cwd, path);
		if (!projectRel.startsWith("..")) return normalizePath(projectRel);
		const homeRel = relative(this.pathContext.home, path);
		if (!homeRel.startsWith("..")) return `~/${normalizePath(homeRel)}`;
		return normalizePath(path);
	}
}

export interface DiffEntry {
	id: string;
	title: string;
	relPath: string;
	category: string;
	created: number;
	updated: number;
}

/**
 * True when MEMORY.md already carries this note: by title/alias, or because one
 * of the note's facts appears in the prose. The fact check is what makes the
 * promotion hint actually stop after the agent has promoted a note, since
 * MEMORY.md is prose and seldom repeats a note's title.
 */
export function hotContains(hotContent: string, title: string, aliases: string[] = [], facts: string[] = []): boolean {
	const haystack = normalizeProse(hotContent);
	if (!haystack) return false;
	if (title.length >= 4 && haystack.includes(normalizeProse(title))) return true;
	for (const alias of aliases) {
		if (alias.length >= 4 && haystack.includes(normalizeProse(alias))) return true;
	}
	for (const fact of facts) {
		const needle = normalizeProse(fact);
		if (needle.length >= 12 && haystack.includes(needle)) return true;
	}
	return false;
}

function normalizeProse(text: string): string {
	return text.toLowerCase().replace(/[`*_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
}

/** Collapse legacy scope names onto the current model. */
export function normalizeScope(scope: Scope | undefined): "primary" | "project" | "all" {
	if (scope === "all") return "all";
	if (scope === "project") return "project";
	return "primary";
}

async function safeLoadConfig(root: string): Promise<MemoriaConfig> {
	try {
		return await loadConfig(root);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

