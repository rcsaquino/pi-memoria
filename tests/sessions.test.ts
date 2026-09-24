/**
 * Session transcript search: fixtures mimic pi's JSONL session format so the
 * parsing, ranking, caching and window-reading behaviour is covered without
 * touching a real agent directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, buildExcerpt, extractMessageText, findPhrase, normalizeForSessionMatch } from "../src/sessions.ts";
import { MemoriaRuntime } from "../src/runtime.ts";
import { renderRecallBlock, renderSystemSection, renderSessionFallback } from "../src/recall.ts";
import { registerMemoriaTools } from "../src/tools.ts";

interface FakeEntry {
	role?: "user" | "assistant" | "toolResult" | "system";
	text?: string;
	thinking?: string;
	tool?: Record<string, unknown>;
	at?: string;
}

/** Write a transcript in pi's JSONL shape. */
async function writeSession(
	root: string,
	dir: string,
	name: string,
	entries: FakeEntry[],
	options: { cwd?: string; startedAt?: string; corrupt?: boolean } = {},
): Promise<string> {
	const targetDir = join(root, dir);
	await mkdir(targetDir, { recursive: true });
	const startedAt = options.startedAt ?? "2026-01-01T10:00:00.000Z";
	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: name, timestamp: startedAt, cwd: options.cwd ?? `/home/me/${dir.replace(/^-+|-+$/g, "")}` }),
	];
	let time = Date.parse(startedAt);
	entries.forEach((entry, index) => {
		time += 1000;
		const content: unknown[] = [];
		if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking, thinkingSignature: "sig" });
		if (entry.text !== undefined) content.push({ type: "text", text: entry.text });
		if (entry.tool) content.push({ type: "toolCall", id: `call_${index}`, name: String(entry.tool.name ?? "bash"), arguments: entry.tool.arguments ?? {} });
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp: new Date(time).toISOString(),
				message: { role: entry.role ?? "user", content, timestamp: time },
			}),
		);
	});
	if (options.corrupt) lines.splice(1, 0, "{not json at all");
	await writeFile(join(targetDir, `${name}.jsonl`), `${lines.join("\n")}\n`, "utf8");
	return join(targetDir, `${name}.jsonl`);
}

