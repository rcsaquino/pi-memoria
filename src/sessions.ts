/**
 * Search pi's saved session transcripts.
 *
 * Curated memory (the library) is the fast path, but it only holds what the
 * agent chose to remember. Sometimes the answer to "did we discuss this?" is in
 * an earlier conversation and nowhere else — so this module scans the JSONL
 * transcripts pi writes under `<agent dir>/sessions/` (and `sessions-archive/`
 * if present) and returns bounded, evidence-linked excerpts.
 *
 * Design constraints, in order:
 *
 * 1. **Exhaustive on disk.** No pre-built index that can go stale: every
 *    readable transcript is streamed, newest first, so a session saved a minute
 *    ago is searchable immediately.
 * 2. **Bounded.** Only user/assistant text is scanned by default; thinking
 *    blocks, image payloads and tool plumbing are skipped. Excerpts, results and
 *    per-message text are capped, and a wall-clock budget can stop a scan
 *    (reporting `partial`).
 * 3. **Cheap on repeat.** Parsed messages are cached by path with mtime+size
 *    validation under a byte budget, so the second search in a session is
 *    in-memory. Substring prefiltering keeps the scoring pass linear.
 * 4. **Read-only.** Transcripts are never written, and `readWindow` refuses
 *    paths outside the configured roots.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import { isCjkChar, stem, tokenize } from "./tokenize.ts";
import { oneLine, truncateChars } from "./util.ts";
import type { SessionFile, SessionHit, SessionMessage, SessionReadResult, SessionScanStats, SessionSearchOptions, SessionSearchResult, SessionWindowMessage } from "./types.ts";

/** Hard cap on a single extracted message, to keep the cache useful. */
export const MAX_SESSION_MESSAGE_CHARS = 4000;
/** Upper bound on ripgrep's file list, so a pathological match set cannot exhaust memory. */
const MAX_RG_OUTPUT_CHARS = 16 * 1024 * 1024;
/** ripgrep is killed after this long, even when the search itself has no budget. */
const MAX_RG_TIMEOUT_MS = 10_000;
/** Directories deeper than this under a root are ignored. */
const MAX_WALK_DEPTH = 4;
/** Files larger than this are skipped rather than read into memory. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/**
 * Upper bound on listed transcript files. Reaching it marks the scan `partial`:
 * a listing this large is a pathological corpus (years of heavy use), and the
 * alternative is an unbounded directory walk inside a prompt.
 */
const MAX_SESSION_FILES = 20_000;

interface Candidate {
	file: SessionFile;
	message: SessionMessage;
	project: string;
	projectName: string;
	score: number;
	matched: string[];
	exact: boolean;
}

/** Loaded from the transcript header or derived from the file name. */
function deriveProject(path: string, cwd?: string): { project: string; projectName: string } {
	if (cwd) return { project: cwd, projectName: basename(cwd) || cwd };
	const dir = basename(join(path, ".."));
	const decoded = dir.replace(/^--+|-+$/g, "").replace(/-/g, "/");
	return { project: decoded, projectName: basename(decoded) || decoded };
}

/** `<timestamp>_<uuid>.jsonl` → epoch ms, falling back to the file mtime. */
function startedAtFromName(path: string, fallback: number): number {
	const match = basename(path).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
	if (!match) return fallback;
	const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Normalize text for phrase matching: NFKC, lowercase, punctuation to spaces. */
export function normalizeForSessionMatch(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Extract the searchable text of one message, honouring the include flags. */
export function extractMessageText(role: string, content: unknown, includeTools: boolean): string {
	const parts: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value.trim()) parts.push(value);
	};
	const walkBlocks = (blocks: unknown, blockRole: "user" | "assistant" | "tool"): void => {
		if (typeof blocks === "string") {
			push(blocks);
			return;
		}
		if (!Array.isArray(blocks)) return;
		for (const block of blocks) {
			if (!block || typeof block !== "object") continue;
			const typed = block as { type?: string; text?: string; arguments?: unknown; input?: unknown };
			if (typed.type === "text") push(typed.text);
			// Thinking blocks are private reasoning, never evidence.
			if (!includeTools) continue;
			if ((blockRole === "assistant" || blockRole === "tool") && (typed.type === "toolCall" || typed.type === "tool_call")) {
				const args = typed.arguments ?? typed.input;
				const rendered = typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args);
				if (rendered) push(rendered);
			}
		}
	};
	if (role === "user" || role === "assistant") walkBlocks(content, role);
	else if (role === "toolResult" && includeTools) walkBlocks(content, "tool");
	const joined = parts.join("\n").replace(/\s+/g, " ").trim();
	return truncateChars(joined, MAX_SESSION_MESSAGE_CHARS);
}

