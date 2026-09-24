/**
 * Minimal, dependency-free YAML-subset frontmatter parser + serializer.
 *
 * Supported: `key: scalar`, quoted strings, booleans, numbers, null, inline
 * arrays `[a, b]`, block arrays (`- item`), one level of nested maps, and
 * literal/folded block scalars (`|`, `|-`, `>`, `>-`).
 *
 * The parser is intentionally forgiving: unparseable lines are kept as raw text
 * so that a malformed memory never blocks indexing.
 */

export interface FrontmatterSplit {
	frontmatter: Record<string, unknown>;
	body: string;
	/** True when the file started with a `---` fence. */
	hasFrontmatter: boolean;
	/** Raw frontmatter source, for round-tripping via `parseFrontmatter` reuse. */
	raw: string;
	/** Line offset where the body starts (used for line-number reporting). */
	bodyLineOffset: number;
}

const FENCE = /^---[ \t]*$/;

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if (first === '"' && last === '"') {
			try {
				return JSON.parse(trimmed) as string;
			} catch {
				return trimmed.slice(1, -1);
			}
		}
		if (first === "'" && last === "'") {
			return trimmed.slice(1, -1).replace(/''/g, "'");
		}
	}
	return trimmed;
}

function parseInlineArray(value: string): unknown[] {
	const inner = value.slice(1, -1).trim();
	if (!inner) return [];
	const items: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i];
		if (quote) {
			current += ch;
			if (ch === quote && inner[i - 1] !== "\\") quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ",") {
			items.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	items.push(current);
	return items.map((item) => parseScalar(item.trim()));
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "~" || trimmed === "null") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseInlineArray(trimmed);
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		const map: Record<string, unknown> = {};
		for (const pair of splitTopLevel(trimmed.slice(1, -1))) {
			const idx = pair.indexOf(":");
			if (idx === -1) continue;
			map[unquote(pair.slice(0, idx))] = parseScalar(pair.slice(idx + 1));
		}
		return map;
	}
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) return unquote(trimmed);
	return trimmed;
}

function splitTopLevel(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let quote: string | undefined;
	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];
		if (quote) {
			current += ch;
			if (ch === quote && input[i - 1] !== "\\") quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "[" || ch === "{") depth += 1;
		if (ch === "]" || ch === "}") depth -= 1;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

function indentOf(line: string): number {
	let i = 0;
	while (i < line.length && line[i] === " ") i += 1;
	return i;
}

function parseBlockScalar(lines: string[], startIndex: number, baseIndent: number, folded: boolean): { value: string; nextIndex: number } {
	const collected: string[] = [];
	let i = startIndex;
	let blockIndent = -1;
	for (; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === "") {
			collected.push("");
			continue;
		}
		const indent = indentOf(line);
		if (indent <= baseIndent) break;
		if (blockIndent === -1) blockIndent = indent;
		collected.push(line.slice(Math.min(blockIndent, indent)));
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
	const value = folded ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n");
	return { value, nextIndex: i };
}

/**
 * Split a markdown document into frontmatter + body.
 */
export function splitFrontmatter(source: string): FrontmatterSplit {
	const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
	const lines = text.split(/\r?\n/);
	if (lines.length === 0 || !FENCE.test(lines[0])) {
		return { frontmatter: {}, body: text, hasFrontmatter: false, raw: "", bodyLineOffset: 0 };
	}
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (FENCE.test(lines[i])) {
			end = i;
			break;
		}
	}
	if (end === -1) {
		return { frontmatter: {}, body: text, hasFrontmatter: false, raw: "", bodyLineOffset: 0 };
	}
	const rawLines = lines.slice(1, end);
	const body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
	return {
		frontmatter: parseFrontmatterLines(rawLines),
		body,
		hasFrontmatter: true,
		raw: rawLines.join("\n"),
		bodyLineOffset: end + 1,
	};
}

