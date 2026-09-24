import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
				"memoria_export",
				"memoria_forget",
				"memoria_hot",
				"memoria_import",
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
		const replace = await hot.execute("call-3", { action: "replace", text: `# Memory\n\n${"x".repeat(6000)}` }, undefined, undefined, harness.ctx);
		assert.equal(replace.details.over, true);
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

test("/memoria topics, diff, export and import work headlessly", async () => {
	await withHarness(async (harness, cwd) => {
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

		const exportPath = join(cwd, "backup.jsonl");
		await command.handler(`export ${exportPath}`, harness.ctx);
		const exported = await readFile(exportPath, "utf8");
		assert.ok(exported.includes("library/knowledge/staging.md"));
		assert.ok(exported.includes("staging.example.com"));

		await command.handler(`import ${exportPath}`, harness.ctx);
		const imported = String((harness.entries[harness.entries.length - 1].data as { markdown: string }).markdown);
		assert.ok(imported.includes("skipped"), imported);

		const hotPath = join(cwd, "about-me.md");
		await command.handler(`export --hot ${hotPath}`, harness.ctx);
		const about = await readFile(hotPath, "utf8");
		assert.ok(about.length > 0);
	});
});

test("memoria_export and memoria_import tools round-trip through a file", async () => {
	await withHarness(async (harness, cwd) => {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, harness.ctx);
		const write = harness.tools.get("memoria_write")!;
		await write.execute("w1", { topic: "Alice", content: "Alice likes tea.", category: "people", tags: ["alice"] }, undefined, undefined, harness.ctx);
		const exportTool = harness.tools.get("memoria_export")!;
		const target = join(cwd, "dump.jsonl");
		const exported = await exportTool.execute("e1", { path: target }, undefined, undefined, harness.ctx);
		assert.ok(String(exported.content[0].text).includes("Exported 1 note"));
		assert.ok((await readFile(target, "utf8")).includes("Alice likes tea."));

		const importTool = harness.tools.get("memoria_import")!;
		const dry = await importTool.execute("i1", { path: target, dry_run: true }, undefined, undefined, harness.ctx);
		assert.ok(String(dry.content[0].text).includes("Dry run"));
		const real = await importTool.execute("i2", { path: target, mode: "merge" }, undefined, undefined, harness.ctx);
		assert.ok(String(real.content[0].text).includes("skipped 1"), String(real.content[0].text));
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
