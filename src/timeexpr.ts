/**
 * Natural-language time expressions in queries.
 *
 * "what did we decide last week?" should not depend on the word "week" being in
 * the stored note, so the window is parsed out of the query and applied as a
 * recency filter instead. Pure and locale-independent in its assertions: all
 * windows are derived from the supplied `now`.
 */

import type { TimeWindow } from "./types.ts";

const DAY = 86_400_000;

/** Start of the local day containing `epochMs`. */
export function startOfDay(epochMs: number): number {
	const date = new Date(epochMs);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Start of the ISO week (Monday) containing `epochMs`. */
function startOfWeek(epochMs: number): number {
	const date = new Date(startOfDay(epochMs));
	const day = (date.getDay() + 6) % 7; // Monday = 0
	date.setDate(date.getDate() - day);
	return date.getTime();
}

/** Start of the month containing `epochMs`. */
function startOfMonth(epochMs: number): number {
	const date = new Date(epochMs);
	return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/** Start of the year containing `epochMs`. */
function startOfYear(epochMs: number): number {
	return new Date(new Date(epochMs).getFullYear(), 0, 1).getTime();
}

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse a time expression from a query.
 *
 * Recognizes: today, yesterday, this week, last week, this month, last month,
 * this year, last year, last N days/weeks/months/years, N days ago, recently /
 * lately, this/last quarter, weekday names, and month names ("in March").
 * Returns undefined when the query has no usable time hint.
 */
export function parseTimeExpression(text: string, now = Date.now()): TimeWindow | undefined {
	const lower = ` ${text.toLowerCase()} `;
	const relative = (since: number, label: string, until?: number): TimeWindow => ({ label, since, until });

	if (/\b(today|this morning|this afternoon|tonight)\b/.test(lower)) {
		return relative(startOfDay(now), "today", now);
	}
	if (/\byesterday\b/.test(lower)) {
		const start = startOfDay(now) - DAY;
		return relative(start, "yesterday", start + DAY);
	}
	if (/\b(just now|moments ago|a moment ago)\b/.test(lower)) {
		return relative(now - 3_600_000, "the last hour", now);
	}

	const countMatch = lower.match(/\b(?:last|past|previous)\s+(\d{1,3})\s*(day|days|week|weeks|month|months|year|years)\b/);
	const agoMatch = lower.match(/\b(\d{1,3})\s*(day|days|week|weeks|month|months|year|years)\s+ago\b/);
	const span = countMatch ?? agoMatch;
	if (span) {
		const count = Number(span[1]);
		const unit = span[2].replace(/s$/, "");
		const ms = unit === "day" ? DAY : unit === "week" ? 7 * DAY : unit === "month" ? 30 * DAY : 365 * DAY;
		if (Number.isFinite(count) && count > 0) return relative(now - count * ms, `the last ${count} ${span[2]}`, now);
	}

	if (/\b(this|last|past|previous)\s+week\b/.test(lower)) {
		const thisWeek = startOfWeek(now);
		return /\blast|previous|past\b/.test(lower)
			? relative(thisWeek - 7 * DAY, "last week", thisWeek)
			: relative(thisWeek, "this week", now);
	}
	if (/\b(this|last|past|previous)\s+month\b/.test(lower)) {
		const thisMonth = startOfMonth(now);
		return /\blast|previous|past\b/.test(lower)
			? relative(startOfMonth(thisMonth - 1), "last month", thisMonth)
			: relative(thisMonth, "this month", now);
	}
	if (/\b(this|last|past|previous)\s+year\b/.test(lower)) {
		const thisYear = startOfYear(now);
		return /\blast|previous|past\b/.test(lower)
			? relative(startOfYear(thisYear - 1), "last year", thisYear)
			: relative(thisYear, "this year", now);
	}
	const quarter = lower.match(/\b(this|last|previous)\s+quarter\b/);
	if (quarter) {
		const month = new Date(now).getMonth();
		const quarterStartMonth = month - (month % 3);
		const start = new Date(new Date(now).getFullYear(), quarterStartMonth, 1).getTime();
		if (/last|previous/.test(quarter[1])) {
			const previousStart = new Date(new Date(now).getFullYear(), quarterStartMonth - 3, 1).getTime();
			return relative(previousStart, "last quarter", start);
		}
		return relative(start, "this quarter", now);
	}
	if (/\b(recently|lately|these days|the other day)\b/.test(lower)) {
		return relative(now - 30 * DAY, "the last 30 days", now);
	}

	// Weekday names: "on Monday" means the most recent Monday.
	for (let index = 0; index < WEEKDAYS.length; index += 1) {
		if (!new RegExp(`\\b(on|last|this|since)?\\s*${WEEKDAYS[index]}\\b`).test(lower)) continue;
		const start = startOfDay(now);
		const current = (new Date(start).getDay() + 6) % 7; // Monday = 0
		const target = (index + 6) % 7;
		let delta = current - target;
		if (delta < 0) delta += 7;
		return relative(start - delta * DAY, `the last ${WEEKDAYS[index]}`, start - delta * DAY + DAY);
	}

	// Month names, with an optional 4-digit year: "in March", "since March 2024".
	for (let index = 0; index < MONTHS.length; index += 1) {
		const pattern = new RegExp(`\\b(?:in|during|since|from)\\s+${MONTHS[index]}(?:\\s+(\\d{4}))?\\b`);
		const match = lower.match(pattern);
		if (!match) continue;
		const year = match[1] ? Number(match[1]) : new Date(now).getFullYear();
		const start = new Date(year, index, 1).getTime();
		const end = new Date(year, index + 1, 1).getTime();
		return { label: `${MONTHS[index][0].toUpperCase()}${MONTHS[index].slice(1)}${match[1] ? ` ${year}` : ""}`, since: start, until: end };
	}
	return undefined;
}