/** Parse raw frontmatter lines into an object. */
export function parseFrontmatterLines(lines: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "" || line.trimStart().startsWith("#")) {
			i += 1;
			continue;
		}
		const indent = indentOf(line);
		if (indent > 0) {
			// Orphan nested content without a parent key: skip.
			i += 1;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon === -1) {
			i += 1;
			continue;
		}
		const key = unquote(line.slice(0, colon));
		if (!key) {
			i += 1;
			continue;
		}
		const rest = line.slice(colon + 1).trim();
		if (rest === "" ) {
			// Could be a nested map or a block array on following lines.
			const nested: Record<string, unknown> = {};
			const items: unknown[] = [];
			let j = i + 1;
			let sawNested = false;
			let sawList = false;
			for (; j < lines.length; j += 1) {
				const next = lines[j];
				if (next.trim() === "") continue;
				const nextIndent = indentOf(next);
				if (nextIndent === 0) break;
				const stripped = next.trim();
				if (stripped.startsWith("- ")) {
					sawList = true;
					items.push(parseScalar(stripped.slice(2)));
				} else if (stripped === "-") {
					sawList = true;
					items.push(null);
				} else {
					const nestedColon = stripped.indexOf(":");
					if (nestedColon === -1) continue;
					sawNested = true;
					nested[unquote(stripped.slice(0, nestedColon))] = parseScalar(stripped.slice(nestedColon + 1));
				}
			}
			if (sawList) result[key] = items;
			else if (sawNested) result[key] = nested;
			else result[key] = null;
			i = j;
			continue;
		}
		if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
			const folded = rest.startsWith(">");
			const { value, nextIndex } = parseBlockScalar(lines, i + 1, indent, folded);
			result[key] = value;
			i = nextIndex;
			continue;
		}
		if (rest.startsWith("&") || rest.startsWith("*") || rest.startsWith("!")) {
			// Anchors, aliases and tags are unsupported: keep as raw text.
			result[key] = rest;
			i += 1;
			continue;
		}
		result[key] = parseScalar(rest);
		i += 1;
	}
	return result;
}

const BARE_SAFE = /^[A-Za-z0-9_./+@-]+( [A-Za-z0-9_./+@-]+)*$/;

function yamlScalar(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	const text = String(value);
	if (text === "") return '""';
	if (/^[a-z]+:\/\//i.test(text) || /^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
	if (BARE_SAFE.test(text) && !/^(true|false|null|~|yes|no|on|off)$/i.test(text) && !/^-?\d/.test(text)) return text;
	return JSON.stringify(text);
}

/** Serialize an object back into frontmatter lines (without the `---` fences). */
export function serializeFrontmatter(data: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else if (value.every((item) => typeof item === "string" && BARE_SAFE.test(item as string))) {
				lines.push(`${key}: [${value.join(", ")}]`);
			} else {
				lines.push(`${key}:`);
				for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
			}
			continue;
		}
		if (value !== null && typeof value === "object") {
			lines.push(`${key}:`);
			for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
				lines.push(`  ${nestedKey}: ${yamlScalar(nestedValue)}`);
			}
			continue;
		}
		const text = String(value);
		if (text.includes("\n")) {
			lines.push(`${key}: |-`);
			for (const line of text.split("\n")) lines.push(`  ${line}`);
			continue;
		}
		lines.push(`${key}: ${yamlScalar(value)}`);
	}
	return lines.join("\n");
}

/** Render a full markdown file with frontmatter. */
export function stringifyWithFrontmatter(data: Record<string, unknown>, body: string): string {
	const fm = serializeFrontmatter(data);
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	return `---\n${fm}\n---\n\n${trimmedBody}\n`;
}

/** Parse a frontmatter date-ish value into epoch ms. */
export function parseDateValue(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return 0;
	const normalized = value.trim().replace(" ", "T");
	const parsed = Date.parse(normalized);
	if (Number.isNaN(parsed)) return 0;
	return parsed;
}
