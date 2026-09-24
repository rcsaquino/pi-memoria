/**
 * In-memory inverted index with incremental persistence.
 *
 * Data layout (mirrors the persisted JSON so load/save are cheap):
 *   terms:      string[]        term dictionary
 *   postings:   number[][]      parallel to terms; flat [docIdx, tf, docIdx, tf, ...]
 *   docs:       IndexedDocMeta[] parallel to docTerms/docTfs
 *   docTerms:   number[][]      term ids per doc (for incremental removal)
 *   docTfs:     number[][]      matching weights
 *   df:         number[]        live document frequency per term
 *   alive:      boolean[]       tombstones for removed docs
 *
 * Removal uses tombstones; compaction happens lazily once garbage exceeds a
 * threshold. Searches skip dead docs and rely on the maintained `df` for BM25.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { INDEX_BIN_FILE, INDEX_DIR, INDEX_FILE, TRASH_DIR } from "./config.ts";
import { GENERATED_INDEX, readMemoryDoc, scanLibrary, isIndexableRelPath } from "./store.ts";
import { atomicWriteFile, debounce, oneLine, readFileBufferOrUndefined, readFileOrUndefined, shortHash, truncateChars } from "./util.ts";
import { termTrigrams, editDistance } from "./tokenize.ts";
import type { IndexedDocMeta, MemoryDoc, PersistedIndex, SearchOptions, SearchResult, StoreStats } from "./types.ts";
import { searchIndex } from "./search.ts";

export const INDEX_VERSION = 4;

/**
 * Above this many notes the index is persisted as a binary blob instead of
 * JSON when `indexFormat` is "auto". The JSON encoding of a 50k-note index is
 * tens of megabytes of text to parse; the binary sections are read directly
 * into typed arrays.
 */
export const BINARY_AUTO_THRESHOLD_DOCS = 20_000;

const BINARY_MAGIC = 0x4d4d5842; // "MMXB"
const BINARY_HEADER_BYTES = 48;

/** True for filesystem events that must not invalidate the index. */
export function isIgnoredWatchPath(relName: string): boolean {
	const name = normalizeRelPath(relName);
	if (!name) return true;
	if (name === INDEX_DIR || name.startsWith(`${INDEX_DIR}/`)) return true;
	if (name === TRASH_DIR || name.startsWith(`${TRASH_DIR}/`)) return true;
	if (basename(name) === GENERATED_INDEX) return true;
	return false;
}

