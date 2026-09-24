/**
 * Tokenizer for memoria.
 *
 * Design goals:
 * - Exact recall for identifiers, paths, versions and error codes.
 * - Tolerance for plural/verb/derivational variants via a conservative stemmer.
 * - CJK support via unigrams + bigrams.
 * - Zero dependencies and fast enough to re-index thousands of notes per second.
 *
 * Both the raw token and its stem are emitted, so exact matches always outrank
 * stemmed coincidences.
 */

export interface TokenizeOptions {
	/** Drop common English stopwords. Default true. */
	stopwords?: boolean;
	/** Emit stemmed variants. Default true. */
	stem?: boolean;
	/** Minimum length for latin tokens. Default 2. */
	minLength?: number;
	/** Hard cap on emitted unique tokens. Default 6000. */
	maxTokens?: number;
}

const STOPWORDS = new Set(
	`a about above after again against all also am an and any are aren't as at be because been before being below between both but by can cannot can't could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how i if in into is isn't it its itself just let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such than that the their theirs them themselves then there these they this those through to too under until up very was wasn't we were weren't what when where which while who whom why with won't would wouldn't you your yours yourself yourselves`.split(
		/\s+/,
	),
);

const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const IDENT_CHAR_RE = /[\p{L}\p{N}_]/u;
const IDENT_SEPARATOR_RE = /[._/\\-]/;
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const HANGUL_RE = /[\uac00-\ud7af]/;

type CjkClass = "han" | "kana" | "hangul";

function cjkClass(ch: string): CjkClass | undefined {
	if (HAN_RE.test(ch)) return "han";
	if (HANGUL_RE.test(ch)) return "hangul";
	if (CJK_CHAR_RE.test(ch)) return "kana";
	return undefined;
}

export function isCjkChar(ch: string): boolean {
	return CJK_CHAR_RE.test(ch);
}

/** Light, targeted stemmer. Conservative on purpose: false merges hurt precision. */
export function stem(token: string): string {
	let t = token;
	if (t.length < 4) return t;
	const rules: Array<[RegExp, string]> = [
		[/sses$/, "ss"],
		[/ies$/, "y"],
		[/izations?$/, "iz"],
		[/isations?$/, "is"],
		[/izing$/, "iz"],
		[/ized$/, "iz"],
		[/izes$/, "iz"],
		[/ize$/, "iz"],
		[/ising$/, "is"],
		[/ised$/, "is"],
		[/ises$/, "is"],
		[/ise$/, "is"],
		[/ments?$/, "ment"],
		[/nesses$/, "ness"],
		[/ness$/, "ness"],
		[/ingly$/, ""],
		[/edly$/, ""],
		[/ing$/, ""],
		[/ed$/, ""],
		[/ly$/, ""],
		[/s$/, ""],
	];
	for (const [pattern, replacement] of rules) {
		if (!pattern.test(t)) continue;
		if (pattern.source === "s$" && /(ss|us|is|as|os)$/.test(t)) continue;
		const candidate = t.replace(pattern, replacement);
		if (candidate.length < 3) continue;
		// Undo a doubled final consonant produced by dropping a suffix: runn -> run.
		t = /([bdfgmnprt])\1$/.test(candidate) ? candidate.slice(0, -1) : candidate;
		break;
	}
	return t;
}

function splitCamelAndCase(word: string): string[] {
	if (!/[A-Z]/.test(word)) return [word];
	const parts = word
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/\s+/)
		.filter(Boolean);
	return parts.length > 1 ? parts : [word];
}