/** Generic text harvest for `custom` payloads (web results, extension data). */
function harvestCustomText(value: unknown, depth = 0): string[] {
	if (depth > 4) return [];
	if (typeof value === "string") return value.length > 2 ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((entry) => harvestCustomText(entry, depth + 1));
	if (value && typeof value === "object") {
		const out: string[] = [];
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (["data", "bytes", "base64", "signature", "image", "thinking"].includes(key)) continue;
			out.push(...harvestCustomText(entry, depth + 1));
		}
		return out;
	}
	return [];
}

/** Case-insensitive, punctuation-tolerant regex for a normalized phrase. */
function phraseRegex(phrase: string): RegExp {
	const parts = phrase.split(" ").filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(parts.join("[^\\p{L}\\p{N}]+"), "iu");
}

/** Where a phrase first appears in the original text, or -1. */
export function findPhrase(text: string, phrases: string[], terms: string[]): number {
	let best = -1;
	for (const phrase of phrases) {
		const match = phraseRegex(phrase).exec(text);
		if (match && (best === -1 || match.index < best)) best = match.index;
	}
	if (best !== -1) return best;
	for (const term of terms) {
		const match = phraseRegex(term).exec(text);
		if (match && (best === -1 || match.index < best)) best = match.index;
	}
	return best;
}

/**
 * Build a bounded excerpt around the first match. Falls back to the head of the
 * message when the match cannot be located in the original text.
 */
export function buildExcerpt(text: string, phrases: string[], terms: string[], maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	const at = findPhrase(flat, phrases, terms);
	if (at === -1) return `${truncateChars(flat, Math.max(1, maxChars - 1)).trimEnd()}…`;
	const half = Math.floor(maxChars / 2);
	let start = Math.max(0, at - Math.floor(half / 2));
	if (start > 0) {
		const space = flat.indexOf(" ", start);
		if (space !== -1 && space - start < 30) start = space + 1;
	}
	let end = Math.min(flat.length, start + maxChars);
	if (end < flat.length) {
		const space = flat.lastIndexOf(" ", end);
		if (space > start) end = space;
	}
	let excerpt = flat.slice(start, end).trim();
	if (start > 0) excerpt = `…${excerpt}`;
	if (end < flat.length) excerpt = `${excerpt.replace(/[,;:.\s]+$/, "")}…`;
	return excerpt;
}

/**
 * Cache key for a transcript parse. Two variants are kept per file: the cheap
 * user/assistant-only parse (the default) and the full parse including tool
 * plumbing, so an `includeTools` search does not force every later search to
 * pay for tool extraction.
 */
function cacheKey(path: string, includeTools: boolean): string {
	return `${path}::${includeTools ? "all" : "core"}`;
}

/** Characters a ripgrep needle may contain: ASCII alphanumerics, `_` and CJK. */
function needleSafe(word: string): boolean {
	if (!word) return false;
	for (const ch of word) {
		if (/[a-z0-9_]/.test(ch) || isCjkChar(ch)) continue;
		return false;
	}
	return true;
}

/**
 * Fixed-string needles for the ripgrep prefilter, or `undefined` when the query
 * cannot be proven to be covered by them.
 *
 * A file is skipped only when ripgrep finds none of these strings, so they must
 * cover everything the scorer can match: every scoring term (`tokenize` already
 * lowercases) and — because a phrase match implies all of its words — the
 * longest safe word of each exact phrase. Terms ending in `y` also probe the
 * `…ies` surface form: that is the one stemmer rule which is not
 * prefix-preserving, so query "party" must also match "parties". Non-ASCII,
 * non-CJK words disable the prefilter rather than risk a normalization
 * mismatch.
 */
