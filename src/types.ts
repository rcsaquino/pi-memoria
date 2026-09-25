/**
 * Core data types for memoria.
 *
 * Keep this module free of runtime imports so tests and tooling can load it
 * without the pi runtime being present.
 */

export type Priority = "low" | "normal" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";
/**
 * Which store(s) an operation targets.
 *
 * - `primary` (default): the user-level store at `<agent dir>/memoria`
 *   (`~/.pi/agent/memoria` unless pi's agent dir is customized).
 * - `project`: the per-project store, when `config.projectRoot` is set. It is
 *   writable, so a project can keep its own memories without polluting the
 *   user-level store.
 * - `all`: primary plus the project store plus every `extraRoots` entry.
 * - `global`: legacy alias for `primary`.
 *
 * `extraRoots` are always read-only additions.
 */
export type Scope = "primary" | "all" | "project" | "global";

/** Frontmatter fields understood by memoria. Unknown keys are preserved verbatim. */
export interface MemoryFrontmatter {
	id?: string;
	title?: string;
	/** Broad grouping name; drives the file name and the note title. */
	topic?: string;
	category?: string;
	tags?: string[] | string;
	/**
	 * Other names this note answers to: nicknames, full names, former topic
	 * names, relations ("Bob's father"). Aliases are indexed, so any of them
	 * recalls the note, which is what keeps a rename cosmetic rather than
	 * load-bearing.
	 */
	aliases?: string[] | string;
	created?: string;
	updated?: string;
	source?: string;
	confidence?: Confidence | string;
	priority?: Priority | string;
	summary?: string;
	/**
	 * Other notes this one is about (ids, relative paths or titles). Rendered in
	 * `memoria_read` and used to pull in related notes during recall.
	 */
	related?: string[] | string;
	/**
	 * Notes this one replaces. A superseded note stays readable but is demoted in
	 * ranking and flagged in recall output, which is how contradictions get
	 * resolved without deleting history.
	 */
	supersedes?: string[] | string;
	/** Epoch ms (or ISO string) of the last time this note was retrieved. */
	last_used?: number | string;
	/** Internal: set when the note was generated from a session. */
	session?: string;
	[key: string]: unknown;
}

/** A memory note as parsed from disk. */
export interface MemoryDoc {
	/** Stable id, `mem_<epochms>_<rand>`. */
	id: string;
	/** Absolute path of the owning store root. */
	root: string;
	/** Absolute file path. */
	path: string;
	/** Path relative to the store root, always forward slashes. e.g. `library/people/alice.md`. */
	relPath: string;
	title: string;
	/** Broad grouping name (frontmatter `topic`, falling back to the title). */
	topic: string;
	/** First folder under `library/`, or `""` when the file lives at the library root. */
	category: string;
	tags: string[];
	/** Alternative names for the same subject (see `MemoryFrontmatter.aliases`). */
	aliases: string[];
	/** Related notes (ids, relative paths or titles). */
	related: string[];
	/** Notes this one replaces (ids, relative paths or titles). */
	supersedes: string[];
	/** Epoch ms of the last retrieval, from frontmatter (`last_used`). */
	lastUsed: number;
	summary: string;
	priority: Priority;
	confidence: Confidence;
	created: number;
	updated: number;
	/** Epoch ms from the filesystem. */
	mtimeMs: number;
	size: number;
	wordCount: number;
	/** Weighted term frequencies used for BM25. Not persisted verbatim. */
	tokens: Record<string, number>;
	/** Sum of all weights in `tokens`. */
	tokenCount: number;
	/** Raw markdown body (frontmatter stripped). Empty when lazily loaded. */
	body: string;
	/** Frontmatter as parsed, preserved for loss-less updates. */
	frontmatter: MemoryFrontmatter;
	/** True when the file lives in `inbox/` and has not been filed yet. */
	unfiled: boolean;
}

/** Compact, JSON-persisted projection of a doc (no body, no tf map). */
export interface IndexedDocMeta {
	id: string;
	root: string;
	path: string;
	relPath: string;
	title: string;
	category: string;
	tags: string[];
	aliases: string[];
	related: string[];
	supersedes: string[];
	summary: string;
	priority: Priority;
	confidence: Confidence;
	created: number;
	updated: number;
	/** Epoch ms of the last retrieval (frontmatter `last_used`). */
	lastUsed: number;
	mtimeMs: number;
	size: number;
	wordCount: number;
	/** Length of the markdown body, so checks can skip reading the file. */
	bodyChars: number;
	tokenCount: number;
	unfiled: boolean;
	/** First ~400 chars of the body, used for listings and index rendering. */
	preview: string;
	/** Cheap content fingerprint to detect edits that keep mtime/size identical. */
	hash: string;
}

