/**
 * Session learning: extract durable memories from a conversation and merge
 * them into the library.
 *
 * The pure functions (`buildTranscriptText`, `buildLearnPrompt`,
 * `parseLearnResponse`, `mergeStrategy`) are testable without the pi runtime;
 * `harvestSession` wires them to the current model.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoriaRuntime } from "./runtime.ts";
import { oneLine, truncateChars } from "./util.ts";
import { tokenizeRaw } from "./tokenize.ts";
import type { Priority } from "./types.ts";

export interface LearnedMemory {
	/** Broad grouping name; becomes the file name and note title. */
	topic: string;
	/** Optional short label for this fact inside the topic note. */
	label: string;
	content: string;
	category: string;
	tags: string[];
	summary: string;
	priority: Priority;
}

export const LEARN_CATEGORIES = ["people", "projects", "preferences", "decisions", "knowledge", "workflows", "inbox"] as const;

const MAX_TRANSCRIPT_CHARS = 48_000;
const MAX_MESSAGE_CHARS = 1_600;
/** Upper bound on model calls per harvest. */
const MAX_CHUNKS = 4;

interface MessageEntryLike {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: string; text?: string; name?: string };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("\n");
}

/** Flatten session entries into a compact, role-tagged transcript. */
export function buildTranscriptText(entries: ReadonlyArray<MessageEntryLike>, maxChars = MAX_TRANSCRIPT_CHARS): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = truncateChars(oneLine(blockText(entry.message.content), MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS).trim();
		if (!text) continue;
		lines.push(`${role === "user" ? "USER" : "ASSISTANT"}: ${text}`);
	}
	const joined = lines.join("\n");
	// Keep the tail of the conversation when it does not fit; recent context is
	// usually where durable facts appear.
	return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * Split a transcript into chunks at line boundaries.
 *
 * Long sessions are harvested chunk by chunk so one huge prompt neither
 * truncates silently nor blocks the UI for the whole extraction. The tail is
 * kept when the transcript exceeds `maxChunks * chunkChars`, because that is
 * where the recent facts are. At most `maxChunks` chunks are returned; if line
 * rounding would produce more, the leading ones are folded together.
 */
export function chunkTranscript(transcript: string, chunkChars = 12_000, maxChunks = MAX_CHUNKS): string[] {
	const size = Math.max(1000, chunkChars);
	const bounded = transcript.length > size * maxChunks ? transcript.slice(transcript.length - size * maxChunks) : transcript;
	const lines = bounded.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let length = 0;
	for (const line of lines) {
		if (length + line.length + 1 > size && current.length > 0) {
			chunks.push(current.join("\n"));
			current = [];
			length = 0;
		}
		current.push(line);
		length += line.length + 1;
	}
	if (current.length > 0) chunks.push(current.join("\n"));
	// Line-boundary rounding can produce one extra chunk; fold the leading
	// extras into the first one so the caller can rely on the cap.
	if (chunks.length > maxChunks) {
		const overflow = chunks.length - maxChunks + 1;
		const merged = chunks.slice(0, overflow).join("\n");
		chunks.splice(0, overflow, merged);
	}
	return chunks;
}

export function buildLearnPrompt(transcript: string, knownTitles: string[] = []): string {
	const known = knownTitles.length > 0 ? `\nAlready stored (do not duplicate; update mentally instead):\n${knownTitles.slice(0, 60).map((title) => `- ${title}`).join("\n")}\n` : "";
	return [
		"You extract durable long-term memories from a conversation for a memory system.",
		"",
		"Memories are grouped by BROAD TOPIC, never by individual fact. The topic becomes the",
		"file name, so it must be a short noun phrase that many related facts could share.",
		"",
		"Return ONLY a JSON array (no prose, no code fences). Each element:",
		'{"topic": string (broad grouping, 1-4 words, a noun phrase), "label": string (short label for this fact, e.g. "Drinks"), "content": string (markdown, 1-6 sentences), "category": one of people|projects|preferences|decisions|knowledge|workflows|inbox, "tags": string[] (lowercase), "summary": string (one line), "priority": "low"|"normal"|"high"|"critical"}',
		"",
		"Topic rules (most important):",
		'- GOOD topics: "Dietary preferences", "Alice", "Deployment conventions", "Project Nightingale", "On-call rotation".',
		'- BAD topics (fact-shaped, will be rejected): "likes apples", "Alice prefers oat milk", "deploys happen on Thursdays".',
		"- Never invent a topic per fact. If several facts belong together, emit multiple elements with the SAME topic and different labels.",
		"",
		"Other rules:",
		"- Keep durable, reusable facts: user preferences, personal/professional context, project facts, decisions and their rationale, conventions, recurring workflows, lessons learned.",
		"- Skip transient task state, code that already lives in the repository, secrets, credentials, and anything the user asked to forget.",
		"- Do not record the assistant's unaccepted suggestions.",
		"- Prefer few high-quality notes over many trivial ones. Merge related facts into a single topic.",
		"- Use the user's own terminology. Write content that will still make sense months later without the conversation.",
		"- If nothing is worth remembering, return [].",
		known,
		"<conversation>",
		transcript,
		"</conversation>",
	].join("\n");
}

function coercePriority(value: unknown): Priority {
	if (value === "low" || value === "high" || value === "critical") return value;
	return "normal";
}