export function ripgrepNeedles(phrases: string[], terms: string[]): string[] | undefined {
	const needles = new Set<string>();
	const add = (word: string): void => {
		const normalized = word.toLowerCase();
		if (!needleSafe(normalized)) return;
		needles.add(normalized);
		if (normalized.length >= 4 && normalized.endsWith("y")) needles.add(`${normalized.slice(0, -1)}ies`);
	};
	for (const term of terms) {
		if (!needleSafe(term.toLowerCase())) return undefined;
		add(term);
	}
	for (const phrase of phrases) {
		// One word of a phrase is enough to witness it: a phrase match implies
		// every word is present. The longest safe word is the most selective, and
		// a short but common witness ("a", "out") would match nearly everything.
		const words = phrase.split(" ").filter((word) => needleSafe(word.toLowerCase()));
		if (words.length === 0) return undefined;
		add(words.reduce((best, word) => (word.length > best.length ? word : best)));
	}
	if (needles.size === 0 || needles.size > 64) return undefined;
	return [...needles];
}

export interface SessionStoreOptions {
	/** Transcript roots to scan, in priority order. */
	roots: string[];
	/** In-memory budget for parsed messages (accounted as twice the file size). */
	cacheBytes?: number;
	/** Default excerpt size. */
	excerptChars?: number;
	/**
	 * Ripgrep binary used to find candidate transcripts before parsing. `null`
	 * disables the accelerator, a path uses exactly that binary, and `undefined`
	 * auto-detects from `rgCandidates` and then `PATH`.
	 */
	rgPath?: string | null;
	/** Locations checked before `PATH` when auto-detecting (e.g. pi's bin dir). */
	rgCandidates?: string[];
}

interface CachedFile {
	path: string;
	mtimeMs: number;
	size: number;
	/** Raw file length, for reporting. */
	rawBytes: number;
	/** Accounted cache cost. */
	cost: number;
	messages: SessionMessage[];
	header: { cwd?: string; startedAt: number };
}

export class SessionStore {
	readonly roots: string[];
	private cache = new Map<string, CachedFile>();
	/** In-flight parses, so concurrent searches share one read/parse per file. */
	private inflight = new Map<string, Promise<{ entry: CachedFile | undefined; skipped: number; rawBytes: number }>>();
	private cacheBytes = 0;
	private cacheBudget: number;
	private excerptChars: number;
	private rgPathOption: string | null | undefined;
	private rgCandidates: string[];
	/** Resolved once per store: a path, `null` (unavailable/disabled), or unknown. */
	private rgLocated: string | null | undefined;

	constructor(options: SessionStoreOptions) {
		this.roots = options.roots;
		this.cacheBudget = Math.max(0, options.cacheBytes ?? 32 * 1024 * 1024);
		this.excerptChars = Math.max(80, options.excerptChars ?? 400);
		this.rgPathOption = options.rgPath;
		this.rgCandidates = options.rgCandidates ?? [];
	}

	/** Resolve the ripgrep binary once; `null` means the accelerator is off. */
	private locateRipgrep(): string | null {
		if (this.rgLocated !== undefined) return this.rgLocated;
		const candidates: string[] = [];
		if (typeof this.rgPathOption === "string") {
			candidates.push(this.rgPathOption);
		} else if (this.rgPathOption === undefined) {
			candidates.push(...this.rgCandidates);
			for (const dir of (process.env.PATH ?? "").split(delimiter)) {
				if (!dir) continue;
				candidates.push(join(dir, process.platform === "win32" ? "rg.exe" : "rg"));
			}
		}
		for (const candidate of candidates) {
			try {
				accessSync(candidate, constants.X_OK);
				this.rgLocated = candidate;
				return candidate;
			} catch {
				// Try the next location.
			}
		}
		this.rgLocated = null;
		return null;
	}

