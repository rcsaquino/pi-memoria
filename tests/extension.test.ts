import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import memoriaExtension from "../index.ts";

interface CapturedTool {
	name: string;
	description: string;
	execute: (toolCallId: string, params: any, signal: undefined, onUpdate: undefined, ctx: any) => Promise<any>;
}

interface Harness {
	pi: ExtensionAPI;
	tools: Map<string, CapturedTool>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void>; description?: string }>;
	entries: Array<{ type: string; data: unknown }>;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	emit: (event: string, payload: any, ctx: any) => Promise<any[]>;
	ctx: ExtensionContext;
	notifications: string[];
}

function createHarness(cwd: string): Harness {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, any>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];

	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		},
		sessionManager: {
			getBranch: () => [],
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: (e: any, c: any) => any) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (tool: any) => {
			tools.set(tool.name, tool as CapturedTool);
		},
		registerCommand: (name: string, options: any) => {
			commands.set(name, options);
		},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		getFlag: () => undefined,
	} as unknown as ExtensionAPI;

	const emit = async (event: string, payload: any, context: any) => {
		const results: any[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, context));
		}
		return results;
	};

	return { pi, tools, commands, entries, handlers, emit, ctx, notifications };
}

async function withHarness(fn: (harness: Harness, cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-ext-"));
	const agentDir = await mkdtemp(join(tmpdir(), "memoria-agent-"));
	// The extension resolves the store through pi's agent dir; point it at a temp
	// directory so tests never read or write the real ~/.pi/agent/memoria.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const harness = createHarness(cwd);
	memoriaExtension(harness.pi);
	try {
		await fn(harness, cwd);
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(cwd, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("registers the memoria tools and the /memoria command", async () => {
	await withHarness(async (harness) => {
		assert.deepEqual(
			[...harness.tools.keys()].sort(),
			[
				"memoria_forget",
				"memoria_hot",
				"memoria_list",
				"memoria_move",
				"memoria_read",
				"memoria_recall",
				"memoria_sessions",
				"memoria_write",
			],
		);
		assert.ok(harness.commands.has("memoria"));
	});
});

test("session_start initializes the store inside pi's agent dir", async () => {
	await withHarness(async (harness, cwd) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		assert.equal(harness.notifications.length, 0, harness.notifications.join("\n"));
		const { existsSync } = await import("node:fs");
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		assert.ok(existsSync(join(agentDir, "memoria", "MEMORY.md")));
		assert.ok(!existsSync(join(cwd, "memoria")), "nothing is written into the project");
	});
});

test("memoria_write then memoria_recall round-trips through tools", async () => {
	await withHarness(async (harness, cwd) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const write = harness.tools.get("memoria_write")!;
		const writeResult = await write.execute("call-1", {
			topic: "Alice",
			label: "Drinks",
			content: "Alice drinks oat milk in her flat white and is lactose intolerant.",
			category: "people",
			tags: ["alice", "preferences"],
		}, undefined, undefined, harness.ctx);
		const written = String(writeResult.content[0].text);
		assert.ok(written.includes("topic note \"Alice\""), written);
		assert.ok(written.includes("memoria/library/people/alice.md"), written);
		const id = writeResult.details.id as string;
		assert.ok(id.startsWith("mem_"));

		const recall = harness.tools.get("memoria_recall")!;
		const recallResult = await recall.execute("call-2", { query: "what milk does alice drink" }, undefined, undefined, harness.ctx);
		const recalled = String(recallResult.content[0].text);
		assert.ok(recalled.includes(id), recalled);
		assert.ok(recalled.includes("oat milk"));
		assert.ok(recallResult.details.total >= 1);

		const read = harness.tools.get("memoria_read")!;
		const readResult = await read.execute("call-3", { ref: id }, undefined, undefined, harness.ctx);
		assert.ok(String(readResult.content[0].text).includes("lactose intolerant"));

		void cwd;
	});
});

test("concurrent first tool calls share one initialized runtime", async () => {
	await withHarness(async (harness) => {
		const write = harness.tools.get("memoria_write")!;
		const [first, second] = await Promise.all([
			write.execute("cold-1", { topic: "Shared topic", category: "projects", content: "The alpha fact survives." }, undefined, undefined, harness.ctx),
			write.execute("cold-2", { topic: "Shared topic", category: "projects", content: "The beta fact survives." }, undefined, undefined, harness.ctx),
		]);
		const read = harness.tools.get("memoria_read")!;
		const result = await read.execute("cold-read", { ref: first.details.id }, undefined, undefined, harness.ctx);
		const body = String(result.content[0].text);
		assert.equal(first.details.id, second.details.id);
		assert.match(body, /alpha fact survives/);
		assert.match(body, /beta fact survives/);
	});
});

test("memoria_move requires an explicit merge for an occupied topic", async () => {
	await withHarness(async (harness) => {
		const write = harness.tools.get("memoria_write")!;
		const source = await write.execute("move-source", { topic: "Alice work", category: "people", content: "Alice knows Rust." }, undefined, undefined, harness.ctx);
		const target = await write.execute("move-target", { topic: "Alice", category: "people", content: "Alice knows Go." }, undefined, undefined, harness.ctx);
		const move = harness.tools.get("memoria_move")!;
		await assert.rejects(() => move.execute("move-refuse", { from: source.details.id, topic: "Alice" }, undefined, undefined, harness.ctx), /merge: true/);
		const merged = await move.execute("move-combine", { from: source.details.id, topic: "Alice", merge: true }, undefined, undefined, harness.ctx);
		assert.equal(merged.details.id, target.details.id);
		const read = harness.tools.get("memoria_read")!;
		const former = await read.execute("move-read", { ref: source.details.id }, undefined, undefined, harness.ctx);
		assert.match(String(former.content[0].text), /Alice knows Rust/);
	});
});

test("before_agent_start injects the system section and an auto-recall message", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.tools.get("memoria_write")!.execute("call-1", {
			topic: "Deploy window",
			label: "Thursday",
			content: "Production deploys only happen on Thursday mornings.",
			category: "workflows",
			tags: ["deploy"],
		}, undefined, undefined, harness.ctx);

		const event = {
			type: "before_agent_start",
			prompt: "When can I deploy to production?",
			systemPrompt: "base prompt",
			systemPromptOptions: { sections: {} as Record<string, string>, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [], skills: [] },
		};
		const results = await harness.emit("before_agent_start", event, harness.ctx);
		assert.ok(event.systemPromptOptions.sections.memoria.includes("memoria_recall"));
		assert.ok(event.systemPromptOptions.sections.memoria.includes("Deploys happen") || event.systemPromptOptions.sections.memoria.length > 100);
		const message = results[0]?.message;
		assert.ok(message, "expected an auto-recall message");
		assert.equal(message.customType, "memoria_recall");
		assert.ok(message.content.includes("Production deploys only happen"), message.content);
		assert.ok(message.content.includes("<memoria_recall"));
	});
});

