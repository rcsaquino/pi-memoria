/**
 * BM25 search over a MemoryIndex.
 *
 * The search path is fully in-memory: posting lists are sorted by document index
 * and scoring never touches the filesystem. Only snippet extraction for the
 * final hits may read a body, and those are cached.
 */

import { tokenize, tokenizeRaw, stem, isCjkChar } from "./tokenize.ts";
import { truncateChars } from "./util.ts";
import { priorityRank } from "./store.ts";
import { parseTimeExpression } from "./timeexpr.ts";
import { synonymsFor } from "./synonyms.ts";
import type { MemoryIndex } from "./index-engine.ts";
import type { Priority, QueryTerm, ScoreBreakdown, SearchHit, SearchOptions, SearchResult } from "./types.ts";

const K1 = 1.2;
const B = 0.75;
const MAX_QUERY_TERMS = 28;
const MAX_CANDIDATES = 2500;
const MAX_POSTINGS_SCANNED = 300_000;
const PREFIX_LIMIT = 12;
const FUZZY_LIMIT = 5;
const EXACT_SCAN_LIMIT = 64;

const PRIORITY_BOOST: Record<Priority, number> = { low: 0, normal: 0.2, high: 0.9, critical: 2.0 };
/** Boost for notes updated inside a time window parsed from the query. */
const TIME_WINDOW_BOOST = 1.5;
/** How much of its source's score a note pulled in through `related` keeps. */
const RELATED_SOURCE_LIMIT = 3;
/** A superseded note is demoted, not hidden: history stays searchable. */
const SUPERSEDED_FACTOR = 0.35;

interface Candidate {
	idx: number;
	score: number;
	/** Bitmask of matched query-term positions. */
	mask: number;
	/** Set when the candidate was pulled in through another note's `related`. */
	relatedTo?: string;
}

export interface AnalyzeOptions {
	/** Query-side synonym table. */
	synonyms?: Record<string, string[]>;
	/** Multiplier applied to synonym-expanded terms. */
	synonymWeight?: number;
	/** Weighted query segments; when present, `query` is only used for phrases. */
	parts?: Array<{ text: string; weight: number }>;
}

/**
 * Build weighted query terms, rarest first.
 *
 * When `parts` is supplied (the current prompt plus weighted previous turns) the
 * strongest weight per term wins, so a term from the current prompt outranks the
 * same term merely mentioned a turn ago. Synonyms from the store's table are
 * added at `synonymWeight` of the term they expand.
 */
export function analyzeQuery(index: MemoryIndex, query: string, options: AnalyzeOptions = {}): QueryTerm[] {
	const weights = new Map<string, number>();
	const addText = (text: string, partWeight: number): void => {
		const surfaceSet = new Set(tokenizeRaw(text));
		for (const token of tokenize(text)) {
			const weight = (surfaceSet.has(token) ? 1 : 0.85) * partWeight;
			weights.set(token, Math.max(weights.get(token) ?? 0, weight));
		}
	};
	if (options.parts && options.parts.length > 0) {
		for (const part of options.parts) addText(part.text, part.weight);
	} else {
		addText(query, 1);
	}
	const table = options.synonyms;
	if (table && Object.keys(table).length > 0) {
		const synonymWeight = options.synonymWeight ?? 0.6;
		for (const [term, weight] of [...weights.entries()]) {
			for (const synonym of synonymsFor(table, term)) {
				let tokens = tokenize(synonym);
				if (tokens.length === 0 && synonym.trim()) tokens = [synonym.trim().toLowerCase()];
				for (const token of tokens) weights.set(token, Math.max(weights.get(token) ?? 0, weight * synonymWeight));
			}
		}
	}
	const n = Math.max(1, index.aliveCount);
	const terms: QueryTerm[] = [];
	for (const [term, weight] of weights) {
		const termId = index.termId(term);
		const df = termId >= 0 ? index.documentFrequency(termId) : 0;
		const idf = df > 0 ? Math.log(1 + (n - df + 0.5) / (df + 0.5)) : Math.log(1 + n + 0.5);
		terms.push({
			term,
			weight,
			termId: df > 0 ? termId : -1,
			idf,
			specific: /[._/\-]|\d/.test(term) || (stem(term) !== term && term.length > 5),
		});
	}
	terms.sort((a, b) => b.idf - a.idf || b.weight - a.weight);
	if (terms.length <= MAX_QUERY_TERMS) return terms;
	const head = terms.slice(0, MAX_QUERY_TERMS);
	const specificExtras = terms.slice(MAX_QUERY_TERMS).filter((term) => term.specific).slice(0, 8);
	return [...head, ...specificExtras];
}