	/**
	 * List the transcripts containing at least one needle with ripgrep.
	 *
	 * Returns matching paths, `"missing"` when no usable binary exists, or
	 * `"error"` when ripgrep failed, timed out, or produced more output than the
	 * caller can use. Both non-result outcomes make the caller fall back to the
	 * full parse, so correctness never depends on the accelerator.
	 */
	private async ripgrepFiles(needles: string[], timeoutMs: number): Promise<Set<string> | "missing" | "error"> {
		const binary = this.locateRipgrep();
		if (!binary) return "missing";
		const roots = this.roots.filter((root) => existsSync(root));
		if (roots.length === 0) return new Set<string>();
		const args = ["--files-with-matches", "--ignore-case", "--fixed-strings", "--no-messages", "--no-ignore", "--text", "--iglob", "*.jsonl"];
		for (const needle of needles) args.push("-e", needle);
		args.push("--", ...roots);
		return await new Promise<Set<string> | "error">((settle) => {
			let child;
			try {
				child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
			} catch {
				settle("error");
				return;
			}
			let out = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: Set<string> | "error"): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				settle(value);
			};
			const kill = (): void => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			};
			timer = setTimeout(() => {
				kill();
				finish("error");
			}, timeoutMs);
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				out += chunk;
				if (out.length > MAX_RG_OUTPUT_CHARS) {
					kill();
					finish("error");
				}
			});
			child.on("error", () => finish("error"));
			child.on("close", (code) => {
				if (code === 1) return finish(new Set<string>());
				if (code !== 0) return finish("error");
				const paths = new Set<string>();
				for (const line of out.split("\n")) {
					const path = line.trim();
					if (path) paths.add(resolve(path));
				}
				finish(paths);
			});
		});
	}

	/** True when at least one root exists on disk. */
	hasRoots(): boolean {
		return this.roots.some((root) => existsSync(root));
	}

	/**
	 * Transcript files, newest session first.
	 *
	 * The directory is re-walked on every call: `stat` is cheap, and a cached
	 * listing would hand a stale mtime/size to the parse cache, hiding a session
	 * that was written seconds ago. Parsing — not walking — is what the cache is
	 * for.
	 *
	 * The walk is itself bounded: `deadline` (a `performance.now()` value) and
	 * `maxFiles` stop it, and `truncated` reports that the listing is not the
	 * whole corpus. That matters because a ten-thousand-session archive would
	 * otherwise stall an automatic recall before the parse budget is even
	 * consulted.
	 */
	async listFiles(options: { deadline?: number; maxFiles?: number } = {}): Promise<{ files: SessionFile[]; truncated: boolean }> {
		const state = { files: [] as SessionFile[], truncated: false };
		const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
		const maxFiles = Math.max(1, options.maxFiles ?? MAX_SESSION_FILES);
		for (const root of this.roots) {
			if (!existsSync(root)) continue;
			await this.walk(root, root, 0, state, () => performance.now() > deadline || state.files.length >= maxFiles);
		}
		state.files.sort((a, b) => b.startedAt - a.startedAt);
		return { files: state.files, truncated: state.truncated };
	}

	private async walk(root: string, dir: string, depth: number, state: { files: SessionFile[]; truncated: boolean }, overBudget: () => boolean): Promise<void> {
		if (depth > MAX_WALK_DEPTH || state.truncated) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// Transcript names start with an ISO timestamp, so name-descending is
		// newest-first: a truncated listing keeps the most recent sessions.
		entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
		for (const entry of entries) {
			if (overBudget()) {
				state.truncated = true;
				return;
			}
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".")) continue;
				await this.walk(root, path, depth + 1, state, overBudget);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			let stats;
			try {
				stats = await stat(path);
			} catch {
				continue;
			}
			if (stats.size === 0 || stats.size > MAX_FILE_BYTES) continue;
			const cachedCore = this.cache.get(cacheKey(path, false));
			const cachedAll = this.cache.get(cacheKey(path, true));
			const fresh = (entry: CachedFile | undefined): CachedFile | undefined => (entry && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size ? entry : undefined);
			const header = (fresh(cachedCore) ?? fresh(cachedAll))?.header;
			const { project, projectName } = deriveProject(path, header?.cwd);
			state.files.push({
				path,
				root,
				relPath: relative(root, path).split(sep).join("/"),
				project,
				projectName,
				startedAt: header?.startedAt ?? startedAtFromName(path, stats.mtimeMs),
				mtimeMs: stats.mtimeMs,
				size: stats.size,
			});
		}
	}

	/** Default-view projection of a parsed file (tool plumbing hidden unless asked). */
	private view(entry: CachedFile, includeTools: boolean): SessionMessage[] {
		return includeTools ? entry.messages : entry.messages.filter((message) => message.role !== "tool" && message.role !== "summary");
	}

	/** Read and parse one transcript, populating the cache (no in-flight handling). */
	private async parseFile(file: SessionFile, includeTools: boolean): Promise<{ entry: CachedFile | undefined; skipped: number; rawBytes: number }> {
		let raw: string;
		try {
			raw = await readFile(file.path, "utf8");
		} catch {
			return { entry: undefined, skipped: 1, rawBytes: 0 };
		}
		const messages: SessionMessage[] = [];
		let skipped = 0;
		let cwd: string | undefined;
		let headerStarted = 0;
		for (const [index, line] of raw.split(/\r?\n/).entries()) {
			if (!line || line.charCodeAt(0) !== 123 /* "{" */) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				skipped += 1;
				continue;
			}
			const type = record.type;
			if (type === "session") {
				if (typeof record.cwd === "string") cwd = record.cwd;
				if (typeof record.timestamp === "string") headerStarted = Date.parse(record.timestamp) || 0;
				continue;
			}
			const entryTime = typeof record.timestamp === "number" ? record.timestamp : typeof record.timestamp === "string" ? Date.parse(record.timestamp) || 0 : 0;
			if (type === "message") {
				const message = record.message as { role?: string; content?: unknown; timestamp?: number } | undefined;
				if (!message || typeof message.role !== "string") continue;
				// The system prompt is large and is not evidence.
				if (message.role === "system") continue;
				const role = message.role === "user" || message.role === "assistant" ? message.role : message.role === "toolResult" ? "tool" : undefined;
				if (!role) continue;
				if (role === "tool" && !includeTools) continue;
				const text = extractMessageText(message.role, message.content, includeTools);
				if (!text) continue;
				messages.push({
					line: index + 1,
					role,
					timestamp: typeof message.timestamp === "number" && message.timestamp > 0 ? message.timestamp : entryTime,
					text,
					normalized: "",
				});
				continue;
			}
			if (!includeTools) continue;
			if (type === "compaction" && typeof record.summary === "string" && record.summary.trim()) {
				const text = truncateChars(record.summary.replace(/\s+/g, " ").trim(), MAX_SESSION_MESSAGE_CHARS);
				messages.push({ line: index + 1, role: "summary", timestamp: entryTime, text, normalized: "" });
				continue;
			}
			if (type === "custom") {
				const text = truncateChars(oneLine(harvestCustomText(record.data).join(" "), MAX_SESSION_MESSAGE_CHARS), MAX_SESSION_MESSAGE_CHARS);
				if (text) messages.push({ line: index + 1, role: "tool", timestamp: entryTime, text, normalized: "" });
				continue;
			}
			// `custom_message` is injected context (e.g. a recall block), not a turn.
		}
		const parsed: CachedFile = {
			path: file.path,
			mtimeMs: file.mtimeMs,
			size: file.size,
			rawBytes: raw.length,
			// Extracted text plus its normalized copy, plus object overhead.
			cost: raw.length * 2,
			messages,
			header: { cwd, startedAt: headerStarted || file.startedAt },
		};
		this.put(parsed, includeTools);
		return { entry: parsed, skipped, rawBytes: raw.length };
	}

	/**
	 * Parse a transcript, reusing the cache when mtime and size are unchanged.
	 *
	 * Concurrent searches (the common case, since one assistant turn can issue
	 * several `memoria_sessions` calls at once) share a single in-flight parse
	 * per file, so parallel searches never multiply read/parse work on one event
	 * loop and never lose older files to another search's wall-clock budget.
	 */
	async messagesFor(file: SessionFile, includeTools: boolean): Promise<{ messages: SessionMessage[]; cached: boolean; skipped: number; rawBytes: number; cwd?: string }> {
		const key = cacheKey(file.path, includeTools);
		const allKey = cacheKey(file.path, true);
		// A full parse can serve the default view, but the default view cannot
		// serve an includeTools search (it never extracted the tool text).
		const cached = includeTools ? this.cache.get(allKey) : (this.cache.get(cacheKey(file.path, false)) ?? this.cache.get(allKey));
		if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
			// Touch for LRU ordering, under the key the entry actually lives on.
			for (const candidate of [key, allKey]) {
				if (this.cache.get(candidate) === cached) {
					this.cache.delete(candidate);
					this.cache.set(candidate, cached);
					break;
				}
			}
			return { messages: this.view(cached, includeTools), cached: true, skipped: 0, rawBytes: cached.rawBytes, cwd: cached.header.cwd };
		}
		// Join an in-flight parse when it can answer this request: the same
		// variant always, or a full parse for a default-view request.
		const pending = this.inflight.get(key) ?? (includeTools ? undefined : this.inflight.get(allKey));
		if (pending) {
			const { entry, skipped, rawBytes } = await pending;
			if (!entry) return { messages: [], cached: false, skipped, rawBytes };
			return { messages: this.view(entry, includeTools), cached: false, skipped, rawBytes: entry.rawBytes, cwd: entry.header.cwd };
		}
		const promise = this.parseFile(file, includeTools);
		this.inflight.set(key, promise);
		try {
			const { entry, skipped, rawBytes } = await promise;
			if (!entry) return { messages: [], cached: false, skipped, rawBytes };
			return { messages: this.view(entry, includeTools), cached: false, skipped, rawBytes: entry.rawBytes, cwd: entry.header.cwd };
		} finally {
			this.inflight.delete(key);
		}
	}

	private put(entry: CachedFile, includeTools: boolean): void {
		const key = cacheKey(entry.path, includeTools);
		const existing = this.cache.get(key);
		if (existing) this.cacheBytes -= existing.cost;
		this.cache.set(key, entry);
		this.cacheBytes += entry.cost;
		while (this.cacheBytes > this.cacheBudget && this.cache.size > 0) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			const evicted = this.cache.get(oldest.value)!;
			this.cache.delete(oldest.value);
			this.cacheBytes -= evicted.cost;
		}
	}

	/** Drop the parsed-message cache. */
	clear(): void {
		this.cache.clear();
		this.cacheBytes = 0;
	}

	get cachedFileCount(): number {
		return this.cache.size;
	}

	/**
	 * Search the transcripts.
	 *
	 * Query terms are matched with the memory tokenizer (identifiers, stems, CJK
	 * unigrams) after a cheap substring prefilter, so the full corpus is examined
	 * without tokenizing every message. Results are ranked by exact-phrase hits,
	 * term coverage and authorship, with recency as the tie-break.
	 */
	async search(query: string, options: SessionSearchOptions = {}): Promise<SessionSearchResult> {
		const started = performance.now();
		const limit = Math.max(1, Math.min(50, options.limit ?? 8));
		const budgetMs = Math.max(0, options.budgetMs ?? 1500);
		const excerptChars = Math.max(80, options.excerptChars ?? this.excerptChars);
		const includeTools = options.includeTools === true;
		const stats: SessionScanStats = { roots: this.roots.filter((root) => existsSync(root)), files: 0, messages: 0, bytes: 0, cachedFiles: 0, skipped: 0, partial: false };

		const phrases = query
			.split(/\n+/)
			.map((part) => normalizeForSessionMatch(part))
			.filter((part) => part.length >= 3);
		if (phrases.length === 0) return { hits: [], stats, tookMs: Math.round((performance.now() - started) * 100) / 100 };

		// Distinctive terms: stopwords dropped by the tokenizer, stems kept so
		// "deploying" finds "deploys".
		const termSet = new Set<string>();
		for (const term of tokenize(query)) {
			if (term.length < 2) continue;
			if (term.length === 1 && isCjkChar(term[0])) continue;
			termSet.add(term);
		}
		const terms = [...termSet].sort((a, b) => b.length - a.length).slice(0, 16);
		const scoringTerms = terms.length > 0 ? terms : phrases.flatMap((phrase) => phrase.split(" ").filter((word) => word.length >= 3)).slice(0, 16);

		const since = options.sinceDays !== undefined ? Date.now() - options.sinceDays * 86_400_000 : undefined;
		const projectFilter = options.project?.trim().toLowerCase();
		// The budget covers the directory walk as well as parsing; a listing that
		// could not be completed is reported as partial.
		const listing = await this.listFiles({ deadline: budgetMs > 0 ? started + budgetMs : undefined });
		if (listing.truncated) stats.partial = true;

		// Ripgrep narrows the parse set to files that contain at least one query
		// needle. Files outside that set are provably match-free, so they count as
		// scanned without being read. Without a usable binary (or a query we cannot
		// prefilter safely) every listed file is parsed exactly as before.
		let parseFilter: Set<string> | undefined;
		if (this.rgPathOption === null) {
			stats.ripgrep = "disabled";
		} else {
			const needles = ripgrepNeedles(phrases, scoringTerms);
			if (!needles) {
				stats.ripgrep = "unsupported";
			} else {
				const remaining = budgetMs > 0 ? started + budgetMs - performance.now() : Number.POSITIVE_INFINITY;
				if (listing.files.length === 0 || remaining <= 0) {
					stats.ripgrep = "skipped";
				} else {
					// The accelerator is fast, but give it a hard cap so a hung binary
					// or a pathological mount cannot stall a prompt. Overrunning the
					// remaining budget only makes the parse below report `partial`.
					const timeout = Number.isFinite(remaining) ? Math.min(MAX_RG_TIMEOUT_MS, Math.max(500, Math.round(remaining * 4))) : MAX_RG_TIMEOUT_MS;
					const found = await this.ripgrepFiles(needles, timeout);
					if (found === "missing") stats.ripgrep = "missing";
					else if (found === "error") stats.ripgrep = "error";
					else {
						parseFilter = found;
						stats.ripgrep = "used";
					}
				}
			}
		}

		const candidates: Candidate[] = [];
		for (const file of listing.files) {
			if (since !== undefined && file.startedAt < since) continue;
			if (projectFilter && !file.project.toLowerCase().includes(projectFilter) && !file.projectName.toLowerCase().includes(projectFilter)) continue;
			// Checked before every file (a clock read per file is free), so the
			// budget is honoured to within one file rather than one batch.
			if (budgetMs > 0 && performance.now() - started > budgetMs) {
				stats.partial = true;
				break;
			}
			if (parseFilter && !parseFilter.has(resolve(file.path))) {
				stats.files += 1;
				stats.bytes += file.size;
				continue;
			}
			const parsed = await this.messagesFor(file, includeTools);
			stats.files += 1;
			stats.bytes += parsed.rawBytes;
			stats.skipped += parsed.skipped;
			if (parsed.cached) stats.cachedFiles += 1;
			for (const message of parsed.messages) {
				stats.messages += 1;
				if (options.userOnly && message.role !== "user") continue;
				if (!message.normalized) message.normalized = normalizeForSessionMatch(message.text);
				const normalized = message.normalized;
				if (!normalized) continue;
				let exact = 0;
				for (const phrase of phrases) if (normalized.includes(phrase)) exact += 1;
				const matched: string[] = [];
				for (const term of scoringTerms) {
					if (normalized.includes(term)) {
						matched.push(term);
						continue;
					}
					// CJK terms are matched by substring above; other scripts can be
					// matched again after tokenizing (stems, camelCase).
					if (term.length >= 4 && !isCjkChar(term[0])) {
						if (!message.terms) message.terms = new Set(tokenize(message.text));
						if (message.terms.has(term) || message.terms.has(stem(term))) matched.push(term);
					}
				}
				if (exact === 0 && matched.length === 0) continue;
				// Exact phrases and term coverage dominate; the role bonus only
				// breaks ties, in favour of first-hand (user) evidence.
				const roleBonus = message.role === "user" ? 8 : message.role === "assistant" ? 0 : message.role === "summary" ? -2 : -4;
				const coverage = scoringTerms.length > 0 && matched.length >= scoringTerms.length ? 5 : 0;
				// The transcript header records the real cwd; prefer it over the
				// decoded folder name for display and filtering.
				const project = parsed.cwd ?? file.project;
				candidates.push({
					file,
					message,
					project,
					projectName: parsed.cwd ? basename(parsed.cwd) || parsed.cwd : file.projectName,
					score: 100 * exact + 10 * matched.length + roleBonus + coverage,
					matched: matched.slice(0, 8),
					exact: exact > 0,
				});
				if (candidates.length > limit * 8) {
					candidates.sort((a, b) => b.score - a.score);
					candidates.length = limit * 4;
				}
			}
		}

		const hits = candidates
			.sort((a, b) => b.score - a.score || b.message.timestamp - a.message.timestamp)
			.slice(0, limit)
			.map((candidate): SessionHit => ({
				path: candidate.file.path,
				relPath: candidate.file.relPath,
				project: candidate.project,
				projectName: candidate.projectName,
				line: candidate.message.line,
				role: candidate.message.role,
				timestamp: candidate.message.timestamp,
				score: candidate.score,
				matched: candidate.matched,
				exact: candidate.exact,
				excerpt: buildExcerpt(candidate.message.text, phrases, scoringTerms, excerptChars),
			}));
		return { hits, stats, tookMs: Math.round((performance.now() - started) * 100) / 100 };
	}

	/**
	 * Read a bounded window of messages around a line, so an agent can verify a
	 * hit in context (including later corrections).
	 */
	async readWindow(path: string, line: number, windowSize = 6): Promise<SessionReadResult | undefined> {
		const target = resolve(path);
		const root = this.roots.find((candidate) => target === resolve(candidate) || target.startsWith(`${resolve(candidate)}${sep}`));
		if (!root || !existsSync(target)) return undefined;
		if (!Number.isFinite(line) || line < 1) return undefined;
		const size = Math.max(0, Math.min(40, Math.floor(windowSize)));
		const from = Math.max(1, Math.floor(line) - size);
		const to = Math.floor(line) + size;
		let raw: string;
		try {
			raw = await readFile(target, "utf8");
		} catch {
			return undefined;
		}
		const messages: SessionWindowMessage[] = [];
		let cwd: string | undefined;
		const lines = raw.split(/\r?\n/);
		for (let index = from - 1; index < lines.length && index + 1 <= to; index += 1) {
			const rawLine = lines[index];
			if (!rawLine || rawLine.charCodeAt(0) !== 123) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(rawLine) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (record.type === "session" && typeof record.cwd === "string") cwd = record.cwd;
			if (record.type !== "message") continue;
			const message = record.message as { role?: string; content?: unknown; timestamp?: number } | undefined;
			if (!message || typeof message.role !== "string" || message.role === "system") continue;
			const role = message.role === "toolResult" ? "tool" : message.role;
			const text = extractMessageText(message.role, message.content, true);
			if (!text) continue;
			const entryTime = typeof record.timestamp === "string" ? Date.parse(record.timestamp) || 0 : 0;
			messages.push({
				line: index + 1,
				role,
				timestamp: typeof message.timestamp === "number" && message.timestamp > 0 ? message.timestamp : entryTime,
				text: truncateChars(text, 2400),
			});
		}
		if (messages.length === 0) return undefined;
		const { projectName } = deriveProject(target, cwd);
		return {
			path: target,
			relPath: relative(root, target).split(sep).join("/"),
			projectName,
			startLine: messages[0].line,
			endLine: messages[messages.length - 1].line,
			messages,
		};
	}
}

/** ISO timestamp for display; empty string when unknown. */
export function formatSessionTime(timestamp: number): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
}