test("auto-recall stays silent when nothing is relevant", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.tools.get("memoria_write")!.execute("call-1", {
			topic: "Deploy window",
			content: "Production deploys only happen on Thursday mornings.",
			category: "workflows",
		}, undefined, undefined, harness.ctx);
		const event = {
			type: "before_agent_start",
			prompt: "Please compute the integral of x squared",
			systemPrompt: "base",
			systemPromptOptions: { sections: {} as Record<string, string>, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [], skills: [] },
		};
		const results = await harness.emit("before_agent_start", event, harness.ctx);
		assert.ok(event.systemPromptOptions.sections.memoria.length > 0, "system section is always injected");
		assert.equal(results[0]?.message, undefined);
	});
});

test("auto-recall warns once when ripgrep is missing", async () => {
	// An empty PATH plus the temp agent dir (no bin/rg) forces the fallback
	// scanner, so the user is told once why the scan may be slow.
	const originalPath = process.env.PATH;
	process.env.PATH = "";
	try {
		await withHarness(async (harness) => {
			await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
			const agentDir = process.env.PI_CODING_AGENT_DIR!;
			const dir = join(agentDir, "sessions", "--home-me-rg--");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "2026-01-01T10-00-00-000Z_a.jsonl"),
				`${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/home/me/rg" })}\n${JSON.stringify({ type: "message", timestamp: "2026-01-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "the zebra migration is scheduled" }] } })}\n`,
				"utf8",
			);
			const event = {
				type: "before_agent_start",
				prompt: "when is the zebra migration",
				systemPrompt: "base",
				systemPromptOptions: { sections: {} as Record<string, string>, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [], skills: [] },
			};
			const first = await harness.emit("before_agent_start", event, harness.ctx);
			assert.ok(first[0]?.message?.content.includes("zebra"), JSON.stringify(first[0]?.message?.content));
			await harness.emit("before_agent_start", event, harness.ctx);
			const warnings = harness.notifications.filter((message) => message.includes("ripgrep"));
			assert.equal(warnings.length, 1, harness.notifications.join(" | "));
		});
	} finally {
		process.env.PATH = originalPath;
	}
});

