/**
 * Query-side synonym expansion.
 *
 * `k8s` should find notes that say `kubernetes` without re-indexing them, so
 * synonyms are applied when the query is analyzed. The table comes from
 * `config.synonyms` (inline) merged with `<root>/synonyms.json`, which makes it
 * per-store: one person's shorthand never leaks into another store.
 *
 * File format (all keys and values lowercase; expansion is bidirectional):
 *
 *   {
 *     "k8s": ["kubernetes", "kube"],
 *     "postgres": ["postgresql", "pg"]
 *   }
 */

import { join } from "node:path";
import { SYNONYMS_FILE } from "./config.ts";
import { readFileOrUndefined } from "./util.ts";

/** Upper bound on the size of a store's synonym table. */
export const MAX_SYNONYM_TERMS = 2000;

/** Normalize an arbitrary JSON value into a clean `term -> alternatives` table. */
export function normalizeSynonymTable(raw: unknown): Record<string, string[]> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const term = key.trim().toLowerCase();
		if (!term || term.length > 60) continue;
		const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
		const cleaned = list
			.map((entry) => String(entry ?? "").trim().toLowerCase())
			.filter((entry) => entry && entry.length <= 60 && entry !== term);
		if (cleaned.length > 0) out[term] = [...new Set(cleaned)].slice(0, 12);
		if (Object.keys(out).length >= MAX_SYNONYM_TERMS) break;
	}
	return out;
}

/** Merge tables left to right; later entries append alternatives. */
export function mergeSynonymTables(...tables: Array<Record<string, string[]> | undefined>): Record<string, string[]> {
	const out = new Map<string, string[]>();
	for (const table of tables) {
		if (!table) continue;
		for (const [term, values] of Object.entries(table)) {
			const existing = out.get(term) ?? [];
			out.set(term, [...new Set([...existing, ...values])].slice(0, 12));
		}
	}
	return Object.fromEntries(out);
}

/**
 * Make expansion symmetric: if `k8s -> kubernetes` then `kubernetes -> k8s`
 * too, so the feature works from whichever word the query happens to use.
 */
export function expandSynonymTable(table: Record<string, string[]>): Record<string, string[]> {
	const out = new Map<string, Set<string>>();
	const add = (from: string, to: string): void => {
		if (from === to) return;
		const set = out.get(from) ?? new Set<string>();
		set.add(to);
		out.set(from, set);
	};
	for (const [term, values] of Object.entries(table)) {
		for (const value of values) {
			add(term, value);
			add(value, term);
		}
	}
	return Object.fromEntries([...out.entries()].map(([term, set]) => [term, [...set].slice(0, 12)]));
}

/** Load `<root>/synonyms.json`; a missing or malformed file yields an empty table. */
export async function loadSynonymsFile(root: string): Promise<Record<string, string[]>> {
	const raw = await readFileOrUndefined(join(root, SYNONYMS_FILE));
	if (!raw) return {};
	try {
		return normalizeSynonymTable(JSON.parse(raw));
	} catch {
		return {};
	}
}

/** Alternatives for a term, already lowercased and deduplicated. */
export function synonymsFor(table: Record<string, string[]>, term: string): string[] {
	return table[term] ?? [];
}

/** Example file content (used by `/memoria doctor` and the README). */
export function synonymsFileTemplate(): string {
	return `${JSON.stringify(
		{
			k8s: ["kubernetes"],
			postgres: ["postgresql", "pg"],
			auth: ["authentication", "login"],
			deps: ["dependencies"],
			repo: ["repository"],
			perf: ["performance"],
		},
		null,
		2,
	)}\n`;
}
