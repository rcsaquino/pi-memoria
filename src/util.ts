/**
 * Small dependency-free helpers shared across memoria.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Generate a stable-ish memory id: `mem_<epochms>_<6 hex>`. */
export function newMemoryId(now = Date.now()): string {
	return `mem_${now}_${randomBytes(3).toString("hex")}`;
}

/** Short sha1 fingerprint of a string. */
export function shortHash(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/** Truncate to `max` characters without splitting a surrogate pair. */
export function truncateChars(input: string, max: number): string {
	if (max <= 0) return "";
	if (input.length <= max) return input;
	let end = max;
	const code = input.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return input.slice(0, end);
}

/** Collapse runs of whitespace, trim, and optionally truncate. */
export function oneLine(input: string, max = Number.POSITIVE_INFINITY): string {
	const flat = input.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${truncateChars(flat, Math.max(1, max - 1))}…` : flat;
}

/**
 * Keyed async mutex. Serializes read-modify-write sequences on the same key
 * (typically a store root) so concurrent tool calls cannot lose writes.
 */
export class KeyedMutex {
	private tails = new Map<string, Promise<void>>();

	async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => {}).then(() => current);
		this.tails.set(key, tail);
		await previous.catch(() => {});
		try {
			return await fn();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

/** Debounce a function; the trailing call wins. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastArgs: A | undefined;
	const flush = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
		const args = lastArgs;
		lastArgs = undefined;
		if (args) fn(...args);
	};
	const cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		lastArgs = undefined;
	};
	const wrapped = (...args: A) => {
		lastArgs = args;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			const callArgs = lastArgs;
			lastArgs = undefined;
			if (callArgs) fn(...callArgs);
		}, waitMs);
		timer.unref?.();
	};
	return Object.assign(wrapped, { flush, cancel });
}

/** Write a file atomically (temp file + rename), creating parent dirs. */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await (typeof data === "string" ? writeFile(tmp, data, "utf8") : writeFile(tmp, data));
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

/** Read a file as utf8, returning undefined when it does not exist. */
export async function readFileOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Read a file as bytes, returning undefined when it does not exist. */
export async function readFileBufferOrUndefined(path: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Normalize a path for comparisons: forward slashes, no trailing slash. */
export function normalizePath(input: string): string {
	const slashed = input.replace(/\\/g, "/");
	return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/** Move to trash (soft delete) instead of hard deleting. */
export async function moveToTrash(path: string, trashDir: string): Promise<string> {
	await mkdir(trashDir, { recursive: true });
	const base = path.split("/").pop() ?? "memory.md";
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	// Different categories can contain the same basename and be removed within
	// one millisecond. A random suffix prevents rename() from replacing the
	// earlier trashed file on POSIX filesystems.
	const target = join(trashDir, `${stamp}_${randomBytes(8).toString("hex")}__${base}`);
	await rename(path, target);
	return target;
}