export interface PersistedIndex {
	version: number;
	root: string;
	builtAt: number;
	docs: IndexedDocMeta[];
	/** Parallel to `terms`: flat [docIndex, tf, docIndex, tf, ...] per term. */
	postings: number[][];
	/** Term dictionary, indexed by term id (never reordered). */
	terms: string[];
}

/** One analyzed query term with its resolved dictionary id and weight. */
export interface QueryTerm {
	term: string;
	/** Relative importance of this query term. */
	weight: number;
	/** Resolved term id, or -1 when absent from the dictionary. */
	termId: number;
	/** Inverse document frequency (or a high placeholder for missing terms). */
	idf: number;
	/** True for identifiers, paths, versions and error codes. */
	specific: boolean;
}

export interface SearchOptions {
	limit?: number;
	/** Restrict to a category (folder under library/). */
	category?: string;
	/** All tags must be present. */
	tags?: string[];
	/** Any of these tags must be present. */
	anyTags?: string[];
	/** Minimum priority. */
	minPriority?: Priority;
	/** Only memories created/updated after this epoch ms. */
	since?: number;
	/** Restrict to a given root. */
	root?: string;
	scope?: Scope;
	/** Include unfiled (inbox) memories. Default true. */
	includeUnfiled?: boolean;
	/** Score floor. */
	minScore?: number;
	/** Allow prefix matching. Default true. */
	prefix?: boolean;
	/** Allow fuzzy matching. Default true. */
	fuzzy?: boolean;
	/** Force a filesystem rescan before searching. */
	refresh?: boolean;
	/** Weighted query segments; the first is the primary prompt. */
	parts?: QueryPart[];
	/** Query-side synonym table (term -> alternatives). */
	synonyms?: Record<string, string[]>;
	/** Multiplier applied to synonym-expanded terms. Default 0.6. */
	synonymWeight?: number;
	/** Include a scoring breakdown per hit. */
	explain?: boolean;
	/** Also return notes linked through `related:` frontmatter. Default true. */
	expandRelated?: boolean;
	/** Maximum related notes pulled into one result. Default 3. */
	relatedHits?: number;
	/** Score factor for notes pulled in through `related`. Default 0.35. */
	relatedBoost?: number;
	/** Honour time expressions such as "last week" found in the query. Default true. */
	timeHints?: boolean;
	/** Drop notes that another live note declares in `supersedes`. Default false. */
	dropSuperseded?: boolean;
	/** Called once with the parsed time window, when a query mentions one. */
	onTimeWindow?: (window: TimeWindow) => void;
	/** Maximum characters of body excerpt per hit. */
	snippetChars?: number;
}

/** One weighted piece of a multi-part query (current prompt + previous turns). */
export interface QueryPart {
	text: string;
	weight: number;
}

/** A time window parsed out of a natural-language query. */
export interface TimeWindow {
	label: string;
	since?: number;
	until?: number;
}

export interface SearchHit {
	doc: IndexedDocMeta;
	score: number;
	/** Which query terms matched, best first. */
	matched: string[];
	/** Body excerpt around the best match. */
	snippet: string;
	/** True when the full query string appears verbatim in the body or title. */
	exact: boolean;
	/** Set when this hit was pulled in through another note's `related:`. */
	relatedTo?: string;
	/** Ids of live notes that declare this note superseded. */
	supersededBy?: string[];
	/** Present only with `explain: true`. */
	breakdown?: ScoreBreakdown;
}

/** Per-component scoring detail for one hit (`explain: true`). */
export interface ScoreBreakdown {
	bm25: number;
	coverage: number;
	priorityRecency: number;
	phrase: number;
	related: number;
	supersededPenalty: number;
	timeBoost: number;
	total: number;
	terms: Array<{ term: string; matches: number; contribution: number }>;
}

/** Retrieval statistics for one note, persisted in `.index/usage.json`. */
export interface UsageEntry {
	/** Times the note appeared in returned results. */
	hits: number;
	/** Times a fact was written to the note. */
	writes: number;
	/** Epoch ms of the last retrieval. */
	lastUsed: number;
}

export interface UsageFile {
	version: number;
	docs: Record<string, UsageEntry>;
	/** Epoch ms of the last session start, for the "what changed" summary. */
	lastSessionAt?: number;
}

