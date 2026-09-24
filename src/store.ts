/**
 * Filesystem layer: reading, writing and organizing markdown memories.
 *
 * All documented behavior lives here so the index engine and search layers stay
 * pure and testable.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parseDateValue, splitFrontmatter, stringifyWithFrontmatter } from "./frontmatter.ts";
import { accumulateTokens, stem, tokenize, tokenizeRaw } from "./tokenize.ts";
import { atomicWriteFile, moveToTrash, newMemoryId, normalizePath, oneLine, readFileOrUndefined, shortHash, truncateChars } from "./util.ts";
import { HOT_FILE, INDEX_DIR, LIBRARY_DIR, TRASH_DIR } from "./config.ts";
import type { Confidence, MemoryDoc, MemoryFrontmatter, Priority } from "./types.ts";

const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];
const CONFIDENCES: Confidence[] = ["low", "medium", "high"];
/** File name of generated table-of-contents files, which are never indexed. */
export const GENERATED_INDEX = "INDEX.md";

/** Field weights used to build the weighted term-frequency map. */
export const FIELD_WEIGHTS = {
	title: 4,
	tags: 3,
	aliases: 3,
	summary: 2,
	related: 1.5,
	supersedes: 1.5,
	category: 1.5,
	body: 1,
};

export function normalizePriority(value: unknown): Priority {
	if (typeof value === "string" && (PRIORITIES as string[]).includes(value.toLowerCase())) return value.toLowerCase() as Priority;
	return "normal";
}

export function normalizeConfidence(value: unknown): Confidence {
	if (typeof value === "string" && (CONFIDENCES as string[]).includes(value.toLowerCase())) return value.toLowerCase() as Confidence;
	return "medium";
}

export function priorityRank(priority: Priority): number {
	return PRIORITIES.indexOf(priority);
}

/** Slugify a title into a file name fragment. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		// Possessives join rather than split: "John's father" -> "johns-father",
		// not "john-s-father".
		.replace(/['\u2019\u02bc]+/g, "")
		.replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return slug || "memory";
}

/** Upper bound on how many alternative names one note may carry. */
export const MAX_ALIASES = 24;
/** Upper bound on `related` / `supersedes` links per note. */
export const MAX_LINKS = 16;

/**
 * Normalize `related` / `supersedes` links: trimmed, deduplicated
 * case-insensitively, capped. Entries are ids (`mem_...`), relative paths or
 * note titles; resolution happens against the live index.
 */
export function normalizeLinks(values: Iterable<unknown> | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values ?? []) {
		const link = oneLine(String(value ?? ""), 160).replace(/^[-*]+\s*/, "").trim();
		if (!link) continue;
		const key = link.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(link);
		if (out.length >= MAX_LINKS) break;
	}
	return out;
}

/**
 * Normalize a list of alternative names: one line each, trimmed, deduplicated
 * case-insensitively, capped. Order is preserved (first wins), so callers can
 * put the most canonical name first.
 */
export function normalizeAliases(values: Iterable<unknown> | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values ?? []) {
		const alias = oneLine(String(value ?? ""), 60).replace(/^[-*]+\s*/, "").trim();
		if (!alias) continue;
		const key = alias.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(alias);
		if (out.length >= MAX_ALIASES) break;
	}
	return out;
}

/** Parse `aliases`/`tags`-style frontmatter values (array or separated string). */
export function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
	if (typeof value === "string") return value.split(/[,\n]+/).map((entry) => entry.trim()).filter(Boolean);
	return [];
}

/** Derive the category (first folder under library/) from a relative path. */
export function categoryFromRelPath(relPath: string): string {
	const normalized = normalizePath(relPath);
	const prefix = `${LIBRARY_DIR}/`;
	if (!normalized.startsWith(prefix)) return "";
	const rest = normalized.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash === -1) return "";
	return rest.slice(0, slash);
}

/** Extract a one-line summary from frontmatter or the first body paragraph. */
export function deriveSummary(body: string, provided?: unknown): string {
	if (typeof provided === "string" && provided.trim()) return oneLine(provided, 240);
	const lines = body.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#") || trimmed.startsWith("<!--") || trimmed.startsWith("```") || trimmed.startsWith("-")) continue;
		return oneLine(trimmed, 240);
	}
	return "";
}