/** Strip diacritics: `café` -> `cafe`. */
function stripDiacritics(input: string): string {
	return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Split text into raw surface tokens before stopword removal and stemming.
 *
 * Identifier runs (paths, dotted names, snake_case, kebab-case, camelCase) are
 * emitted whole and also decomposed, so both `src/core/index.ts` and `index.ts`
 * are searchable. CJK runs are split by script and emitted as unigrams, bigrams
 * and the full run.
 */
export function splitSurfaceTokens(text: string): string[] {
	const out: string[] = [];
	const source = stripDiacritics(text);

	const emitRun = (run: string) => {
		// Deduplicate only within one run so repeated words keep their frequency.
		const local = new Set<string>();
		const pushLocal = (value: string) => {
			const lowered = value.toLowerCase();
			if (!lowered || local.has(lowered)) return;
			local.add(lowered);
			out.push(lowered);
		};
		pushLocal(run);
		// Split on path separators first so `index.ts` survives as a segment,
		// then decompose each segment further.
		for (const segment of run.split(/[/\\]+/)) {
			if (!segment) continue;
			if (segment !== run) pushLocal(segment);
			for (const camelPart of splitCamelAndCase(segment)) {
				if (camelPart !== segment) pushLocal(camelPart);
				const subs = camelPart.split(/[._-]+/).filter(Boolean);
				if (subs.length > 1) for (const sub of subs) if (sub !== camelPart) pushLocal(sub);
			}
		}
	};

	let latin = "";
	const flushLatin = () => {
		if (latin) emitRun(latin);
		latin = "";
	};

	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		const script = cjkClass(ch);
		if (script) {
			flushLatin();
			let j = i;
			while (j < source.length && cjkClass(source[j]) === script) j += 1;
			const run = source.slice(i, j);
			if (run.length <= 12) out.push(run.toLowerCase());
			const local = new Set<string>();
			for (let k = 0; k < run.length; k += 1) {
				const unigram = run[k].toLowerCase();
				if (!local.has(unigram)) {
					local.add(unigram);
					out.push(unigram);
				}
				if (k + 1 < run.length) {
					const bigram = run.slice(k, k + 2).toLowerCase();
					if (!local.has(bigram)) {
						local.add(bigram);
						out.push(bigram);
					}
				}
			}
			i = j;
			continue;
		}
		if (IDENT_CHAR_RE.test(ch)) {
			latin += ch;
			i += 1;
			continue;
		}
		if (IDENT_SEPARATOR_RE.test(ch) && latin && i + 1 < source.length && IDENT_CHAR_RE.test(source[i + 1])) {
			latin += ch;
			i += 1;
			continue;
		}
		flushLatin();
		i += 1;
	}
	flushLatin();
	return out;
}

function acceptToken(token: string, stopwords: boolean, minLength: number): boolean {
	if (!token) return false;
	const isCjk = CJK_CHAR_RE.test(token);
	if (token.length < (isCjk ? 1 : minLength)) return false;
	if (stopwords && !isCjk && token.length <= 12 && STOPWORDS.has(token)) return false;
	return true;
}

/** Tokenize into unique surface terms (no stemming). Used for query analysis. */
export function tokenizeRaw(text: string, options: TokenizeOptions = {}): string[] {
	const { stopwords = true, minLength = 2, maxTokens = 6000 } = options;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const token of splitSurfaceTokens(text)) {
		if (!acceptToken(token, stopwords, minLength)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
		if (out.length >= maxTokens) break;
	}
	return out;
}

/** Tokenize into unique surface + stemmed terms. Used for query analysis. */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
	const { stem: doStem = true } = options;
	const base = tokenizeRaw(text, options);
	if (!doStem) return base;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const token of base) {
		if (!seen.has(token)) {
			seen.add(token);
			out.push(token);
		}
		const reduced = stem(token);
		if (reduced !== token && !seen.has(reduced)) {
			seen.add(reduced);
			out.push(reduced);
		}
	}
	return out;
}

/** Raw term frequencies (surface tokens only) with stopword/min-length filtering. */
export function termCounts(text: string, options: TokenizeOptions = {}): Map<string, number> {
	const { stopwords = true, minLength = 2, maxTokens = 6000 } = options;
	const counts = new Map<string, number>();
	for (const token of splitSurfaceTokens(text)) {
		if (!acceptToken(token, stopwords, minLength)) continue;
		counts.set(token, (counts.get(token) ?? 0) + 1);
		if (counts.size >= maxTokens) break;
	}
	return counts;
}

/**
 * Tokenize `text` and accumulate weighted frequencies into `target`.
 * Field boosts are applied by calling this once per field with a multiplier.
 */
export function accumulateTokens(
	text: string,
	weight: number,
	target: Record<string, number>,
	options: TokenizeOptions = {},
): void {
	if (!text) return;
	const { stem: doStem = true } = options;
	for (const [token, count] of termCounts(text, options)) {
		const weighted = count * weight;
		target[token] = (target[token] ?? 0) + weighted;
		if (doStem) {
			const reduced = stem(token);
			if (reduced !== token) target[reduced] = (target[reduced] ?? 0) + weighted * 0.9;
		}
	}
}

/** Character trigrams of a term, used for fuzzy term lookup. */
export function termTrigrams(term: string): string[] {
	const padded = `^${term}$`;
	const out: string[] = [];
	for (let i = 0; i + 3 <= padded.length; i += 1) out.push(padded.slice(i, i + 3));
	return out;
}

/** Levenshtein distance with an early-out band. */
export function editDistance(a: string, b: string, max = 2): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j += 1) prev[j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > max) return max + 1;
		for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
	}
	return prev[b.length];
}