function normalizeRelPath(relPath: string): string {
	return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

const COMPACT_THRESHOLD_RATIO = 0.25;
const COMPACT_THRESHOLD_MIN = 32;

/** Simple byte-budgeted FIFO cache for memory bodies. */
class BodyCache {
	private map = new Map<string, string>();
	private bytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	get(key: string): string | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		// Refresh recency.
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	set(key: string, value: string): void {
		if (this.maxBytes <= 0 || value.length > this.maxBytes) return;
		const existing = this.map.get(key);
		if (existing !== undefined) {
			this.bytes -= existing.length;
			this.map.delete(key);
		}
		this.map.set(key, value);
		this.bytes += value.length;
		while (this.bytes > this.maxBytes) {
			const oldest = this.map.keys().next();
			if (oldest.done) break;
			const oldestValue = this.map.get(oldest.value)!;
			this.map.delete(oldest.value);
			this.bytes -= oldestValue.length;
		}
	}

	clear(): void {
		this.map.clear();
		this.bytes = 0;
	}

	delete(key: string): void {
		const existing = this.map.get(key);
		if (existing === undefined) return;
		this.bytes -= existing.length;
		this.map.delete(key);
	}

	get size(): number {
		return this.map.size;
	}
}

/**
 * A doc without the fields that are recomputed on load (`root` from the store
 * and `path` from the relative path). On a 20k-note store this is ~2 MB of
 * redundant JSON.
 */
function leanDoc(doc: IndexedDocMeta): IndexedDocMeta {
	const copy = { ...doc } as Record<string, unknown>;
	delete copy.root;
	delete copy.path;
	return copy as unknown as IndexedDocMeta;
}

export interface MemoryIndexOptions {
	bodyCacheBytes?: number;
	maxScanIntervalMs?: number;
	/** Path fragments excluded from indexing (mirrors `config.exclude`). */
	exclude?: string[];
	/** Persistence format: auto (binary above a threshold), json or binary. */
	indexFormat?: string;
}

export class MemoryIndex {
	readonly root: string;

	terms: string[] = [];
	postings: number[][] = [];
	docs: IndexedDocMeta[] = [];
	docTerms: number[][] = [];
	docTfs: number[][] = [];
	df: number[] = [];
	alive: boolean[] = [];

	builtAt = 0;
	loadMs = 0;
	lastSearchMs = 0;
	lastScanAt = 0;
	/** Set when files changed since the last scan. */
	dirty = true;
	watcherActive = false;

	private termIds = new Map<string, number>();
	private idToIdx = new Map<string, number>();
	/** Built only for lookups that miss canonical ids; aliases are not the hot path. */
	private aliasToIdx: Map<string, number> | undefined;
	private relPathToIdx = new Map<string, number>();
	private bodyCache: BodyCache;
	private trigramIndex: Map<string, number[]> | undefined;
	private fuzzyCache = new Map<string, number[]>();
	/** Term ids sorted by term text; rebuilt lazily for prefix search. */
	private sortedTermIdsCache: number[] | undefined;
	/** Reusable dense buffers for the search hot loop. */
	private scratch: SearchScratch | undefined;
	private scratchGeneration = 0;
	/** Cached resolution of `related` / `supersedes` links. */
	private linkCache: { supersedes: Map<string, string[]>; titles: Map<string, number>; related: Map<number, number[]> } | undefined;
	private scanIntervalMs: number;
	private exclude: string[];
	private compactionQueued = false;
	private indexFormat: string;
	/** Bytes of the index file currently on disk, and which format it is in. */
	persistedBytes = 0;
	persistedFormat: "json" | "binary" = "json";

	constructor(root: string, options: MemoryIndexOptions = {}) {
		this.root = root;
		this.bodyCache = new BodyCache(options.bodyCacheBytes ?? 8 * 1024 * 1024);
		this.scanIntervalMs = options.maxScanIntervalMs ?? 5000;
		this.exclude = options.exclude ?? [];
		this.indexFormat = options.indexFormat ?? "auto";
	}

	get indexFilePath(): string {
		return join(this.root, INDEX_DIR, INDEX_FILE);
	}

	get indexBinaryPath(): string {
		return join(this.root, INDEX_DIR, INDEX_BIN_FILE);
	}

	/** Which format this index should persist in. */
	chosenFormat(): "json" | "binary" {
		if (this.indexFormat === "binary") return "binary";
		if (this.indexFormat === "json") return "json";
		return this.aliveCount >= BINARY_AUTO_THRESHOLD_DOCS ? "binary" : "json";
	}

	/** Change the on-disk format; the next save rewrites the index. */
	setIndexFormat(format: string): void {
		this.indexFormat = format;
	}

	get aliveCount(): number {
		let count = 0;
		for (const value of this.alive) if (value) count += 1;
		return count;
	}

	get avgDocLength(): number {
		let total = 0;
		let count = 0;
		for (let i = 0; i < this.docs.length; i += 1) {
			if (!this.alive[i]) continue;
			total += this.docs[i].tokenCount;
			count += 1;
		}
		return count === 0 ? 1 : Math.max(1, total / count);
	}

	getDoc(idx: number): IndexedDocMeta | undefined {
		return this.docs[idx];
	}

	/**
	 * Dense per-doc scratch buffers for scoring. Keyed by doc index, so they are
	 * invalidated whenever compaction renumbers documents.
	 */
	searchScratch(): SearchScratch {
		const size = this.docs.length;
		if (!this.scratch || this.scratch.scores.length < size || this.scratch.generation !== this.scratchGeneration) {
			this.scratch = {
				scores: new Float64Array(size),
				coverage: new Int32Array(size),
				mask: new Uint32Array(size),
				touched: new Int32Array(size),
				generation: this.scratchGeneration,
			};
		}
		return this.scratch;
	}

	idxForId(id: string): number | undefined {
		const direct = this.idToIdx.get(id);
		if (direct !== undefined) return direct;
		// Imports may have ids that do not use the mem_ prefix. A merge records the
		// retired id as an alias, so every former id must remain usable.
		if (!this.aliasToIdx) {
			this.aliasToIdx = new Map();
			for (let idx = 0; idx < this.docs.length; idx += 1) {
				if (!this.alive[idx]) continue;
				for (const alias of this.docs[idx].aliases) {
					if (!this.aliasToIdx.has(alias)) this.aliasToIdx.set(alias, idx);
				}
			}
		}
		return this.aliasToIdx.get(id);
	}

	idxForRelPath(relPath: string): number {
		return this.relPathToIdx.get(normalizeRelPath(relPath)) ?? -1;
	}

	/** Read the body for a doc, using the cache and falling back to disk. */
	async bodyFor(idx: number): Promise<string> {
		const doc = this.docs[idx];
		if (!doc) return "";
		const cached = this.bodyCache.get(doc.path);
		if (cached !== undefined) return cached;
		const memory = await readMemoryDoc(this.root, doc.path);
		const body = memory?.body ?? "";
		this.bodyCache.set(doc.path, body);
		return body;
	}

	/** Synchronous body access for hot paths; returns preview when not cached. */
	bodyOrPreview(idx: number): string {
		const doc = this.docs[idx];
		if (!doc) return "";
		return this.bodyCache.get(doc.path) ?? doc.preview;
	}

	/* ---------------------------------------------------------------- */
	/* Mutation                                                          */
	/* ---------------------------------------------------------------- */

	private termIdFor(term: string, create: boolean): number {
		const existing = this.termIds.get(term);
		if (existing !== undefined) return existing;
		if (!create) return -1;
		const id = this.terms.length;
		this.terms.push(term);
		this.postings.push([]);
		this.df.push(0);
		this.termIds.set(term, id);
		this.sortedTermIdsCache = undefined;
		return id;
	}

	/** Add a parsed doc to the index. */
	addDoc(doc: MemoryDoc): number {
		const idx = this.docs.length;
		const meta: IndexedDocMeta = {
			id: doc.id,
			root: doc.root,
			path: doc.path,
			relPath: doc.relPath,
			title: doc.title,
			category: doc.category,
			tags: doc.tags,
			aliases: doc.aliases,
			related: doc.related,
			supersedes: doc.supersedes,
			summary: doc.summary,
			priority: doc.priority,
			confidence: doc.confidence,
			created: doc.created,
			updated: doc.updated,
			lastUsed: doc.lastUsed,
			mtimeMs: doc.mtimeMs,
			size: doc.size,
			wordCount: doc.wordCount,
			bodyChars: doc.body.length,
			tokenCount: doc.tokenCount,
			unfiled: doc.unfiled,
			preview: oneLine(doc.body, 400),
			hash: shortHash(`${doc.size}:${doc.mtimeMs}:${doc.body.length}:${doc.title}:${doc.aliases.join(",")}`),
		};
		const termIds: number[] = [];
		const tfs: number[] = [];
		for (const [term, tf] of Object.entries(doc.tokens)) {
			const termId = this.termIdFor(term, true);
			termIds.push(termId);
			tfs.push(tf);
			this.postings[termId].push(idx, tf);
			this.df[termId] += 1;
		}
		this.docs.push(meta);
		this.docTerms.push(termIds);
		this.docTfs.push(tfs);
		this.alive.push(true);
		this.idToIdx.set(doc.id, idx);
		this.aliasToIdx = undefined;
		this.relPathToIdx.set(meta.relPath, idx);
		this.bodyCache.set(doc.path, doc.body);
		this.linkCache = undefined;
		return idx;
	}

	/** Mark a doc as removed (tombstone). */
	removeDoc(idx: number): void {
		if (idx < 0 || !this.alive[idx]) return;
		const doc = this.docs[idx];
		this.alive[idx] = false;
		this.idToIdx.delete(doc.id);
		this.aliasToIdx = undefined;
		this.relPathToIdx.delete(doc.relPath);
		this.bodyCache.delete(doc.path);
		const termIds = this.docTerms[idx] ?? [];
		for (const termId of termIds) {
			if (this.df[termId] > 0) this.df[termId] -= 1;
		}
		this.linkCache = undefined;
		this.maybeQueueCompaction();
	}

	private maybeQueueCompaction(): void {
		const total = this.docs.length;
		const dead = total - this.aliveCount;
		const threshold = Math.max(COMPACT_THRESHOLD_MIN, Math.floor(total * COMPACT_THRESHOLD_RATIO));
		if (dead > threshold && !this.compactionQueued) {
			this.compactionQueued = true;
			queueMicrotask(() => {
				this.compactionQueued = false;
				this.compact();
			});
		}
	}

	/** Rebuild postings from live docs, dropping tombstones and renumbering. */
	compact(): void {
		const newDocs: IndexedDocMeta[] = [];
		const newDocTerms: number[][] = [];
		const newDocTfs: number[][] = [];
		const newPostings: number[][] = [];
		const newDf: number[] = [];
		const newTermIds = new Map<string, number>();
		const remap = new Map<number, number>();
		for (let oldIdx = 0; oldIdx < this.docs.length; oldIdx += 1) {
			if (!this.alive[oldIdx]) continue;
			remap.set(oldIdx, newDocs.length);
			newDocs.push(this.docs[oldIdx]);
		}
		const internTerm = (term: string): number => {
			const existing = newTermIds.get(term);
			if (existing !== undefined) return existing;
			const id = newPostings.length;
			newPostings.push([]);
			newDf.push(0);
			newTermIds.set(term, id);
			return id;
		};
		// Rebuild the dictionary in the old term order to keep ids stable-ish.
		const oldToNewTerm: number[] = new Array(this.terms.length).fill(-1);
		for (let oldTermId = 0; oldTermId < this.terms.length; oldTermId += 1) {
			if (this.df[oldTermId] <= 0) continue;
			oldToNewTerm[oldTermId] = internTerm(this.terms[oldTermId]);
		}
		for (let oldIdx = 0; oldIdx < this.docs.length; oldIdx += 1) {
			if (!this.alive[oldIdx]) continue;
			const newIdx = remap.get(oldIdx)!;
			const termIds: number[] = [];
			const tfs: number[] = [];
			const oldTerms = this.docTerms[oldIdx] ?? [];
			const oldTfs = this.docTfs[oldIdx] ?? [];
			for (let k = 0; k < oldTerms.length; k += 1) {
				const newTermId = oldToNewTerm[oldTerms[k]];
				if (newTermId === undefined || newTermId < 0) continue;
				termIds.push(newTermId);
				tfs.push(oldTfs[k]);
				newPostings[newTermId].push(newIdx, oldTfs[k]);
				newDf[newTermId] += 1;
			}
			newDocTerms.push(termIds);
			newDocTfs.push(tfs);
		}
		this.terms = [...newTermIds.keys()];
		this.termIds = newTermIds;
		this.postings = newPostings;
		this.df = newDf;
		this.docs = newDocs;
		this.docTerms = newDocTerms;
		this.docTfs = newDocTfs;
		this.alive = new Array(newDocs.length).fill(true);
		this.idToIdx = new Map();
		this.aliasToIdx = undefined;
		this.relPathToIdx = new Map();
		for (let i = 0; i < newDocs.length; i += 1) {
			this.idToIdx.set(newDocs[i].id, i);
			this.relPathToIdx.set(newDocs[i].relPath, i);
		}
		this.trigramIndex = undefined;
		this.fuzzyCache.clear();
		this.sortedTermIdsCache = undefined;
		this.scratch = undefined;
		this.linkCache = undefined;
		this.scratchGeneration += 1;
	}

	clearDocs(): void {
		this.terms = [];
		this.postings = [];
		this.docs = [];
		this.docTerms = [];
		this.docTfs = [];
		this.df = [];
		this.alive = [];
		this.termIds = new Map();
		this.idToIdx = new Map();
		this.aliasToIdx = undefined;
		this.relPathToIdx = new Map();
		this.trigramIndex = undefined;
		this.fuzzyCache.clear();
		this.bodyCache.clear();
		this.sortedTermIdsCache = undefined;
		this.scratch = undefined;
		this.linkCache = undefined;
		this.scratchGeneration += 1;
	}

	/* ---------------------------------------------------------------- */
	/* Term dictionary helpers                                           */
	/* ---------------------------------------------------------------- */

	/** Term ids ordered by their term text. Cached; invalidated on any dictionary change. */
	sortedTermIds(): number[] {
		if (this.sortedTermIdsCache) return this.sortedTermIdsCache;
		const ids = new Array<number>(this.terms.length);
		for (let i = 0; i < ids.length; i += 1) ids[i] = i;
		ids.sort((a, b) => (this.terms[a] < this.terms[b] ? -1 : this.terms[a] > this.terms[b] ? 1 : 0));
		this.sortedTermIdsCache = ids;
		return ids;
	}

	termId(term: string): number {
		return this.termIds.get(term) ?? -1;
	}

	documentFrequency(termId: number): number {
		return termId >= 0 ? this.df[termId] ?? 0 : 0;
	}

	/**
	 * Weighted term frequency for a single document.
	 *
	 * Posting lists are kept sorted by document index, so this is a binary
	 * search instead of a scan. Used by `explain` to attribute scores to terms.
	 */
	postingTfFor(termId: number, docIdx: number): number {
		if (termId < 0 || termId >= this.postings.length) return 0;
		const posting = this.postings[termId];
		let lo = 0;
		let hi = posting.length / 2 - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const doc = posting[mid * 2];
			if (doc === docIdx) return posting[mid * 2 + 1];
			if (doc < docIdx) lo = mid + 1;
			else hi = mid - 1;
		}
		return 0;
	}

	/* ---------------------------------------------------------------- */
	/* Note links (`related` / `supersedes`)                              */
	/* ---------------------------------------------------------------- */

	private links(): { supersedes: Map<string, string[]>; titles: Map<string, number>; related: Map<number, number[]> } {
		if (this.linkCache) return this.linkCache;
		const titles = new Map<string, number>();
		for (let i = 0; i < this.docs.length; i += 1) {
			if (!this.alive[i]) continue;
			const title = this.docs[i].title.toLowerCase();
			if (!titles.has(title)) titles.set(title, i);
		}
		const resolve = (ref: string): number | undefined => {
			const trimmed = ref.trim();
			if (!trimmed) return undefined;
			const byId = this.idxForId(trimmed);
			if (byId !== undefined) return byId;
			const byPath = this.relPathToIdx.get(normalizeRelPath(trimmed));
			if (byPath !== undefined) return byPath;
			return titles.get(trimmed.toLowerCase());
		};
		const supersedes = new Map<string, string[]>();
		const related = new Map<number, number[]>();
		for (let i = 0; i < this.docs.length; i += 1) {
			if (!this.alive[i]) continue;
			const meta = this.docs[i];
			for (const ref of meta.supersedes ?? []) {
				const target = resolve(ref);
				if (target === undefined || target === i) continue;
				const targetId = this.docs[target].id;
				const list = supersedes.get(targetId) ?? [];
				if (!list.includes(meta.id)) list.push(meta.id);
				supersedes.set(targetId, list);
			}
			const targets: number[] = [];
			for (const ref of meta.related ?? []) {
				const target = resolve(ref);
				if (target !== undefined && target !== i && !targets.includes(target)) targets.push(target);
			}
			if (targets.length > 0) related.set(i, targets);
		}
		this.linkCache = { supersedes, titles, related };
		return this.linkCache;
	}

	/** Resolve a `related`/`supersedes` reference to a live doc index. */
	resolveLink(ref: string): number | undefined {
		const titles = this.links().titles;
		const trimmed = ref.trim();
		if (!trimmed) return undefined;
		const byId = this.idxForId(trimmed);
		if (byId !== undefined && this.alive[byId]) return byId;
		const byPath = this.relPathToIdx.get(normalizeRelPath(trimmed));
		if (byPath !== undefined && this.alive[byPath]) return byPath;
		const byTitle = titles.get(trimmed.toLowerCase());
		return byTitle !== undefined && this.alive[byTitle] ? byTitle : undefined;
	}

	/** Map of doc id to the ids of live notes that declare it superseded. */
	supersedeMap(): Map<string, string[]> {
		return this.links().supersedes;
	}

	/** Live doc indices this doc links to through `related:`. */
	relatedDocs(idx: number): number[] {
		return this.links().related.get(idx) ?? [];
	}

	/**
	 * Rebuild a weighted term-frequency map for one doc from the in-memory
	 * postings. Used by similarity checks; never on the search path.
	 */
	docTokens(idx: number): Record<string, number> {
		const out: Record<string, number> = {};
		const termIds = this.docTerms[idx] ?? [];
		const tfs = this.docTfs[idx] ?? [];
		for (let i = 0; i < termIds.length; i += 1) {
			const term = this.terms[termIds[i]];
			if (term) out[term] = tfs[i] ?? 0;
		}
		return out;
	}

	/** Terms beginning with `prefix`, closest length first. */
	prefixMatches(prefix: string, limit: number): number[] {
		const ids = this.sortedTermIds();
		let lo = 0;
		let hi = ids.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.terms[ids[mid]] < prefix) lo = mid + 1;
			else hi = mid;
		}
		const out: number[] = [];
		for (let i = lo; i < ids.length && out.length < limit; i += 1) {
			const termId = ids[i];
			if (!this.terms[termId].startsWith(prefix)) break;
			if (this.df[termId] > 0) out.push(termId);
		}
		out.sort((a, b) => Math.abs(this.terms[a].length - prefix.length) - Math.abs(this.terms[b].length - prefix.length));
		return out;
	}

	private buildTrigramIndex(): void {
		const index = new Map<string, number[]>();
		for (let termId = 0; termId < this.terms.length; termId += 1) {
			if (this.df[termId] <= 0) continue;
			const term = this.terms[termId];
			for (const trigram of new Set(termTrigrams(term))) {
				const bucket = index.get(trigram);
				if (bucket) bucket.push(termId);
				else index.set(trigram, [termId]);
			}
		}
		this.trigramIndex = index;
	}

	/** Fuzzy term candidates within edit distance `maxDistance`. */
	fuzzyMatches(term: string, maxDistance: number, limit: number): number[] {
		if (term.length < 4) return [];
		const cached = this.fuzzyCache.get(term);
		if (cached) return cached;
		if (!this.trigramIndex) this.buildTrigramIndex();
		const trigrams = [...new Set(termTrigrams(term))];
		const counts = new Map<number, number>();
		for (const trigram of trigrams) {
			for (const termId of this.trigramIndex!.get(trigram) ?? []) {
				counts.set(termId, (counts.get(termId) ?? 0) + 1);
			}
		}
		const minShared = Math.max(1, Math.ceil(trigrams.length * 0.4));
		const candidates: Array<{ termId: number; distance: number }> = [];
		for (const [termId, shared] of counts) {
			if (shared < minShared) continue;
			const candidate = this.terms[termId];
			if (Math.abs(candidate.length - term.length) > maxDistance) continue;
			const distance = editDistance(term, candidate, maxDistance);
			if (distance <= maxDistance) candidates.push({ termId, distance });
		}
		candidates.sort((a, b) => a.distance - b.distance || this.df[b.termId] - this.df[a.termId]);
		const out = candidates.slice(0, limit).map((entry) => entry.termId);
		this.fuzzyCache.set(term, out);
		return out;
	}

	/* ---------------------------------------------------------------- */
	/* Persistence and freshness                                         */
	/* ---------------------------------------------------------------- */

	/** Load the persisted index, then reconcile against the filesystem. */
	async load(): Promise<void> {
		const started = performance.now();
		let loaded = false;
		// Binary is preferred whenever it is present and decodable; the JSON path
		// stays as a fallback (hand-edited stores, older versions, corruption).
		const binary = await readFileBufferOrUndefined(this.indexBinaryPath);
		if (binary) {
			if (this.hydrateBinary(binary)) {
				loaded = true;
				this.persistedFormat = "binary";
				this.persistedBytes = binary.length;
			}
		}
		if (!loaded) {
			const raw = await readFileOrUndefined(this.indexFilePath);
			if (raw) {
				try {
					const parsed = JSON.parse(raw) as PersistedIndex;
					if (parsed.version === INDEX_VERSION && parsed.root === this.root && Array.isArray(parsed.docs)) {
						this.hydrate(parsed);
						this.persistedFormat = "json";
						this.persistedBytes = raw.length;
					}
				} catch {
					this.clearDocs();
				}
			}
		}
		this.loadMs = Math.round((performance.now() - started) * 100) / 100;
		await this.refresh(true);
	}

	/**
	 * Encode the index as a binary blob.
	 *
	 * Layout (little-endian): header, docs JSON, term offsets + term bytes,
	 * posting offsets, posting doc indices (uint32) and posting weights
	 * (float32). Postings are the bulk of an index, and this avoids both the
	 * JSON text and the per-number parse cost for large stores.
	 */
	serializeBinary(): Buffer {
		const parsed = this.serialize();
		const docsJson = Buffer.from(JSON.stringify(parsed.docs), "utf8");
		const termCount = parsed.terms.length;
		const termOffsets = Buffer.allocUnsafe((termCount + 1) * 4);
		const encodedTerms: Buffer[] = [];
		let termBytes = 0;
		for (let i = 0; i < termCount; i += 1) {
			termOffsets.writeUInt32LE(termBytes, i * 4);
			const encoded = Buffer.from(parsed.terms[i], "utf8");
			encodedTerms.push(encoded);
			termBytes += encoded.length;
		}
		termOffsets.writeUInt32LE(termBytes, termCount * 4);
		const postingOffsets = Buffer.allocUnsafe((termCount + 1) * 4);
		let postingCount = 0;
		for (let i = 0; i < termCount; i += 1) {
			postingOffsets.writeUInt32LE(postingCount, i * 4);
			postingCount += Math.floor((parsed.postings[i]?.length ?? 0) / 2);
		}
		postingOffsets.writeUInt32LE(postingCount, termCount * 4);
		const postingDocs = Buffer.allocUnsafe(postingCount * 4);
		const postingTfs = Buffer.allocUnsafe(postingCount * 4);
		let at = 0;
		for (let i = 0; i < termCount; i += 1) {
			const posting = parsed.postings[i] ?? [];
			for (let k = 0; k + 1 < posting.length; k += 2) {
				postingDocs.writeUInt32LE(posting[k], at * 4);
				postingTfs.writeFloatLE(posting[k + 1], at * 4);
				at += 1;
			}
		}
		const rootHash = parseInt(shortHash(this.root), 16) >>> 0;
		const header = Buffer.alloc(BINARY_HEADER_BYTES);
		header.writeUInt32LE(BINARY_MAGIC, 0);
		header.writeUInt32LE(INDEX_VERSION, 4);
		header.writeDoubleLE(parsed.builtAt, 8);
		header.writeUInt32LE(parsed.docs.length, 16);
		header.writeUInt32LE(termCount, 20);
		header.writeUInt32LE(postingCount, 24);
		header.writeUInt32LE(docsJson.length, 28);
		header.writeUInt32LE(termBytes, 32);
		header.writeUInt32LE(rootHash, 36);
		header.writeUInt32LE(0, 40);
		header.writeUInt32LE(0, 44);
		return Buffer.concat([header, docsJson, termOffsets, ...encodedTerms, postingOffsets, postingDocs, postingTfs]);
	}

	/** Decode a blob produced by `serializeBinary`. Returns false when invalid. */
	hydrateBinary(buffer: Buffer): boolean {
		try {
			if (buffer.length < BINARY_HEADER_BYTES) return false;
			if (buffer.readUInt32LE(0) !== BINARY_MAGIC) return false;
			if (buffer.readUInt32LE(4) !== INDEX_VERSION) return false;
			if ((buffer.readUInt32LE(36) >>> 0) !== (parseInt(shortHash(this.root), 16) >>> 0)) return false;
			const builtAt = buffer.readDoubleLE(8);
			const docCount = buffer.readUInt32LE(16);
			const termCount = buffer.readUInt32LE(20);
			const postingCount = buffer.readUInt32LE(24);
			const docsJsonBytes = buffer.readUInt32LE(28);
			const termBytes = buffer.readUInt32LE(32);
			const docsStart = BINARY_HEADER_BYTES;
			const termOffsetsStart = docsStart + docsJsonBytes;
			const termBytesStart = termOffsetsStart + (termCount + 1) * 4;
			const postingOffsetsStart = termBytesStart + termBytes;
			const postingDocsStart = postingOffsetsStart + (termCount + 1) * 4;
			const postingTfsStart = postingDocsStart + postingCount * 4;
			if (postingTfsStart + postingCount * 4 !== buffer.length) return false;
			const docs = JSON.parse(buffer.toString("utf8", docsStart, termOffsetsStart)) as PersistedIndex["docs"];
			if (!Array.isArray(docs) || docs.length !== docCount) return false;
			const terms = new Array<string>(termCount);
			for (let i = 0; i < termCount; i += 1) {
				const from = termBytesStart + buffer.readUInt32LE(termOffsetsStart + i * 4);
				const to = termBytesStart + buffer.readUInt32LE(termOffsetsStart + (i + 1) * 4);
				terms[i] = buffer.toString("utf8", from, to);
			}
			const postings = new Array<number[]>(termCount);
			for (let i = 0; i < termCount; i += 1) {
				const from = buffer.readUInt32LE(postingOffsetsStart + i * 4);
				const to = buffer.readUInt32LE(postingOffsetsStart + (i + 1) * 4);
				const list = new Array<number>((to - from) * 2);
				for (let k = from; k < to; k += 1) {
					list[(k - from) * 2] = buffer.readUInt32LE(postingDocsStart + k * 4);
					list[(k - from) * 2 + 1] = buffer.readFloatLE(postingTfsStart + k * 4);
				}
				postings[i] = list;
			}
			this.hydrate({ version: INDEX_VERSION, root: this.root, builtAt, docs, terms, postings });
			return true;
		} catch {
			this.clearDocs();
			return false;
		}
	}

	hydrate(parsed: PersistedIndex): void {
		this.clearDocs();
		this.terms = Array.isArray(parsed.terms) ? parsed.terms : [];
		this.postings = Array.isArray(parsed.postings) ? parsed.postings : [];
		this.docs = Array.isArray(parsed.docs) ? parsed.docs : [];
		// Defensive: fields added after the first release, plus the two derivable
		// fields the serializer strips (`root`/`path` cost ~100 bytes per note).
		for (const doc of this.docs) {
			if (!doc.root) doc.root = this.root;
			if (!doc.path) doc.path = join(this.root, doc.relPath);
			if (!Array.isArray(doc.aliases)) doc.aliases = [];
			if (!Array.isArray(doc.related)) doc.related = [];
			if (!Array.isArray(doc.supersedes)) doc.supersedes = [];
			if (typeof doc.lastUsed !== "number") doc.lastUsed = doc.updated ?? 0;
			if (typeof doc.bodyChars !== "number") doc.bodyChars = doc.preview?.length ?? 0;
		}
		if (this.postings.length !== this.terms.length) {
			// Corrupt or truncated index: fall back to a clean slate.
			this.clearDocs();
			return;
		}
		this.builtAt = parsed.builtAt ?? 0;
		this.docTerms = [];
		this.docTfs = [];
		this.df = new Array(this.terms.length).fill(0);
		this.termIds = new Map();
		for (let i = 0; i < this.terms.length; i += 1) this.termIds.set(this.terms[i], i);
		// Rebuild df + docTerms from postings (single pass over the compact arrays).
		for (let termId = 0; termId < this.postings.length; termId += 1) {
			const posting = this.postings[termId];
			this.df[termId] = posting.length / 2;
		}
		const docCount = this.docs.length;
		this.docTerms = new Array(docCount);
		this.docTfs = new Array(docCount);
		for (let i = 0; i < docCount; i += 1) {
			this.docTerms[i] = [];
			this.docTfs[i] = [];
		}
		for (let termId = 0; termId < this.postings.length; termId += 1) {
			const posting = this.postings[termId];
			for (let i = 0; i + 1 < posting.length; i += 2) {
				const docIdx = posting[i];
				if (docIdx < 0 || docIdx >= docCount) continue;
				this.docTerms[docIdx].push(termId);
				this.docTfs[docIdx].push(posting[i + 1]);
			}
		}
		this.alive = new Array(docCount).fill(true);
		this.idToIdx = new Map();
		this.aliasToIdx = undefined;
		this.relPathToIdx = new Map();
		for (let i = 0; i < docCount; i += 1) {
			this.idToIdx.set(this.docs[i].id, i);
			this.relPathToIdx.set(this.docs[i].relPath, i);
		}
		this.sortedTermIdsCache = undefined;
	}

	/** Serialize the index for persistence, omitting derivable per-doc fields. */
	serialize(): PersistedIndex {
		if (!this.alive.every(Boolean)) this.compact();
		return {
			version: INDEX_VERSION,
			root: this.root,
			builtAt: this.builtAt || Date.now(),
			docs: this.docs.map(leanDoc),
			terms: this.terms,
			// Strip dead postings defensively; compact() already guarantees this.
			postings: this.postings,
		};
	}

	async save(): Promise<number> {
		const format = this.chosenFormat();
		if (format === "binary") {
			const payload = this.serializeBinary();
			await atomicWriteFile(this.indexBinaryPath, payload);
			if (existsSync(this.indexFilePath)) await rm(this.indexFilePath, { force: true }).catch(() => {});
			this.persistedBytes = payload.length;
			this.persistedFormat = "binary";
			return payload.length;
		}
		const json = JSON.stringify(this.serialize());
		await atomicWriteFile(this.indexFilePath, json);
		if (existsSync(this.indexBinaryPath)) await rm(this.indexBinaryPath, { force: true }).catch(() => {});
		this.persistedBytes = json.length;
		this.persistedFormat = "json";
		return json.length;
	}

	/**
	 * Reconcile the in-memory index with the filesystem.
	 * Returns true when anything changed.
	 */
	async refresh(force = false): Promise<boolean> {
		const now = Date.now();
		if (!force && !this.dirty && now - this.lastScanAt < this.scanIntervalMs) return false;
		this.lastScanAt = now;
		this.dirty = false;
		const scanned = await scanLibrary(this.root, this.exclude);
		let changed = false;
		const seen = new Set<string>();
		for (const [relPath, entry] of scanned) {
			seen.add(relPath);
			const existingIdx = this.relPathToIdx.get(relPath) ?? -1;
			if (existingIdx === -1) {
				const doc = await readMemoryDoc(this.root, entry.path);
				if (doc) {
					this.addDoc(doc);
					changed = true;
				}
				continue;
			}
			const existing = this.docs[existingIdx];
			if (existing.mtimeMs !== entry.mtimeMs || existing.size !== entry.size) {
				const doc = await readMemoryDoc(this.root, entry.path);
				this.removeDoc(existingIdx);
				if (doc) this.addDoc(doc);
				changed = true;
			}
		}
		for (let idx = 0; idx < this.docs.length; idx += 1) {
			if (!this.alive[idx]) continue;
			const doc = this.docs[idx];
			if (!isIndexableRelPath(doc.relPath, this.exclude)) continue;
			if (seen.has(doc.relPath)) continue;
			this.removeDoc(idx);
			changed = true;
		}
		if (changed) {
			this.builtAt = Date.now();
			this.fuzzyCache.clear();
		}
		return changed;
	}

	/** Full rebuild from disk. */
	async rebuild(): Promise<number> {
		this.clearDocs();
		const scanned = await scanLibrary(this.root, this.exclude);
		for (const entry of scanned.values()) {
			const doc = await readMemoryDoc(this.root, entry.path);
			if (doc) this.addDoc(doc);
		}
		this.builtAt = Date.now();
		this.dirty = true;
		this.lastScanAt = Date.now();
		await this.save();
		return this.aliveCount;
	}

	/* ---------------------------------------------------------------- */
	/* Search                                                            */
	/* ---------------------------------------------------------------- */

	async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
		const started = performance.now();
		await this.refresh(false);
		const result = this.searchWarm(query, options);
		this.lastSearchMs = Math.round((performance.now() - started) * 100) / 100;
		return result;
	}

	/** Score an index the caller has already refreshed. */
	searchWarm(query: string, options: SearchOptions = {}): SearchResult {
		const started = performance.now();
		const result = searchIndex(this, query, options);
		this.lastSearchMs = Math.round((performance.now() - started) * 100) / 100;
		return result;
	}

	stats(indexBytes = 0): StoreStats {
		const categories: Record<string, number> = {};
		for (let i = 0; i < this.docs.length; i += 1) {
			if (!this.alive[i]) continue;
			const key = this.docs[i].category || "(root)";
			categories[key] = (categories[key] ?? 0) + 1;
		}
		let totalBytes = 0;
		for (let i = 0; i < this.docs.length; i += 1) if (this.alive[i]) totalBytes += this.docs[i].size;
		return {
			root: this.root,
			docs: this.aliveCount,
			categories,
			totalBytes,
			indexBytes,
			indexBuiltAt: this.builtAt,
			indexLoadMs: this.loadMs,
			lastSearchMs: this.lastSearchMs,
			watcherActive: this.watcherActive,
			dirty: this.dirty,
		};
	}

	/** Live doc metadata (skipping tombstones). */
	liveDocs(): Array<{ idx: number; meta: IndexedDocMeta }> {
		const out: Array<{ idx: number; meta: IndexedDocMeta }> = [];
		for (let i = 0; i < this.docs.length; i += 1) {
			if (this.alive[i]) out.push({ idx: i, meta: this.docs[i] });
		}
		return out;
	}

	/** Cheap aggregate metadata (no allocations proportional to library size). */
	overview(recentLimit = 4): IndexOverview {
		const counts = new Map<string, number>();
		let docs = 0;
		const recent: IndexOverview["recent"] = [];
		for (let i = 0; i < this.docs.length; i += 1) {
			if (!this.alive[i]) continue;
			const meta = this.docs[i];
			docs += 1;
			const key = meta.category || "(root)";
			counts.set(key, (counts.get(key) ?? 0) + 1);
			if (recent.length < recentLimit) {
				recent.push({ id: meta.id, title: meta.title, relPath: meta.relPath, created: meta.created });
				recent.sort((a, b) => b.created - a.created);
			} else if (meta.created > recent[recent.length - 1].created) {
				recent[recent.length - 1] = { id: meta.id, title: meta.title, relPath: meta.relPath, created: meta.created };
				recent.sort((a, b) => b.created - a.created);
			}
		}
		return {
			docs,
			categories: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
			recent,
		};
	}

	/** Stop-gap for very large previews. */
	static previewOf(body: string): string {
		return truncateChars(oneLine(body, 400), 400);
	}
}

/** Per-prompt overview used to render the system section without building big arrays. */
export interface IndexOverview {
	docs: number;
	categories: Array<[string, number]>;
	recent: Array<{ id: string; title: string; relPath: string; created: number }>;
}

/** Dense scratch buffers reused across searches to avoid per-query allocation. */
export interface SearchScratch {
	scores: Float64Array;
	coverage: Int32Array;
	mask: Uint32Array;
	touched: Int32Array;
	generation: number;
}

/** Debounced saver bound to an index instance. */
export function createIndexSaver(index: MemoryIndex, delayMs = 400): { schedule: () => void; flush: () => Promise<void> } {
	let pending: Promise<void> | undefined;
	const save = debounce(() => {
		pending = index.save().then(
			() => undefined,
			() => undefined,
		);
	}, delayMs);
	return {
		schedule: () => save(),
		flush: async () => {
			save.flush();
			while (pending) {
				const current = pending;
				pending = undefined;
				await current;
			}
			await index.save().catch(() => {});
		},
	};
}