/** Parse the model's JSON array, tolerating code fences and stray prose. */
export function parseLearnResponse(text: string): LearnedMemory[] {
	const cleaned = text.replace(/```(?:json)?/gi, "").trim();
	const start = cleaned.indexOf("[");
	const end = cleaned.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: LearnedMemory[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		// `title` is accepted as a legacy alias for `topic`.
		const topic = typeof raw.topic === "string" ? raw.topic : typeof raw.title === "string" ? raw.title : "";
		if (!topic || typeof raw.content !== "string") continue;
		const label = typeof raw.label === "string" ? oneLine(raw.label, 80) : "";
		const content = raw.content.trim();
		if (!content) continue;
		const category = typeof raw.category === "string" && (LEARN_CATEGORIES as readonly string[]).includes(raw.category) ? raw.category : "inbox";
		const tags = Array.isArray(raw.tags) ? raw.tags.map((tag) => oneLine(String(tag), 40).toLowerCase()).filter(Boolean).slice(0, 12) : [];
		const summary = typeof raw.summary === "string" && raw.summary.trim() ? oneLine(raw.summary, 240) : oneLine(content, 240);
		out.push({ topic: oneLine(topic, 120), label, content, category, tags, summary, priority: coercePriority(raw.priority) });
		if (out.length >= 25) break;
	}
	return out;
}

/**
 * Decide whether a learned memory should update an existing one.
 * Returns the memory id to update, or undefined to create a new note.
 */
export function mergeTarget(
	candidate: LearnedMemory,
	existing: Array<{ id: string; title: string; category: string; score: number }>,
): string | undefined {
	const candidateTokens = new Set(tokenizeRaw(candidate.topic, { stopwords: true }));
	for (const entry of existing) {
		if (entry.category !== candidate.category) continue;
		const entryTokens = tokenizeRaw(entry.title, { stopwords: true });
		const overlap = entryTokens.filter((token) => candidateTokens.has(token)).length;
		const denominator = Math.max(1, Math.min(candidateTokens.size, entryTokens.length));
		const ratio = overlap / denominator;
		if (ratio >= 0.6 && entry.score > 3) return entry.id;
		if (entry.score > 14) return entry.id;
	}
	return undefined;
}

export interface HarvestResult {
	created: string[];
	updated: string[];
	skipped: number;
	error?: string;
	/** Number of extraction calls made. */
	chunks?: number;
}

export interface HarvestOptions {
	/** Characters per extraction chunk. */
	chunkChars?: number;
	/** Maximum extraction calls. */
	maxChunks?: number;
	/** Progress callback, used to keep the UI informed during long extractions. */
	onProgress?: (update: { phase: "extracting" | "merging" | "done"; index: number; total: number }) => void;
}

/**
 * Ask the current model to extract memories from the session and persist them.
 * Merges into near-duplicate existing notes instead of creating clones.
 */
export async function harvestSession(
	ctx: ExtensionContext,
	runtime: MemoriaRuntime,
	entries: ReadonlyArray<MessageEntryLike>,
	options: HarvestOptions = {},
): Promise<HarvestResult> {
	const result: HarvestResult = { created: [], updated: [], skipped: 0, chunks: 0 };
	const transcript = buildTranscriptText(entries);
	if (transcript.length < 200) {
		return { ...result, error: "Conversation is too short to learn from." };
	}
	const model = ctx.model;
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { ...result, error: "No authenticated model available for extraction." };
	}
	const chunks = chunkTranscript(transcript, options.chunkChars ?? 12_000, options.maxChunks ?? MAX_CHUNKS);
	const knownTitles = (await runtime.listEntries("all")).map((entry) => entry.meta.title);
	const candidates: LearnedMemory[] = [];
	const seenCandidates = new Set<string>();
	for (let index = 0; index < chunks.length; index += 1) {
		options.onProgress?.({ phase: "extracting", index: index + 1, total: chunks.length });
		const prompt = buildLearnPrompt(chunks[index], knownTitles);
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens: 4096, cacheRetention: "none" },
		);
		result.chunks = index + 1;
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		for (const candidate of parseLearnResponse(text)) {
			const key = `${candidate.category}:${candidate.topic.toLowerCase()}::${candidate.content.toLowerCase().slice(0, 60)}`;
			if (seenCandidates.has(key)) continue;
			seenCandidates.add(key);
			candidates.push(candidate);
		}
	}
	if (candidates.length === 0) {
		return { ...result, error: "The model found nothing durable to store." };
	}
	options.onProgress?.({ phase: "merging", index: chunks.length, total: chunks.length });
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const dedupeKey = `${candidate.category}:${candidate.topic.toLowerCase()}`;
		const search = await runtime.search(`${candidate.topic} ${candidate.tags.join(" ")}`, { limit: 3, scope: "all" });
		const existing = search.hits.map((hit) => ({ id: hit.doc.id, title: hit.doc.title, category: hit.doc.category, score: hit.score }));
		const target = seen.has(dedupeKey) ? undefined : mergeTarget(candidate, existing);
		if (target) {
			const appended = await runtime.appendToNote(target, {
				content: candidate.content,
				label: candidate.label,
				tags: candidate.tags,
				summary: candidate.summary,
				priority: candidate.priority,
				source: "session-extract",
			});
			if (appended?.duplicate) result.skipped += 1;
			else if (appended) result.updated.push(appended.doc.id);
			else result.skipped += 1;
			seen.add(dedupeKey);
			continue;
		}
		const written = await runtime.write({
			topic: candidate.topic,
			content: candidate.content,
			label: candidate.label,
			category: candidate.category,
			tags: candidate.tags,
			summary: candidate.summary,
			priority: candidate.priority,
			source: "session-extract",
		});
		if (written.result.duplicate) result.skipped += 1;
		else if (written.result.updated) result.updated.push(written.result.doc.id);
		else result.created.push(written.result.doc.id);
		seen.add(dedupeKey);
	}
	options.onProgress?.({ phase: "done", index: chunks.length, total: chunks.length });
	return result;
}
