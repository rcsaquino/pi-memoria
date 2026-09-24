/**
 * Similarity heuristics used for housekeeping:
 *
 * - `suggestMerges`: pairs of notes that look like the same subject filed twice
 *   ("dietary preferences" vs "food preferences", or a person's note and their
 *   legacy relation note).
 * - `detectContradictions`: fact units that say the same thing with opposite
 *   polarity ("deploys on Thursday" vs "no longer deploys on Thursday").
 *
 * Both are deliberately conservative: a false positive wastes a sentence of the
 * agent's attention, but a merge that folds two subjects together is worse than
 * a missed hint, so the thresholds err on the side of silence.
 */

import type { Contradiction, MergeSuggestion } from "./types.ts";

/** Enough information to compare two notes. */
export interface SimilarityDoc {
	id: string;
	title: string;
	relPath: string;
	category: string;
	/** Alternative names the subject goes by (nicknames, relations, former names). */
	aliases?: string[];
	/** Weighted term frequencies (title + body), as stored in the index. */
	tokens: Record<string, number>;
	priority?: number;
}

/** One fact unit extracted from a note body. */
export interface FactUnitLike {
	id: string;
	relPath: string;
	label?: string;
	text: string;
}

/** Words that flip the meaning of a fact. */
const NEGATION_WORDS = new Set([
	"not",
	"no",
	"never",
	"none",
	"without",
	"dont",
	"don't",
	"doesnt",
	"doesn't",
	"isnt",
	"isn't",
	"wasnt",
	"wasn't",
	"arent",
	"aren't",
	"wont",
	"won't",
	"cant",
	"can't",
	"avoid",
	"avoids",
	"avoided",
	"dislike",
	"dislikes",
	"disliked",
	"stopped",
	"stop",
	"removed",
	"removed",
	"deprecated",
	"cancelled",
	"canceled",
	"rejected",
	"denied",
	"never",
	"no-longer",
	"longer",
	"instead",
	"except",
	"unlike",
	"neither",
	"nor",
	"rather",
]);

/** True when a fact carries negation or a reversal. */
export function hasNegation(text: string): boolean {
	for (const token of text.toLowerCase().split(/[^a-z0-9']+/)) {
		if (!token) continue;
		if (NEGATION_WORDS.has(token)) return true;
	}
	return false;
}

/** Tokens that carry meaning for similarity (no negations, no one-letter noise). */
export function contentTokens(tokens: Iterable<string>): string[] {
	const out: string[] = [];
	for (const token of tokens) {
		if (token.length < 3) continue;
		if (NEGATION_WORDS.has(token)) continue;
		out.push(token);
	}
	return out;
}

/** Cosine similarity of two weighted term vectors. Returns 0..1. */
export function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
	const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
	let dot = 0;
	for (const [term, weight] of Object.entries(small)) {
		const other = large[term];
		if (other !== undefined) dot += weight * other;
	}
	if (dot === 0) return 0;
	const norm = (vector: Record<string, number>): number => {
		let sum = 0;
		for (const weight of Object.values(vector)) sum += weight * weight;
		return Math.sqrt(sum);
	};
	const denominator = norm(a) * norm(b);
	return denominator === 0 ? 0 : dot / denominator;
}

/** Jaccard similarity of two token sets. Returns 0..1. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / (left.size + right.size - shared);
}

export interface MergeOptions {
	/** Minimum containment score to report a pair. */
	threshold?: number;
	/** Minimum number of shared distinctive terms. */
	minShared?: number;
	/** Maximum number of pairs returned. */
	limit?: number;
	/** Terms present in more than this fraction of notes are not distinctive. */
	maxDocumentRatio?: number;
	/** Buckets larger than this are skipped (a term that is not distinctive in practice). */
	maxBucketSize?: number;
}

/** Terms that carry identity for similarity purposes. */
export function isComparableTerm(term: string): boolean {
	if (term.length < 4) return false;
	// Note ids are indexed so links are searchable; they must not make two
	// linked notes look like the same subject.
	if (term.startsWith("mem_")) return false;
	if (/^[0-9]+$/.test(term)) return false;
	return true;
}

/** IDF weights from a document-frequency table. */
export function makeIdf(df: Map<string, number>, docCount: number): (term: string) => number {
	return (term: string) => Math.log(1 + docCount / (1 + (df.get(term) ?? 1))) + 0.5;
}