/** Two notes whose contents look like the same subject. */
export interface MergeSuggestion {
	a: { id: string; title: string; relPath: string; category: string };
	b: { id: string; title: string; relPath: string; category: string };
	/** Cosine similarity of the weighted term vectors, 0..1. */
	score: number;
	/** Distinctive terms the two notes share. */
	shared: string[];
	category: string;
}

/** Two fact units that appear to disagree. */
export interface Contradiction {
	a: { id: string; relPath: string; text: string };
	b: { id: string; relPath: string; text: string };
	shared: string[];
	reason: string;
}

export interface SearchResult {
	hits: SearchHit[];
	total: number;
	/** Wall-clock duration in milliseconds. */
	tookMs: number;
	/** True when result collection was capped by the engine. */
	truncated: boolean;
	/** Terms that produced no match at all. */
	missing: string[];
	/** Time window parsed from the query, when one was recognized. */
	timeWindow?: TimeWindow;
}

export interface RecallBlock {
	query: string;
	hits: SearchHit[];
	rendered: string;
	tookMs: number;
}

export interface StoreStats {
	root: string;
	docs: number;
	categories: Record<string, number>;
	totalBytes: number;
	indexBytes: number;
	indexBuiltAt: number;
	indexLoadMs: number;
	lastSearchMs: number;
	watcherActive: boolean;
	dirty: boolean;
}

export interface HotFileState {
	content: string;
	chars: number;
	limit: number;
	over: boolean;
	path: string;
	mtimeMs: number;
}

export interface MemoriaConfig {
	version: number;
	/**
	 * Primary store location. Supports `$AGENT_DIR` (pi's user config dir,
	 * `~/.pi/agent` by default), a leading `~`, absolute paths, and paths
	 * relative to the working directory.
	 */
	rootDir: string;
	/** Additional read-only store roots (absolute, `~` or `$AGENT_DIR` prefixed). */
	extraRoots: string[];
	/** Hard cap for MEMORY.md, in characters. */
	hotLimit: number;
	/** Maximum characters injected per recalled memory snippet. */
	snippetChars: number;
	/** Auto-recall tuning. */
	autoRecall: boolean;
	autoRecallLimit: number;
	/** Minimum fraction of the strongest eligible score for automatic recall. */
	autoRecallMinRatio: number;
	autoRecallMinScore: number;
	autoRecallMaxChars: number;
	/** Number of previous user turns folded into the recall query. */
	autoRecallLastTurns: number;
	/** Maximum bytes of body text kept in the in-memory cache. */
	bodyCacheBytes: number;
	/** Milliseconds between filesystem freshness scans when no watcher is active. */
	scanIntervalMs: number;
	/** Extra glob-free path fragments to exclude from indexing. */
	exclude: string[];
	/** Default category folder for new memories without one. */
	defaultCategory: string;
	/** Maximum words in a topic name before falling back to the category. */
	topicMaxWords: number;
	/** A topic note larger than this spills into a numbered sibling file. */
	topicMaxChars: number;
	/**
	 * Optional per-project store (writable). Empty disables it. Supports
	 * `$AGENT_DIR`, a leading `~`, absolute and cwd-relative paths.
	 */
	projectRoot: string;
	/** Weight of previous turns relative to the current prompt in auto-recall. */
	autoRecallPriorWeight: number;
	/** Track hits/writes/last-used per note in `.index/usage.json`. */
	usageTracking: boolean;
	/** Rewrite a note's `last_used` frontmatter at most this often. */
	lastUsedWriteIntervalMs: number;
	/** A note unused for this many days is reported as stale by doctor. */
	staleAfterDays: number;
	/** Suggest promoting a note to MEMORY.md after this many writes. */
	promoteAfterWrites: number;
	/** Cosine similarity above which two notes are reported as merge candidates. */
	dedupeThreshold: number;
	/** Maximum related notes pulled into a search result. */
	relatedHits: number;
	/** Score factor for notes pulled in through `related:`. */
	relatedBoost: number;
	/** Inline query-side synonyms, merged over `<root>/synonyms.json`. */
	synonyms: Record<string, string[]>;
	/** Multiplier applied to synonym-expanded query terms. */
	synonymWeight: number;
	/** Turn time expressions in queries ("last week") into a recency filter. */
	timeHints: boolean;
	/** LRU cache size for repeated identical searches (0 disables). */
	searchCacheSize: number;
	/** Rerank the top candidates with the session model before returning. */
	rerank: boolean;
	/** Model id for reranking; empty uses the session model. */
	rerankModel: string;
	/** How many candidates the reranker may see. */
	rerankTopK: number;
	/** Reranker budget in milliseconds; falls back to lexical order on timeout. */
	rerankTimeoutMs: number;
	/** Idle delay after a filesystem event before refreshing the index. */
	watcherSettleMs: number;
	/** Index persistence format: auto (binary above a threshold), json or binary. */
	indexFormat: string;
	/** Search pi's saved session transcripts (past conversations). */
	sessionSearch: boolean;
	/** Extra session roots, in addition to `<agent dir>/sessions[-archive]`. */
	sessionRoots: string[];
	/** Search sessions automatically when the library returns nothing. */
	sessionFallback: boolean;
	/** Budget for an explicit session search, in milliseconds. */
	sessionScanMs: number;
	/** Characters of context per session hit. */
	sessionExcerptChars: number;
	/** In-memory budget for parsed session messages. */
	sessionCacheBytes: number;
	/** Include tool calls, tool results and compaction summaries by default. */
	sessionIncludeTools: boolean;
	/** Use a ripgrep prefilter to skip match-free transcripts when `rg` exists. */
	sessionRipgrep: boolean;
}