function normalizeForMatch(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Extract a query-focused excerpt from a body. */
export function extractSnippet(body: string, terms: string[], maxChars: number): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (!flat) return "";
	if (flat.length <= maxChars) return flat;
	const haystack = flat.toLowerCase();
	const needles = terms
		.map((term) => term.toLowerCase())
		.filter((term) => term.length >= 2 && !isCjkChar(term[0]))
		.slice(0, 10);
	const positions: Array<{ index: number; term: string }> = [];
	for (const needle of needles) {
		let from = 0;
		for (let found = 0; found < 6; found += 1) {
			const at = haystack.indexOf(needle, from);
			if (at === -1) break;
			positions.push({ index: at, term: needle });
			from = at + needle.length;
		}
	}
	if (positions.length === 0) {
		return `${flat.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
	}
	const half = Math.floor(maxChars / 2);
	let bestStart = 0;
	let bestScore = -1;
	for (const position of positions) {
		const start = Math.max(0, position.index - half);
		const end = Math.min(flat.length, start + maxChars);
		const windowText = haystack.slice(start, end);
		let score = 0;
		for (const needle of needles) if (windowText.includes(needle)) score += 1;
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	let start = bestStart;
	if (start > 0) {
		const space = flat.indexOf(" ", start);
		if (space !== -1 && space - start < 24) start = space + 1;
	}
	let snippet = flat.slice(start, Math.min(flat.length, start + maxChars)).trim();
	if (start > 0) snippet = `…${snippet}`;
	if (start + maxChars < flat.length) snippet = `${snippet.replace(/[,;:.\s]+$/, "")}…`;
	return snippet;
}

function baseScore(doc: MemoryIndex["docs"][number], now: number): number {
	const priority = PRIORITY_BOOST[doc.priority] ?? 0.2;
	const ageDays = Math.max(0, (now - (doc.updated || doc.created)) / 86_400_000);
	return priority + 0.35 * Math.exp(-ageDays / 180);
}

function matchesCategory(docCategory: string, filter: string): boolean {
	if (filter.endsWith("/*")) return docCategory === filter.slice(0, -2) || docCategory.startsWith(filter.slice(0, -1));
	return docCategory === filter;
}

function passesFilters(doc: MemoryIndex["docs"][number], options: SearchOptions, keepUnfiled: boolean): boolean {
	if (options.root && doc.root !== options.root) return false;
	if (!keepUnfiled && doc.unfiled) return false;
	if (options.category && !matchesCategory(doc.category, options.category)) return false;
	if (options.minPriority && priorityRank(doc.priority) < priorityRank(options.minPriority)) return false;
	if (options.since && doc.updated < options.since) return false;
	if (options.tags && options.tags.length > 0) {
		for (const tag of options.tags) if (!doc.tags.includes(tag)) return false;
	}
	if (options.anyTags && options.anyTags.length > 0) {
		if (!options.anyTags.some((tag) => doc.tags.includes(tag))) return false;
	}
	return true;
}

/** Decode a query-term bitmask back into term labels (best first). */
function maskToTerms(mask: number, queryTerms: QueryTerm[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < queryTerms.length && i < 31; i += 1) {
		if (mask & (1 << i)) out.push(queryTerms[i].term);
	}
	return out;
}

/** Run a search against a warm index. Pure and synchronous. */
export function searchIndex(index: MemoryIndex, query: string, options: SearchOptions = {}): SearchResult {
	const started = performance.now();
	const limit = Math.max(1, Math.min(100, options.limit ?? 8));
	const usePrefix = options.prefix !== false;
	const useFuzzy = options.fuzzy !== false;
	const minScore = options.minScore ?? 0;
	const keepUnfiled = options.includeUnfiled !== false;
	const avgDocLength = index.avgDocLength;
	const n = Math.max(1, index.aliveCount);
	const queryTerms = analyzeQuery(index, query, {
		synonyms: options.synonyms,
		synonymWeight: options.synonymWeight,
		parts: options.parts,
	});
	const timeWindow = options.timeHints === false ? undefined : parseTimeExpression(query);
	if (timeWindow) options.onTimeWindow?.(timeWindow);
	const inWindow = (doc: MemoryIndex["docs"][number]): boolean => {
		if (!timeWindow) return false;
		if (timeWindow.since !== undefined && doc.updated < timeWindow.since) return false;
		if (timeWindow.until !== undefined && doc.updated >= timeWindow.until) return false;
		return true;
	};

	// Filter-only browse mode: no usable query terms (e.g. all stopwords) but
	// filters were supplied. Return the newest/highest-priority matches.
	if (queryTerms.length === 0) {
		const now = Date.now();
		const candidates: Candidate[] = [];
		for (let idx = 0; idx < index.docs.length; idx += 1) {
			if (!index.alive[idx]) continue;
			const doc = index.docs[idx];
			if (!passesFilters(doc, options, keepUnfiled)) continue;
			candidates.push({ idx, score: baseScore(doc, now), mask: 0 });
		}
		candidates.sort((a, b) => b.score - a.score);
		const browseHits: SearchHit[] = candidates.slice(0, limit).map((candidate) => {
			const doc = index.docs[candidate.idx];
			return {
				doc,
				score: Math.round(candidate.score * 1000) / 1000,
				matched: [],
				snippet: truncateChars(doc.preview, 280),
				exact: false,
			};
		});
		return {
			hits: browseHits,
			total: candidates.length,
			tookMs: Math.round((performance.now() - started) * 1000) / 1000,
			truncated: candidates.length > limit,
			missing: [],
			timeWindow,
		};
	}

	const scratch = index.searchScratch();
	const scoreBuf = scratch.scores;
	const coverageBuf = scratch.coverage;
	const maskBuf = scratch.mask;
	const touched = scratch.touched;
	let touchedCount = 0;
	const missing: string[] = [];
	let scanned = 0;
	let truncated = false;

	const postings = index.postings;
	const docMetas = index.docs;
	const alive = index.alive;
	const dfTable = index.df;
	const k1Scale = K1 * (1 - B);
	const bScale = K1 * B;

	const addTerm = (termId: number, weight: number, idf: number, termIndex: number): number => {
		if (termId < 0) return 0;
		const posting = postings[termId];
		const df = dfTable[termId] ?? 0;
		if (df <= 0 || posting.length === 0) return 0;
		const effectiveIdf = idf > 0 ? idf : Math.log(1 + (n - df + 0.5) / (df + 0.5));
		const bit = termIndex < 31 ? 1 << termIndex : 0;
		let added = 0;
		for (let i = 0; i + 1 < posting.length; i += 2) {
			const docIdx = posting[i];
			if (alive[docIdx] !== true) continue;
			const tf = posting[i + 1];
			if (scoreBuf[docIdx] === 0) touched[touchedCount++] = docIdx;
			// Inlined BM25: idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
			scoreBuf[docIdx] += (effectiveIdf * (tf * (K1 + 1)) * weight) / (tf + k1Scale + (bScale * docMetas[docIdx].tokenCount) / avgDocLength);
			coverageBuf[docIdx] += 1;
			maskBuf[docIdx] |= bit;
			added += 1;
			scanned += 1;
		}
		return added;
	};

	for (let termIndex = 0; termIndex < queryTerms.length; termIndex += 1) {
		const queryTerm = queryTerms[termIndex];
		if (scanned > MAX_POSTINGS_SCANNED) {
			truncated = true;
			break;
		}
		let added = 0;
		if (queryTerm.termId >= 0) {
			added += addTerm(queryTerm.termId, queryTerm.weight, queryTerm.idf, termIndex);
		}
		if (added === 0 && usePrefix && queryTerm.term.length >= 3) {
			for (const termId of index.prefixMatches(queryTerm.term, PREFIX_LIMIT)) {
				const extra = index.terms[termId].length - queryTerm.term.length;
				const weight = queryTerm.weight * (0.55 / (1 + Math.max(0, extra)));
				added += addTerm(termId, weight, 0, termIndex);
			}
		}
		if (added === 0 && useFuzzy && queryTerm.term.length >= 4) {
			const maxDistance = queryTerm.term.length >= 8 ? 2 : 1;
			for (const termId of index.fuzzyMatches(queryTerm.term, maxDistance, FUZZY_LIMIT)) {
				added += addTerm(termId, queryTerm.weight * 0.35, 0, termIndex);
			}
		}
		if (added === 0) missing.push(queryTerm.term);
	}

	/** Reset the shared scratch buffers so the next search starts clean. */
	const releaseScratch = () => {
		for (let i = 0; i < touchedCount; i += 1) {
			const idx = touched[i];
			scoreBuf[idx] = 0;
			coverageBuf[idx] = 0;
			maskBuf[idx] = 0;
		}
	};

	const now = Date.now();
	const candidates: Candidate[] = [];
	for (let t = 0; t < touchedCount; t += 1) {
		const idx = touched[t];
		const doc = index.docs[idx];
		if (!passesFilters(doc, options, keepUnfiled)) continue;
		candidates.push({
			idx,
			score: scoreBuf[idx] + coverageBuf[idx] * 0.6 + baseScore(doc, now) + (inWindow(doc) ? TIME_WINDOW_BOOST : 0),
			mask: maskBuf[idx],
		});
	}
	releaseScratch();
	candidates.sort((a, b) => b.score - a.score);
	const capped = candidates.length > MAX_CANDIDATES;
	if (capped) truncated = true;
	const trimmed = candidates.length > MAX_CANDIDATES ? candidates.slice(0, MAX_CANDIDATES) : candidates;

	// Exact-phrase bonuses need the body; only pay for the strongest candidates.
	const normalizedQuery = normalizeForMatch(query);
	const phraseEligible = normalizedQuery.length >= 3;
	if (phraseEligible) {
		for (const candidate of trimmed.slice(0, EXACT_SCAN_LIMIT)) {
			const doc = index.docs[candidate.idx];
			if (doc.title.toLowerCase().includes(normalizedQuery)) candidate.score += 6;
			else if (doc.summary.toLowerCase().includes(normalizedQuery)) candidate.score += 2;
			if (index.bodyOrPreview(candidate.idx).toLowerCase().includes(normalizedQuery)) candidate.score += 3;
		}
		trimmed.sort((a, b) => b.score - a.score);
	}

	const hits: SearchHit[] = [];
	const claimed = new Set<number>();
	for (const candidate of trimmed) {
		if (hits.length >= limit) break;
		if (candidate.score < minScore) continue;
		const doc = index.docs[candidate.idx];
		const body = index.bodyOrPreview(candidate.idx);
		claimed.add(candidate.idx);
		hits.push({
			doc,
			score: candidate.score,
			matched: maskToTerms(candidate.mask, queryTerms),
			snippet: extractSnippet(body, queryTerms.slice(0, 10).map((term) => term.term), options.limit === 1 ? 600 : (options.snippetChars ?? 280)),
			exact: phraseEligible && normalizeForMatch(`${doc.title}\n${body}`).includes(normalizedQuery),
			...(candidate.relatedTo ? { relatedTo: candidate.relatedTo } : {}),
		});
	}

	// Related notes: a note that says "see Bob" should surface Bob too, even if
	// his note does not contain the query words. Pulled in after ranking so the
	// link never displaces a direct match.
	const relatedLimit = options.expandRelated === false ? 0 : Math.max(0, options.relatedHits ?? 3);
	if (relatedLimit > 0 && hits.length > 0) {
		const budget = relatedLimit;
		let added = 0;
		for (const hit of hits.slice(0, RELATED_SOURCE_LIMIT)) {
			if (added >= budget) break;
			const sourceIdx = index.idxForId(hit.doc.id);
			if (sourceIdx === undefined) continue;
			for (const targetIdx of index.relatedDocs(sourceIdx)) {
				if (added >= budget) break;
				if (claimed.has(targetIdx)) continue;
				const target = index.docs[targetIdx];
				claimed.add(targetIdx);
				added += 1;
				hits.push({
					doc: target,
					score: hit.score * (options.relatedBoost ?? 0.35),
					matched: [],
					snippet: extractSnippet(index.bodyOrPreview(targetIdx), queryTerms.slice(0, 10).map((term) => term.term), 280),
					exact: false,
					relatedTo: hit.doc.id,
				});
			}
		}
	}

	// Superseded notes are demoted (or dropped on request) but never hidden by
	// default: the old decision stays searchable next to the one that replaced it.
	const supersedeMap = index.supersedeMap();
	if (supersedeMap.size > 0) {
		for (const hit of hits) {
			const supersededBy = supersedeMap.get(hit.doc.id);
			if (!supersededBy || supersededBy.length === 0) continue;
			hit.supersededBy = supersededBy;
			hit.score *= SUPERSEDED_FACTOR;
		}
		if (options.dropSuperseded) {
			for (let i = hits.length - 1; i >= 0; i -= 1) if (hits[i].supersededBy) hits.splice(i, 1);
		}
	}

	hits.sort((a, b) => b.score - a.score);
	if (hits.length > limit) hits.length = limit;
	for (const hit of hits) hit.score = Math.round(hit.score * 1000) / 1000;

	if (options.explain) {
		for (const hit of hits) {
			const idx = index.idxForId(hit.doc.id);
			if (idx === undefined) continue;
			hit.breakdown = explainHit(index, idx, queryTerms, {
				phrase: hit.exact ? 1 : 0,
				related: hit.relatedTo ? 1 : 0,
				supersededPenalty: hit.supersededBy ? 1 - SUPERSEDED_FACTOR : 0,
				timeBoost: inWindow(index.docs[idx]) ? TIME_WINDOW_BOOST : 0,
			});
		}
	}

	return {
		hits,
		total: candidates.length,
		tookMs: Math.round((performance.now() - started) * 1000) / 1000,
		truncated,
		missing: [...new Set(missing)].slice(0, 8),
		timeWindow,
	};
}

/**
 * Attribute a hit's score to its components and terms.
 *
 * Only runs with `explain: true`, and only for the returned hits, so it may
 * afford a binary search per query term per hit.
 */
export function explainHit(
	index: MemoryIndex,
	idx: number,
	queryTerms: QueryTerm[],
	extra: { phrase: number; related: number; supersededPenalty: number; timeBoost: number },
): ScoreBreakdown {
	const doc = index.docs[idx];
	const avgDocLength = index.avgDocLength;
	const k1Scale = K1 * (1 - B);
	const bScale = K1 * B;
	const n = Math.max(1, index.aliveCount);
	let bm25 = 0;
	const terms: ScoreBreakdown["terms"] = [];
	for (const queryTerm of queryTerms) {
		let contribution = 0;
		let matches = 0;
		if (queryTerm.termId >= 0) {
			const tf = index.postingTfFor(queryTerm.termId, idx);
			if (tf > 0) {
				const df = index.documentFrequency(queryTerm.termId);
				const idf = df > 0 ? Math.log(1 + (n - df + 0.5) / (df + 0.5)) : queryTerm.idf;
				contribution = (idf * (tf * (K1 + 1)) * queryTerm.weight) / (tf + k1Scale + (bScale * doc.tokenCount) / avgDocLength);
				matches = 1;
			}
		}
		if (contribution > 0) {
			bm25 += contribution;
			terms.push({ term: queryTerm.term, matches, contribution: Math.round(contribution * 1000) / 1000 });
		}
	}
	terms.sort((a, b) => b.contribution - a.contribution);
	const coverageTerms = queryTerms.filter((queryTerm) => queryTerm.termId >= 0 && index.postingTfFor(queryTerm.termId, idx) > 0).length;
	const coverage = coverageTerms * 0.6;
	const priorityRecency = baseScore(doc, Date.now());
	const phrase = extra.phrase > 0 ? 3 : 0;
	const related = extra.related > 0 ? 1 : 0;
	const supersededPenalty = extra.supersededPenalty > 0 ? -(1 - SUPERSEDED_FACTOR) : 0;
	return {
		bm25: Math.round(bm25 * 1000) / 1000,
		coverage: Math.round(coverage * 1000) / 1000,
		priorityRecency: Math.round(priorityRecency * 1000) / 1000,
		phrase,
		related,
		supersededPenalty: Math.round(supersededPenalty * 1000) / 1000,
		timeBoost: extra.timeBoost,
		total: Math.round((bm25 + coverage + priorityRecency + phrase + related + supersededPenalty + extra.timeBoost) * 1000) / 1000,
		terms: terms.slice(0, 12),
	};
}
