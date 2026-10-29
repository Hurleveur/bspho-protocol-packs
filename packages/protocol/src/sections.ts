/**
 * Section structure of a protocol, found by code: numbered and styled headings
 * (or the PDF outline when it is rich), arranged into a tree, each section owning
 * the verbatim lines up to the next heading of the same or higher rank.
 * Works on PDFs without an outline (most of the corpus). No model calls.
 */
import type * as mupdf from "mupdf";
import type { Box, Line, PdfPage } from "./pdf.ts";

export interface Heading {
	id: string; // "h12": stable within one build
	page: number;
	y: number;
	/** Bottom of the heading (it may wrap over several lines). */
	yEnd: number;
	title: string;
	/** Higher = more important. Numbered: 100 - depth; styled: font size + emphasis. */
	rank: number;
	numbered: boolean;
}

export interface Section {
	heading: Heading;
	parent: string | null;
	path: string[]; // titles from the root
	/** Verbatim content lines (heading excluded), in reading order, up to the next heading of same or higher rank. */
	lines: Line[];
	/** Last page the section reaches. */
	endPage: number;
}

const NUMBERED = /^((?:\d{1,2}|[A-Z])(?:\.\d{1,2}){0,4})\.?\)?(?:\s+[-–—:])?\s+(\S.*)$/;
const APPENDIX =
	/^(?:appendix|annex|annexe|chapter|section|part)\s+[A-Z0-9IVX]{1,5}\b/i;
const PAGE_NO = /^(?:page\s*)?\d+(?:\s*(?:of|\/|von)\s*\d+)?$/i;
const NOT_TITLE_START =
	/^(?:mg|g|ml|kg|m2|m²|h|hrs?|days?|weeks?|months?|years?|x|×|%|and|or|to|of|in)\b/i;
const BOILER_LINE =
	/^(?:(?:no\.? of pages|page|version|date)\b.*|confidential|protocol|page)$/i;
const SKIP_TITLES = new Set([
	"contents",
	"table of contents",
	"content",
	"index",
	"inhaltsverzeichnis",
	"table des matières",
	"sommaire",
]);

export const norm = (t: string) =>
	t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

function clean(t: string): string {
	let s = t.trim().split(/\s{3,}|\t/)[0];
	s = s.replace(/\s*\.{3,}.*$/, "");
	s = s.replace(/\s+/g, " ").replace(/^[\s:–\-•]+|[\s:–\-•]+$/g, "");
	return s;
}

const isUpper = (t: string) => t === t.toUpperCase() && t !== t.toLowerCase();
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

/** Lines repeated on many pages (running headers/footers), digits ignored. */
export function boilerplate(pages: PdfPage[]): Set<string> {
	const seen = new Map<string, number>();
	for (const p of pages)
		for (const k of new Set(p.lines.map((l) => norm(l.text))))
			seen.set(k, (seen.get(k) ?? 0) + 1);
	const min = Math.max(3, 0.2 * pages.length);
	return new Set([...seen].filter(([, c]) => c >= min).map(([k]) => k));
}