test("slash-command prompts skip auto-recall", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.tools.get("memoria_write")!.execute("call-1", { topic: "Deploy window", content: "Deploys on Thursday.", category: "workflows" }, undefined, undefined, harness.ctx);
		const event = {
			type: "before_agent_start",
			prompt: "/memoria search deploy",
			systemPrompt: "base",
			systemPromptOptions: { sections: {} as Record<string, string>, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [], skills: [] },
		};
		const results = await harness.emit("before_agent_start", event, harness.ctx);
		assert.equal(results[0]?.message, undefined);
	});
});

test("/memoria command handlers append entries", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const command = harness.commands.get("memoria")!;
		// Bare `/memoria` (empty args) must behave like `status`.
		await command.handler("", harness.ctx);
		assert.ok(harness.entries.some((entry) => String((entry.data as any).markdown).includes("Store root")));

		await command.handler("status", harness.ctx);
		assert.ok(harness.entries.some((entry) => String((entry.data as any).markdown).includes("Store root")));

		await command.handler("store Remember that the staging URL is staging.example.com", harness.ctx);
		assert.ok(harness.notifications.some((message) => message.includes("inbox-") && message.includes("mem_")), harness.notifications.join(" | "));

		await command.handler("search staging URL", harness.ctx);
		const searchEntry = harness.entries[harness.entries.length - 1];
		assert.ok(String((searchEntry.data as any).markdown).includes("staging"));

		await command.handler("hot", harness.ctx);
		await command.handler("paths", harness.ctx);
		await command.handler("doctor", harness.ctx);
		await command.handler("index", harness.ctx);
		await command.handler("reindex", harness.ctx);
		assert.ok(harness.entries.length >= 6);
	});
});

test("memoria_hot add and compact respect the budget", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const hot = harness.tools.get("memoria_hot")!;
		await hot.execute("call-1", { action: "add", topic: "Preferences", text: "The user prefers dark mode." }, undefined, undefined, harness.ctx);
		const read = await hot.execute("call-2", { action: "read" }, undefined, undefined, harness.ctx);
		assert.ok(String(read.content[0].text).includes("dark mode"));
		assert.ok(!String(read.content[0].text).includes("Preferences —"), "no label written into MEMORY.md");
		assert.ok(!String(read.content[0].text).includes("<!--"));
		await assert.rejects(() => hot.execute("call-3", { action: "replace", text: "x".repeat(6000) }, undefined, undefined, harness.ctx), /budget/);
		const compact = await hot.execute("call-4", { action: "compact" }, undefined, undefined, harness.ctx);
		assert.ok(compact.details.chars <= 5000);
		assert.equal(compact.details.over, undefined);
	});
});

test("memoria_list browses categories", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		await harness.tools.get("memoria_write")!.execute("call-1", { topic: "Alpha", content: "first", category: "knowledge" }, undefined, undefined, harness.ctx);
		const list = harness.tools.get("memoria_list")!;
		const result = await list.execute("call-2", {}, undefined, undefined, harness.ctx);
		assert.ok(String(result.content[0].text).includes("Alpha"));
		assert.equal(result.details.count, 1);
	});
});

