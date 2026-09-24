/**
 * Rendering of everything memoria injects into the model context:
 *
 * 1. The stable `<memoria>` system-prompt section (MEMORY.md + library map + rules).
 * 2. The per-prompt recall block delivered as a custom message.
 *
 * Both renderers are pure so they can be unit tested without the pi runtime.
 */

import { hotIsEmpty, trimHot } from "./store.ts";
import type { MemoriaConfig, QueryPart, SearchHit, TimeWindow } from "./types.ts";
import { oneLine, truncateChars } from "./util.ts";

export const RECALL_CUSTOM_TYPE = "memoria_recall";

const RULES = `Long-term memory (memoria) is available and MUST be used.

Rules:
- Relevant memories are auto-surfaced before your reply. Treat them as reliable background.
- Before answering anything about people, preferences, projects, decisions, past incidents, credentials locations, or anything the user may have said in an earlier session, call memoria_recall first. Never claim "I don't remember" without searching.
- Read a full note with memoria_read (by id or path). Store durable new facts with memoria_write, which groups facts into broad topic notes.
- MEMORY.md below is loaded at the start of every session, so it holds only what pays off that often: who the user is, how they like to work, hard constraints, and the one-line state of active work. Write it as short, natural paragraphs — no headings, no bullet lists, no annotations, no "Topic — fact" labels.
- Everything occasional (URLs, versions, paths, history, rationale, one-off details) belongs in library notes, where recall finds it on demand. Keep MEMORY.md small and high-leverage.
- The library is plain markdown under library/ and can also be read or grepped directly.`;

export interface SystemSectionInput {
	root: string;
	hotContent: string;
	hotChars: number;
	hotLimit: number;
	hotOver: boolean;
	categories: Array<[string, number]>;
	totalDocs: number;
	indexTookMs: number;
	/** Recently created memories, newest first. */
	recent?: Array<{ id: string; title: string; relPath: string }>;
}

/** Render the content of the `<memoria>` system-prompt section. */
export function renderSystemSection(input: SystemSectionInput): string {
	const parts: string[] = [];
	parts.push(RULES);
	if (input.hotOver) {
		parts.push(`> WARNING: MEMORY.md is over budget (${input.hotChars}/${input.hotLimit} chars). Run memoria_hot to compact it.`);
	} else {
		parts.push(`MEMORY.md budget: ${input.hotChars}/${input.hotLimit} chars.`);
	}
	parts.push("");
	parts.push("## MEMORY.md (always loaded: who the user is and what matters most)");
	parts.push("");
	if (hotIsEmpty(input.hotContent)) {
		parts.push("_(empty — write a short introduction to the user and the standing context with memoria_hot)_");
	} else {
		// Never let an over-budget file crowd out the rest of the prompt, and never
		// write a truncation marker into the file itself.
		const safe = input.hotContent.length > input.hotLimit ? trimHot(input.hotContent, input.hotLimit).content : input.hotContent;
		parts.push(safe.trim());
	}

	if (input.categories.length > 0) {
		parts.push("");
		parts.push("## Memory library");
		parts.push("");
		const map = input.categories
			.slice(0, 24)
			.map(([category, count]) => `${category} (${count})`)
			.join(", ");
		parts.push(`${input.totalDocs} notes in ${input.categories.length} categories: ${map}`);
		parts.push(`Full tree: memoria_list. Generated table of contents: ${input.root}/library/INDEX.md`);
	}
	if (input.recent && input.recent.length > 0) {
		parts.push("");
		parts.push("## Recently learned");
		parts.push("");
		for (const entry of input.recent.slice(0, 4)) {
			parts.push(`- ${oneLine(entry.title, 90)} — ${entry.id} (${entry.relPath})`);
		}
	}
	return parts.join("\n").trim();
}

export interface RecallRenderInput {
	query: string;
	hits: SearchHit[];
	maxChars: number;
	tookMs: number;
	missing?: string[];
	/** Time window parsed out of the prompt, when one was recognized. */
	timeWindow?: TimeWindow;
}

/** Render the per-prompt recall block injected as a custom message. */
export function renderRecallBlock(input: RecallRenderInput): string {
	const header = `<memoria_recall query="${escapeAttribute(truncateChars(oneLine(input.query, 160), 160))}" hits="${input.hits.length}" took="${input.tookMs}ms">`;
	const footer = "</memoria_recall>";
	const budget = Math.max(200, input.maxChars - header.length - footer.length - 40);
	const lines: string[] = [];
	let used = 0;
	if (input.timeWindow) lines.push(`Time window from the prompt: ${input.timeWindow.label}.`);
	for (const hit of input.hits) {
		const title = oneLine(hit.doc.title, 100);
		const flags = [hit.exact ? "exact" : "", hit.supersededBy ? "SUPERSEDED - check the replacing note" : "", hit.relatedTo ? "related" : ""].filter(Boolean).join(" | ");
		const meta = `${hit.doc.relPath}${hit.doc.tags.length > 0 ? ` | tags: ${hit.doc.tags.join(", ")}` : ""} | score ${hit.score}${flags ? ` | ${flags}` : ""}`;
		const snippet = truncateChars(oneLine(hit.snippet, 360), Math.min(360, Math.max(120, input.maxChars - used - 200)));
		const entry = `- [${hit.doc.id}] ${title}\n  (${meta})\n  ${snippet}`;
		if (used + entry.length > budget && lines.length > 0) break;
		lines.push(entry);
		used += entry.length;
	}
	const missing = input.missing && input.missing.length > 0 ? `\nTerms with no matches: ${input.missing.join(", ")}` : "";
	return `${header}\n${lines.join("\n")}${missing}\nRead full notes with memoria_read {id}. Search deeper with memoria_recall if needed.\n${footer}`;
}

function escapeAttribute(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the weighted auto-recall query: the current prompt plus the last few
 * turns at a lower weight, so a long previous message cannot out-vote what the
 * user just asked.
 */
export function buildRecallParts(prompt: string, previousPrompts: string[], lastTurns: number, priorWeight = 0.4): QueryPart[] {
	const parts: QueryPart[] = [{ text: truncateChars(prompt, 1600), weight: 1 }];
	const weight = Math.max(0.05, Math.min(1, priorWeight));
	let added = 0;
	for (let i = previousPrompts.length - 1; i >= 0 && added < lastTurns; i -= 1) {
		const prior = previousPrompts[i];
		if (!prior || prior === prompt) continue;
		parts.push({ text: truncateChars(prior, 800), weight });
		added += 1;
	}
	return parts;
}

/** Flatten recall parts back into one string (used for logging and diagnostics). */
export function buildRecallQuery(prompt: string, previousPrompts: string[], lastTurns: number): string {
	return truncateChars(buildRecallParts(prompt, previousPrompts, lastTurns).map((part) => part.text).join("\n"), 1600);
}

/** Render a compact human-readable line for the TUI status. */
export function renderStatusLine(config: MemoriaConfig, docs: number, hotChars: number, lastSearchMs: number): string {
	return `memoria ${docs} notes · MEMORY.md ${hotChars}/${config.hotLimit} · ${lastSearchMs}ms`;
}