async function withSessions(
	fn: (context: { root: string; store: SessionStore }) => Promise<void>,
	options: { cacheBytes?: number } = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "memoria-sessions-"));
	try {
		const store = new SessionStore({ roots: [root], cacheBytes: options.cacheBytes ?? 8 * 1024 * 1024, excerptChars: 200 });
		await fn({ root, store });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------ */
/* Extraction and normalization                                        */
/* ------------------------------------------------------------------ */

test("normalization folds case, punctuation and unicode", () => {
	assert.equal(normalizeForSessionMatch("  Oat-MILK!!  "), "oat milk");
	assert.equal(normalizeForSessionMatch("l’art"), "l art");
	assert.equal(normalizeForSessionMatch("日本語、テスト"), "日本語 テスト");
});

test("extractMessageText skips thinking and tool plumbing unless asked", () => {
	const content = [
		{ type: "thinking", thinking: "SECRET REASONING" },
		{ type: "text", text: "Visible answer." },
		{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
	];
	const plain = extractMessageText("assistant", content, false);
	assert.equal(plain, "Visible answer.");
	const withTools = extractMessageText("assistant", content, true);
	assert.ok(withTools.includes("Visible answer."));
	assert.ok(withTools.includes("ls -la"));
	assert.ok(!withTools.includes("SECRET REASONING"), "thinking is never evidence");
	// Tool results are only readable through the tool flag.
	assert.equal(extractMessageText("toolResult", [{ type: "text", text: "output" }], false), "");
	assert.equal(extractMessageText("toolResult", [{ type: "text", text: "output" }], true), "output");
});

test("findPhrase and buildExcerpt locate and bound the match", () => {
	const text = `${"padding ".repeat(60)}the deploy window moved to Tuesday after lunch${" trailing".repeat(60)}`;
	const at = findPhrase(text, ["deploy window moved"], []);
	assert.ok(at > 0);
	const excerpt = buildExcerpt(text, ["deploy window moved"], [], 120);
	assert.ok(excerpt.length <= 130, `excerpt was ${excerpt.length} chars`);
	assert.ok(excerpt.includes("deploy window moved"));
	assert.ok(excerpt.startsWith("…"));
	assert.ok(excerpt.endsWith("…"));
	// Short messages are returned whole.
	assert.equal(buildExcerpt("short note", ["short"], [], 200), "short note");
});

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

test("finds a verbatim phrase and marks it exact", async () => {
	await withSessions(async ({ root, store }) => {
		await writeSession(root, "--home-me-proj--", "2026-01-01T10-00-00-000Z_a", [
			{ role: "user", text: "Remember that the deploy window is Thursday morning." },
			{ role: "assistant", text: "Noted." },
		]);
		await writeSession(root, "--home-me-proj--", "2026-02-01T10-00-00-000Z_b", [
			{ role: "user", text: "Unrelated conversation about gardening." },
			{ role: "assistant", text: "The deploy window moved to Tuesday after the incident." },
		]);
		const result = await store.search("deploy window moved", { limit: 5, budgetMs: 10_000 });
		// Both messages share terms, but the verbatim phrase must rank first.
		assert.equal(result.hits.length, 2, JSON.stringify(result.hits));
		assert.equal(result.hits[0].exact, true);
		assert.equal(result.hits[0].role, "assistant");
		assert.equal(result.hits[0].relPath, "--home-me-proj--/2026-02-01T10-00-00-000Z_b.jsonl");
		assert.equal(result.hits[1].exact, false);
		assert.ok(result.hits[0].excerpt.includes("moved to Tuesday"));
		assert.equal(result.stats.partial, false);
		assert.equal(result.stats.skipped, 0);
	});
});

test("ranks user evidence above assistant text when the match is equal", async () => {
	await withSessions(async ({ root, store }) => {
		await writeSession(root, "--home-me-a--", "2026-01-01T10-00-00-000Z_a", [
			{ role: "assistant", text: "Your favourite fruit is mango." },
			{ role: "user", text: "My favourite fruit is mango." },
		]);
		const result = await store.search("favourite fruit mango", { limit: 5, budgetMs: 10_000 });
		assert.equal(result.hits.length, 2);
		assert.equal(result.hits[0].role, "user");
	});
});

test("searches CJK text and tolerates case and punctuation differences", async () => {
	await withSessions(async ({ root, store }) => {
		await writeSession(root, "--home-me-cjk--", "2026-01-01T10-00-00-000Z_a", [
			{ role: "user", text: "東京タワーの展望台は150メートルです。" },
			{ role: "assistant", text: "OAT-MILK!!! is the order." },
		]);
		const cjk = await store.search("東京タワー", { limit: 5, budgetMs: 10_000 });
		assert.equal(cjk.hits.length, 1);
		assert.equal(cjk.hits[0].role, "user");
		const folded = await store.search("oat milk", { limit: 5, budgetMs: 10_000 });
		assert.equal(folded.hits.length, 1);
		assert.equal(folded.hits[0].role, "assistant");
	});
});

test("tool results, compaction summaries and custom payloads need includeTools", async () => {
	await withSessions(async ({ root, store }) => {
		const path = await writeSession(root, "--home-me-tools--", "2026-01-01T10-00-00-000Z_a", [
			{ role: "user", text: "Please inspect the pineapple configuration." },
			{ role: "assistant", text: "Running the check.", tool: { name: "bash", arguments: { command: "grep pineapple config.yml" } } },
			{ role: "toolResult", text: "pineapple: enabled in config.yml" },
		]);
		// Append derived entries at the end of the transcript.
		const extra = [
			JSON.stringify({ type: "compaction", timestamp: "2026-01-01T10:00:10.000Z", summary: "Discussion about pineapple migrations and rollback." }),
			JSON.stringify({ type: "custom", timestamp: "2026-01-01T10:00:11.000Z", customType: "web-search-results", data: { title: "Pineapple docs", url: "https://example.com/pineapple" } }),
		].join("\n");
		const existing = await (await import("node:fs/promises")).readFile(path, "utf8");
		await writeFile(path, `${existing}${extra}\n`, "utf8");
		const plain = await store.search("pineapple", { limit: 10, budgetMs: 10_000 });
		assert.ok(plain.hits.every((hit) => hit.role === "user" || hit.role === "assistant"), JSON.stringify(plain.hits.map((hit) => hit.role)));
		const withTools = await store.search("pineapple", { limit: 10, budgetMs: 10_000, includeTools: true });
		const roles = new Set(withTools.hits.map((hit) => hit.role));
		assert.ok(roles.has("tool"), `tool results should be searchable: ${[...roles].join(", ")}`);
		assert.ok(roles.has("summary"), `compaction summaries should be searchable: ${[...roles].join(", ")}`);
		assert.ok(withTools.hits.some((hit) => hit.excerpt.includes("Pineapple docs")), "custom payload text should be searchable");
	});
});

test("user_only, since_days and project filters narrow the corpus", async () => {
	await withSessions(async ({ root, store }) => {
		await writeSession(root, "--home-me-old--", "2026-01-01T10-00-00-000Z_old", [{ role: "user", text: "ancient pineapple note" }], { cwd: "/home/me/old", startedAt: "2026-01-01T10:00:00.000Z" });
		await writeSession(root, "--home-me-new--", "2026-09-01T10-00-00-000Z_new", [
			{ role: "user", text: "recent pineapple question" },
			{ role: "assistant", text: "recent pineapple answer" },
		], { cwd: "/home/me/new", startedAt: "2026-09-01T10:00:00.000Z" });
		const all = await store.search("pineapple", { limit: 10, budgetMs: 10_000 });
		assert.equal(all.hits.length, 3);
		const users = await store.search("pineapple", { limit: 10, budgetMs: 10_000, userOnly: true });
		assert.equal(users.hits.length, 2);
		const recent = await store.search("pineapple", { limit: 10, budgetMs: 10_000, sinceDays: 30 });
		assert.equal(recent.hits.length, 2);
		assert.ok(recent.hits.every((hit) => hit.project.includes("new")));
		const project = await store.search("pineapple", { limit: 10, budgetMs: 10_000, project: "old" });
		assert.equal(project.hits.length, 1);
		// The transcript header records the real working directory.
		assert.equal(project.hits[0].project, "/home/me/old");
		assert.equal(project.hits[0].projectName, "old");
	});
});

test("a tiny budget reports a partial scan instead of hanging", async () => {
	await withSessions(async ({ root, store }) => {
		for (let i = 0; i < 40; i += 1) {
			await writeSession(root, "--home-me-many--", `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10-00-00-000Z_${i}`, [
				{ role: "user", text: `pineapple conversation number ${i}` },
			]);
		}
		const result = await store.search("pineapple", { limit: 5, budgetMs: 0.0001 });
		assert.equal(result.stats.partial, true);
		assert.ok(result.stats.files < 40, `expected an early stop, scanned ${result.stats.files} files`);
	});
});

test("corrupt lines, symlinks and empty files are skipped and counted", async () => {
	await withSessions(async ({ root, store }) => {
		await writeSession(root, "--home-me-bad--", "2026-01-01T10-00-00-000Z_bad", [{ role: "user", text: "pineapple survives corruption" }], { corrupt: true });
		await writeFile(join(root, "--home-me-bad--", "empty.jsonl"), "", "utf8");
		const outside = await mkdtemp(join(tmpdir(), "memoria-sessions-outside-"));
		await writeFile(join(outside, "target.jsonl"), `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "pineapple symlink" }] } })}\n`, "utf8");
		await symlink(join(outside, "target.jsonl"), join(root, "--home-me-bad--", "link.jsonl"));
		try {
			const result = await store.search("pineapple", { limit: 5, budgetMs: 10_000 });
			assert.equal(result.hits.length, 1);
			assert.ok(result.stats.skipped >= 1, "the corrupt line is reported");
			assert.equal(result.hits[0].excerpt.includes("survives corruption"), true);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("parsed transcripts are cached and re-read when the file changes", async () => {
	await withSessions(async ({ root, store }) => {
		const path = await writeSession(root, "--home-me-cache--", "2026-01-01T10-00-00-000Z_a", [{ role: "user", text: "first pineapple note" }]);
		const first = await store.search("pineapple", { limit: 5, budgetMs: 10_000 });
		assert.equal(first.stats.cachedFiles, 0);
		assert.equal(store.cachedFileCount, 1);
		const second = await store.search("pineapple", { limit: 5, budgetMs: 10_000 });
		assert.equal(second.stats.cachedFiles, 1, "the second search is served from memory");
		assert.equal(second.hits[0].excerpt, first.hits[0].excerpt);
		// Rewrite with different content and a newer mtime.
		await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/home/me/cache" })}\n${JSON.stringify({ type: "message", timestamp: "2026-01-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "rewritten mango note with extra length" }] } })}\n`, "utf8");
		const future = new Date(Date.now() + 5000);
		await utimes(path, future, future);
		const third = await store.search("mango", { limit: 5, budgetMs: 10_000 });
		assert.equal(third.hits.length, 1);
		assert.ok(third.hits[0].excerpt.includes("rewritten mango"));
		const gone = await store.search("pineapple", { limit: 5, budgetMs: 10_000, includeTools: true });
		assert.equal(gone.hits.length, 0, "the stale cached text is gone");
	});
});

test("readWindow returns surrounding dialogue and refuses unsafe paths", async () => {
	await withSessions(async ({ root, store }) => {
		const path = await writeSession(root, "--home-me-window--", "2026-01-01T10-00-00-000Z_a", [
			{ role: "user", text: "First question about deploys." },
			{ role: "assistant", text: "Deploys happen on Thursday." },
			{ role: "user", text: "Correction: deploys moved to Tuesday." },
			{ role: "assistant", text: "Understood, Tuesday." },
		]);
		const window = await store.readWindow(path, 3, 2);
		assert.ok(window);
		assert.equal(window!.messages.length, 4);
		assert.equal(window!.messages[0].role, "user");
		assert.ok(window!.messages.some((message) => message.text.includes("Correction")));
		assert.equal(window!.relPath, "--home-me-window--/2026-01-01T10-00-00-000Z_a.jsonl");
		assert.equal(await store.readWindow("/etc/hostname", 1, 2), undefined, "paths outside the roots are refused");
		assert.equal(await store.readWindow(join(root, "missing.jsonl"), 1, 2), undefined);
		assert.equal(await store.readWindow(path, 0, 2), undefined);
		assert.equal((await store.readWindow(path, 2, 0))!.messages.length, 1, "a zero window returns just that line");
	});
});

test("a missing sessions directory yields an empty result", async () => {
	const store = new SessionStore({ roots: [join(tmpdir(), "memoria-sessions-does-not-exist")] });
	const result = await store.search("anything", { budgetMs: 100 });
	assert.deepEqual(result.hits, []);
	assert.deepEqual(result.stats.roots, []);
	assert.equal(store.hasRoots(), false);
	assert.equal(await store.readWindow("/tmp/whatever.jsonl", 1, 3), undefined);
});

/* ------------------------------------------------------------------ */
/* Runtime and extension integration                                   */
/* ------------------------------------------------------------------ */

async function withAgentDir(fn: (context: { runtime: MemoriaRuntime; agentDir: string; sessions: string; cwd: string; home: string }) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-session-cwd-"));
	const home = await mkdtemp(join(tmpdir(), "memoria-session-home-"));
	const agentDir = join(home, ".pi", "agent");
	const sessions = join(agentDir, "sessions");
	await mkdir(sessions, { recursive: true });
	const runtime = new MemoriaRuntime(cwd, { home, agentDir });
	try {
		await runtime.init(true);
		await fn({ runtime, agentDir, sessions, cwd, home });
	} finally {
		await runtime.dispose();
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
}

test("the runtime searches real session roots and falls back only on an empty library", async () => {
	await withAgentDir(async ({ runtime, sessions }) => {
		await writeSession(sessions, "--home-me-proj--", "2026-01-01T10-00-00-000Z_a", [
			{ role: "user", text: "We agreed the deploy window is Thursday morning." },
			{ role: "assistant", text: "Confirmed: Thursday morning deploy window." },
		]);
		assert.deepEqual(runtime.sessionRoots(), [sessions, join(sessions, "..", "sessions-archive")]);

		// Explicit search.
		const found = await runtime.sessionSearch("deploy window thursday", { limit: 3, budgetMs: 10_000 });
		assert.equal(found.hits.length, 2);
		assert.equal(found.stats.files, 1);
		assert.equal(found.stats.cachedFiles, 0);

		// Fallback: nothing in the library, so the transcripts are attached.
		const recalled = await runtime.recall("what did we agree about the deploy window?", { scope: "primary" });
		assert.equal(recalled.hits.length, 0);
		assert.ok(recalled.sessionHits && recalled.sessionHits.length > 0, JSON.stringify(recalled.sessionHits));
		assert.ok(recalled.sessionStats && recalled.sessionStats.files >= 1);

		// Once the library knows the fact, no session fallback is needed.
		await runtime.write({ topic: "Deploy process", content: "The deploy window is Thursday morning.", category: "workflows" });
		const withMemory = await runtime.recall("what did we agree about the deploy window?", { scope: "primary" });
		assert.ok(withMemory.hits.length > 0);
		assert.equal(withMemory.sessionHits, undefined);

		// The window read works through the runtime as well.
		const hit = recalled.sessionHits![0];
		const window = await runtime.sessionRead(hit.path, hit.line, 2);
		assert.ok(window && window.messages.length >= 1);

		// Disabling the feature stops the fallback but leaves the library alone.
		await runtime.reconfigure({ ...runtime.config, sessionFallback: false });
		const noFallback = await runtime.recall("something entirely absent from memory", { scope: "primary" });
		assert.equal(noFallback.sessionHits, undefined);
		const disabled = await runtime.sessionSearch("deploy", { limit: 3 });
		assert.ok(disabled.hits.length > 0);
		await runtime.reconfigure({ ...runtime.config, sessionSearch: false });
		assert.deepEqual((await runtime.sessionSearch("deploy", {})).hits, []);
	});
});

test("an explicit session search can be pointed at an extra root", async () => {
	await withAgentDir(async ({ runtime, home }) => {
		const extra = join(home, "archive");
		await writeSession(extra, "--home-me-archived--", "2025-05-01T10-00-00-000Z_a", [{ role: "user", text: "archived pineapple decision" }], { cwd: "/home/me/archived" });
		await runtime.reconfigure({ ...runtime.config, sessionRoots: [extra] });
		const result = await runtime.sessionSearch("pineapple decision", { limit: 5, budgetMs: 10_000 });
		assert.equal(result.hits.length, 1);
		assert.equal(result.stats.roots.includes(extra), true);
		assert.equal(runtime.sessionRoots()[0], extra);
	});
});

test("the recall renderers label session evidence and keep it separate", async () => {
	const hits = [
		{
			path: "/home/me/.pi/agent/sessions/p/2026-01-01T10-00-00-000Z_a.jsonl",
			relPath: "p/2026-01-01T10-00-00-000Z_a.jsonl",
			project: "/home/me/proj",
			projectName: "proj",
			line: 12,
			role: "user" as const,
			timestamp: Date.parse("2026-01-01T10:00:00.000Z"),
			score: 125,
			matched: ["deploy", "thursday"],
			exact: true,
			excerpt: "the deploy window is Thursday morning",
		},
	];
	const fallback = renderSessionFallback(hits, { files: 3, messages: 20, partial: false });
	assert.ok(fallback.includes("No memory note matched"));
	assert.ok(fallback.includes("not curated memory"));
	assert.ok(fallback.includes("memoria_sessions"));
	assert.ok(fallback.includes(":12"), fallback);

	const block = renderRecallBlock({ query: "deploy window", hits: [], maxChars: 1200, tookMs: 4, sessionHits: hits, sessionStats: { files: 3, messages: 20, partial: false } });
	assert.ok(block.startsWith("<memoria_recall"));
	assert.ok(block.includes("past") || block.includes("earlier conversations"), block);
	assert.ok(block.includes("2026-01-01"));
	const system = renderSystemSection({ root: "/root", hotContent: "", hotChars: 0, hotLimit: 5000, hotOver: false, categories: [], totalDocs: 0, indexTookMs: 0 });
	assert.ok(system.includes("memoria_sessions"), "the system prompt tells the agent about session search");
});

test("the memoria_sessions tool searches and reads transcripts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-session-tool-"));
	const home = await mkdtemp(join(tmpdir(), "memoria-session-tool-home-"));
	const agentDir = join(home, ".pi", "agent");
	const sessions = join(agentDir, "sessions");
	await mkdir(sessions, { recursive: true });
	await writeSession(sessions, "--home-me-tool--", "2026-01-01T10-00-00-000Z_a", [
		{ role: "user", text: "Let us use the pineapple release process." },
		{ role: "assistant", text: "Pineapple release process noted." },
	]);
	const runtime = new MemoriaRuntime(cwd, { home, agentDir });
	const tools = new Map<string, { execute: (id: string, params: any, signal: undefined, update: undefined, ctx: unknown) => Promise<any> }>();
	const pi = {
		registerTool: (definition: any) => {
			tools.set(definition.name, definition);
		},
	} as never;
	registerMemoriaTools(pi, async () => runtime);
	const ctx = { cwd } as never;
	try {
		await runtime.init(true);
		const sessionsTool = tools.get("memoria_sessions")!;
		assert.ok(sessionsTool, "memoria_sessions is registered");
		const search = await sessionsTool.execute("s1", { action: "search", query: "pineapple release process" }, undefined, undefined, ctx);
		const searchText = String(search.content[0].text);
		assert.ok(searchText.includes("pineapple release process"), searchText);
		assert.ok(searchText.includes("file:"), searchText);
		const read = await sessionsTool.execute("s2", { action: "read", path: join(sessions, "--home-me-tool--", "2026-01-01T10-00-00-000Z_a.jsonl"), line: 2, window: 2 }, undefined, undefined, ctx);
		const readText = String(read.content[0].text);
		assert.ok(readText.includes("pineapple release process"));
		assert.ok(readText.includes("latest correction"), readText);
		const missing = await sessionsTool.execute("s3", { action: "search", query: "definitely-not-there-anywhere" }, undefined, undefined, ctx);
		assert.ok(String(missing.content[0].text).includes("No saved conversation matched"));
		await assert.rejects(() => sessionsTool.execute("s4", { action: "read", path: "/etc/hostname", line: 1 }, undefined, undefined, ctx).then((value) => {
			if (String(value.content[0].text).includes("No transcript window")) throw new Error("refused");
			return value;
		}));
	} finally {
		await runtime.dispose();
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});

test("both skills ship with frontmatter that describes when to load them", async () => {
	for (const name of ["memoria", "memoria-sessions"]) {
		const path = join("skills", name, "SKILL.md");
		assert.ok(existsSync(path), `${path} exists`);
		const content = await (await import("node:fs/promises")).readFile(path, "utf8");
		assert.match(content, /^---\nname: [a-z-]+\ndescription: .+\n---/m, `${path} has skill frontmatter`);
	}
});

test("the listing itself is bounded and reports truncation", async () => {
	await withSessions(async ({ root, store }) => {
		for (let i = 0; i < 6; i += 1) {
			await writeSession(root, `--home-me-p${i}--`, `2026-01-0${i + 1}T10-00-00-000Z_s${i}`, [{ role: "user", text: `pineapple in project ${i}` }], {
				cwd: `/home/me/p${i}`,
				startedAt: `2026-01-0${i + 1}T10:00:00.000Z`,
			});
		}
		const all = await store.listFiles();
		assert.equal(all.files.length, 6);
		assert.equal(all.truncated, false);
		const capped = await store.listFiles({ maxFiles: 2 });
		assert.equal(capped.files.length, 2);
		assert.equal(capped.truncated, true);
		// Newest sessions survive the cap.
		assert.deepEqual(capped.files.map((file) => file.projectName).sort(), ["p4", "p5"]);

		// An exhausted deadline stops the walk before any file is parsed, and the
		// scan says so instead of implying the corpus was fully searched.
		store.clear();
		const starved = await store.listFiles({ deadline: performance.now() - 1 });
		assert.equal(starved.truncated, true);
		assert.equal(starved.files.length, 0);
	});
});

test("a partial search reports that its coverage was incomplete", async () => {
	await withSessions(async ({ root, store }) => {
		for (let i = 0; i < 12; i += 1) {
			await writeSession(root, `--home-me-q${i}--`, `2026-02-${String(i + 1).padStart(2, "0")}T10-00-00-000Z_s${i}`, [{ role: "user", text: `mango note ${i}` }], { cwd: `/home/me/q${i}` });
		}
		const partial = await store.search("mango", { limit: 20, budgetMs: 0.0001 });
		assert.equal(partial.stats.partial, true, "a starved budget is flagged");
		assert.equal(partial.stats.files, 0);
		// Full budget: everything is covered and nothing is flagged.
		const complete = await store.search("mango", { limit: 20, budgetMs: 20_000 });
		assert.equal(complete.stats.partial, false);
		assert.equal(complete.stats.files, 12);
		assert.equal(complete.hits.length, 12);
	});
});