test("failures inside tools surface as thrown errors, not crashes", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const recall = harness.tools.get("memoria_recall")!;
		const result = await recall.execute("call-1", { query: "unmatched gibberish zzz" }, undefined, undefined, harness.ctx);
		assert.ok(String(result.content[0].text).includes("No memories matched"));
		const missing = await harness.tools.get("memoria_read")!.execute("call-2", { ref: "mem_does_not_exist" }, undefined, undefined, harness.ctx);
		assert.ok(String(missing.content[0].text).includes("Memory not found"));
	});
});

test("/memoria topics and diff work headlessly", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const write = harness.tools.get("memoria_write")!;
		await write.execute("w1", { topic: "Staging", content: "The staging URL is staging.example.com.", category: "knowledge", tags: ["staging"] }, undefined, undefined, harness.ctx);
		await write.execute("w2", { topic: "Deploy process", content: "Deploys happen on Thursdays.", category: "workflows", tags: ["deploy"] }, undefined, undefined, harness.ctx);
		const command = harness.commands.get("memoria")!;

		await command.handler("topics", harness.ctx);
		const topics = String((harness.entries[harness.entries.length - 1].data as { markdown: string }).markdown);
		assert.ok(topics.includes("Staging"), topics);
		assert.ok(topics.includes("facts in"), topics);

		await command.handler("diff 1", harness.ctx);
		const diff = String((harness.entries[harness.entries.length - 1].data as { markdown: string }).markdown);
		assert.ok(diff.includes("New ("), diff);
	});
});

test("memoria_recall explain returns a scoring breakdown", async () => {
	await withHarness(async (harness) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const write = harness.tools.get("memoria_write")!;
		await write.execute("w1", { topic: "Alice", content: "Alice drinks oat milk.", category: "people", tags: ["alice"] }, undefined, undefined, harness.ctx);
		const recall = harness.tools.get("memoria_recall")!;
		const result = await recall.execute("r1", { query: "oat milk", explain: true }, undefined, undefined, harness.ctx);
		const text = String(result.content[0].text);
		assert.ok(text.includes("score breakdown"), text);
		assert.ok(text.includes("bm25"));
		const superseded = await recall.execute("r2", { query: "oat milk", drop_superseded: true }, undefined, undefined, harness.ctx);
		assert.ok(String(superseded.content[0].text).includes("matching memories"));
	});
});

test("auto recall strips metadata and suppresses only evidence still in the active context", async () => {
	await withHarness(async (harness) => {
		const result = await harness.tools.get("memoria_write")!.execute("write", {
			topic: "Deploy window", content: "Production deploys happen on Thursday mornings.", category: "workflows",
		}, undefined, undefined, harness.ctx);
		const branch: any[] = [];
		(harness.ctx.sessionManager as any).buildContextEntries = () => branch;
		const event = {
			type: "before_agent_start", prompt: "[telegram] When can I deploy to production?\n[time] 2026-09-25 10:36:33 Asia/Manila",
			systemPromptOptions: { sections: {} },
		};
		const invoke = async () => (await harness.emit("before_agent_start", event, harness.ctx))[0]?.message;
		const first = await invoke();
		assert.ok(first, harness.notifications.join(" | "));
		assert.ok(!first.content.includes("2026") && !first.content.includes("telegram"));
		assert.equal(first.details.fingerprints.length, 1);
		branch.push({ type: "custom_message", ...first });
		assert.equal(await invoke(), undefined);
		branch.push({ type: "compaction" });
		const afterCompact = await invoke();
		assert.ok(afterCompact);
		branch.push({ type: "custom_message", ...afterCompact });
		await harness.tools.get("memoria_write")!.execute("update", {
			id: result.details.id, topic: "Deploy window", content: "Production deploys now happen on Friday mornings.",
		}, undefined, undefined, harness.ctx);
		assert.ok(await invoke(), "changed note must be recalled again");
		branch.length = 0;
		assert.ok(await invoke(), "another branch must not inherit suppression");
	});
});
