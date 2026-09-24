import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLearnPrompt, buildTranscriptText, chunkTranscript, harvestSession, mergeTarget, parseLearnResponse } from "../src/learn.ts";
import { MemoriaRuntime } from "../src/runtime.ts";

test("buildTranscriptText keeps user and assistant text and skips tools", () => {
	const entries = [
		{ type: "message", message: { role: "system", content: "ignored" } },
		{ type: "message", message: { role: "user", content: "I prefer oat milk." } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Noted." }, { type: "toolCall", name: "read" }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file contents" }] } },
		{ type: "model_change" },
	];
	const text = buildTranscriptText(entries);
	assert.ok(text.includes("USER: I prefer oat milk."));
	assert.ok(text.includes("ASSISTANT: Noted."));
	assert.ok(!text.includes("file contents"));
	assert.ok(!text.includes("ignored"));
});

test("buildTranscriptText respects the character budget", () => {
	const entries = Array.from({ length: 50 }, (_, i) => ({
		type: "message",
		message: { role: "user", content: `message number ${i} ${"x".repeat(200)}` },
	}));
	const text = buildTranscriptText(entries, 1000);
	assert.ok(text.length <= 1000);
	assert.ok(text.includes("message number 49"));
});

test("buildLearnPrompt embeds rules and known titles", () => {
	const prompt = buildLearnPrompt("USER: hi", ["Existing note"]);
	assert.ok(prompt.includes("JSON array"));
	assert.ok(prompt.includes("Existing note"));
	assert.ok(prompt.includes("<conversation>"));
	assert.ok(prompt.includes("USER: hi"));
	// The extraction prompt must steer the model toward broad topics.
	assert.ok(prompt.includes("BROAD TOPIC"));
	assert.ok(prompt.includes("likes apples"));
});

test("parseLearnResponse accepts clean JSON", () => {
	const parsed = parseLearnResponse(
		JSON.stringify([
			{ topic: "Dietary preferences", label: "Drinks", content: "Alice drinks oat milk.", category: "people", tags: ["Alice", "diet"], summary: "Oat milk", priority: "high" },
		]),
	);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].topic, "Dietary preferences");
	assert.equal(parsed[0].label, "Drinks");
	assert.deepEqual(parsed[0].tags, ["alice", "diet"]);
	assert.equal(parsed[0].priority, "high");
});

test("parseLearnResponse tolerates code fences and prose", () => {
	const parsed = parseLearnResponse('Here you go:\n```json\n[{"topic":"T","content":"C","category":"bogus","priority":"urgent"}]\n```\nDone.');
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].category, "inbox");
	assert.equal(parsed[0].priority, "normal");
	assert.equal(parsed[0].summary, "C");
});

test("parseLearnResponse rejects malformed payloads", () => {
	assert.deepEqual(parseLearnResponse("no json here"), []);
	assert.deepEqual(parseLearnResponse("[not json]"), []);
	assert.deepEqual(parseLearnResponse('[{"topic":123,"content":"x"}]'), []);
	assert.deepEqual(parseLearnResponse('[{"topic":"ok"}]'), []);
});

test("mergeTarget updates near-duplicates and creates otherwise", () => {
	const candidate = { topic: "Dietary preferences", label: "", content: "", category: "people", tags: [], summary: "", priority: "normal" as const };
	const duplicate = mergeTarget(candidate, [{ id: "mem_1", title: "Dietary preferences notes", category: "people", score: 8 }]);
	assert.equal(duplicate, "mem_1");
	const differentCategory = mergeTarget(candidate, [{ id: "mem_2", title: "Dietary preferences notes", category: "projects", score: 20 }]);
	assert.equal(differentCategory, undefined);
	const unrelated = mergeTarget(candidate, [{ id: "mem_3", title: "Postgres version", category: "people", score: 1 }]);
	assert.equal(unrelated, undefined);
	const strongScore = mergeTarget(candidate, [{ id: "mem_4", title: "Something else entirely", category: "people", score: 20 }]);
	assert.equal(strongScore, "mem_4");
});

test("chunkTranscript splits at line boundaries and keeps the tail", () => {
	const transcript = Array.from({ length: 100 }, (_, i) => `USER: message number ${i} ${"x".repeat(50)}`).join("\n");
	const chunks = chunkTranscript(transcript, 1000, 4);
	assert.ok(chunks.length > 1 && chunks.length <= 4, `expected 2-4 chunks, got ${chunks.length}`);
	// The first chunk may be the result of folding the head, the rest must fit.
	for (const chunk of chunks.slice(1)) assert.ok(chunk.length <= 1000, `chunk was ${chunk.length} chars`);
	assert.ok(chunks[1].startsWith("USER:"), `chunks after the first start at a message boundary: ${JSON.stringify(chunks[1].slice(0, 20))}`);
	const bounded = chunkTranscript(transcript, 1000, 2);
	assert.equal(bounded.length, 2);
	assert.ok(bounded[1].includes("message number 99"), "the newest part of the conversation is always included");
	assert.deepEqual(chunkTranscript("short", 1000, 4), ["short"]);
});

test("harvestSession chunks a long session, reports progress and stores the result", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-learn-"));
	const home = await mkdtemp(join(tmpdir(), "memoria-learn-home-"));
	const runtime = new MemoriaRuntime(cwd, { home, agentDir: join(home, ".pi", "agent") });
	const entries = Array.from({ length: 40 }, (_, i) => ({
		type: "message",
		message: { role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ${"y".repeat(400)}` },
	}));
	const seenChunks: number[] = [];
	let calls = 0;
	const model = { provider: "test", id: "test-model" };
	const ctx = {
		model,
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls += 1;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify([
								{
									topic: "Client preferences",
									label: `Fact ${calls}`,
									content: `Durable fact number ${calls} from the session.`,
									category: "preferences",
									tags: ["session"],
									summary: `Fact ${calls}`,
									priority: "normal",
								},
							]),
						},
					],
				};
			},
		},
	};
	try {
		await runtime.init(true);
		const result = await harvestSession(ctx as never, runtime, entries, {
			chunkChars: 2000,
			onProgress: (update) => {
				if (update.phase === "extracting") seenChunks.push(update.index);
			},
		});
		assert.ok(result.chunks && result.chunks >= 2, `expected chunked extraction, got ${result.chunks}`);
		assert.deepEqual(seenChunks, [1, 2, 3, 4]);
		assert.equal(result.error, undefined);
		// Every chunk contributed a fact to the same broad topic.
		const entriesAfter = await runtime.listEntries("primary");
		assert.equal(entriesAfter.length, 1);
		assert.equal(entriesAfter[0].meta.title, "Client preferences");
		const doc = await runtime.readMemory(entriesAfter[0].meta.id, "primary");
		assert.ok(doc!.doc.body.includes("Durable fact number 1"));
		assert.ok(doc!.doc.body.includes("Durable fact number 4"));
	} finally {
		await runtime.dispose();
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});
