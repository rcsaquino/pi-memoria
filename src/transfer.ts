/**
 * JSONL export/import.
 *
 * One JSON object per line so the format is appendable, diffable and readable
 * without a parser dependency. `memoria_export` writes it, `memoria_import`
 * reads it; the same format is what a future migration tool would use.
 *
 * A record is either a memory note (`type: "memory"`) or the always-loaded
 * briefing (`type: "hot"`). Unknown fields are ignored on import, and unknown
 * record types are reported instead of silently dropped.
 */

import { basename, join } from "node:path";
import { LIBRARY_DIR } from "./config.ts";
import {
	normalizeAliases,
	normalizeConfidence,
	normalizeLinks,
	normalizePriority,
	parseStringList,
	readMemoryDoc,
	slugify,
	uniquePath,
} from "./store.ts";
import { stringifyWithFrontmatter } from "./frontmatter.ts";
import { atomicWriteFile, newMemoryId, normalizePath, oneLine, truncateChars } from "./util.ts";
import type { MemoryDoc, MemoryFrontmatter } from "./types.ts";

/** Upper bound on an imported note body, to keep a bad file from filling the store. */
export const MAX_IMPORT_BODY_CHARS = 400_000;

export interface ImportedNote {
	id: string;
	relPath: string;
	title: string;
	category: string;
	tags: string[];
	aliases: string[];
	related: string[];
	supersedes: string[];
	summary: string;
	priority: string;
	confidence: string;
	created?: number;
	updated?: number;
	body: string;
}

export type ExportRecord =
	| { type: "hot"; root?: string; content: string }
	| ({ type: "memory"; root?: string } & ImportedNote);

/** Serialize one record as a single JSONL line. */
export function encodeJsonl(record: ExportRecord): string {
	return JSON.stringify(record);
}

/**
 * Validate and normalize a relative path from an import file.
 *
 * Import files are data, not code: a path is only accepted when it stays inside
 * `library/`, ends in `.md`, and contains no traversal segments.
 */
export function sanitizeRelPath(relPath: string): string | undefined {
	const cleaned = normalizePath(String(relPath ?? "").trim()).replace(/^\.\//, "");
	if (!cleaned || cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return undefined;
	const segments = cleaned.split("/");
	if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
	if (segments.some((segment) => segment.startsWith("."))) return undefined;
	if (!cleaned.startsWith(`${LIBRARY_DIR}/`)) return undefined;
	if (!cleaned.toLowerCase().endsWith(".md")) return undefined;
	if (basename(cleaned).toLowerCase() === "index.md") return undefined;
	return cleaned;
}

/** Parse JSONL text into records, collecting per-line errors instead of throwing. */
export function decodeJsonl(text: string): { records: ExportRecord[]; errors: string[] } {
	const records: ExportRecord[] = [];
	const errors: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			errors.push(`line ${i + 1}: not valid JSON`);
			continue;
		}
		if (!parsed || typeof parsed !== "object") {
			errors.push(`line ${i + 1}: not an object`);
			continue;
		}
		const raw = parsed as Record<string, unknown>;
		if (raw.type === "hot") {
			if (typeof raw.content !== "string") {
				errors.push(`line ${i + 1}: hot record without content`);
				continue;
			}
			records.push({ type: "hot", content: truncateChars(raw.content, MAX_IMPORT_BODY_CHARS) });
			continue;
		}
		if (raw.type !== "memory") {
			errors.push(`line ${i + 1}: unsupported record type ${JSON.stringify(raw.type)}`);
			continue;
		}
		if (typeof raw.body !== "string" || typeof raw.relPath !== "string") {
			errors.push(`line ${i + 1}: memory record needs relPath and body`);
			continue;
		}
		const relPath = sanitizeRelPath(raw.relPath);
		if (!relPath) {
			errors.push(`line ${i + 1}: unsafe or non-library path ${JSON.stringify(raw.relPath)}`);
			continue;
		}
		const category = typeof raw.category === "string" && raw.category.trim() ? oneLine(raw.category, 80) : relPath.split("/")[1] ?? "inbox";
		const title = typeof raw.title === "string" && raw.title.trim() ? oneLine(raw.title, 160) : basename(relPath).replace(/\.md$/i, "");
		records.push({
			type: "memory",
			id: typeof raw.id === "string" && raw.id.trim() ? oneLine(raw.id, 120) : newMemoryId(),
			relPath,
			title,
			category,
			tags: parseStringList(raw.tags).map((tag) => oneLine(tag, 40).toLowerCase()).filter(Boolean).slice(0, 24),
			aliases: normalizeAliases(parseStringList(raw.aliases)),
			related: normalizeLinks(parseStringList(raw.related)),
			supersedes: normalizeLinks(parseStringList(raw.supersedes)),
			summary: typeof raw.summary === "string" ? oneLine(raw.summary, 240) : "",
			priority: normalizePriority(raw.priority),
			confidence: normalizeConfidence(raw.confidence),
			created: typeof raw.created === "number" && Number.isFinite(raw.created) ? raw.created : undefined,
			updated: typeof raw.updated === "number" && Number.isFinite(raw.updated) ? raw.updated : undefined,
			body: truncateChars(raw.body, MAX_IMPORT_BODY_CHARS),
		});
	}
	return { records, errors };
}

/**
 * Write an imported note to disk, preserving its id.
 *
 * When the target path is already taken by a different note the file is written
 * to a free sibling (`topic-2.md`) instead of overwriting anything.
 */
export async function writeImportedNote(root: string, note: ImportedNote): Promise<MemoryDoc> {
	const relPath = sanitizeRelPath(note.relPath) ?? `${LIBRARY_DIR}/inbox/${slugify(note.title)}.md`;
	const target = join(root, relPath);
	const occupant = await readMemoryDoc(root, target);
	const path = occupant && occupant.id !== note.id ? await uniquePath(root, relPath.split("/").slice(0, -1).join("/"), basename(relPath).replace(/\.md$/i, "")) : target;
	const nowIso = new Date().toISOString();
	const body = ensureHeading(note.body, note.title);
	const frontmatter: MemoryFrontmatter = {
		id: note.id,
		title: note.title,
		topic: note.title,
		category: note.category,
		tags: note.tags,
		created: note.created ? new Date(note.created).toISOString() : nowIso,
		updated: note.updated ? new Date(note.updated).toISOString() : nowIso,
		last_used: note.updated ?? Date.now(),
		source: "import",
		confidence: normalizeConfidence(note.confidence),
		priority: normalizePriority(note.priority),
	};
	if (note.summary) frontmatter.summary = oneLine(note.summary, 240);
	if (note.aliases.length > 0) frontmatter.aliases = note.aliases;
	if (note.related.length > 0) frontmatter.related = note.related;
	if (note.supersedes.length > 0) frontmatter.supersedes = note.supersedes;
	await atomicWriteFile(path, stringifyWithFrontmatter(frontmatter as Record<string, unknown>, body));
	const doc = await readMemoryDoc(root, path);
	if (!doc) throw new Error(`Failed to read back imported memory at ${path}`);
	return doc;
}

function ensureHeading(body: string, title: string): string {
	const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (/^\s*#\s+/.test(trimmed)) return trimmed;
	return `# ${title}\n\n${trimmed}`;
}