function bodySize(pages: PdfPage[]): number {
	const weight = new Map<number, number>();
	for (const p of pages)
		for (const l of p.lines) {
			const k = Math.round(l.size * 2) / 2;
			weight.set(k, (weight.get(k) ?? 0) + l.text.length);
		}
	return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

function classify(
	l: Line,
	height: number,
	body: number,
	boiler: Set<string>,
): { title: string; rank: number; numbered: boolean } | null {
	const t = l.text;
	if (
		t.length < 3 ||
		t.length > 120 ||
		boiler.has(norm(t)) ||
		PAGE_NO.test(t) ||
		SKIP_TITLES.has(clean(t).toLowerCase())
	)
		return null;
	if (
		l.bbox[3] < 0.06 * height ||
		l.bbox[1] > 0.94 * height ||
		l.cells ||
		BOILER_LINE.test(t)
	)
		return null;
	const words = t.split(/\s+/);
	if (new Set(words).size <= words.length / 2) return null; // "EOT EOT"
	if (
		/[,;]$/.test(t) ||
		(t.endsWith(".") && !t.endsWith("..")) ||
		count(t, /\p{L}/gu) < 4
	)
		return null;
	if (/\.{4,}|…{2,}|[<>=≤≥±]|\d\s*\/\s*[lL]\b/.test(t)) return null; // TOC line or lab value
	// A heading never closes a parenthesis it did not open: "B19, HIV 1/2, HAV, HBV, HCV, VZV)" is a wrapped list line.
	if (count(t, /\)/g) > count(t, /\(/g)) return null;
	const styled = l.bold || l.size >= body + 0.9;
	const m = NUMBERED.exec(t);
	if (m) {
		const [, num, title] = m;
		const first = num.split(".")[0];
		if (/^\d+$/.test(first) && !(+first >= 1 && +first <= 40)) return null;
		if (
			!/^\p{Lu}/u.test(title) ||
			NOT_TITLE_START.test(title) ||
			title.split(/\s+/).length > 14
		)
			return null;
		if (!styled && (!num.includes(".") || title.length > 70)) return null;
		if (count(title, /\d/g) > title.length / 3) return null;
		return { title: clean(t), rank: 100 - count(num, /\./g), numbered: true };
	}
	if (APPENDIX.test(t) && /^\p{Lu}/u.test(t) && styled && words.length <= 14)
		return { title: clean(t), rank: 100, numbered: true };
	// "Course 2 – CPX-351" is a heading; "Day 1,3,5: 100 mg/m2" is not.
	if (words.length > 10 || !/^\p{Lu}/u.test(t) || count(t, /\d/g) > t.length / 3)
		return null;
	const caps = isUpper(t) && count(t, /\p{L}/gu) >= 6;
	if (!styled && !(caps && words.length >= 2)) return null;
	return {
		title: clean(t),
		rank: l.size + 0.5 * +caps + 0.3 * +l.bold,
		numbered: false,
	};
}

export function detectHeadings(pages: PdfPage[]): Heading[] {
	const body = bodySize(pages);
	const boiler = boilerplate(pages);
	const out: Heading[] = [];
	for (const p of pages) {
		let last = "";
		let prev: { line: Line; heading: Heading } | null = null;
		for (const l of p.lines) {
			// A heading that wraps: the next line, same style, right below, starting lowercase or with "(" continues it.
			if (prev) {
				const pl = prev.line;
				const gap = l.bbox[1] - pl.bbox[3];
				if (
					gap < 0.6 * (pl.bbox[3] - pl.bbox[1]) &&
					Math.abs(l.size - pl.size) < 0.3 &&
					l.bold === pl.bold &&
					/^[\p{Ll}(]/u.test(l.text)
				) {
					prev.heading.title = clean(`${prev.heading.title} ${l.text}`);
					prev.heading.yEnd = l.bbox[3];
					prev = { line: l, heading: prev.heading };
					continue;
				}
			}
			prev = null;
			const h = classify(l, p.height, body, boiler);
			if (!h || h.title.length < 3 || h.title === last) continue;
			last = h.title;
			const heading = {
				id: `h${out.length}`,
				page: p.page,
				y: l.bbox[1],
				yEnd: l.bbox[3],
				...h,
			};
			out.push(heading);
			prev = { line: l, heading };
		}
	}
	return out;
}

interface OutlineItem {
	title?: string;
	page?: number;
	down?: OutlineItem[];
}

/** Headings from the PDF bookmarks, positioned on the matching line when we can find it. */
export function outlineHeadings(
	doc: mupdf.Document,
	pages: PdfPage[],
): Heading[] | null {
	const flat: { title: string; page: number; level: number }[] = [];
	const walk = (items: OutlineItem[], level: number) => {
		for (const it of items) {
			const title = clean(it.title ?? "");
			if (
				it.page !== undefined &&
				it.page >= 0 &&
				title.length >= 3 &&
				!SKIP_TITLES.has(title.toLowerCase()) &&
				!/^(?:see)\b/i.test(title)
			) {
				flat.push({
					title: title.length > 120 ? `${title.slice(0, 117)}...` : title,
					page: it.page + 1,
					level,
				});
			}
			if (it.down) walk(it.down, level + 1);
		}
	};
	walk((doc.loadOutline() ?? []) as OutlineItem[], 1);
	if (flat.length <= 20) return null;
	// Some outlines carry one bookmark per visual line of a wrapped heading ("3.3. Rationale for a differentiated",
	// "chemotherapy schedule for the study"): a same-page, same-level entry starting lowercase or "(" continues the
	// previous one. A lowercase entry with nothing to continue is a stray line, not a heading.
	const merged: { title: string; first: string; page: number; level: number }[] = [];
	for (const f of flat) {
		const last = merged.at(-1);
		const tail =
			/^\p{Ll}(?!\p{Ll}*\p{Lu})/u.test(f.title) || f.title.startsWith("(");
		if (tail && last && last.page === f.page && last.level === f.level)
			last.title = `${last.title} ${f.title}`;
		else if (!/^\p{Ll}(?!\p{Ll}*\p{Lu})/u.test(f.title))
			merged.push({ ...f, first: f.title });
	}
	return merged.map((f, i) => {
		const key = norm(f.first).slice(0, 40);
		const lines = pages[f.page - 1]?.lines ?? [];
		const at = lines.findIndex(
			(l) => norm(l.text).includes(key) || key.includes(norm(l.text)),
		);
		const line = lines[at];
		// The title may wrap onto following lines: they belong to the heading, not to its content.
		let yEnd = line?.bbox[3] ?? 0;
		let title = f.title;
		const full = norm(title);
		let j = at + 1;
		for (; at >= 0 && j < lines.length && j <= at + 3; j++) {
			const t = norm(lines[j].text);
			if (t.length < 3 || !full.includes(t)) break;
			yEnd = lines[j].bbox[3];
		}
		// A wrapped tail the bookmark left out ("... Consolidation 1" / "(Augmented BFM)"): same style, right below.
		const pl = lines[j - 1];
		const nl = lines[j];
		if (
			at >= 0 &&
			pl &&
			nl &&
			nl.bbox[1] - pl.bbox[3] < 0.6 * (pl.bbox[3] - pl.bbox[1]) &&
			nl.bold === pl.bold &&
			Math.abs(nl.size - pl.size) < 0.3 &&
			/^[\p{Ll}(]/u.test(nl.text) &&
			nl.text.length < 80
		) {
			title = clean(`${title} ${nl.text}`);
			yEnd = nl.bbox[3];
		}
		if (title.length > 120) title = `${title.slice(0, 117)}...`;
		return {
			id: `h${i}`,
			page: f.page,
			y: line?.bbox[1] ?? 0,
			yEnd,
			title,
			rank: 100 - f.level,
			numbered: true,
		};
	});
}

/** Arrange headings into a tree and give each section its verbatim lines. */
export function buildSections(pages: PdfPage[], headings: Heading[]): Section[] {
	const boiler = boilerplate(pages);
	const sorted = [...headings].sort((a, b) => a.page - b.page || a.y - b.y);
	const stack: Heading[] = [];
	const sections: Section[] = [];
	for (const h of sorted) {
		while (stack.length && stack.at(-1)!.rank <= h.rank) stack.pop();
		sections.push({
			heading: h,
			parent: stack.at(-1)?.id ?? null,
			path: [...stack.map((s) => s.title), h.title],
			lines: [],
			endPage: h.page,
		});
		stack.push(h);
	}
	// Content lines: everything after a heading until the next heading of any rank goes to that heading;
	// a section's full text is its own lines plus its descendants' (see sectionText).
	const at = (page: number, y: number) => page * 1e5 + y;
	const starts = sections.map((s) => at(s.heading.page, s.heading.y));
	let si = -1;
	for (const p of pages) {
		for (const l of p.lines) {
			// Running headers/footers and page numbers are not content.
			if (
				boiler.has(norm(l.text)) ||
				PAGE_NO.test(l.text) ||
				l.bbox[3] < 0.05 * p.height ||
				l.bbox[1] > 0.95 * p.height
			)
				continue;
			const pos = at(p.page, l.bbox[1]);
			while (si + 1 < sections.length && starts[si + 1] <= pos + 0.5) si++;
			if (si < 0) continue;
			const s = sections[si];
			const h = s.heading;
			if (
				h.page === p.page &&
				l.bbox[1] >= h.y - 0.5 &&
				l.bbox[3] <= h.yEnd + 0.5
			)
				continue; // the heading line(s) itself
			s.lines.push(l);
			s.endPage = p.page;
		}
	}
	return sections;
}

/** Lines of a section including all its descendants, in reading order. */
export function sectionLines(sections: Section[], id: string): Line[] {
	const kids = new Map<string, Section[]>();
	for (const s of sections)
		if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
	const out: Line[] = [];
	const walk = (s: Section) => {
		out.push(...s.lines);
		for (const k of kids.get(s.heading.id) ?? []) walk(k);
	};
	const root = sections.find((s) => s.heading.id === id);
	if (root) walk(root);
	return out;
}

export function boxesOf(lines: Line[]): { page: number; bbox: Box }[] {
	return lines.map((l) => ({ page: l.page, bbox: l.bbox }));
}