/** Derive a title from frontmatter, the first H1, or the file name. */
export function deriveTitle(frontmatter: MemoryFrontmatter, body: string, relPath: string): string {
	if (typeof frontmatter.title === "string" && frontmatter.title.trim()) return oneLine(frontmatter.title, 160);
	const h1 = body.match(/^\s*#\s+(.+)$/m);
	if (h1) return oneLine(h1[1], 160);
	const file = basename(relPath).replace(/\.md$/i, "");
	return oneLine(file.replace(/[-_]+/g, " "), 160);
}

function stripLeadingTitle(body: string, title: string): string {
	const match = body.match(/^\s*#\s+(.+?)\s*$/m);
	if (!match) return body;
	if (oneLine(match[1], 160).toLowerCase() !== title.toLowerCase()) return body;
	return body.slice(match[0].length).replace(/^\n+/, "");
}

function computeTokens(
	title: string,
	category: string,
	tags: string[],
	aliases: string[],
	links: string[],
	summary: string,
	body: string,
): { tokens: Record<string, number>; tokenCount: number } {
	const tokens: Record<string, number> = {};
	accumulateTokens(title, FIELD_WEIGHTS.title, tokens);
	accumulateTokens(tags.join(" "), FIELD_WEIGHTS.tags, tokens);
	// Aliases are indexed at tag weight: finding a note by any of its names must
	// not depend on the file name that happened to win.
	accumulateTokens(aliases.join(" "), FIELD_WEIGHTS.aliases, tokens);
	// Linked note names are searchable too, so following a relationship works
	// from either end.
	accumulateTokens(links.join(" "), FIELD_WEIGHTS.related, tokens);
	accumulateTokens(category, FIELD_WEIGHTS.category, tokens);
	accumulateTokens(summary, FIELD_WEIGHTS.summary, tokens);
	const bodyWithoutTitle = stripLeadingTitle(body, title);
	accumulateTokens(bodyWithoutTitle, FIELD_WEIGHTS.body, tokens);
	let tokenCount = 0;
	for (const value of Object.values(tokens)) tokenCount += value;
	return { tokens, tokenCount: Math.max(1, Math.round(tokenCount)) };
}

export interface ParseDocInput {
	source: string;
	root: string;
	path: string;
	relPath: string;
	mtimeMs: number;
	size: number;
}

/** Parse a markdown file into a MemoryDoc. Missing ids are synthesized deterministically. */
export function parseMemoryDoc(input: ParseDocInput): MemoryDoc {
	const { source, root, path, relPath } = input;
	const split = splitFrontmatter(source);
	const fm = split.frontmatter as MemoryFrontmatter;
	const body = split.body;
	const title = deriveTitle(fm, body, relPath);
	const topic = typeof fm.topic === "string" && fm.topic.trim() ? oneLine(fm.topic, 120) : title;
	const category = typeof fm.category === "string" && fm.category.trim() ? oneLine(fm.category, 80) : categoryFromRelPath(relPath);
	const tags = Array.isArray(fm.tags)
		? fm.tags.map((tag) => String(tag).trim()).filter(Boolean)
		: typeof fm.tags === "string"
			? fm.tags.split(/[,\s]+/).filter(Boolean)
			: [];
	const aliases = normalizeAliases(parseStringList(fm.aliases));
	const related = normalizeLinks(parseStringList(fm.related));
	const supersedes = normalizeLinks(parseStringList(fm.supersedes));
	const summary = deriveSummary(body, fm.summary);
	const id = typeof fm.id === "string" && fm.id.trim() ? oneLine(fm.id, 120) : `mem_${shortHash(`${relPath}:${source.length}`)}`;
	const created = parseDateValue(fm.created) || input.mtimeMs;
	const updated = parseDateValue(fm.updated) || input.mtimeMs;
	const lastUsed = parseDateValue(fm.last_used) || updated;
	const { tokens, tokenCount } = computeTokens(title, category, tags, aliases, [...related, ...supersedes], summary, body);
	const wordCount = body.split(/\s+/).filter(Boolean).length;
	return {
		id,
		root,
		path,
		relPath: normalizePath(relPath),
		title,
		topic,
		category,
		tags,
		aliases,
		related,
		supersedes,
		lastUsed,
		summary,
		priority: normalizePriority(fm.priority),
		confidence: normalizeConfidence(fm.confidence),
		created,
		updated,
		mtimeMs: input.mtimeMs,
		size: input.size,
		wordCount,
		tokens,
		tokenCount,
		body,
		frontmatter: fm,
		unfiled: category === "inbox" || relPath === `${LIBRARY_DIR}/inbox`,
	};
}

/** Read and parse a memory file from disk. */
export async function readMemoryDoc(root: string, path: string): Promise<MemoryDoc | undefined> {
	try {
		const [source, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		const relPath = normalizePath(relative(root, path));
		return parseMemoryDoc({ source, root, path, relPath, mtimeMs: stats.mtimeMs, size: stats.size });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Whether a relative path should be indexed. */
export function isIndexableRelPath(relPath: string, exclude: string[] = []): boolean {
	const normalized = normalizePath(relPath);
	if (!normalized.startsWith(`${LIBRARY_DIR}/`)) return false;
	if (!normalized.toLowerCase().endsWith(".md")) return false;
	if (basename(normalized) === GENERATED_INDEX) return false;
	if (normalized.split("/").some((segment) => segment.startsWith("."))) return false;
	for (const fragment of exclude) {
		if (fragment && normalized.includes(fragment)) return false;
	}
	return true;
}

export interface ScannedFile {
	relPath: string;
	path: string;
	mtimeMs: number;
	size: number;
}

/** Recursively scan the library for markdown memories. */
export async function scanLibrary(root: string, exclude: string[] = []): Promise<Map<string, ScannedFile>> {
	const out = new Map<string, ScannedFile>();
	const libraryRoot = join(root, LIBRARY_DIR);
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const relPath = normalizePath(relative(root, full));
			if (!isIndexableRelPath(relPath, exclude)) continue;
			try {
				const stats = await stat(full);
				out.set(relPath, { relPath, path: full, mtimeMs: stats.mtimeMs, size: stats.size });
			} catch {
				// File disappeared mid-scan: ignore.
			}
		}
	};
	await walk(libraryRoot);
	return out;
}

export interface CreateMemoryInput {
	/** The fact(s) to store, as markdown. Appended to the topic note when it exists. */
	content: string;
	/** Broad grouping name; becomes the file name and the note title. */
	topic?: string;
	/**
	 * Legacy alias for `topic`. Kept because models often reach for "title".
	 * Fact-like values are still rejected and filed under the category.
	 */
	title?: string;
	/** Short bold label for this specific fact inside the topic note, e.g. "Drinks". */
	label?: string;
	category?: string;
	tags?: string[];
	/**
	 * Other names this note answers to (nickname, full name, former topic,
	 * relation). Indexed, so any of them recalls the note.
	 */
	aliases?: string[];
	/** Related notes (ids, relative paths or titles). */
	related?: string[];
	/** Notes this one replaces (ids, relative paths or titles). */
	supersedes?: string[];
	summary?: string;
	priority?: string;
	confidence?: string;
	source?: string;
	session?: string;
	/** When set, replace the body of this note instead of adding to a topic note. */
	id?: string;
	/** Pre-resolved document for `id` updates (avoids a filesystem scan). */
	existingDoc?: MemoryDoc;
	/** Explicit file name override (without extension). Bypasses topic resolution. */
	slug?: string;
	/**
	 * auto (default): add the fact to the topic note, creating it when missing.
	 * new: always create a new sibling file.
	 * replace: overwrite the topic note body (destroys other facts in it).
	 */
	mode?: "auto" | "new" | "replace";
	/** Overwrite an existing file at the target path (used with `slug`). */
	allowOverwrite?: boolean;
}

export interface CreateMemoryResult {
	doc: MemoryDoc;
	/** True when an existing note was updated. */
	updated: boolean;
	/** True when the fact was appended to an existing topic note. */
	merged: boolean;
	/** True when the fact was already present and nothing changed. */
	duplicate: boolean;
	/** Resolved broad topic (may differ from the requested one). */
	topic: string;
	/** True when a fact-like topic was rejected in favor of the category. */
	topicAdjusted: boolean;
	/** Explanation for `topicAdjusted`. */
	topicNote?: string;
	path: string;
	relPath: string;
}

/* ------------------------------------------------------------------ */
/* Topics: file names always stay broad                                */
/* ------------------------------------------------------------------ */

/** Subjects that make a phrase read like a personal fact, not a topic. */
const ATOMIC_SUBJECTS = new Set([
	"i",
	"we",
	"you",
	"they",
	"he",
	"she",
	"it",
	"me",
	"us",
	"them",
	"my",
	"our",
	"your",
	"their",
	"his",
	"her",
	"this",
	"that",
	"user",
	"users",
	"the user",
	"someone",
	"everyone",
	"people",
]);

/**
 * Unambiguous personal-fact verbs. Deliberately excludes noun/verb homographs
 * ("start", "work", "plan", "call", "result") so noun-phrase topics such as
 * "cold start optimization" are not mistaken for facts.
 */
const PERSONAL_VERBS = new Set([
	"like",
	"likes",
	"love",
	"loves",
	"prefer",
	"prefers",
	"hate",
	"hates",
	"dislike",
	"dislikes",
	"enjoy",
	"enjoys",
	"want",
	"wants",
	"need",
	"needs",
	"drink",
	"drinks",
	"eat",
	"eats",
	"speak",
	"speaks",
	"live",
	"lives",
	"read",
	"reads",
	"watch",
	"watches",
	"play",
	"plays",
	"drive",
	"drives",
	"own",
	"owns",
	"study",
	"studies",
	"learn",
	"learns",
	"learned",
	"moved",
	"moves",
	"visit",
	"visits",
	"use",
	"uses",
	"used",
	"is",
	"are",
	"was",
	"were",
	"am",
	"has",
	"have",
	"had",
	"can",
	"will",
	"would",
	"should",
	"must",
	"does",
	"do",
	"did",
	"believes",
	"believe",
	"thinks",
	"think",
	"decided",
	"decides",
	"happen",
	"happens",
	"happened",
	"occur",
	"occurs",
	"occurred",
	"exists",
	"exist",
	"existed",
	"depends",
	"depend",
	"differs",
	"differ",
	"matters",
	"matter",
	"spoke",
	"said",
	"says",
	"told",
	"tells",
]);

/**
 * Relation and role nouns. A topic built from one of these names describes a
 * *relationship* rather than a subject: "johns-father", "Alice's manager",
 * "dad". Those hold only until the person has a name, so they are facts
 * wearing a file name. "family", "friends" and team/org names are not here —
 * those are genuinely broad.
 */
const RELATION_NOUNS = new Set([
	"dad",
	"daddy",
	"father",
	"mom",
	"mum",
	"mommy",
	"mother",
	"parent",
	"parents",
	"son",
	"daughter",
	"child",
	"children",
	"kid",
	"kids",
	"brother",
	"sister",
	"sibling",
	"siblings",
	"wife",
	"husband",
	"spouse",
	"partner",
	"fiance",
	"fiancee",
	"boyfriend",
	"girlfriend",
	"uncle",
	"aunt",
	"cousin",
	"nephew",
	"niece",
	"grandfather",
	"grandmother",
	"grandpa",
	"grandma",
	"grandparent",
	"grandparents",
	"grandson",
	"granddaughter",
	"roommate",
	"neighbor",
	"landlord",
	"employer",
	"employee",
	"manager",
	"boss",
	"supervisor",
	"colleague",
	"coworker",
	"teammate",
	"mentor",
	"mentee",
	"assistant",
]);

/** `John's`, `Johns'`, `John’s` — a possessive makes the phrase relational. */
const POSSESSIVE = /[^\s]['\u2019]s?($|\s)|['\u2019]s\b/;

/**
 * True when a string reads like a single fact rather than a broad grouping.
 * `"I like apples"`, `"likes apples"`, `"Alice prefers oat milk"` and
 * `"John's father"` are facts; `"Dietary preferences"`, `"Deployment process"`,
 * `"Alice"` and `"Family"` are topics.
 */
export function looksAtomicTopic(requested: string): boolean {
	const cleaned = oneLine(requested, 160);
	if (!cleaned) return true;
	if (/[!?;]$/.test(cleaned) || cleaned.includes(",")) return true;
	const tokens = tokenizeRaw(cleaned, { stopwords: false, stem: false });
	if (tokens.length === 0) return true;
	const isVerb = (token: string) => PERSONAL_VERBS.has(token) || PERSONAL_VERBS.has(stem(token));
	/**
	 * A live predicate rather than a noun. Gerunds are excluded on purpose:
	 * "Machine learning notebook" and "Budget planning" are topics even though
	 * "learning" and "planning" look verbish, while "Alice prefers oat milk" and
	 * "likes apples" are facts.
	 */
	const isPredicate = (token: string) => isVerb(token) && !token.endsWith("ing");
	if (isPredicate(tokens[0])) return true;
	const subject = tokens[0] === "the" && tokens[1] ? `the ${tokens[1]}` : tokens[0];
	if (ATOMIC_SUBJECTS.has(subject)) return true;
	// A relation is a fact about someone else: "John's father" today, a name
	// tomorrow. The relationship belongs in the fact text; the note lives under
	// a broad topic (the person's name, or the category as a fallback).
	if (tokens.some((token) => RELATION_NOUNS.has(token) || RELATION_NOUNS.has(stem(token)))) return true;
	if (tokens.length > 1 && POSSESSIVE.test(cleaned)) return true;
	// Short phrases containing a personal verb read like facts: "Alice prefers
	// oat milk", "alice prefers oat milk", "Project Nightingale uses Postgres".
	// Rejecting a noun-phrase topic only costs specificity (it falls back to the
	// category); accepting a fact-shaped topic produces a bad file name, so this
	// check is deliberately aggressive.
	if (tokens.length <= 5 && tokens.some(isPredicate)) return true;
	return false;
}

export interface TopicResolution {
	/** Display form of the resolved topic. */
	topic: string;
	/** File-name base derived from the topic. */
	slug: string;
	/** True when the requested topic was rejected or missing. */
	adjusted: boolean;
	/** Human-readable explanation when adjusted. */
	note?: string;
}

function titleCaseTopic(topic: string): string {
	const trimmed = oneLine(topic, 160);
	if (!trimmed) return trimmed;
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Resolve a requested topic into a broad, file-safe topic.
 *
 * The fallback is the category name, so even a missing or fact-like topic can
 * never produce a file such as `likes-apples.md`.
 */
export function resolveTopic(
	requested: string | undefined,
	category: string,
	defaultCategory: string,
	maxWords = 6,
): TopicResolution {
	const fallbackBase = category || defaultCategory;
	const fallback: TopicResolution = {
		topic: titleCaseTopic(fallbackBase),
		slug: slugify(fallbackBase),
		adjusted: false,
	};
	const cleaned = oneLine(requested ?? "", 120);
	if (!cleaned) return fallback;
	if (looksAtomicTopic(cleaned)) {
		return {
			...fallback,
			adjusted: true,
			note: `"${cleaned}" names a single fact or relationship, not a broad topic; filed under "${fallback.topic}" instead. Put the fact in the note body and use a broad topic (e.g. the person's name) for the file`,
		};
	}
	const tokens = tokenizeRaw(cleaned, { stopwords: false, stem: false });
	if (tokens.length > maxWords) {
		return {
			...fallback,
			adjusted: true,
			note: `"${cleaned}" is too long for a topic name (${tokens.length} words, max ${maxWords}); filed under "${fallback.topic}" instead`,
		};
	}
	return { topic: titleCaseTopic(cleaned), slug: slugify(cleaned), adjusted: false };
}

export interface AppendFactResult {
	body: string;
	changed: boolean;
	duplicate: boolean;
}

/**
 * Append one fact to a topic note body.
 *
 * Facts live under a single `## Facts` section: single-line facts become
 * bullets (optionally with a bold label), multi-line facts become `### label`
 * blocks. Appending an already-present fact is a no-op.
 */
export function appendFact(body: string, label: string | undefined, content: string): AppendFactResult {
	const trimmed = content.replace(/^\n+/, "").replace(/\s+$/, "").trim();
	if (!trimmed) return { body, changed: false, duplicate: false };
	const singleLine = !trimmed.includes("\n");
	const plain = singleLine ? oneLine(trimmed, 2000).replace(/^[-*]\s*/, "") : "";
	const probe = oneLine(singleLine ? plain : trimmed, 80).toLowerCase();
	if (probe.length >= 12 && body.toLowerCase().includes(probe)) {
		return { body, changed: false, duplicate: true };
	}

	const labelText = label && label.trim() ? oneLine(label.trim(), 80) : undefined;
	let entry: string;
	if (singleLine) {
		entry = labelText ? `- **${labelText}** — ${plain}` : `- ${plain}`;
	} else {
		entry = labelText ? `### ${labelText}\n\n${trimmed}` : trimmed;
	}

	const base = body.replace(/\s+$/, "");
	const header = /^##\s+Facts\s*$/m.exec(base);
	if (!header) {
		const separator = base.length > 0 ? "\n\n" : "";
		return { body: `${base}${separator}## Facts\n\n${entry}\n`, changed: true, duplicate: false };
	}
	const sectionStart = header.index + header[0].length;
	const nextHeading = base.slice(sectionStart).search(/\n##\s/);
	const insertAt = nextHeading === -1 ? base.length : sectionStart + nextHeading;
	const before = base.slice(0, insertAt).replace(/\s+$/, "");
	const after = base.slice(insertAt).replace(/^\s+/, "");
	const joined = before.length > 0 ? `${before}\n${entry}` : entry;
	return { body: after ? `${joined}\n\n${after}\n` : `${joined}\n`, changed: true, duplicate: false };
}

/** Extend a topic note's summary with a new fact summary, without duplication. */
export function extendSummary(existing: string, addition: string, maxChars = 240): string {
	const add = oneLine(addition, maxChars);
	if (!add) return oneLine(existing, maxChars);
	const current = oneLine(existing, maxChars);
	if (!current) return add;
	const probe = add.toLowerCase().slice(0, Math.min(24, add.length));
	if (probe.length >= 8 && current.toLowerCase().includes(probe)) return current;
	if (current.length + add.length + 2 > maxChars) return current;
	return `${current.replace(/[.;]+$/, "")}; ${add}`;
}

/** First free `<slug>.md` (or `<slug>-N.md`) inside a store directory. */
export async function uniquePath(root: string, relDir: string, slug: string): Promise<string> {
	const dir = join(root, relDir);
	await mkdir(dir, { recursive: true });
	let candidate = `${slug}.md`;
	let counter = 2;
	while (true) {
		const full = join(dir, candidate);
		try {
			await stat(full);
			candidate = `${slug}-${counter}.md`;
			counter += 1;
			if (counter > 500) throw new Error(`Unable to find a free file name for ${slug}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return full;
			throw error;
		}
	}
}

function resolveCategoryPath(category: string | undefined, defaultCategory: string): { relDir: string; category: string } {
	const clean = oneLine(category ?? defaultCategory, 80)
		.replace(/[\\:]+/g, "/")
		.replace(/\.\./g, "")
		.replace(/^\/+|\/+$/g, "")
		.trim();
	if (!clean) return { relDir: `${LIBRARY_DIR}/${defaultCategory}`, category: defaultCategory };
	const first = clean.split("/")[0];
	return { relDir: `${LIBRARY_DIR}/${clean}`, category: first };
}

export interface CreateMemoryOptions {
	/** Maximum words allowed in a topic name before falling back to the category. */
	topicMaxWords?: number;
	/** A topic note larger than this spills into a numbered sibling. */
	topicMaxChars?: number;
}

/**
 * Add a memory to the store.
 *
 * Without an `id` this adds a fact to a **topic note**: the file name is the
 * broad topic slug, never the fact. Existing topic notes are appended to, so
 * related facts accumulate in one place instead of creating `likes-apples.md`.
 */
export async function createMemory(
	root: string,
	input: CreateMemoryInput,
	defaultCategory = "inbox",
	options: CreateMemoryOptions = {},
): Promise<CreateMemoryResult> {
	const now = new Date();
	const nowIso = now.toISOString();
	const nowMs = now.getTime();
	const maxChars = Math.max(500, options.topicMaxChars ?? 8000);
	if (input.id) {
		const existing = input.existingDoc ?? (await findDocById(root, input.id));
		if (!existing) throw new Error(`Memory not found: ${input.id}`);
		const updated = await updateMemory(root, existing, {
			content: input.content,
			tags: input.tags,
			related: input.related,
			supersedes: input.supersedes,
			summary: input.summary,
			priority: input.priority,
			confidence: input.confidence,
			category: input.category,
			source: input.source,
		});
		return {
			doc: updated,
			updated: true,
			merged: false,
			duplicate: false,
			topic: typeof updated.frontmatter.topic === "string" ? updated.frontmatter.topic : updated.title,
			topicAdjusted: false,
			path: updated.path,
			relPath: updated.relPath,
		};
	}

	const { relDir, category } = resolveCategoryPath(input.category, defaultCategory);
	const resolution = input.slug
		? { topic: titleCaseTopic(oneLine(input.slug, 120)), slug: slugify(input.slug), adjusted: false }
		: resolveTopic(input.topic ?? input.title, category, defaultCategory, options.topicMaxWords ?? 6);
	const mode = input.mode ?? "auto";
	const inputAliases = normalizeAliases(input.aliases);

	// Find the topic note to merge into, or the first free sibling slot.
	let mergeTarget: MemoryDoc | undefined;
	let firstFreeBase: string | undefined;
	if (mode !== "new") {
		for (let n = 1; n <= 100; n += 1) {
			const base = n === 1 ? resolution.slug : `${resolution.slug}-${n}`;
			const candidate = await readMemoryDoc(root, join(root, relDir, `${base}.md`));
			if (!candidate) {
				if (!firstFreeBase) firstFreeBase = base;
				break;
			}
			if (!mergeTarget && candidate.size <= maxChars) mergeTarget = candidate;
		}
	}

	if (mergeTarget && mode === "auto") {
		const appended = appendFact(mergeTarget.body, input.label, input.content);
		if (!appended.changed) {
			return {
				doc: mergeTarget,
				updated: false,
				merged: true,
				duplicate: true,
				topic: typeof mergeTarget.frontmatter.topic === "string" ? mergeTarget.frontmatter.topic : mergeTarget.title,
				topicAdjusted: resolution.adjusted,
				topicNote: resolution.note,
				path: mergeTarget.path,
				relPath: mergeTarget.relPath,
			};
		}
		const tags = input.tags ? [...new Set([...mergeTarget.tags, ...input.tags.map((tag) => oneLine(tag, 40)).filter(Boolean)])] : mergeTarget.tags;
		const aliases = inputAliases.length > 0 ? normalizeAliases([...mergeTarget.aliases, ...inputAliases]) : mergeTarget.aliases;
		const related = normalizeLinks([...mergeTarget.related, ...(input.related ?? [])]);
		const supersedes = normalizeLinks([...mergeTarget.supersedes, ...(input.supersedes ?? [])]);
		const priority = priorityRank(normalizePriority(input.priority)) > priorityRank(mergeTarget.priority)
			? normalizePriority(input.priority)
			: mergeTarget.priority;
		const summary = extendSummary(mergeTarget.summary, input.summary ?? deriveSummary(input.content));
		const merged = await updateMemory(root, mergeTarget, {
			content: appended.body,
			tags,
			aliases,
			related: input.related ? related : undefined,
			supersedes: input.supersedes ? supersedes : undefined,
			summary,
			priority,
			confidence: input.confidence,
			source: input.source ?? "agent",
		});
		return {
			doc: merged,
			updated: true,
			merged: true,
			duplicate: false,
			topic: resolution.topic,
			topicAdjusted: resolution.adjusted,
			topicNote: resolution.note,
			path: merged.path,
			relPath: merged.relPath,
		};
	}

	const path = mode === "replace" && firstFreeBase === resolution.slug && !mergeTarget
		? join(root, relDir, `${resolution.slug}.md`)
		: firstFreeBase
			? join(root, relDir, `${firstFreeBase}.md`)
			: await uniquePath(root, relDir, resolution.slug);
	const relPath = normalizePath(relative(root, path));
	const existingAtPath = mode === "replace" ? await readMemoryDoc(root, path) : undefined;
	const frontmatter: MemoryFrontmatter = {
		id: existingAtPath?.id ?? newMemoryId(nowMs),
		title: resolution.topic,
		topic: resolution.topic,
		category,
		tags: input.tags?.map((tag) => oneLine(tag, 40)).filter(Boolean) ?? [],
		created: existingAtPath?.frontmatter.created ?? nowIso,
		updated: nowIso,
		last_used: nowMs,
		source: input.source ?? "agent",
		confidence: normalizeConfidence(input.confidence),
		priority: normalizePriority(input.priority),
	};
	const aliases = normalizeAliases([...parseStringList(existingAtPath?.frontmatter.aliases), ...inputAliases]);
	if (aliases.length > 0) frontmatter.aliases = aliases;
	const related = normalizeLinks([...parseStringList(existingAtPath?.frontmatter.related), ...(input.related ?? [])]);
	if (related.length > 0) frontmatter.related = related;
	const supersedes = normalizeLinks([...parseStringList(existingAtPath?.frontmatter.supersedes), ...(input.supersedes ?? [])]);
	if (supersedes.length > 0) frontmatter.supersedes = supersedes;
	const summary = oneLine(input.summary ?? deriveSummary(input.content), 240);
	if (summary) frontmatter.summary = summary;
	if (input.session) frontmatter.session = input.session;
	const contentBody = input.content.replace(/^\n+/, "").replace(/\s+$/, "");
	let body: string;
	if (mode === "replace" && /^\s*#\s+/.test(contentBody)) {
		// Full document supplied: keep its structure.
		body = contentBody;
	} else {
		const heading = `# ${resolution.topic}`;
		body = appendFact(heading, input.label, contentBody).body;
	}
	await atomicWriteFile(path, stringifyWithFrontmatter(frontmatter as Record<string, unknown>, body));
	const doc = await readMemoryDoc(root, path);
	if (!doc) throw new Error(`Failed to read back memory at ${path}`);
	return {
		doc,
		updated: Boolean(existingAtPath),
		merged: false,
		duplicate: false,
		topic: resolution.topic,
		topicAdjusted: resolution.adjusted,
		topicNote: resolution.note,
		path,
		relPath,
	};
}

/**
 * Find a memory by id anywhere under the library.
 *
 * When the caller already has index metadata, pass it in `candidates` to skip
 * the full directory scan (the common case inside tools).
 */
export async function findDocById(
	root: string,
	id: string,
	candidates?: Array<{ id: string; path: string }>,
): Promise<MemoryDoc | undefined> {
	if (candidates) {
		const match = candidates.find((entry) => entry.id === id);
		return match ? readMemoryDoc(root, match.path) : undefined;
	}
	const scanned = await scanLibrary(root);
	for (const entry of scanned.values()) {
		const doc = await readMemoryDoc(root, entry.path);
		if (doc && doc.id === id) return doc;
	}
	return undefined;
}

export interface UpdateMemoryInput {
	title?: string;
	content?: string;
	tags?: string[];
	aliases?: string[];
	/** Replace the note's outgoing `related` links. */
	related?: string[];
	/** Replace the note's `supersedes` links. */
	supersedes?: string[];
	summary?: string;
	priority?: string;
	confidence?: string;
	category?: string;
	/** Replace only if the current body matches this hash prefix (optimistic concurrency). */
	expectHash?: string;
	source?: string;
}

/** Update an existing memory in place, moving it when the category changes. */
export async function updateMemory(root: string, doc: MemoryDoc, input: UpdateMemoryInput): Promise<MemoryDoc> {
	if (input.expectHash && !shortHash(doc.body).startsWith(input.expectHash)) {
		throw new Error(`Memory ${doc.id} changed since it was read; re-read and retry.`);
	}
	const frontmatter: MemoryFrontmatter = { ...doc.frontmatter };
	if (input.title !== undefined) frontmatter.title = oneLine(input.title, 160);
	if (input.tags !== undefined) frontmatter.tags = input.tags.map((tag) => oneLine(tag, 40)).filter(Boolean);
	if (input.aliases !== undefined) {
		const aliases = normalizeAliases(input.aliases);
		if (aliases.length > 0) frontmatter.aliases = aliases;
		else delete frontmatter.aliases;
	}
	if (input.related !== undefined) {
		const related = normalizeLinks(input.related);
		if (related.length > 0) frontmatter.related = related;
		else delete frontmatter.related;
	}
	if (input.supersedes !== undefined) {
		const supersedes = normalizeLinks(input.supersedes);
		if (supersedes.length > 0) frontmatter.supersedes = supersedes;
		else delete frontmatter.supersedes;
	}
	if (input.summary !== undefined) frontmatter.summary = oneLine(input.summary, 240);
	if (input.priority !== undefined) frontmatter.priority = normalizePriority(input.priority);
	if (input.confidence !== undefined) frontmatter.confidence = normalizeConfidence(input.confidence);
	if (input.source !== undefined) frontmatter.source = oneLine(input.source, 120);
	if (input.category !== undefined) {
		const { category } = resolveCategoryPath(input.category, doc.category || "inbox");
		frontmatter.category = category;
	}
	frontmatter.updated = new Date().toISOString();
	// Writing is using: keep the persisted recency signal fresh without a
	// separate pass. Reads are updated lazily by the usage tracker instead.
	frontmatter.last_used = Date.now();

	const body = input.content !== undefined ? input.content.replace(/^\n+/, "").replace(/\s+$/, "") : doc.body.replace(/\s+$/, "");
	if (!input.summary && input.content !== undefined) {
		const derived = deriveSummary(body);
		if (derived) frontmatter.summary = derived;
	}
	if (!frontmatter.id) frontmatter.id = doc.id;
	if (!frontmatter.title) frontmatter.title = doc.title;

	const targetCategory = typeof frontmatter.category === "string" && frontmatter.category ? frontmatter.category : doc.category;
	let targetPath = doc.path;
	if (input.category !== undefined && targetCategory !== doc.category) {
		const fileSlug = basename(doc.relPath).replace(/\.md$/i, "");
		targetPath = await uniquePath(root, `${LIBRARY_DIR}/${targetCategory}`, fileSlug);
	}
	const raw = stringifyWithFrontmatter(frontmatter as Record<string, unknown>, body);
	if (targetPath !== doc.path) {
		// Journal the move so a crash between the write and the trash can be
		// repaired on the next start (otherwise both files exist with one id).
		await writeJournal(root, { op: "move", from: doc.relPath, to: normalizePath(relative(root, targetPath)), at: Date.now() });
	}
	await atomicWriteFile(targetPath, raw);
	if (targetPath !== doc.path) {
		const trashed = await moveToTrash(doc.path, join(root, TRASH_DIR, "moved")).then(
			() => true,
			() => false,
		);
		if (trashed) await clearJournal(root).catch(() => {});
	}
	const updated = await readMemoryDoc(root, targetPath);
	if (!updated) throw new Error(`Failed to read back memory at ${targetPath}`);
	return updated;
}

/** Remove a memory file, returning the trash path. */
export async function deleteMemory(root: string, doc: MemoryDoc): Promise<string> {
	return moveToTrash(doc.path, join(root, TRASH_DIR));
}

/* ------------------------------------------------------------------ */
/* Consolidation: re-file a note under a better broad topic            */
/* ------------------------------------------------------------------ */

/**
 * Break a note body into appendable fact units.
 *
 * `- **Label** — text` bullets keep their label; `### Label` blocks attach the
 * label to the following block; anything else becomes one prose unit.
 */
export function extractFactUnits(body: string): Array<{ label?: string; text: string }> {
	const units: Array<{ label?: string; text: string }> = [];
	const withoutTitle = body.replace(/^\s*#\s+[^\n]*\n?/, "");
	let buffer: string[] = [];
	let pendingLabel: string | undefined;
	const flush = (): void => {
		const text = buffer.join("\n").trim();
		buffer = [];
		if (!text) return;
		const bullet = text.match(/^-\s+\*\*(.+?)\*\*\s*[\u2014\u2013-]\s*([\s\S]*)$/);
		if (bullet) {
			units.push({ label: bullet[1].trim(), text: bullet[2].trim() });
			pendingLabel = undefined;
			return;
		}
		const plain = text.match(/^-\s+([\s\S]*)$/);
		if (plain) {
			units.push({ label: pendingLabel, text: plain[1].replace(/\s+/g, " ").trim() });
			pendingLabel = undefined;
			return;
		}
		units.push({ label: pendingLabel, text });
		pendingLabel = undefined;
	};
	for (const raw of withoutTitle.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (/^\s*##\s+Facts\s*$/.test(line)) continue;
		const heading = line.match(/^\s*###\s+(.+?)\s*$/);
		if (heading) {
			flush();
			pendingLabel = heading[1];
			continue;
		}
		if (/^\s*[-*]\s+/.test(line)) flush();
		buffer.push(line);
	}
	flush();
	return units;
}

export interface MoveMemoryInput {
	/** Target broad topic; becomes the file name and the note title. */
	topic: string;
	/** Target category folder. Defaults to the note's current category. */
	category?: string;
	/**
	 * When the target topic already exists: true (default) merges this note into
	 * it, false refuses and reports the conflict.
	 */
	merge?: boolean;
	/** Record the note's previous names as aliases of the target (default true). */
	keepAlias?: boolean;
}

export interface MoveMemoryResult {
	doc: MemoryDoc;
	/** Previous relative path. */
	from: string;
	moved: boolean;
	/** True when the facts were folded into an existing note. */
	merged: boolean;
	/** Explanation when nothing changed. */
	reason?: string;
	/** Aliases added to the target by this move. */
	aliasesAdded: string[];
	topicAdjusted: boolean;
	topicNote?: string;
	/** Where the old file went (always `.trash/`). */
	trashPath?: string;
}

/**
 * Re-file a note under a better broad topic.
 *
 * This is the escape hatch for names that only became knowable later: a note
 * filed as "John's father" when the person is really "Bob". The previous topic
 * (and the previous file name) are kept as aliases, so nothing that referred to
 * the old name stops working, and an existing target note is merged into rather
 * than clobbered.
 */
export async function moveMemory(
	root: string,
	doc: MemoryDoc,
	input: MoveMemoryInput,
	defaultCategory = "inbox",
	options: CreateMemoryOptions = {},
): Promise<MoveMemoryResult> {
	const { relDir, category } = resolveCategoryPath(input.category, doc.category || defaultCategory);
	const resolution = resolveTopic(input.topic, category, category || defaultCategory, options.topicMaxWords ?? 6);
	const targetPath = join(root, relDir, `${resolution.slug}.md`);
	const targetRelPath = normalizePath(relative(root, targetPath));
	const keepAlias = input.keepAlias !== false;
	const base = {
		from: doc.relPath,
		aliasesAdded: [] as string[],
		topicAdjusted: resolution.adjusted,
		topicNote: resolution.note,
	};
	if (targetRelPath === doc.relPath) {
		return { ...base, doc, moved: false, merged: false, reason: `Already filed under "${resolution.topic}".` };
	}

	const target = await readMemoryDoc(root, targetPath);
	if (target && input.merge === false) {
		throw new Error(
			`${targetRelPath} already exists (topic "${target.topic}"), so moving ${doc.relPath} there would either overwrite or mix two subjects. Re-run with merge: true to combine them, or pick a different topic.`,
		);
	}
	const previousAliases = target ? normalizeAliases([...target.aliases, ...parseStringList(target.frontmatter.aliases)]) : [];
	const aliases = normalizeAliases([
		...previousAliases,
		...doc.aliases,
		...(keepAlias ? [doc.topic, doc.title, basename(doc.relPath).replace(/\.md$/i, "")] : []),
	]);
	const aliasesAdded = aliases.filter((alias) => !previousAliases.some((previous) => previous.toLowerCase() === alias.toLowerCase()));

	if (target) {
		// Merge: fold the facts in, ignore duplicates, keep the oldest identity.
		let body = target.body.replace(/\s+$/, "");
		let mergedFacts = 0;
		for (const unit of extractFactUnits(doc.body)) {
			const appended = appendFact(body, unit.label, unit.text);
			if (appended.changed) {
				body = appended.body;
				mergedFacts += 1;
			}
		}
		const tags = [...new Set([...target.tags, ...doc.tags])];
		const priority = priorityRank(doc.priority) > priorityRank(target.priority) ? doc.priority : target.priority;
		const updated = await updateMemory(root, target, {
			content: body,
			tags,
			aliases,
			summary: extendSummary(target.summary, doc.summary),
			priority,
		});
		await writeJournal(root, { op: "move", from: doc.relPath, to: updated.relPath, at: Date.now() });
		const trashPath = await deleteMemory(root, doc);
		await clearJournal(root).catch(() => {});
		return { ...base, doc: updated, moved: true, merged: mergedFacts > 0, aliasesAdded, trashPath };
	}

	// Pure rename: the note keeps its id, so ids read earlier stay valid.
	const frontmatter: MemoryFrontmatter = {
		...doc.frontmatter,
		id: doc.id,
		title: resolution.topic,
		topic: resolution.topic,
		category,
		updated: new Date().toISOString(),
	};
	if (frontmatter.created === undefined) frontmatter.created = new Date(doc.created).toISOString();
	if (aliases.length > 0) frontmatter.aliases = aliases;
	else delete frontmatter.aliases;
	const body = stripLeadingTitle(doc.body, doc.title).replace(/^\n+/, "").replace(/\s+$/, "");
	const newBody = /^\s*#\s+/.test(body) ? body : `# ${resolution.topic}\n\n${body}`;
	await writeJournal(root, { op: "move", from: doc.relPath, to: targetRelPath, at: Date.now() });
	await atomicWriteFile(targetPath, stringifyWithFrontmatter(frontmatter as Record<string, unknown>, newBody));
	const renamed = await readMemoryDoc(root, targetPath);
	if (!renamed) throw new Error(`Failed to read back memory at ${targetPath}`);
	const trashPath = await deleteMemory(root, doc);
	await clearJournal(root).catch(() => {});
	return { ...base, doc: renamed, moved: true, merged: false, aliasesAdded, trashPath };
}

/**
 * Refresh only the `last_used` frontmatter field of a note.
 *
 * Kept separate from `updateMemory` on purpose: a recall must not change
 * `updated`, or reading a note would make it look recently edited and corrupt
 * recency ranking. Returns the re-parsed doc, or undefined when unchanged.
 */
export async function touchLastUsed(root: string, doc: MemoryDoc, usedAt = Date.now()): Promise<MemoryDoc | undefined> {
	const lastUsed = parseDateValue(doc.frontmatter.last_used) || 0;
	if (usedAt - lastUsed < 1000) return undefined;
	const frontmatter: MemoryFrontmatter = { ...doc.frontmatter, last_used: usedAt };
	if (!frontmatter.id) frontmatter.id = doc.id;
	if (!frontmatter.title) frontmatter.title = doc.title;
	const raw = stringifyWithFrontmatter(frontmatter as Record<string, unknown>, doc.body.replace(/\s+$/, ""));
	await atomicWriteFile(doc.path, raw);
	return readMemoryDoc(root, doc.path);
}

/** Count the fact units in a note body (bullets and labeled blocks). */
export function countFacts(body: string): number {
	return extractFactUnits(body).length;
}

/* ------------------------------------------------------------------ */
/* Crash-safe moves (journal)                                          */
/* ------------------------------------------------------------------ */

export interface MoveJournalEntry {
	op: "move";
	/** Relative path of the source file. */
	from: string;
	/** Relative path of the destination file. */
	to: string;
	at: number;
}

function journalPath(root: string): string {
	return join(root, INDEX_DIR, "journal.json");
}

/** Record an in-progress move before it becomes visible on disk. */
export async function writeJournal(root: string, entry: MoveJournalEntry): Promise<void> {
	await atomicWriteFile(journalPath(root), JSON.stringify(entry));
}

export async function readJournal(root: string): Promise<MoveJournalEntry | undefined> {
	const raw = await readFileOrUndefined(journalPath(root));
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as MoveJournalEntry;
		if (parsed && parsed.op === "move" && typeof parsed.from === "string" && typeof parsed.to === "string") return parsed;
	} catch {
		// A corrupt journal is not worth failing over; the files themselves are
		// authoritative and doctor reports duplicate ids.
	}
	return undefined;
}

export async function clearJournal(root: string): Promise<void> {
	await rm(journalPath(root), { force: true });
}

/**
 * Finish an interrupted move: when the journal says `from` was moved to `to`
 * and both files exist, trash the source. Safe to call on every start.
 */
export async function recoverJournal(root: string): Promise<string | undefined> {
	const entry = await readJournal(root);
	if (!entry) return undefined;
	const fromPath = join(root, entry.from);
	const toPath = join(root, entry.to);
	let recovered: string | undefined;
	if (existsSync(fromPath) && existsSync(toPath)) {
		await moveToTrash(fromPath, join(root, TRASH_DIR, "moved")).then(
			() => {
				recovered = `completed interrupted move ${entry.from} -> ${entry.to}`;
			},
			() => undefined,
		);
	}
	await clearJournal(root).catch(() => {});
	return recovered;
}

/* ------------------------------------------------------------------ */
/* MEMORY.md (the always-injected hot cache)                           */
/* ------------------------------------------------------------------ */

export interface HotState {
	path: string;
	content: string;
	chars: number;
	limit: number;
	over: boolean;
	exists: boolean;
}

/** Read MEMORY.md with budget accounting. */
export async function readHot(root: string, limit: number): Promise<HotState> {
	const path = join(root, HOT_FILE);
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { path, content: "", chars: 0, limit, over: false, exists: false };
	}
	const chars = content.length;
	return { path, content, chars, limit, over: chars > limit, exists: true };
}

/** Write MEMORY.md atomically. Callers enforce/validate the budget. */
export async function writeHot(root: string, content: string): Promise<void> {
	await atomicWriteFile(join(root, HOT_FILE), content.endsWith("\n") ? content : `${content}\n`);
}

/**
 * MEMORY.md is a plain-prose briefing: a short introduction to the user plus the
 * standing context that is worth loading into every single session. It reads as
 * normal paragraphs — no headings, no bullet lists, no annotations, no key/value
 * or "Topic — fact" markers. Every character here is paid for on every request,
 * so only the highest-leverage facts belong in it.
 */
export const HOT_TITLE = "# Memory";

export function hotTemplate(): string {
	return `${HOT_TITLE}\n`;
}

/** Drop HTML comments (including the legacy annotation block). */
export function stripHotComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/** Blank-line-separated paragraph blocks. */
export function splitHotParagraphs(content: string): string[] {
	return stripHotComments(content)
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean);
}

/** The prose body of MEMORY.md, without the optional title or comments. */
export function hotBody(content: string): string {
	return splitHotParagraphs(content)
		.filter((block) => !/^#\s+/.test(block))
		.join("\n\n")
		.trim();
}

/** True when MEMORY.md holds no facts (only a title, comments or whitespace). */
export function hotIsEmpty(content: string): boolean {
	return hotBody(content).length === 0;
}

function isTitleBlock(block: string): boolean {
	return /^#\s+\S/.test(block);
}

/** Split a paragraph into addressable units: sentences and bullets. */
export function splitHotUnits(paragraph: string): string[] {
	return paragraph
		.split(/\n+(?=\s*[-*]\s)/)
		.flatMap((chunk) => chunk.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(\[])/))
		.map((unit) => unit.trim())
		.filter(Boolean);
}

function renderHot(title: string | undefined, body: string[]): string {
	const parts = [...(title ? [title] : []), ...body.filter(Boolean)];
	return `${parts.join("\n\n").replace(/\s+$/, "")}\n`;
}

/**
 * Choose the paragraph a new sentence belongs to, by token overlap with the
 * caller's topic hint. Returns -1 when nothing is close enough, in which case
 * the sentence becomes a new paragraph.
 *
 * There is no marker syntax in the file: MEMORY.md is prose, so placement is
 * inferred from content rather than from anchors.
 */
function findParagraphForTopic(body: string[], topic: string): number {
	const topicTokens = new Set(tokenize(topic, { stopwords: true }));
	if (topicTokens.size === 0) return -1;
	let best = -1;
	let bestScore = 0;
	for (let i = 0; i < body.length; i += 1) {
		const paragraphTokens = new Set(tokenize(body[i], { stopwords: true }));
		if (paragraphTokens.size === 0) continue;
		let overlap = 0;
		for (const token of topicTokens) if (paragraphTokens.has(token)) overlap += 1;
		const score = overlap / topicTokens.size;
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	}
	return bestScore >= 0.5 ? best : -1;
}

export interface HotAddResult {
	content: string;
	changed: boolean;
	/** The paragraph the fact landed in. */
	paragraph: string;
	/** True when a new anchored paragraph was created. */
	created: boolean;
}

/**
 * Append a sentence (or several) to MEMORY.md.
 *
 * With `topic`, the text joins the paragraph with the strongest token overlap,
 * so related facts stay together; otherwise it becomes a new paragraph. No
 * marker or anchor text is ever written into the file.
 */
export function addHotEntry(content: string, text: string, topic?: string): HotAddResult {
	const sentence = oneLine(text, 1200).replace(/^[-*]\s*/, "").trim();
	if (!sentence) return { content, changed: false, paragraph: "", created: false };
	const blocks = splitHotParagraphs(content);
	const title = blocks.find(isTitleBlock);
	const body = blocks.filter((block) => !isTitleBlock(block));
	const cleanTopic = topic && topic.trim() ? oneLine(topic, 80) : "";
	if (cleanTopic) {
		const index = findParagraphForTopic(body, cleanTopic);
		if (index >= 0) {
			body[index] = `${body[index].replace(/\s+$/, "")} ${sentence}`;
			return { content: renderHot(title, body), changed: true, paragraph: body[index], created: false };
		}
	}
	body.push(sentence);
	return { content: renderHot(title, body), changed: true, paragraph: sentence, created: true };
}

/**
 * Remove every sentence or bullet containing `pattern`.
 * Returns the new content and the number of units removed.
 */
export function removeHotMatches(content: string, pattern: string): [string, number] {
	const needle = pattern.trim().toLowerCase();
	if (!needle) return [content, 0];
	const blocks = splitHotParagraphs(content);
	const title = blocks.find(isTitleBlock);
	const body: string[] = [];
	let removed = 0;
	for (const block of blocks) {
		if (isTitleBlock(block)) continue;
		const kept = splitHotUnits(block).filter((unit) => {
			if (unit.toLowerCase().includes(needle)) {
				removed += 1;
				return false;
			}
			return true;
		});
		if (kept.length > 0) body.push(kept.join(" "));
	}
	return [renderHot(title, body), removed];
}

export interface HotTrimResult {
	content: string;
	/** Text that no longer fits, so callers can report or re-file it. */
	removed: string;
	trimmed: boolean;
}

/**
 * Trim MEMORY.md to the limit, dropping paragraphs from the bottom and cutting
 * the last paragraph at a sentence boundary. The removed text is returned
 * instead of being written into the file as a marker.
 */
export function trimHot(content: string, limit: number): HotTrimResult {
	if (content.length <= limit) return { content, removed: "", trimmed: false };
	const blocks = splitHotParagraphs(content);
	const title = blocks.find(isTitleBlock);
	const body = blocks.filter((block) => !isTitleBlock(block));
	const kept: string[] = [];
	const dropped: string[] = [];
	let used = title ? title.length + 2 : 0;
	for (let i = 0; i < body.length; i += 1) {
		const block = body[i];
		if (used + block.length + 2 <= limit) {
			kept.push(block);
			used += block.length + 2;
			continue;
		}
		const units = splitHotUnits(block);
		const partial: string[] = [];
		const rest: string[] = [];
		for (const unit of units) {
			const trial = [...partial, unit].join(" ");
			if (used + trial.length + 2 <= limit) partial.push(unit);
			else rest.push(unit);
		}
		if (partial.length > 0) kept.push(partial.join(" "));
		if (rest.length > 0) dropped.push(rest.join(" "));
		for (let j = i + 1; j < body.length; j += 1) dropped.push(body[j]);
		break;
	}
	return { content: renderHot(title, kept), removed: dropped.join("\n\n"), trimmed: true };
}

/* ------------------------------------------------------------------ */
/* Generated library indexes                                           */
/* ------------------------------------------------------------------ */

export interface IndexListingDoc {
	relPath: string;
	title: string;
	id: string;
	category: string;
	tags: string[];
	summary: string;
	priority: Priority;
	updated: number;
}

function sortEntries(entries: IndexListingDoc[]): IndexListingDoc[] {
	return entries.slice().sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title));
}

function entryLines(entry: IndexListingDoc, link: string): string[] {
	const tags = entry.tags.length > 0 ? ` · tags: ${entry.tags.join(", ")}` : "";
	const priority = entry.priority !== "normal" ? ` · priority: ${entry.priority}` : "";
	const summary = entry.summary ? ` — ${entry.summary}` : "";
	return [`- [${entry.title}](${link})${summary}`, `  - id: \`${entry.id}\`${tags}${priority}`];
}

/** Render `library/INDEX.md` plus one index per category. */
export function renderLibraryIndexes(docs: IndexListingDoc[], generatedAt = new Date()): Map<string, string> {
	const byCategory = new Map<string, IndexListingDoc[]>();
	for (const doc of docs) {
		const key = doc.category || "(root)";
		const list = byCategory.get(key) ?? [];
		list.push(doc);
		byCategory.set(key, list);
	}
	const stamp = generatedAt.toISOString();
	const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));
	const out = new Map<string, string>();

	const rootLines: string[] = [
		"# Memory Library Index",
		"",
		`<!-- Generated by memoria at ${stamp}. Do not edit; run /memoria index to regenerate. -->`,
		"",
		`${docs.length} memories in ${categories.length} categories.`,
		"",
		"## Categories",
		"",
	];
	for (const category of categories) {
		rootLines.push(`- \`${category}\` — ${byCategory.get(category)!.length}`);
	}
	if (categories.length === 0) rootLines.push("_(empty)_");
	rootLines.push("");
	for (const category of categories) {
		rootLines.push(`## ${category}`, "");
		for (const entry of sortEntries(byCategory.get(category)!)) {
			rootLines.push(...entryLines(entry, encodeURI(entry.relPath)));
		}
		rootLines.push("");
	}
	out.set("INDEX.md", `${rootLines.join("\n").trimEnd()}\n`);

	for (const category of categories) {
		const dirName = category === "(root)" ? "" : category;
		const lines = [`# ${category}`, "", `<!-- Generated by memoria at ${stamp}. Do not edit. -->`, ""];
		for (const entry of sortEntries(byCategory.get(category)!)) {
			const fileName = entry.relPath.split("/").pop() ?? "";
			lines.push(...entryLines(entry, encodeURI(fileName)));
		}
		lines.push("");
		out.set(dirName ? `${dirName}/INDEX.md` : "INDEX.md", `${lines.join("\n").trimEnd()}\n`);
	}
	return out;
}

/** Build the category map used by the system prompt. */
export function categorySummary(docs: Array<{ category: string }>): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const doc of docs) {
		const key = doc.category || "(root)";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Create the store skeleton on disk (idempotent). */
export async function ensureStore(root: string, hotLimit: number, defaultCategory = "inbox"): Promise<void> {
	await mkdir(join(root, LIBRARY_DIR, defaultCategory), { recursive: true });
	await mkdir(join(root, INDEX_DIR), { recursive: true });
	const hot = await readHot(root, hotLimit);
	if (!hot.exists) await writeHot(root, hotTemplate());
}

/** Resolve a user-supplied memory reference (id, alias, relative path, or absolute path). */
export async function resolveMemoryRef(
	root: string,
	ref: string,
	candidates?: Array<{ id: string; path: string; aliases?: string[] }>,
): Promise<MemoryDoc | undefined> {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	if (trimmed.endsWith(".md")) {
		const candidate = trimmed.startsWith("/") ? trimmed : resolve(root, trimmed);
		const direct = await readMemoryDoc(root, candidate);
		if (direct) return direct;
	}
	const needle = trimmed.toLowerCase();
	const matchesRef = (doc: { id: string; aliases: string[] }) => doc.id === trimmed || doc.aliases.some((alias) => alias.toLowerCase() === needle);
	if (candidates) {
		const match = candidates.find((entry) => entry.id === trimmed || entry.aliases?.some((alias) => alias.toLowerCase() === needle));
		return match ? readMemoryDoc(root, match.path) : undefined;
	}
	for (const entry of (await scanLibrary(root)).values()) {
		const doc = await readMemoryDoc(root, entry.path);
		if (doc && matchesRef(doc)) return doc;
	}
	return undefined;
}

/** Read a range of lines from a file path inside the store, guarding traversal. */
export async function readStoreFile(root: string, relOrAbs: string, maxChars = 40_000): Promise<{ path: string; content: string; truncated: boolean }> {
	const target = relOrAbs.startsWith("/") ? relOrAbs : resolve(root, relOrAbs);
	const normalizedRoot = resolve(root);
	if (!normalizePath(target).startsWith(normalizePath(normalizedRoot))) {
		throw new Error(`Refusing to read outside the memoria root: ${relOrAbs}`);
	}
	const content = await readFile(target, "utf8");
	return { path: target, content: truncateChars(content, maxChars), truncated: content.length > maxChars };
}
