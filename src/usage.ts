/**
 * Retrieval and write statistics, kept in `.index/usage.json`.
 *
 * This is derived data: deleting the file loses promotion and staleness hints
 * and nothing else. The search path must never do disk I/O, so hits are counted
 * in memory and flushed on a debounce; the runtime also refreshes a note's
 * `last_used` frontmatter at most once per `lastUsedWriteIntervalMs`.
 */

import { join } from "node:path";
import { INDEX_DIR, USAGE_FILE } from "./config.ts";
import { atomicWriteFile, readFileOrUndefined } from "./util.ts";
import type { UsageEntry, UsageFile } from "./types.ts";

export const USAGE_VERSION = 1;

/** Upper bound on tracked notes; the least recently used are dropped first. */
export const MAX_USAGE_ENTRIES = 50_000;

function emptyEntry(): UsageEntry {
	return { hits: 0, writes: 0, lastUsed: 0 };
}

function coerceEntry(raw: unknown): UsageEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = raw as Record<string, unknown>;
	const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
	const entry = { hits: number(input.hits), writes: number(input.writes), lastUsed: number(input.lastUsed) };
	if (entry.hits === 0 && entry.writes === 0 && entry.lastUsed === 0) return undefined;
	return entry;
}

/** In-memory usage table with an explicit, debounced flush. */
export class UsageStore {
	private docs = new Map<string, UsageEntry>();
	private changed = false;
	private saving?: Promise<void>;
	private lastSessionAt = 0;

	constructor(root: string) {
		this.root = root;
	}

	private readonly root: string;

	/** Load `<root>/.index/usage.json`; a missing or corrupt file starts empty. */
	static async load(root: string): Promise<UsageStore> {
		const store = new UsageStore(root);
		const raw = await readFileOrUndefined(join(root, INDEX_DIR, USAGE_FILE));
		if (!raw) return store;
		try {
			const parsed = JSON.parse(raw) as UsageFile;
			if (!parsed || typeof parsed !== "object" || !parsed.docs || typeof parsed.docs !== "object") return store;
			if (typeof parsed.lastSessionAt === "number" && Number.isFinite(parsed.lastSessionAt)) store.lastSessionAt = parsed.lastSessionAt;
			for (const [id, value] of Object.entries(parsed.docs)) {
				const entry = coerceEntry(value);
				if (entry) store.docs.set(id, entry);
			}
		} catch {
			// Derived data: a corrupt file is simply ignored.
		}
		return store;
	}

	get(id: string): UsageEntry | undefined {
		return this.docs.get(id);
	}

	/** Count one retrieval (`hit`) or one fact write (`write`). */
	record(id: string, kind: "hit" | "write", at = Date.now()): void {
		if (!id) return;
		let entry = this.docs.get(id);
		if (!entry) {
			entry = emptyEntry();
			this.docs.set(id, entry);
		}
		if (kind === "hit") entry.hits += 1;
		else entry.writes += 1;
		if (at > entry.lastUsed) entry.lastUsed = at;
		this.changed = true;
	}

	/** Note that a note was touched without counting a read or a write. */
	markUsed(id: string, at: number): void {
		const entry = this.docs.get(id);
		if (entry) {
			if (at > entry.lastUsed) {
				entry.lastUsed = at;
				this.changed = true;
			}
			return;
		}
		this.docs.set(id, { hits: 0, writes: 0, lastUsed: at });
		this.changed = true;
	}

	entries(): Array<[string, UsageEntry]> {
		return [...this.docs.entries()];
	}

	get size(): number {
		return this.docs.size;
	}

	get dirty(): boolean {
		return this.changed;
	}

	/** Drop entries whose note no longer exists, then cap the table size. */
	prune(validIds: Set<string>): number {
		let removed = 0;
		for (const id of [...this.docs.keys()]) {
			if (!validIds.has(id)) {
				this.docs.delete(id);
				removed += 1;
			}
		}
		if (this.docs.size > MAX_USAGE_ENTRIES) {
			const byAge = [...this.docs.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
			for (const [id] of byAge.slice(0, this.docs.size - MAX_USAGE_ENTRIES)) {
				this.docs.delete(id);
				removed += 1;
			}
		}
		if (removed > 0) this.changed = true;
		return removed;
	}

	/** Epoch ms of the previous session start (0 when unknown). */
	sessionStartedAt(): number {
		return this.lastSessionAt;
	}

	/** Record this session's start so the next one can summarise what changed. */
	markSessionStart(at = Date.now()): void {
		this.lastSessionAt = at;
		this.changed = true;
	}

	async save(): Promise<void> {
		if (this.saving) {
			await this.saving;
			return this.save();
		}
		if (!this.changed) return;
		this.changed = false;
		const payload: UsageFile = { version: USAGE_VERSION, docs: Object.fromEntries(this.docs), lastSessionAt: this.lastSessionAt };
		const saving = atomicWriteFile(join(this.root, INDEX_DIR, USAGE_FILE), JSON.stringify(payload));
		this.saving = saving;
		try {
			await saving;
		} catch (error) {
			this.changed = true;
			throw error;
		} finally {
			if (this.saving === saving) this.saving = undefined;
		}
	}

	/** Notes with no recorded use in `staleMs`, oldest first. */
	stale(staleMs: number, now = Date.now(), minWrites = 1): Array<{ id: string; entry: UsageEntry; idleMs: number }> {
		const out: Array<{ id: string; entry: UsageEntry; idleMs: number }> = [];
		for (const [id, entry] of this.docs) {
			if (entry.writes < minWrites && entry.hits === 0) continue;
			const idleMs = now - (entry.lastUsed || 0);
			if (idleMs >= staleMs) out.push({ id, entry, idleMs });
		}
		return out.sort((a, b) => b.idleMs - a.idleMs);
	}

	/** Notes written often enough to be worth promoting into MEMORY.md. */
	promotionCandidates(minWrites: number): Array<{ id: string; entry: UsageEntry }> {
		const out: Array<{ id: string; entry: UsageEntry }> = [];
		for (const [id, entry] of this.docs) if (entry.writes >= minWrites) out.push({ id, entry });
		return out.sort((a, b) => b.entry.writes - a.entry.writes);
	}
}

/** Human-readable idle duration, e.g. "3 months" or "12 days". */
export function describeAge(ms: number): string {
	const days = Math.floor(ms / 86_400_000);
	if (days < 1) return "today";
	if (days < 45) return `${days} day${days === 1 ? "" : "s"}`;
	const months = Math.round(days / 30);
	if (months < 18) return `${months} months`;
	const years = Math.max(1, Math.round(days / 365));
	return `${years} year${years === 1 ? "" : "s"}`;
}