/* ------------------------------------------------------------------ */
/* Session transcripts (past conversations)                            */
/* ------------------------------------------------------------------ */

/** One searchable message extracted from a saved session transcript. */
export interface SessionMessage {
	/** 1-based line in the transcript file. */
	line: number;
	/** Who produced the text. `summary` is a compaction summary, `tool` derived output. */
	role: "user" | "assistant" | "tool" | "summary";
	/** Epoch ms of the entry. */
	timestamp: number;
	/** Extracted text, capped per message. */
	text: string;
	/** Normalized text used for phrase matching. */
	normalized: string;
	/** Tokenized terms, built lazily only for candidate messages. */
	terms?: Set<string>;
}

/** A transcript file on disk. */
export interface SessionFile {
	path: string;
	root: string;
	relPath: string;
	/** Project the session ran in: the recorded cwd, or a decode of the folder name. */
	project: string;
	/** Short display name for the project (basename of the cwd). */
	projectName: string;
	/** Session start, from the file name or the header. */
	startedAt: number;
	mtimeMs: number;
	size: number;
}

export interface SessionSearchOptions {
	limit?: number;
	/** Only sessions started within the last N days. */
	sinceDays?: number;
	/** Substring match on the project path or folder name. */
	project?: string;
	/** Include tool calls, tool results, custom payloads and compaction summaries. */
	includeTools?: boolean;
	/** Only user messages. */
	userOnly?: boolean;
	/** Wall-clock budget; stops scanning (newest first) and reports `partial`. */
	budgetMs?: number;
	/** Excerpt size override. */
	excerptChars?: number;
}

export interface SessionHit {
	path: string;
	relPath: string;
	project: string;
	projectName: string;
	line: number;
	role: SessionMessage["role"];
	timestamp: number;
	score: number;
	matched: string[];
	exact: boolean;
	excerpt: string;
}

/**
 * How the ripgrep candidate prefilter contributed to a transcript scan.
 *
 * `used` means ripgrep listed the files containing at least one query needle
 * and the rest were skipped without parsing. The others are fallbacks so the
 * search still works without a usable `rg`:
 * `missing` (no binary), `error` (spawn failure/timeout/bad exit),
 * `disabled` (config), `unsupported` (query cannot be prefiltered safely),
 * `skipped` (no budget left to try).
 */
export type SessionRipgrepStatus = "used" | "missing" | "error" | "disabled" | "unsupported" | "skipped";

export interface SessionScanStats {
	roots: string[];
	files: number;
	messages: number;
	bytes: number;
	/** Files served from the parsed-message cache. */
	cachedFiles: number;
	/** Unreadable files or lines that could not be parsed. */
	skipped: number;
	/** True when the budget stopped the scan before every file was read. */
	partial: boolean;
	/** Ripgrep prefilter outcome, when a scan ran. */
	ripgrep?: SessionRipgrepStatus;
}

export interface SessionSearchResult {
	hits: SessionHit[];
	stats: SessionScanStats;
	tookMs: number;
}

export interface SessionWindowMessage {
	line: number;
	role: string;
	timestamp: number;
	text: string;
}

export interface SessionReadResult {
	path: string;
	relPath: string;
	projectName: string;
	startLine: number;
	endLine: number;
	messages: SessionWindowMessage[];
}
