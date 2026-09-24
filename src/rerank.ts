/**
 * Model-backed reranking of recall candidates.
 *
 * BM25 is fast and exact but has no idea which of five plausible notes the user
 * actually means. When enabled (`config.rerank`), the top candidates are shown
 * to the session model and it returns them in relevance order. The model call is
 * strictly optional: on any error, timeout, missing auth or unparsable reply the
 * lexical order is kept, so enabling reranking can never make recall fail.
 */

import { oneLine } from "./util.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Reranker } from "./runtime.ts";

/** Candidate lines given to the model are truncated to keep the prompt small. */
const CANDIDATE_CHARS = 160;
/** Upper bound on the reranker's reply; it only has to name ids. */
const MAX_REPLY_TOKENS = 500;

/** Build a reranker bound to the current session context. */
export function createModelReranker(ctx: ExtensionContext): Reranker {
	return async (query, hits, options) => {
		const model = options.model ? findModel(ctx, options.model) : ctx.model;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
		const list = hits
			.map((hit, index) => `${index + 1}. ${hit.doc.id} — ${oneLine(hit.doc.title, 80)}: ${oneLine(hit.snippet, CANDIDATE_CHARS)}`)
			.join("\n");
		const prompt = [
			"Rank the memory notes below by how well each answers the question.",
			"Return ONLY a JSON array of ids, most relevant first, e.g. [\"mem_1_aa\", \"mem_2_bb\"].",
			"Include every id exactly once. Do not explain.",
			"",
			`Question: ${oneLine(query, 300)}`,
			"",
			"Notes:",
			list,
		].join("\n");
		const call = ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens: MAX_REPLY_TOKENS, cacheRetention: "none" },
		);
		const response = await withTimeout(call, options.timeoutMs);
		if (!response) return undefined;
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const known = new Set(hits.map((hit) => hit.doc.id));
		const ids: string[] = [];
		for (const match of text.matchAll(/mem_[A-Za-z0-9_]+/g)) {
			if (known.has(match[0]) && !ids.includes(match[0])) ids.push(match[0]);
		}
		// A partial order is still useful: unknown ids are appended by the caller.
		return ids.length > 0 ? ids : undefined;
	};
}

function findModel(ctx: ExtensionContext, id: string): ExtensionContext["model"] {
	const trimmed = id.trim();
	if (!trimmed) return undefined;
	for (const model of ctx.modelRegistry.getAvailable()) {
		if (`${model.provider}/${model.id}` === trimmed || model.id === trimmed) return model;
	}
	const slash = trimmed.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1));
	return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), Math.max(250, timeoutMs));
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}
