/**
 * memoria — agent-first long-term memory for pi.
 *
 * Layout created by this extension inside the working directory:
 *
 *   memoria/
 *   ├── MEMORY.md        curated memory injected into every session (<= 5000 chars)
 *   ├── config.json      optional configuration
 *   ├── .index/          derived search index (never indexed)
 *   ├── .trash/          soft-deleted memories
 *   └── library/         categorized markdown memories, browsable as plain files
 *
 * Three layers produce the recall guarantee:
 *   1. MEMORY.md is always in the system prompt (stable, cache-friendly section).
 *   2. Every user prompt is searched against the library and the best matches are
 *      injected automatically as a `memoria_recall` message.
 *   3. memoria_recall / memoria_read / memoria_list tools let the agent dig deeper.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MemoriaRuntime } from "./src/runtime.ts";
import { registerMemoriaTools } from "./src/tools.ts";
import { registerMemoriaCommand, setStatus } from "./src/commands.ts";
import { RECALL_CUSTOM_TYPE, cleanRecallPrompt, selectAutoRecallHits, recallFingerprint, visibleRecallFingerprints, buildRecallParts, renderRecallBlock, renderStatusLine, renderSystemSection, ripgrepNotice } from "./src/recall.ts";
import { createModelReranker } from "./src/rerank.ts";
import { tokenizeRaw } from "./src/tokenize.ts";
import { KeyedMutex, oneLine } from "./src/util.ts";

const RECENT_PROMPT_LIMIT = 6;

export default function memoria(pi: ExtensionAPI) {
	let runtime: MemoriaRuntime | undefined;
	let runtimeCwd: string | undefined;
	const runtimeLock = new KeyedMutex();
	let hotCache: { content: string; chars: number; limit: number; over: boolean; mtimeMs: number } | undefined;
	let recentPrompts: string[] = [];
	/** The missing-ripgrep warning is shown once per session, not on every prompt. */
	let ripgrepWarned = false;
	/** Resolve (and lazily initialize) the runtime for this working directory. */
	const getRuntime = (ctx: ExtensionContext): Promise<MemoriaRuntime> => runtimeLock.run("runtime", async () => {
		if (!runtime || runtimeCwd !== ctx.cwd) {
			const previous = runtime;
			runtime = undefined;
			runtimeCwd = undefined;
			await previous?.dispose().catch(() => {});
			// Follow pi's own agent directory (honours PI_CODING_AGENT_DIR) so the
			// store lives at `<agent dir>/memoria`.
			const next = new MemoriaRuntime(ctx.cwd, { agentDir: getAgentDir() });
			try {
				await next.init(true);
			} catch (error) {
				await next.dispose().catch(() => {});
				throw error;
			}
			runtime = next;
			runtimeCwd = ctx.cwd;
			hotCache = undefined;
			recentPrompts = [];
		}
		return runtime;
	});

	/** Read MEMORY.md, reusing the cached copy until its mtime changes. */
	const readHotCached = async (memoria: MemoriaRuntime): Promise<{ content: string; chars: number; limit: number; over: boolean }> => {
		const path = join(memoria.roots.primary, "MEMORY.md");
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch {
			mtimeMs = 0;
		}
		if (hotCache && hotCache.mtimeMs === mtimeMs && hotCache.limit === memoria.config.hotLimit) return hotCache;
		const state = await memoria.hotState();
		hotCache = { content: state.content, chars: state.chars, limit: state.limit, over: state.over, mtimeMs };
		return hotCache;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			const memoria_ = await getRuntime(ctx);
			const stats = await memoria_.stats();
			const total = stats.roots.reduce((sum, entry) => sum + entry.docs, 0);
			setStatus(ctx, renderStatusLine(memoria_.config, total, stats.hot.chars, 0));
			// Tell the user (never the model) what changed since last time.
			const delta = await memoria_.sessionDelta(5);
			if (delta && delta.created.length + delta.updated.length > 0) {
				const parts: string[] = [];
				if (delta.created.length > 0) parts.push(`${delta.created.length} new`);
				if (delta.updated.length > 0) parts.push(`${delta.updated.length} updated`);
				const titles = [...delta.created, ...delta.updated]
					.slice(0, 3)
					.map((entry) => oneLine(entry.title, 40))
					.join(", ");
				ctx.ui.notify(`memoria: ${parts.join(", ")} since your last session (${titles})`, "info");
			}
		} catch (error) {
			setStatus(ctx, undefined);
			ctx.ui.notify(`memoria: store unavailable (${(error as Error).message})`, "warning");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const memoria_ = await getRuntime(ctx);

			// Layer 1: stable system-prompt section with MEMORY.md + library map.
			const hot = await readHotCached(memoria_);
			const overview = await memoria_.overview(0);
			event.systemPromptOptions.sections.memoria = renderSystemSection({
				root: memoria_.roots.primary,
				hotContent: hot.over ? hot.content.slice(0, hot.limit) : hot.content,
				hotChars: hot.chars,
				hotLimit: hot.limit,
				hotOver: hot.over,
				categories: overview.categories,
				totalDocs: overview.docs,
				indexTookMs: 0,
			});

			// Reranking is opt-in and best-effort; the lexical order is the fallback.
			memoria_.setReranker(memoria_.config.rerank ? createModelReranker(ctx) : undefined);

			// Layer 2: per-prompt recall block.
			if (!memoria_.config.autoRecall) return undefined;
			const prompt = cleanRecallPrompt(event.prompt ?? "");
			if (prompt.trimStart().startsWith("/")) return undefined;
			const tokens = tokenizeRaw(prompt);
			if (tokens.length < 2 && !/\d/.test(prompt)) return undefined;
			const parts = buildRecallParts(prompt, recentPrompts, memoria_.config.autoRecallLastTurns, memoria_.config.autoRecallPriorWeight);
			const result = await memoria_.recall(oneLine(prompt, 400), { limit: memoria_.config.autoRecallLimit, scope: "all", parts });
			const rgNotice = ripgrepNotice(result.sessionStats?.ripgrep);
			if (rgNotice && !ripgrepWarned) {
				ripgrepWarned = true;
				ctx.ui.notify(`memoria: ${rgNotice}.`, "warning");
			}
			recentPrompts = [...recentPrompts, prompt].slice(-RECENT_PROMPT_LIMIT);
			const tables = await Promise.all([...new Set(result.hits.map(hit => hit.doc.root))].map(root => memoria_.synonymsFor(root)));
			const synonyms: Record<string, string[]> = {};
			for (const table of tables) for (const [term, values] of Object.entries(table)) synonyms[term] = [...(synonyms[term] ?? []), ...values];
			const relevant = selectAutoRecallHits(result.hits, prompt, memoria_.config.autoRecallMinScore, memoria_.config.autoRecallMinRatio, synonyms);
			const seen = visibleRecallFingerprints(ctx.sessionManager.buildContextEntries?.() ?? ctx.sessionManager.getBranch());
			const hits = relevant.filter(hit => !seen.has(recallFingerprint(hit)));
			// Nothing in the library? Show what earlier conversations said instead
			// of leaving the model with nothing to go on.
			const sessionHits = relevant.length === 0 ? result.sessionHits : undefined;
			if (hits.length === 0 && (!sessionHits || sessionHits.length === 0)) return undefined;
			const rendered = renderRecallBlock({
				query: oneLine(prompt, 160),
				hits,
				maxChars: memoria_.config.autoRecallMaxChars,
				tookMs: result.tookMs,
				missing: result.missing,
				timeWindow: result.timeWindow,
				sessionHits,
				sessionStats: result.sessionStats,
			});
			if (!rendered) return undefined;
			const included = hits.filter(hit => rendered.includes(`- [${hit.doc.id}]`));
			return {
				message: {
					customType: RECALL_CUSTOM_TYPE,
					content: rendered,
					display: true,
					details: { ids: included.map((hit) => hit.doc.id), fingerprints: included.map(recallFingerprint), tookMs: result.tookMs, sessionHits: sessionHits?.length ?? 0 },
				},
			};
		} catch (error) {
			// Recall failures must never break the turn.
			ctx.ui.notify(`memoria: recall failed: ${(error as Error).message}`, "warning");
			return undefined;
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await runtimeLock.run("runtime", async () => {
			await runtime?.flushUsageNow().catch(() => {});
			await runtime?.dispose().catch(() => {});
			runtime = undefined;
			runtimeCwd = undefined;
			hotCache = undefined;
			recentPrompts = [];
		});
	});

	pi.registerMessageRenderer(RECALL_CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details as { ids?: string[]; tookMs?: number; sessionHits?: number } | undefined;
		const ids = details?.ids ?? [];
		const summary =
			ids.length > 0
				? `recalled ${ids.length} ${ids.length === 1 ? "memory" : "memories"}`
				: `searched past sessions (${details?.sessionHits ?? 0} match${(details?.sessionHits ?? 0) === 1 ? "" : "es"})`;
		const header =
			theme.fg("accent", theme.bold("memoria ")) +
			theme.fg("muted", summary) +
			theme.fg("dim", details?.tookMs !== undefined ? ` (${details.tookMs}ms)` : "");
		const body = typeof message.content === "string" ? message.content : "";
		const visible = options.expanded ? body : oneLine(body, 200);
		return new Text(`${header}\n${theme.fg("dim", visible)}`, 0, 0);
	});

	registerMemoriaTools(pi, getRuntime);
	registerMemoriaCommand(pi, getRuntime);
}
