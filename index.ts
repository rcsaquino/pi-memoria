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
import { RECALL_CUSTOM_TYPE, buildRecallParts, renderRecallBlock, renderStatusLine, renderSystemSection, ripgrepNotice } from "./src/recall.ts";
import { buildTranscriptText, harvestSession } from "./src/learn.ts";
import { createModelReranker } from "./src/rerank.ts";
import { tokenizeRaw } from "./src/tokenize.ts";
import { oneLine } from "./src/util.ts";

const RECENT_PROMPT_LIMIT = 6;

export default function memoria(pi: ExtensionAPI) {
	let runtime: MemoriaRuntime | undefined;
	let runtimeCwd: string | undefined;
	let initPromise: Promise<void> | undefined;
	let hotCache: { content: string; chars: number; limit: number; over: boolean; mtimeMs: number } | undefined;
	let recentPrompts: string[] = [];
	/** The missing-ripgrep warning is shown once per session, not on every prompt. */
	let ripgrepWarned = false;
	/** Auto-learn bookkeeping: user turns since the last extraction, and when. */
	let turnsSinceLearn = 0;
	let lastLearnAt = 0;
	let learnInFlight = false;

	/** Resolve (and lazily initialize) the runtime for this working directory. */
	const getRuntime = async (ctx: ExtensionContext): Promise<MemoriaRuntime> => {
		if (!runtime || runtimeCwd !== ctx.cwd) {
			await runtime?.dispose().catch(() => {});
			// Follow pi's own agent directory (honours PI_CODING_AGENT_DIR) so the
			// store lives at `<agent dir>/memoria`.
			runtime = new MemoriaRuntime(ctx.cwd, { agentDir: getAgentDir() });
			runtimeCwd = ctx.cwd;
			hotCache = undefined;
			recentPrompts = [];
			turnsSinceLearn = 0;
			lastLearnAt = 0;
			learnInFlight = false;
			initPromise = runtime.init(true).catch((error) => {
				// Allow a later attempt to retry instead of caching the rejection forever.
				initPromise = undefined;
				throw error;
			});
		}
		await initPromise;
		return runtime;
	};

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
			const overview = await memoria_.overview(4);
			event.systemPromptOptions.sections.memoria = renderSystemSection({
				root: memoria_.roots.primary,
				hotContent: hot.over ? hot.content.slice(0, hot.limit) : hot.content,
				hotChars: hot.chars,
				hotLimit: hot.limit,
				hotOver: hot.over,
				categories: overview.categories,
				totalDocs: overview.docs,
				indexTookMs: 0,
				recent: overview.recent,
			});

			// Reranking is opt-in and best-effort; the lexical order is the fallback.
			memoria_.setReranker(memoria_.config.rerank ? createModelReranker(ctx) : undefined);

			// Layer 2: per-prompt recall block.
			turnsSinceLearn += 1;
			if (!memoria_.config.autoRecall) return undefined;
			const prompt = event.prompt ?? "";
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
			const hits = result.hits.filter((hit) => hit.score >= memoria_.config.autoRecallMinScore);
			// Nothing in the library? Show what earlier conversations said instead
			// of leaving the model with nothing to go on.
			const sessionHits = hits.length === 0 ? result.sessionHits : undefined;
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
			return {
				message: {
					customType: RECALL_CUSTOM_TYPE,
					content: rendered,
					display: true,
					details: { ids: hits.map((hit) => hit.doc.id), tookMs: result.tookMs, sessionHits: sessionHits?.length ?? 0 },
				},
			};
		} catch (error) {
			// Recall failures must never break the turn.
			ctx.ui.notify(`memoria: recall failed: ${(error as Error).message}`, "warning");
			return undefined;
		}
	});

	/**
	 * Automatic session learning.
	 *
	 * Runs only when configured, only after enough conversation has accumulated,
	 * and at most once per cooldown window. It never blocks the turn: extraction
	 * happens after the agent loop ends.
	 */
	const maybeAutoLearn = async (ctx: ExtensionContext, trigger: "settle" | "shutdown"): Promise<void> => {
		if (!runtime || learnInFlight) return;
		const mode = runtime.config.autoLearn;
		if (mode === "off") return;
		if (mode === "on-settle" && trigger !== "settle") return;
		if (mode === "on-shutdown" && trigger !== "shutdown") return;
		if (turnsSinceLearn < runtime.config.autoLearnMinTurns) return;
		const now = Date.now();
		if (now - lastLearnAt < runtime.config.autoLearnCooldownMs) return;
		const branch = ctx.sessionManager.getBranch() as ReadonlyArray<{ type?: string; message?: { role?: string; content?: unknown } }>;
		// The character floor keeps a burst of tiny turns from triggering a model
		// call that has nothing to extract from.
		const transcriptChars = buildTranscriptText(branch, 40_000).length;
		if (transcriptChars < runtime.config.autoLearnMinChars) return;
		learnInFlight = true;
		lastLearnAt = now;
		turnsSinceLearn = 0;
		try {
			setStatus(ctx, "memoria: extracting memories...");
			const result = await harvestSession(ctx, runtime, branch, {
				chunkChars: runtime.config.learnChunkChars,
				onProgress: (update) => {
					if (update.total > 1) setStatus(ctx, `memoria: extracting memories... ${update.index}/${update.total}`);
				},
			});
			const total = result.created.length + result.updated.length;
			if (total > 0) {
				ctx.ui.notify(`memoria: learned ${total} note${total === 1 ? "" : "s"} (${result.created.length} new, ${result.updated.length} updated)`, "info");
			} else if (result.error) {
				setStatus(ctx, undefined);
			}
		} catch (error) {
			ctx.ui.notify(`memoria: auto-learn failed: ${(error as Error).message}`, "warning");
		} finally {
			learnInFlight = false;
			try {
				const stats = await runtime.stats();
				const docs = stats.roots.reduce((sum, entry) => sum + entry.docs, 0);
				setStatus(ctx, renderStatusLine(runtime.config, docs, stats.hot.chars, 0));
			} catch {
				setStatus(ctx, undefined);
			}
		}
	};

	pi.on("agent_end", async (_event, ctx) => {
		await maybeAutoLearn(ctx, "settle").catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await maybeAutoLearn(ctx, "shutdown");
		} catch {
			// Shutdown must never throw.
		}
		await runtime?.flushUsageNow().catch(() => {});
		await runtime?.dispose().catch(() => {});
		runtime = undefined;
		runtimeCwd = undefined;
		initPromise = undefined;
		hotCache = undefined;
		recentPrompts = [];
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
