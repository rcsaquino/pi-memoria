/**
 * User-facing `/memoria` command with subcommands and autocomplete.
 *
 * Command output is appended as a custom entry (never sent to the model) and
 * rendered as markdown in interactive mode.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import type { MemoriaRuntime } from "./runtime.ts";
import type { RuntimeGetter } from "./tools.ts";
import { harvestSession } from "./learn.ts";
import { formatSessionTime } from "./sessions.ts";
import { describeAge } from "./usage.ts";
import { atomicWriteFile, oneLine } from "./util.ts";
import type { Scope } from "./types.ts";

export const COMMAND_ENTRY_TYPE = "memoria_command";

const SUBCOMMANDS: Array<{ value: string; label: string; description: string }> = [
	{ value: "status", label: "status", description: "Store locations, index stats and MEMORY.md budget" },
	{ value: "search", label: "search <query>", description: "Search long-term memory" },
	{ value: "store", label: "store <text>", description: "Quickly save a memory to the inbox" },
	{ value: "read", label: "read <id|path>", description: "Read a full memory note" },
	{ value: "move", label: "move <ref> <topic>", description: "Re-file a note under a better broad topic" },
	{ value: "hot", label: "hot", description: "Show MEMORY.md and its budget" },
	{ value: "reindex", label: "reindex", description: "Rebuild the search index from disk" },
	{ value: "index", label: "index", description: "Regenerate library/INDEX.md table of contents" },
	{ value: "doctor", label: "doctor", description: "Check the store for consistency problems" },
	{ value: "topics", label: "topics", description: "Review notes: size, facts, usage, merge candidates" },
	{ value: "diff", label: "diff [days]", description: "Show memories created or updated recently" },
	{ value: "sessions", label: "sessions <query>", description: "Search earlier conversations (raw transcripts)" },
	{ value: "export", label: "export [file]", description: "Dump the store to JSONL" },
	{ value: "import", label: "import <file>", description: "Restore memories from a JSONL export" },
	{ value: "learn", label: "learn", description: "Extract durable memories from the current session" },
	{ value: "paths", label: "paths", description: "Print store paths" },
	{ value: "forget", label: "forget <id>", description: "Move a memory to .trash" },
];

function emit(pi: ExtensionAPI, title: string, markdown: string): void {
	pi.appendEntry(COMMAND_ENTRY_TYPE, { title, markdown });
}

async function statusMarkdown(runtime: MemoriaRuntime): Promise<string> {
	const { roots, hot, recovered } = await runtime.stats();
	const lines: string[] = [];
	lines.push(`**Store root:** \`${runtime.displayPath(runtime.roots.primary)}\` ${roots.length === 0 ? "_(not created yet — use /memoria store to initialize)_" : ""}`);
	if (runtime.roots.project) lines.push(`**Project root:** \`${runtime.displayPath(runtime.roots.project)}\``);
	if (runtime.roots.extras.length > 0) lines.push(`**Extra roots (read-only):** ${runtime.roots.extras.map((extra) => `\`${runtime.displayPath(extra)}\``).join(", ")}`);
	if (recovered && recovered.length > 0) lines.push(`**Recovered:** ${recovered.join("; ")}`);
	lines.push(`**MEMORY.md:** ${hot.chars}/${hot.limit} chars${hot.over ? " — **over budget**" : ""}`);
	lines.push("");
	if (roots.length === 0) {
		lines.push("_No index loaded._");
		return lines.join("\n");
	}
	lines.push("| root | notes | index built | load | last search | watcher |");
	lines.push("| --- | ---: | --- | ---: | ---: | --- |");
	for (const stats of roots) {
		const built = stats.indexBuiltAt ? new Date(stats.indexBuiltAt).toISOString().replace("T", " ").slice(0, 19) : "-";
		lines.push(
			`| \`${runtime.displayPath(stats.root)}\` | ${stats.docs} | ${built} | ${stats.indexLoadMs}ms | ${stats.lastSearchMs}ms | ${stats.watcherActive ? "on" : "off"} |`,
		);
	}
	const categories = new Map<string, number>();
	for (const stats of roots) for (const [category, count] of Object.entries(stats.categories)) categories.set(category, (categories.get(category) ?? 0) + count);
	if (categories.size > 0) {
		lines.push("");
		lines.push(`**Categories:** ${[...categories.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => `${category} (${count})`).join(", ")}`);
	}
	lines.push("");
	lines.push(`**Auto-recall:** ${runtime.config.autoRecall ? `on (limit ${runtime.config.autoRecallLimit}, min score ${runtime.config.autoRecallMinScore})` : "off"} | **auto-learn:** ${runtime.config.autoLearn}`);
	lines.push(`**Index:** ${runtime.config.indexFormat} | **rerank:** ${runtime.config.rerank ? runtime.config.rerankModel || "session model" : "off"} | **synonym table:** ${Object.keys(runtime.config.synonyms).length} inline`);
	lines.push(
		`**Session recall:** ${runtime.config.sessionSearch ? (runtime.config.sessionFallback ? "on (falls back when memory is empty)" : "on (explicit only)") : "off"} | roots: ${runtime.sessionRoots().filter((root) => existsSync(root)).length}`,
	);
	return lines.join("\n");
}

function parseScopeFlag(args: string, fallback: Scope = "primary"): { scope: Scope; rest: string } {
	const match = args.match(/(?:^|\s)--(primary|global|all|project)\b/);
	if (!match) return { scope: fallback, rest: args };
	return { scope: match[1] as Scope, rest: args.replace(match[0], " ") };
}

export function registerMemoriaCommand(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
	pi.registerEntryRenderer(COMMAND_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { title?: string; markdown?: string } | undefined;
		const markdown = data?.markdown ?? "";
		const heading = data?.title ?? "memoria";
		try {
			return new Markdown(`**${heading}**\n\n${markdown}`, 1, 0, getMarkdownTheme());
		} catch {
			return new Text(theme.fg("accent", heading) + `\n${markdown}`, 1, 0);
		}
	});

	pi.registerCommand("memoria", {
		description: "Long-term memory: status, search, store, reindex, doctor",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (trimmed.includes(" ")) return null;
			const filtered = SUBCOMMANDS.filter((entry) => entry.value.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((entry) => ({ value: entry.value, label: entry.label, description: entry.description })) : null;
		},
		handler: async (rawArgs, ctx: ExtensionCommandContext) => {
			const runtime = await getRuntime(ctx);
			const args = rawArgs.trim();
			// `"".split(/\s+/)` yields `[""]`, so default explicitly.
			const parts = args.length > 0 ? args.split(/\s+/) : [];
			const subcommand = parts[0] ?? "status";
			const remainder = parts.slice(1).join(" ").trim();
			await runtime.prepare(true);
			switch (subcommand) {
				case "status": {
					emit(pi, "memoria status", await statusMarkdown(runtime));
					return;
				}
				case "search":
				case "recall": {
					if (!remainder) {
						ctx.ui.notify("Usage: /memoria search <query>", "warning");
						return;
					}
					const { scope, rest: query } = parseScopeFlag(remainder, "all");
					const result = await runtime.recall(query || remainder, { limit: 12, scope });
					if (result.hits.length === 0) {
						emit(pi, `memoria search: ${oneLine(remainder, 80)}`, `No memories matched. ${result.total} candidates after filtering.`);
						return;
					}
					const lines = [`${result.hits.length} of ${result.total} matches in ${result.tookMs}ms${result.reranked ? " (model-reranked)" : ""}.`, ""];
					if (result.timeWindow) lines.push(`_Time window: ${result.timeWindow.label}_`, "");
					result.hits.forEach((hit, index) => {
						const doc = hit.doc;
						const flags = [hit.relatedTo ? "related" : "", hit.supersededBy ? "superseded" : ""].filter(Boolean).join(", ");
						lines.push(`${index + 1}. **${doc.title}** — \`${doc.id}\` (score ${hit.score}${flags ? `, ${flags}` : ""})`);
						lines.push(`   \`${doc.relPath}\`${doc.tags.length > 0 ? ` · tags: ${doc.tags.join(", ")}` : ""}`);
						lines.push(`   ${oneLine(hit.snippet, 320)}`);
						lines.push("");
					});
					emit(pi, `memoria search: ${oneLine(remainder, 80)}`, lines.join("\n"));
					return;
				}
				case "store": {
					if (!remainder) {
						ctx.ui.notify("Usage: /memoria store <text>", "warning");
						return;
					}
					// Quick captures accumulate in one broad, date-based inbox note rather
					// than creating a file per thought. The label keeps them triageable.
					const now = new Date();
					const day = now.toISOString().slice(0, 10);
					const time = now.toISOString().slice(11, 16);
					const { result } = await runtime.write({
						topic: `Inbox ${day}`,
						label: time,
						content: remainder,
						category: "inbox",
						tags: [],
						summary: oneLine(remainder, 200),
						source: "user-command",
					});
					ctx.ui.notify(`Saved to ${runtime.displayPath(result.path)} (${result.doc.id})`, "info");
					return;
				}
				case "read": {
					if (!remainder) {
						ctx.ui.notify("Usage: /memoria read <id|path>", "warning");
						return;
					}
					const found = await runtime.readMemory(remainder, "all");
					if (!found) {
						ctx.ui.notify(`Memory not found: ${remainder}`, "error");
						return;
					}
					const { doc } = found;
					emit(pi, `${doc.title} (${doc.id})`, [`\`${doc.relPath}\``, "", doc.body].join("\n"));
					return;
				}
				case "move": {
					const [ref, ...rest] = remainder.split(/\s+/).filter(Boolean);
					const topic = rest.join(" ").trim();
					if (!ref || !topic) {
						ctx.ui.notify("Usage: /memoria move <id|path|alias> <new broad topic>", "warning");
						return;
					}
					const moved = await runtime.move(ref, { topic }, "all");
					if (!moved) {
						ctx.ui.notify(`Memory not found: ${ref}`, "error");
						return;
					}
					const { result } = moved;
					const lines = [
						result.moved
							? result.merged
								? `Merged \`${result.from}\` into the existing note **${result.doc.topic}** (\`${result.doc.relPath}\`).`
								: `Re-filed \`${result.from}\` as **${result.doc.topic}** (\`${result.doc.relPath}\`).`
							: `No change: ${result.reason ?? "already at the target"}`,
					];
					if (result.aliasesAdded.length > 0) lines.push(`Aliases added: ${result.aliasesAdded.map((alias) => `\`${alias}\``).join(", ")}`);
					if (result.topicNote) lines.push(`Note: ${result.topicNote}`);
					emit(pi, `memoria move: ${oneLine(result.doc.topic, 60)}`, lines.join("\n"));
					return;
				}
				case "hot": {
					const hot = await runtime.hotState();
					emit(
						pi,
						`MEMORY.md ${hot.chars}/${hot.limit} chars`,
						hot.content.trim() || "_(empty)_",
					);
					return;
				}
				case "reindex": {
					ctx.ui.notify("Rebuilding memoria indexes...", "info");
					const results = await runtime.rebuild("all");
					const lines = results.map((entry) => `- \`${runtime.displayPath(entry.root)}\`: ${entry.docs} notes in ${entry.tookMs}ms`);
					emit(pi, "memoria reindex", lines.join("\n") || "_No roots to index._");
					return;
				}
				case "index": {
					const results = await runtime.regenerateIndexes("all");
					const lines = results.map((entry) => `- \`${runtime.displayPath(entry.root)}\`: ${entry.files} index files`);
					emit(pi, "memoria index", lines.join("\n") || "_No roots to index._");
					return;
				}
				case "doctor": {
					const report = await runtime.health();
					if (report.findings.length === 0) {
						emit(pi, "memoria doctor", "No problems found.");
						return;
					}
					const sections: string[] = [report.findings.map((finding) => `- ${finding}`).join("\n")];
					const extra: string[] = [];
					if (report.merges.length > 0) extra.push(`_${report.merges.length} merge candidate pair(s)_`);
					if (report.contradictions.length > 0) extra.push(`_${report.contradictions.length} possible contradiction(s)_`);
					if (report.stale.length > 0) extra.push(`_${report.stale.length} stale note(s)_`);
					if (report.promotions.length > 0) extra.push(`_${report.promotions.length} promotion candidate(s)_`);
					if (extra.length > 0) sections.push(extra.join(" · ") + ". See /memoria topics for details.");
					emit(pi, "memoria doctor", sections.join("\n\n"));
					return;
				}
				case "topics": {
					const report = await runtime.topicsReport();
					if (report.length === 0) {
						emit(pi, "memoria topics", "_No memories yet._");
						return;
					}
					const merges = await runtime.mergeSuggestions(8);
					const lines: string[] = [];
					lines.push(`${report.length} topic notes.`);
					lines.push("");
					lines.push("| topic | category | facts | size | updated | hits | last used |");
					lines.push("| --- | --- | ---: | ---: | --- | ---: | --- |");
					let totalFacts = 0;
					for (const entry of report.slice(0, 200)) {
						totalFacts += entry.facts;
						const updated = entry.updated ? new Date(entry.updated).toISOString().slice(0, 10) : "-";
						const lastUsed = entry.lastUsed ? describeAge(Date.now() - entry.lastUsed) + " ago" : "never";
						lines.push(
							`| ${entry.stale ? "**stale** " : ""}${entry.title} | ${entry.category || "(root)"} | ${entry.facts} | ${Math.round(entry.bytes / 1024)}k | ${updated} | ${entry.hits} | ${lastUsed} |`,
						);
					}
					lines.push("");
					lines.push(`${totalFacts} facts in ${report.length} notes.`);
					if (merges.length > 0) {
						lines.push("");
						lines.push("**Merge candidates** (same subject, two files):");
						for (const merge of merges) {
							lines.push(
								`- \`${merge.a.relPath}\` ↔ \`${merge.b.relPath}\` (${Math.round(merge.score * 100)}% overlap: ${merge.shared.join(", ")}) → \`/memoria move ${merge.b.id} ${merge.a.title}\``,
							);
						}
					}
					emit(pi, "memoria topics", lines.join("\n"));
					return;
				}
				case "sessions": {
					const flags = remainder.split(/\s+/).filter(Boolean);
					const readIndex = flags.indexOf("--read");
					if (readIndex >= 0) {
						const path = flags[readIndex + 1];
						const line = Number.parseInt(flags[readIndex + 2] ?? "1", 10);
						const windowFlag = flags.find((flag) => flag.startsWith("--window="));
						const window = windowFlag ? Number.parseInt(windowFlag.slice(9), 10) : 6;
						if (!path) {
							ctx.ui.notify("Usage: /memoria sessions --read <path> <line> [--window=6]", "warning");
							return;
						}
						const found = await runtime.sessionRead(path, Number.isFinite(line) ? line : 1, Number.isFinite(window) ? window : 6);
						if (!found) {
							ctx.ui.notify("No transcript window there. Paths must come from a /memoria sessions search.", "error");
							return;
						}
						const lines = [`\`${found.relPath}\` · project **${found.projectName}** · lines ${found.startLine}-${found.endLine}`, ""];
						for (const message of found.messages) {
							lines.push(`- **[${message.line}] ${message.role}** ${formatSessionTime(message.timestamp)}: ${oneLine(message.text, 1200)}`);
						}
						emit(pi, "memoria sessions: window", lines.join("\n"));
						return;
					}
					const daysFlag = flags.find((flag) => flag.startsWith("--days="));
					const projectFlag = flags.find((flag) => flag.startsWith("--project="));
					const query = flags.filter((flag) => !flag.startsWith("--")).join(" ");
					if (!query) {
						ctx.ui.notify("Usage: /memoria sessions <query> [--days=N] [--project=name] [--tools] [--user]", "warning");
						return;
					}
					const result = await runtime.sessionSearch(query, {
						limit: 10,
						sinceDays: daysFlag ? Number.parseInt(daysFlag.slice(7), 10) : undefined,
						project: projectFlag ? projectFlag.slice(10) : undefined,
						includeTools: flags.includes("--tools"),
						userOnly: flags.includes("--user"),
					});
					const stats = result.stats;
					const header = `${result.hits.length} match${result.hits.length === 1 ? "" : "es"} in ${stats.files} sessions / ${stats.messages} messages (${result.tookMs}ms${stats.partial ? ", partial scan" : ""}${stats.skipped > 0 ? `, ${stats.skipped} unreadable records skipped` : ""}).`;
					if (result.hits.length === 0) {
						emit(pi, `memoria sessions: ${oneLine(query, 60)}`, `${header}\n\nNo saved conversation matched. Try other wording, a name or a date.`);
						return;
					}
					const lines = [header, "", "_Evidence from raw transcripts, not curated memory._", ""];
					for (const hit of result.hits) {
						lines.push(`- **[${hit.role}] ${formatSessionTime(hit.timestamp)}** · ${hit.projectName} · score ${hit.score}${hit.exact ? " · exact" : ""}`);
						lines.push(`  ${oneLine(hit.excerpt, 400)}`);
						lines.push(`  \`${hit.path}:${hit.line}\` · matched: ${hit.matched.join(", ") || "-"}`);
					}
					lines.push("", `Verify context: \`/memoria sessions --read <path> <line>\``);
					emit(pi, `memoria sessions: ${oneLine(query, 60)}`, lines.join("\n"));
					return;
				}
				case "diff": {
					const days = remainder ? Number.parseInt(remainder, 10) : 7;
					const report = await runtime.diffReport(Number.isFinite(days) ? days : 7);
					const lines: string[] = [];
					if (report.created.length === 0 && report.updated.length === 0) {
						lines.push(`_No memories created or updated in the last ${Number.isFinite(days) ? days : 7} days._`);
					} else {
						if (report.created.length > 0) {
							lines.push(`**New (${report.created.length})**`);
							for (const entry of report.created.slice(0, 40)) lines.push(`- ${entry.title} \`${entry.relPath}\` (${entry.category || "(root)"})`);
						}
						if (report.updated.length > 0) {
							lines.push("", `**Updated (${report.updated.length})**`);
							for (const entry of report.updated.slice(0, 40)) lines.push(`- ${entry.title} \`${entry.relPath}\` (${entry.category || "(root)"})`);
						}
					}
					emit(pi, `memoria diff: last ${Number.isFinite(days) ? days : 7} days`, lines.join("\n"));
					return;
				}
				case "export": {
					const flags = remainder.split(/\s+/).filter(Boolean);
					// `--hot` exports MEMORY.md alone as a readable "about me" document.
					if (flags.includes("--hot")) {
						const fileArg = flags.find((flag) => !flag.startsWith("--"));
						const target = fileArg
							? isAbsolute(fileArg)
								? fileArg
								: resolve(ctx.cwd, fileArg)
							: resolve(ctx.cwd, "about-me.md");
						const hot = await runtime.hotState();
						await atomicWriteFile(target, `${hot.content.trim()}\n`);
						emit(pi, "memoria export", `Wrote MEMORY.md (${hot.chars} chars) to \`${target}\`.`);
						return;
					}
					const fileArg = flags.find((flag) => !flag.startsWith("--"));
					const { jsonl, notes } = await runtime.exportJsonl({ scope: "all" });
					const target = fileArg
						? isAbsolute(fileArg)
							? fileArg
							: resolve(ctx.cwd, fileArg)
						: resolve(ctx.cwd, `memoria-export-${new Date().toISOString().slice(0, 10)}.jsonl`);
					await atomicWriteFile(target, jsonl);
					emit(pi, "memoria export", `Exported ${notes} note(s) to \`${target}\` (${jsonl.length} bytes).`);
					return;
				}
				case "import": {
					if (!remainder) {
						ctx.ui.notify("Usage: /memoria import <file> [--merge|--replace|--skip] [--dry-run]", "warning");
						return;
					}
					const flags = remainder.split(/\s+/);
					const fileArg = flags.find((flag) => !flag.startsWith("--"));
					if (!fileArg) {
						ctx.ui.notify("Usage: /memoria import <file> [--merge|--replace|--skip] [--dry-run]", "warning");
						return;
					}
					const mode = flags.includes("--replace") ? "replace" : flags.includes("--skip") ? "skip" : "merge";
					const dryRun = flags.includes("--dry-run");
					const target = isAbsolute(fileArg) ? fileArg : resolve(ctx.cwd, fileArg);
					const { readFile } = await import("node:fs/promises");
					const payload = await readFile(target, "utf8");
					const result = await runtime.importJsonl(payload, { mode, dryRun });
					const lines = [
						`${dryRun ? "Dry run:" : "Imported"} ${result.created.length} new, ${result.updated.length} updated, ${result.skipped} skipped.`,
					];
					if (result.hotImported) lines.push("MEMORY.md restored.");
					if (result.errors.length > 0) lines.push("", "**Skipped records:**", ...result.errors.slice(0, 20).map((error) => `- ${error}`));
					emit(pi, `memoria import: ${oneLine(fileArg, 60)}`, lines.join("\n"));
					return;
				}
				case "learn": {
					ctx.ui.notify("Extracting durable memories from this session...", "info");
					const branch = ctx.sessionManager.getBranch() as ReadonlyArray<{ type?: string; message?: { role?: string; content?: unknown } }>;
					const result = await harvestSession(ctx, runtime, branch, {
						chunkChars: runtime.config.learnChunkChars,
						onProgress: (update) => {
							if (update.total > 1) {
								setStatus(ctx, `memoria: extracting memories... ${update.index}/${update.total}`);
								ctx.ui.notify(`Extracting memories (${update.index}/${update.total})...`, "info");
							}
						},
					});
					setStatus(ctx, undefined);
					const lines: string[] = [];
					if (result.error) lines.push(result.error);
					if (result.created.length > 0) lines.push(`**Created ${result.created.length}:**\n${result.created.map((id) => `- \`${id}\``).join("\n")}`);
					if (result.updated.length > 0) lines.push(`**Updated ${result.updated.length}:**\n${result.updated.map((id) => `- \`${id}\``).join("\n")}`);
					if (result.skipped > 0) lines.push(`_${result.skipped} candidate(s) could not be merged._`);
					emit(pi, "memoria learn", lines.join("\n\n") || "Nothing durable found in this session.");
					return;
				}
				case "paths": {
					const paths = runtime.paths();
					emit(
						pi,
						"memoria paths",
						[
							`- primary store: \`${runtime.displayPath(paths.primary)}\``,
							...(paths.project ? [`- project store: \`${runtime.displayPath(paths.project)}\``] : []),
							`- pi agent dir: \`${runtime.displayPath(paths.agentDir)}\``,
							`- MEMORY.md: \`${runtime.displayPath(paths.hot)}\``,
							`- library: \`${runtime.displayPath(paths.library)}\``,
							`- index: \`${runtime.displayPath(paths.indexDir)}\``,
							...paths.extras.map((extra) => `- extra root: \`${runtime.displayPath(extra)}\``),
							...paths.sessions.map((root) => `- session root: \`${runtime.displayPath(root)}\`${existsSync(root) ? "" : " _(missing)_"}`),
						].join("\n"),
					);
					return;
				}
				case "forget": {
					if (!remainder) {
						ctx.ui.notify("Usage: /memoria forget <id>", "warning");
						return;
					}
					const result = await runtime.forget(remainder, "all");
					if (!result) {
						ctx.ui.notify(`Memory not found: ${remainder}`, "error");
						return;
					}
					ctx.ui.notify(`Moved ${result.doc.id} to ${runtime.displayPath(result.trashPath)}`, "info");
					return;
				}
				default: {
					ctx.ui.notify(`Unknown subcommand: ${subcommand}. Try: ${SUBCOMMANDS.map((entry) => entry.value).join(", ")}`, "warning");
				}
			}
		},
	});
}

/** Update the footer status line. Safe in non-TUI modes (no-op). */
export function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus("memoria", text);
	} catch {
		// Status is best-effort; RPC/print modes may not support it.
	}
}