/** Slug used for name comparison: apostrophes join, everything else splits. */
function nameSlug(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/['\u2019\u02bc]+/g, "")
		.replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** True when `shorter` is a strict leading or trailing run of `longer`. */
function isRunOf(shorter: string[], longer: string[]): boolean {
	if (shorter.length === 0 || shorter.length >= longer.length) return false;
	const prefix = shorter.every((token, index) => longer[index] === token);
	if (prefix) return true;
	const offset = longer.length - shorter.length;
	return shorter.every((token, index) => longer[offset + index] === token);
}

/**
 * True when two notes are plausibly about the same subject *by their names*:
 * equal slugs, or one name being a prefix/suffix of the other
 * ("Alice" vs "Alice Smith", "Project Nightingale" vs "Nightingale").
 *
 * Shared individual words are deliberately not enough: "John Doe" and "John
 * Doe's father" share tokens but are two different people, and merging them
 * would be worse than missing a duplicate.
 */
export function namesLinked(a: SimilarityDoc, b: SimilarityDoc): boolean {
	const names = (doc: SimilarityDoc): string[] => [doc.title, ...(doc.aliases ?? [])].map(nameSlug).filter((name) => name.length >= 3);
	const left = names(a);
	const right = names(b);
	for (const x of left) {
		const tx = x.split("-").filter(Boolean);
		for (const y of right) {
			if (x === y) return true;
			const ty = y.split("-").filter(Boolean);
			if (isRunOf(tx, ty) || isRunOf(ty, tx)) return true;
		}
	}
	return false;
}

export interface PairSimilarity {
	/** IDF-weighted containment of the smaller note's vocabulary in the other. */
	score: number;
	/** Distinctive terms the two notes share. */
	shared: string[];
	/** True when the titles/aliases point at the same subject. */
	linked: boolean;
	/**
	 * True when the pair is worth reporting as a possible duplicate. A name link
	 * lowers the bar; without one, the notes must be near-identical.
	 */
	duplicate: boolean;
}

/**
 * Compare two notes.
 *
 * Score is IDF-weighted *containment*: how much of the smaller note's
 * distinctive vocabulary also appears in the other note. Two notes about one
 * person (a legacy "John's father" note and a newer "Bob" note) share the entity
 * and its facts, so nearly all of the smaller note is contained in the larger
 * one. Ordinary notes that merely mention a common word score low.
 */
export function compareDocs(a: SimilarityDoc, b: SimilarityDoc, idfOf: (term: string) => number, options: { threshold?: number; minShared?: number } = {}): PairSimilarity {
	const threshold = options.threshold ?? 0.62;
	// A name link relaxes the shared-term requirement; without one the bar is
	// intentionally much higher (see `duplicate` below).
	const minShared = options.minShared ?? 1;
	const termsOf = (doc: SimilarityDoc): string[] => Object.keys(doc.tokens).filter(isComparableTerm);
	const left = termsOf(a);
	const right = termsOf(b);
	const rightSet = new Set(right);
	const shared = left.filter((term) => rightSet.has(term));
	const massOf = (terms: string[]): number => terms.reduce((sum, term) => sum + idfOf(term), 0);
	const leftMass = massOf(left);
	const rightMass = massOf(right);
	const sharedMass = massOf(shared);
	const smallerMass = Math.min(leftMass, rightMass);
	const score = smallerMass === 0 ? 0 : sharedMass / smallerMass;
	const linked = namesLinked(a, b);
	// Without a name link, a shared paragraph is not enough: a person's note
	// routinely mentions their employer, family and projects. Require the notes
	// to be near-identical instead.
	const duplicate = linked
		? score >= threshold && shared.length >= minShared
		: score >= 0.9 && shared.length >= Math.max(5, minShared);
	return { score, shared, linked, duplicate };
}

/**
 * Find note pairs that look like the same subject.
 *
 * Pairs are generated only from shared distinctive terms, so the cost is
 * proportional to real overlap instead of the quadratic number of pairs.
 */
export function suggestMerges(docs: SimilarityDoc[], options: MergeOptions = {}): MergeSuggestion[] {
	const threshold = options.threshold ?? 0.62;
	const limit = options.limit ?? 20;
	const maxDocumentRatio = options.maxDocumentRatio ?? 0.2;
	const maxBucketSize = options.maxBucketSize ?? 40;
	if (docs.length < 2) return [];

	const n = docs.length;
	const df = new Map<string, number>();
	const buckets = new Map<string, number[]>();
	for (let i = 0; i < n; i += 1) {
		for (const term of Object.keys(docs[i].tokens)) {
			if (!isComparableTerm(term)) continue;
			df.set(term, (df.get(term) ?? 0) + 1);
			const bucket = buckets.get(term);
			if (bucket) bucket.push(i);
			else buckets.set(term, [i]);
		}
	}
	const idfOf = makeIdf(df, n);
	const maxDf = Math.max(2, Math.ceil(n * maxDocumentRatio));

	const pairs = new Map<string, { a: number; b: number }>();
	for (const [term, members] of buckets) {
		if (members.length < 2 || members.length > maxBucketSize) continue;
		if ((df.get(term) ?? 0) > maxDf) continue;
		for (let x = 0; x < members.length; x += 1) {
			for (let y = x + 1; y < members.length; y += 1) {
				const a = members[x];
				const b = members[y];
				if (docs[a].category !== docs[b].category) continue;
				const key = a < b ? `${a}:${b}` : `${b}:${a}`;
				if (!pairs.has(key)) pairs.set(key, { a, b });
			}
		}
	}

	const suggestions: MergeSuggestion[] = [];
	for (const { a, b } of pairs.values()) {
		const similarity = compareDocs(docs[a], docs[b], idfOf, { threshold });
		if (!similarity.duplicate) continue;
		suggestions.push({
			a: { id: docs[a].id, title: docs[a].title, relPath: docs[a].relPath, category: docs[a].category },
			b: { id: docs[b].id, title: docs[b].title, relPath: docs[b].relPath, category: docs[b].category },
			score: Math.round(similarity.score * 1000) / 1000,
			shared: [...new Set(similarity.shared)].sort().slice(0, 8),
			category: docs[a].category,
		});
	}
	suggestions.sort((x, y) => y.score - x.score);
	return suggestions.slice(0, limit);
}

/** Suggestions involving one specific note id. */
export function mergesFor(suggestions: MergeSuggestion[], id: string): MergeSuggestion[] {
	return suggestions.filter((suggestion) => suggestion.a.id === id || suggestion.b.id === id);
}

export interface ContradictionOptions {
	/** Minimum Jaccard similarity of content tokens. */
	threshold?: number;
	/** Minimum shared content tokens. */
	minShared?: number;
	limit?: number;
}

/**
 * Find fact units that share enough wording to be about the same thing but
 * disagree on polarity, e.g. "Deploys happen on Thursdays" and "Deploys no
 * longer happen on Thursdays".
 */
export function detectContradictions(units: FactUnitLike[], options: ContradictionOptions = {}): Contradiction[] {
	const threshold = options.threshold ?? 0.5;
	const minShared = options.minShared ?? 2;
	const limit = options.limit ?? 20;
	const parsed = units
		.map((unit) => ({ unit, tokens: contentTokens(unit.text.toLowerCase().split(/[^a-z0-9']+/)), negated: hasNegation(unit.text) }))
		.filter((entry) => entry.tokens.length >= 3);
	// Bucket by content token so only plausible pairs are compared.
	const buckets = new Map<string, number[]>();
	parsed.forEach((entry, index) => {
		for (const token of new Set(entry.tokens)) {
			const bucket = buckets.get(token);
			if (bucket) bucket.push(index);
			else buckets.set(token, [index]);
		}
	});
	const seen = new Set<string>();
	const out: Contradiction[] = [];
	for (const members of buckets.values()) {
		if (members.length < 2 || members.length > 60) continue;
		for (let x = 0; x < members.length; x += 1) {
			for (let y = x + 1; y < members.length; y += 1) {
				const left = parsed[members[x]];
				const right = parsed[members[y]];
				if (left.negated === right.negated) continue;
				if (left.unit.id === right.unit.id && left.unit.text === right.unit.text) continue;
				const key = members[x] < members[y] ? `${members[x]}:${members[y]}` : `${members[y]}:${members[x]}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const shared = left.tokens.filter((token) => right.tokens.includes(token));
				if (shared.length < minShared) continue;
				if (jaccard(left.tokens, right.tokens) < threshold) continue;
				out.push({
					a: { id: left.unit.id, relPath: left.unit.relPath, text: left.unit.text },
					b: { id: right.unit.id, relPath: right.unit.relPath, text: right.unit.text },
					shared: [...new Set(shared)].slice(0, 6),
					reason: "one side is negated and the wording otherwise matches; confirm which is current",
				});
			}
		}
	}
	out.sort((a, b) => b.shared.length - a.shared.length);
	return out.slice(0, limit);
}
