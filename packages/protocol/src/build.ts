/**
 * PDF → ProtocolSpec. Stages (each reported through `onStage` so the upload screen can show them live):
 *   parse     read every page (text, fonts, positions)
 *   identity  title, version, date from the cover and running header; sha256
 *   sections  headings (PDF outline when rich, else detected) arranged into a tree
 *   label     one Gemini Flash call: a kind per heading, parent fixes, flow edges; ids only, no text
 *   anchors   code cuts the verbatim blocks and resolves edge evidence on the page
 *   check     structural checks: steps without start requirements, raster pages, unresolved evidence
 *   consistency  "Check these": delegations, dangling references, missing start requirements (code),
 *             then contradictions / gaps / ambiguities (one Pro call over the whole protocol; ids only)
 */
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText, Output } from "ai";
import type * as mupdf from "mupdf";
import { z } from "zod";
import { codeFindings, modelFindings } from "./consistency.ts";
import { createFigureAnalyser } from "./figures.ts";
import {
	type Box,
	type Line,
	openPdf,
	type PdfPage,
	readPages,
	sha256,
} from "./pdf.ts";
import {
	boilerplate,
	buildSections,
	detectHeadings,
	type Heading,
	norm as normLine,
	outlineHeadings,
	type Section,
} from "./sections.ts";
import {
	type Anchor,
	DiagnosticStage,
	type Edge,
	EdgeKind,
	type Finding,
	type Monitoring,
	type Node,
	NodeKind,
	ProtocolSpec,
	SPEC_VERSION,
	Timepoint,
	type Warning,
} from "./spec.ts";
import { type SegInput, type SegmentAnswer, Segments, segmentAll } from "./segment.ts";
import { locate, normalize } from "./verify.ts";

/** Tokens per model call of the current build, recorded in build.counts for cost accounting. */
let usage: Record<string, number> = {};
function track(call: string, u: { inputTokens?: number; outputTokens?: number }) {
	usage[`${call}TokensIn`] = (usage[`${call}TokensIn`] ?? 0) + (u.inputTokens ?? 0);
	usage[`${call}TokensOut`] =
		(usage[`${call}TokensOut`] ?? 0) + (u.outputTokens ?? 0);
}

export const PIPELINE_VERSION = "1.0.0";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "qwiklabs-gcp-01-ce74ae98024d";
// Build time is paid once per protocol version; lookups are free. So the pipeline uses the strongest
// model with deep thinking, falling back to faster ones only on quota errors. PIPELINE_MODEL=flash for quick runs.
const MODELS =
	process.env.PIPELINE_MODEL === "flash"
		? [
				{ location: "global", model: "gemini-3-flash-preview" },
				{ location: "europe-west1", model: "gemini-2.5-flash" },
			]
		: [
				{ location: "global", model: "gemini-3.1-pro-preview" },
				{ location: "europe-west1", model: "gemini-2.5-pro" },
				{ location: "global", model: "gemini-3-flash-preview" },
			];

function thinkingFor(model: string) {
	if (model.includes("pro"))
		return model.startsWith("gemini-3")
			? { thinkingLevel: "high" }
			: { thinkingBudget: 8192 };
	return model.startsWith("gemini-3")
		? { thinkingLevel: "low" }
		: { thinkingBudget: 1024 };
}

export type Stage =
	| "parse"
	| "identity"
	| "sections"
	| "label"
	| "anchors"
	| "check"
	| "consistency"
	| "done";
export type StageEvent = {
	stage: Stage;
	message: string;
	ms?: number;
	counts?: Record<string, number>;
};

export interface BuildInput {
	pdf: Uint8Array;
	/** Known protocol ids and titles, to recognise a new version of an existing protocol. */
	known?: {
		id: string;
		short: string;
		title: string;
		version: string;
		sha256: string;
	}[];
	onStage?: (e: StageEvent) => void;
	/** Skip the model call (headings only, every node kind "other"). */
	offline?: boolean;
	/** Disease family from the catalogue (leukaemia, lymphoma, bone_tumours...), when known: steers the work-up staging. */
	family?: string;
}

// --- Blocks -------------------------------------------------------------------------------

const FIGURE_TITLE =
	/^(?:figure|fig\.|table|tableau|schema|scheme|flow\s*chart|algorithm|abbildung|tabelle)\s*[\dA-Z]/i;

const withCaption = (c: Anchor | undefined) => (c ? { caption: c } : {});

/** The page regions a section occupies: from its heading to the next heading (any rank), one box per page. */
function regionsOf(
	s: Section,
	sections: Section[],
	pages: PdfPage[],
	boiler: Set<string>,
	bands?: (page: number) => [number, number][],
): { page: number; bbox: Box }[] {
	const i = sections.indexOf(s);
	const next = sections[i + 1]?.heading;
	const out: { page: number; bbox: Box }[] = [];
	const last = Math.min(s.endPage, s.heading.page + 2);
	for (let pg = s.heading.page; pg <= last; pg++) {
		const p = pages[pg - 1];
		const lines = p.lines.filter(
			(l) =>
				l.bbox[3] > 0.05 * p.height &&
				l.bbox[1] < 0.95 * p.height &&
				!boiler.has(normLine(l.text)) &&
				!/^\d+$/.test(l.text.trim()),
		);
		const x0 = Math.min(
			...lines.map((l) => l.bbox[0]),
			...p.images.map((b) => b[0]),
		);
		const x1 = Math.max(
			...lines.map((l) => l.bbox[2]),
			...p.images.map((b) => b[2]),
		);
		const strict = !!bands; // a figure section: stop at its drawing
		// (a drawing filled with full prose lines is a text box or highlight, not a table)
		const drawn = (bands?.(pg) ?? []).filter(([a, b]) => {
			const inside = p.lines.filter(
				(l) => l.bbox[1] >= a - 3 && l.bbox[3] <= b + 3,
			);
			return (
				inside.filter((l) => !l.cells && l.text.length >= 75).length <=
				inside.length / 2
			);
		});
		let top = pg === s.heading.page ? s.heading.yEnd + 8 : 0.05 * p.height;
		// A drawn table starting right under its title keeps its header row.
		for (const [a, b] of drawn)
			if (pg === s.heading.page && a >= s.heading.yEnd - 1 && a < top && b > top)
				top = Math.max(a - 1, s.heading.yEnd + 1);
		// End at the next heading, else at the last real content (never the running footer).
		const content = [
			...lines.map((l) => l.bbox[3]),
			...p.images.map((b) => b[3]),
		].filter((y) => y > top);
		let bottom =
			next && next.page === pg ? next.y - 2 : Math.max(top, ...content) + 4;
		// A figure ends where ordinary prose resumes (headings after it are often missing from the outline):
		// the first long body line after a gap, unless it reads as a caption or footnote ("A. ...", "* ...", "Note").
		// Below a drawn table/diagram (rules, boxes) or image, no gap is needed: the crop stops after the drawing
		// and its footnotes. On a continuation page the figure must resume at the top, else nothing is cropped.
		let prose = false;
		let prevBottom = top;
		let seen = 0;
		let sawFigure = false;
		let prevFigure = false;
		let prevCaption = false;
		let cut: number | null = null; // top of the first plain line after the last figure/caption line
		for (const l of lines
			.filter((l) => l.bbox[1] >= top && l.bbox[3] <= bottom)
			.sort((a, b) => a.bbox[1] - b.bbox[1])) {
			const inFigure =
				p.images.some((b) => l.bbox[1] >= b[1] - 2 && l.bbox[3] <= b[3] + 2) ||
				drawn.some(([a, b]) => l.bbox[1] >= a - 3 && l.bbox[3] <= b + 3);
			// (a caption or footnote wraps: its tight follow-on lines belong to it)
			const caption: boolean =
				/^(?:[A-H][.)]\s|[*†‡#§¹²³⁴⁵⁶⁷⁸⁹])/.test(l.text) ||
				/^(?:\d\)\s|(?:notes?|abbreviations?|legend|source|key)\b)/i.test(
					l.text,
				) ||
				(strict && prevCaption && l.bbox[1] - prevBottom < 5);
			prevCaption = caption;
			const longProse = !inFigure && !l.cells && l.text.length >= 75 && !caption;
			const figureAbove =
				p.images.some((b) => b[1] >= top - 2 && b[3] <= l.bbox[1] + 2) ||
				drawn.some(([a, b]) => a >= top - 2 && b <= l.bbox[1] + 2);
			sawFigure ||= strict && figureAbove;
			if (
				longProse &&
				(seen >= 2 || (strict && (pg > s.heading.page || sawFigure))) &&
				(l.bbox[1] - prevBottom > 6 ||
					(strict && (prevFigure || sawFigure || pg > s.heading.page)))
			) {
				bottom = (strict && sawFigure && cut !== null ? cut : l.bbox[1]) - 3;
				prose = true;
				break;
			}
			if (inFigure || caption || l.cells) cut = null;
			else cut ??= l.bbox[1];
			sawFigure ||= inFigure;
			prevFigure = inFigure;
			seen++;
			prevBottom = l.bbox[3];
		}
		// A lone line (a heading the outline missed) before prose resumes is not a figure.
		const kept = lines.filter(
			(l) => l.bbox[1] >= top && l.bbox[3] <= bottom,
		).length;
		const hasImage =
			p.images.some((b) => b[3] > top && b[1] < bottom) ||
			drawn.some(([a, b]) => b > top && a < bottom);
		if (
			bottom - top > 20 &&
			Number.isFinite(x0) &&
			(!strict || kept >= 2 || hasImage || !prose)
		)
			out.push({ page: pg, bbox: [x0, top, x1, bottom] });
		// The figure resumes below the prose (a drawn table after its intro paragraph): crop each later drawing too,
		// and follow it onto the next page when it runs to the page bottom.
		let resumed = false;
		if (strict && prose)
			for (const [a, b] of drawn) {
				if (a <= bottom + 2 || (next && next.page === pg && b > next.y))
					continue;
				out.push({ page: pg, bbox: [x0, a - 2, x1, b + 2] });
				resumed = b > 0.85 * p.height;
			}
		if ((prose && !resumed) || (next && next.page === pg)) break;
	}
	return out;
}

const START_CUE =
	/\b(?:start|starting|begin|beginning|commence|given|administered|proceed|continu|recover|recovery|provided|providing|before|prior to|if|when|until|must|should)\b/i;

const COUNT_CRITERION =
	/\b(?:ANC|neutrophils?|granulocytes?|platelets?|thrombocytes?|WBC|leu[ck]ocytes?|haematological recovery|hematological recovery|blood counts?|neutrophiles|plaquettes)\b[^.]{0,80}?(?:[≥>≤<]|recover|x\s*10|\/mm|\/µl|G\/l)/i;

const LONE_BULLET = /^[•●▪◦■□♦◆►▸➢➤✓✔*\-–\uf0b7\uf0a7]$/;
/** Typed rules ("________", "-------", "=====") drawn as text: decoration, not content. */
const RULE_LINE = /^[\s_\-=–—~.·]{5,}$/;

const BULLET = /^(?:[•●▪◦■□♦◆►▸➢➤✓✔*o\-–]\s|\(?[a-z0-9]{1,2}[.)]\s)/i;
/** A multi-level list number ("3.1 Morphology.", "2.1.4 Imaging") opens a sub-item; a decimal in prose ("1.5 mg") does not. */
const SUBNUM = /^\d{1,2}(?:\.\d{1,2}){1,2}\.?\s+\p{Lu}/u;
const ITEM = (t: string) => BULLET.test(t) || SUBNUM.test(t);
/** A line that is only a logical connector, or a criterion ending in one (upper case: "... OR"). */
const CONNECTOR_LINE = /^(?:[•\-–]\s*)?(?:or|and|and\/or)$/i;
const TRAILING_CONNECTOR = /(?:^|[\s,])(?:OR|AND|AND\/OR)$/;
const LEAD_GLYPH = /^[•●▪◦■□♦◆►▸➢➤✓✔\-–]\s*/;

/**
 * Headings found inside a verified table grid are its row labels ("CHEMOTHERAPY", "RADIOTHERAPY" in a road map
 * schedule), not sections: a section cut there tears the table into loose lines and its rows become steps.
 * Only grids the figure analyser verifies cell by cell count (three or more rows), so callouts and flowcharts keep their headings.
 */
export function dropGridHeadings(
	headings: Heading[],
	pages: PdfPage[],
	figs: ReturnType<typeof createFigureAnalyser>,
): Heading[] {
	const grids = new Map<number, Box[]>();
	const gridsOf = (pg: number) => {
		let g = grids.get(pg);
		if (!g) {
			const lines = pages[pg - 1]?.lines ?? [];
			g = figs.bands(pg).flatMap(([a, b]): Box[] => {
				const inside = lines.filter(
					(l) => l.bbox[1] >= a - 3 && l.bbox[3] <= b + 3,
				);
				if (inside.length < 3) return [];
				const w = figs.widen(pg, [
					Math.min(...inside.map((l) => l.bbox[0])),
					a,
					Math.max(...inside.map((l) => l.bbox[2])),
					b,
				]);
				return (figs.table(pg, w)?.table?.rows.length ?? 0) >= 3 ? [w] : [];
			});
			grids.set(pg, g);
		}
		return g;
	};
	return headings.filter(
		(h) => !gridsOf(h.page).some((b) => h.y >= b[1] - 1 && h.yEnd <= b[3] + 1),
	);
}

/** Group a section's lines into paragraphs / list items: one Anchor each. */
/**
 * Tables flatten badly as text (cells interleave, columns lose their meaning), so runs of
 * multi-cell lines are kept as a table: shown as the cropped page region, text kept for search.
 */
export function splitTables(
	lines: Line[],
	bands?: (page: number) => [number, number][],
	grid?: (page: number, bbox: Box) => boolean,
): { text: Line[]; tables: { page: number; bbox: Box; lines: Line[] }[] } {
	const text: Line[] = [];
	const tables: { page: number; bbox: Box; lines: Line[] }[] = [];
	// Lines inside a ruled grid (drawn rules/boxes) laid out in two or more columns are table rows even when
	// the gap between columns is too narrow to read as cells ("Intrathecal therapy | Intrathecal therapy, dosing ...").
	const ruled = new Set<Line>();
	for (const pg of bands ? new Set(lines.map((l) => l.page)) : [])
		for (const [a, b] of bands!(pg)) {
			const inside = lines.filter(
				(l) => l.page === pg && l.bbox[1] >= a - 3 && l.bbox[3] <= b + 3,
			);
			// (a grid whose cells hold running prose, like a synopsis, reads better as text)
			if (
				inside.length < 3 ||
				inside.filter((l) => !l.cells && l.text.length >= 75).length >
					Math.max(2, inside.length / 4)
			)
				continue;
			const lefts = [
				...new Set(inside.map((l) => Math.round(l.bbox[0] / 10))),
			].sort((x, y) => x - y);
			// A grid whose rows all start in its first column ("Drug | Age <1 | ..." over "Single Mtx dosing"):
			// two rows of three or more cells, and the drawing cuts into a verified grid (column rules, not
			// a frame around a formula or a callout), make it a table, its one-cell rows included.
			const multi = () =>
				inside.filter((l) => l.cells >= 2).length >= 2 &&
				!!grid?.(pg, [
					Math.min(...inside.map((l) => l.bbox[0])),
					a,
					Math.max(...inside.map((l) => l.bbox[2])),
					b,
				]);
			if (lefts.at(-1)! - lefts[0] >= 4 || multi())
				for (const l of inside) ruled.add(l);
		}
	const cellish = (l: Line) => l.cells > 0 || ruled.has(l);
	let i = 0;
	while (i < lines.length) {
		if (!cellish(lines[i])) {
			text.push(lines[i++]);
			continue;
		}
		// Extend the run over tabular lines and short wrapped cell fragments on the same page.
		let j = i;
		let tabular = 0;
		let quiet = 0;
		// Two-column layouts ("Cyclophosphamide (CPM) | 1000 mg/m2 over 30-60 min ...") read as interleaved
		// lines: a line indented to the description column, or a short one, continues the table.
		const left = lines[i].bbox[0];
		while (j < lines.length && lines[j].page === lines[i].page) {
			const l = lines[j];
			if (cellish(l)) {
				tabular++;
				quiet = 0;
			} else if (l.bbox[0] > left + 40 || (l.text.length < 60 && quiet < 2))
				quiet = l.bbox[0] > left + 40 ? 0 : quiet + 1;
			else if (quiet < 1) quiet++;
			else break;
			j++;
		}
		const end = j - quiet;
		if (tabular >= 3) {
			const run = lines.slice(i, end);
			const bbox: Box = [
				Math.min(...run.map((l) => l.bbox[0])),
				Math.min(...run.map((l) => l.bbox[1])),
				Math.max(...run.map((l) => l.bbox[2])),
				Math.max(...run.map((l) => l.bbox[3])),
			];
			tables.push({ page: run[0].page, bbox, lines: run });
			i = end;
		} else {
			text.push(...lines.slice(i, end));
			i = end;
		}
	}
	// One table often reads as several runs (rows with a single filled cell break the run):
	// merge runs on the same page that are close together, with the lines between them.
	const merged: typeof tables = [];
	for (const t of tables) {
		const last = merged.at(-1);
		if (last && last.page === t.page && t.bbox[1] - last.bbox[3] < 70) {
			const between = text.filter(
				(l) =>
					l.page === t.page &&
					l.bbox[1] >= last.bbox[3] - 1 &&
					l.bbox[3] <= t.bbox[1] + 1,
			);
			last.lines.push(...between, ...t.lines);
			last.bbox = [
				Math.min(last.bbox[0], t.bbox[0], ...between.map((l) => l.bbox[0])),
				last.bbox[1],
				Math.max(last.bbox[2], t.bbox[2], ...between.map((l) => l.bbox[2])),
				t.bbox[3],
			];
		} else merged.push({ ...t, lines: [...t.lines] });
	}
	const inTable = new Set(merged.flatMap((t) => t.lines));
	return { text: text.filter((l) => !inTable.has(l)), tables: merged };
}

export function blocksOf(all: Line[]): Anchor[] {
	const lines = all.filter((l) => !RULE_LINE.test(l.text));
	const out: Anchor[] = [];
	let cur: Line[] = [];
	const flush = () => {
		if (cur.length)
			out.push({
				page: cur[0].page,
				text: cur.map((l) => l.text).join("\n"),
				bbox: cur.map((l) => l.bbox),
			});
		cur = [];
	};
	for (const l of lines) {
		const prev = cur.at(-1);
		if (prev) {
			const h = prev.bbox[3] - prev.bbox[1];
			const gap = l.bbox[1] - prev.bbox[3];
			// "OR / AND / unless" lines continue the previous criterion: never split the logic apart.
			const joins =
				/^(?:or|and|and\/or|unless|except)\b/i.test(l.text) &&
				l.page === prev.page &&
				gap < 1.5 * h;
			// A bullet glyph extracted on its own line opens an item; the text right after it belongs to it.
			const loneBullet = LONE_BULLET.test(l.text);
			const afterBullet = LONE_BULLET.test(prev.text) && cur.length === 1;
			// "...and rising." then "Each subsequent block is started when:" are two different statements.
			const newIntro =
				/[.;]$/.test(prev.text.trim()) && /:\s*$/.test(l.text.trim());
			// A list item ends when the text moves back left of its indent (an ordinary paragraph resumes).
			const itemStart = cur.find((c) => !LONE_BULLET.test(c.text));
			const dedent =
				(LONE_BULLET.test(cur[0].text) || ITEM(cur[0].text)) &&
				itemStart !== undefined &&
				itemStart !== l &&
				l.bbox[0] < itemStart.bbox[0] - 6 &&
				(/[.;:]$/.test(prev.text.trim()) || l.text.trim().length <= 40);
			// A bold line ending in ":" is a run-in heading ("Toxicity and Late Effects Follow-up:"): its own block,
			// and the paragraph after it starts a new one.
			// A short unmarked line at (or left of) the bullet's own position is a sub-heading ("Laboratory criteria"), not a wrap.
			const sideHeading =
				ITEM(cur[0].text) &&
				!ITEM(l.text) &&
				l.bbox[0] <= cur[0].bbox[0] + 2 &&
				l.text.trim().length <= 40 &&
				!/^(?:or|and)\b/i.test(l.text);
			const runIn =
				(l.bold && /:\s*$/.test(l.text) && !/^\p{Ll}/u.test(l.text)) ||
				(prev.bold && /:\s*$/.test(prev.text) && !l.bold);
			const samePage = l.page === prev.page;
			// "• CNS3 status OR" / "OR" then "• Cranial nerve palsy": the alternatives form one criterion.
			const joined =
				samePage &&
				gap < 2 * h &&
				(TRAILING_CONNECTOR.test(prev.text.trim()) ||
					CONNECTOR_LINE.test(prev.text.trim()));
			const loneJoin =
				samePage && gap < 2 * h && CONNECTOR_LINE.test(l.text.trim());
			// A list item wrapping onto a lowercase line continues, even across a wide justified gap ("cells")
			// or a bold tail ("...reported within 24 hours:").
			const inItem = LONE_BULLET.test(cur[0].text) || ITEM(cur[0].text);
			const cont =
				inItem &&
				samePage &&
				gap < 1.5 * h &&
				/^\p{Ll}/u.test(l.text) &&
				!ITEM(l.text) &&
				!/[.:;]$/.test(prev.text.trim()) &&
				l.bbox[0] >= cur[0].bbox[0] - 6;
			// A short run-in heading line repeated as the paragraph's first words ("Pre-hydration" / "Pre-hydration should be...").
			const head =
				cur.length === 1 || (cur.length === 2 && LONE_BULLET.test(cur[0].text))
					? prev.text.replace(LEAD_GLYPH, "")
					: "";
			// Also "IRB Approval" / "Approval from ...", and a bold heading line over a regular paragraph ("5.6.1 - Timing").
			const short =
				head.length >= 4 &&
				head.length <= 60 &&
				!/[.:;,]$/.test(head) &&
				head.split(/\s+/).length <= 6;
			const lastWord = head.split(/\s+/).at(-1) ?? "";
			const repeats =
				short &&
				(l.text.startsWith(`${head} `) ||
					(/^\p{Lu}\p{Ll}{4,}$/u.test(lastWord) &&
						l.text.startsWith(`${lastWord} `)) ||
					(!inItem &&
						prev.bold &&
						!l.bold &&
						/^\p{Lu}/u.test(l.text) &&
						l.text.length > head.length));
			const keep = joins || joined || loneJoin || cont;
			if (
				repeats ||
				(!keep && (runIn || sideHeading || loneBullet || newIntro || dedent)) ||
				(!keep &&
					!afterBullet &&
					(!samePage ||
						ITEM(l.text) ||
						gap > 0.9 * h ||
						l.cells ||
						prev.cells))
			)
				flush();
		}
		cur.push(l);
	}
	flush();
	return out;
}

/** One segmentation call (segment.ts), with the usual model fallbacks on quota errors. */
export async function askSegments(prompt: string): Promise<SegmentAnswer> {
	let last: unknown;
	for (const { location, model } of MODELS) {
		try {
			const vertex = createVertex({ project: PROJECT, location });
			const r = await generateText({
				model: vertex(model),
				output: Output.object({ schema: Segments }),
				prompt,
				temperature: 0,
				providerOptions: { vertex: { thinkingConfig: thinkingFor(model) } },
			});
			track("segment", r.usage);
			return r.output;
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

// --- Identity -----------------------------------------------------------------------------

const VERSION = /\b(?:version|vers\.?|v)\s*[:.]?\s*(\d+(?:\.\d+)*[a-z]?)\b/i;
const DATE_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
	[
		/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/,
		(m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`,
	],
	[/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
	[
		/\b(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]*(\d{4})\b/i,
		(m) =>
			`${m[3]}-${String("janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[2].toLowerCase().slice(0, 3)) / 3 + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`,
	],
];

function identity(pages: PdfPage[]) {
	// Running header/footer: the most common line over pages 2-20 that mentions a version.
	const freq = new Map<string, { n: number; line: Line }>();
	for (const p of pages.slice(1, 20))
		for (const l of p.lines)
			if (VERSION.test(l.text) || DATE_PATTERNS.some(([re]) => re.test(l.text))) {
				const k = l.text.replace(/\bpage\s*\d+(\s*of\s*\d+)?/i, "").trim();
				freq.set(k, { n: (freq.get(k)?.n ?? 0) + 1, line: l });
			}
	const header = [...freq.entries()].sort((a, b) => b[1].n - a[1].n)[0];
	const cover = pages[0]?.lines ?? [];
	const titleLines = [...cover]
		.filter((l) => l.text.length > 3)
		.sort((a, b) => b.size - a.size)
		.slice(0, 3);
	const title = titleLines
		.sort((a, b) => a.bbox[1] - b.bbox[1])
		.map((l) => l.text)
		.join(" ");
	const sources = [header?.[1].line, ...cover].filter(Boolean) as Line[];
	let version = "";
	let date: string | null = null;
	let evidence: Line | undefined;
	for (const l of sources) {
		const v = VERSION.exec(l.text);
		if (v && !version) {
			version = v[1];
			evidence = l;
		}
		for (const [re, fmt] of DATE_PATTERNS) {
			const m = l.text.match(re);
			if (m && !date) date = fmt(m);
		}
	}
	return {
		title: title || "Untitled protocol",
		version,
		date,
		evidence: evidence
			? ({
					page: evidence.page,
					text: evidence.text,
					bbox: [evidence.bbox],
				} satisfies Anchor)
			: undefined,
	};
}

function languageOf(pages: PdfPage[]): string {
	const text = pages
		.slice(0, 40)
		.map((p) => p.text)
		.join(" ")
		.toLowerCase();
	const score = (words: string[]) =>
		words.reduce(
			(n, w) => n + (text.match(new RegExp(`\\b${w}\\b`, "g"))?.length ?? 0),
			0,
		);
	const s = {
		en: score(["the", "and", "with", "patients"]),
		fr: score(["les", "des", "avec", "patients"]),
		de: score(["der", "und", "die", "mit"]),
	};
	return (Object.entries(s).sort((a, b) => b[1] - a[1])[0] ?? ["en"])[0];
}

// --- Labelling ----------------------------------------------------------------------------

const Labels = z.object({
	nodes: z
		.array(
			z.object({
				id: z
					.string()
					.describe(
						"Heading id from the list (e.g. h12). Only ids that exist.",
					),
				kind: NodeKind,
				stage: DiagnosticStage.optional().describe(
					"Only for diagnostic work-up headings (kind diagnostics): the work-up stage.",
				),
				parent: z
					.string()
					.nullable()
					.optional()
					.describe(
						"Only if the heading tree is wrong: the id of the heading this belongs under (e.g. a start_requirements heading under its step).",
					),
			}),
		)
		.describe("Every heading that is not 'other'. Omit headings that are 'other'."),
	edges: z
		.array(
			z.object({
				from: z.string(),
				to: z.string(),
				kind: EdgeKind,
				evidencePage: z
					.number()
					.int()
					.optional()
					.describe("Page of the sentence that establishes the edge."),
				evidenceQuote: z
					.string()
					.optional()
					.describe(
						"That sentence copied exactly from the excerpt (5-30 words).",
					),
			}),
		)
		.describe(
			"Treatment flow between step/phase headings in the order a patient goes through them, forks as 'alternative' edges, re-stratification as 'restratify_to', and 'see_also' from a step to response/supportive sections elsewhere. Only ids from the list.",
		),
});

function outlineForModel(sections: Section[]): string {
	return sections
		.map((s) => {
			const depth = s.path.length - 1;
			const excerpt = s.lines
				.slice(0, 4)
				.map((l) => l.text)
				.join(" ")
				.slice(0, 220);
			return `${s.heading.id} p${s.heading.page} ${"  ".repeat(Math.min(depth, 6))}${s.heading.title}${excerpt ? ` | ${excerpt}` : ""}`;
		})
		.join("\n");
}

const LineStages = z.object({
	lines: z
		.array(
			z.object({
				id: z.string().describe("Line id from the list (e.g. d12)."),
				stage: z.enum([
					"primary",
					"molecular",
					"extent",
					"baseline",
					"relapse",
					"follow_up",
					"on_treatment",
					"none",
				]),
				role: z
					.enum(["item", "technique", "context"])
					.describe(
						"item = an investigation to do (tickable); technique = how to do it (imaging protocol, sequences, acquisition parameters, positioning, contrast dosing); context = intro, explanation, rationale.",
					),
			}),
		)
		.describe("One entry per line id."),
});
type Stage4 = z.infer<typeof DiagnosticStage>;
type LineIn = { id: string; section: string; text: string; nodeId: string };

const LIST_ITEM = /^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–]|o\s|\(?[a-z0-9]{1,2}[.)]\s)/i;
/** Lists of the work-up: an intro line ending ":" and the item lines after it, inside one section. */
function workupLists(lines: LineIn[]): { intro: LineIn; items: LineIn[] }[] {
	const out: { intro: LineIn; items: LineIn[] }[] = [];
	let cur: { intro: LineIn; items: LineIn[] } | null = null;
	for (const l of lines) {
		const tx = l.text.trim();
		if (cur && cur.intro.nodeId !== l.nodeId) cur = null;
		if (cur && (LIST_ITEM.test(tx) || (cur.items.length && /^[a-z]/.test(tx))))
			cur.items.push(l);
		else if (/:\s*$/.test(tx) && tx.length < 240)
			out.push((cur = { intro: l, items: [] }));
		else cur = null;
	}
	return out.filter((x) => x.items.length);
}

const RELAPSE_TITLE = /\b(relaps\w*|recurren\w*|progressi(?:on|ve disease))\b/i;
const FOLLOW_TITLE = /\bfollow[- ]?up\b|after (the )?end of (treatment|therapy)/i;

type RawStages = z.infer<typeof LineStages>["lines"];

/**
 * Sort the diagnostic work-up's verbatim lines into the clinical order of the work-up:
 * 1 primary tumour, 2 molecular/genetic, 3 extent of disease, 4 pre-treatment baseline,
 * plus work-ups at relapse and during follow-up, which are not part of the initial diagnosis.
 * The model sees line ids with their text (lists marked with their intro) and returns a stage and role per id; it writes no text.
 * Code then settles lists (settleStages): a list whose intro sets the context or that describes one procedure stays in one stage,
 * a long list of distinct investigations keeps a stage per item; the section title wins for relapse/follow-up sections.
 */
export async function stageModel(
	title: string,
	lines: LineIn[],
	family?: string,
): Promise<RawStages> {
	const lists = workupLists(lines);
	const tag = new Map<string, string>();
	lists.forEach((l, i) => {
		tag.set(l.intro.id, `L${i} intro`);
		for (const it of l.items) tag.set(it.id, `L${i} item`);
	});
	const prompt = [
		`Paediatric oncology protocol "${title}". Below are the lines of its diagnostic work-up and assessment sections, each with an id and its section path; list lines are marked "Lk intro" / "Lk item".`,
		"Assign each line the stage it belongs to, in the order a clinician works:",
		"primary = establishing the primary tumour/disease: history and clinical exam of the presenting problem, imaging of the primary site (e.g. MRI of the primary), biopsy, histology, morphology, immunophenotyping, pathology review;",
		"molecular = genetic/molecular confirmation and tumour biology: translocations, fusion genes (e.g. EWSR1, PAX-FOXO1), cytogenetics, FISH, NGS, MYCN, molecular markers, germline predisposition;",
		"extent = extent of disease / staging ('bilan d'extension'): metastatic work-up, chest CT, PET-CT, bone scintigraphy, whole-body MRI, bone marrow aspirate/trephine for involvement, CSF/CNS status, definitions of metastases;",
		"baseline = pre-treatment baseline: organ function and fitness before therapy (echocardiography, ECG, renal function/GFR, liver function, audiometry, fertility preservation, pregnancy test, serology, blood counts, height/weight, consent, performance status);",
		"relapse = the work-up at suspected or confirmed relapse, recurrence or progression (any line in a relapse/recurrence section, or under a list intro about recurrence), never the initial stages;",
		"follow_up = investigations during follow-up after end of treatment, never the initial stages;",
		"on_treatment = an investigation at a timepoint during treatment (day 15 or day 29 marrow, MRD during therapy, before each course, end of a phase), not the work-up at diagnosis;",
		"none = not an investigation (general text, references, trial administration).",
		"A list is one unit: its intro line sets the context for all its items ('All children with a suspected tumour recurrence should have:' makes every item relapse). Give a list's intro and items the same stage unless an item is clearly a different kind of investigation within the same context.",
		...(family === "leukaemia" || family === "marrow_failure_histiocytosis"
			? [
					"This is a leukaemia/marrow protocol: primary = confirming the diagnosis (the diagnostic bone marrow aspirate/trephine, blood count and smear, morphology, immunophenotyping, cytochemistry); molecular = cytogenetics, molecular genetics, fusion transcripts, MRD markers; extent = CNS/CSF status, testicular or other extramedullary involvement, mediastinal mass, organomegaly. The bone marrow examination at diagnosis is primary, not extent.",
				]
			: family === "lymphoma"
				? [
						"This is a lymphoma protocol: primary = confirming the diagnosis (biopsy of a node or mass, histology, immunohistochemistry); molecular = molecular/genetic markers; extent = staging (PET-CT, CT/MRI of involved regions, bone marrow, CSF).",
					]
				: []),
		"Also give each line a role: item (an investigation or action to do), technique (how-to: imaging protocol, MRI sequences, slice thickness, contrast, PET acquisition parameters, positioning) or context (intro, explanation, rationale). Technique lines keep the stage of the investigation they describe.",
		"",
		...lines.map(
			(l) =>
				`${l.id} [${l.section}]${tag.has(l.id) ? ` ${tag.get(l.id)}:` : ""} ${l.text.replace(/\s+/g, " ").slice(0, 240)}`,
		),
	].join("\n");
	let out: z.infer<typeof LineStages> | undefined;
	let last: unknown;
	for (const { location, model } of MODELS) {
		try {
			const vertex = createVertex({ project: PROJECT, location });
			const thinkingConfig = thinkingFor(model);
			const r = await generateText({
				model: vertex(model),
				output: Output.object({ schema: LineStages }),
				prompt,
				temperature: 0,
				providerOptions: { vertex: { thinkingConfig } },
			});
			track("stages", r.usage);
			out = r.output;
			break;
		} catch (e) {
			last = e;
		}
	}
	if (!out) throw last;
	return out.lines;
}

/** Lines per staging call: long work-ups are staged in chunks of whole sections. */
const STAGE_CHUNK = 300;

/**
 * Stage the diagnostic work-up in place: every line under a diagnostics node gets its work-up stage.
 * Schedule-of-assessment sections are staged too, because protocols often describe the examinations at diagnosis
 * in a "Study assessments" chapter. One whose investigations are mostly the initial work-up becomes diagnostics;
 * the others keep their kind and no stages.
 */
export async function stageWorkup(
	nodes: Node[],
	title: string,
	family?: string,
): Promise<{ staged: number; moved: string[] }> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const rootOf = (n: Node, kind: NodeKind): Node | undefined => {
		let root: Node | undefined;
		for (
			let p: Node | undefined = n;
			p;
			p = p.parent ? byId.get(p.parent) : undefined
		)
			if (p.kind === kind) root = p;
		return root;
	};
	const groups = new Map<string, { root: Node; nodes: Node[] }>();
	for (const n of nodes) {
		const root =
			rootOf(n, "diagnostics") ??
			(n.kind === "schedule" ? rootOf(n, "schedule") : undefined);
		if (!root) continue;
		const g = groups.get(root.id) ?? { root, nodes: [] };
		g.nodes.push(n);
		groups.set(root.id, g);
	}
	let next = 0;
	const lines = [...groups.values()].map((g) =>
		g.nodes.flatMap((n) =>
			n.blocks.map((a) => ({
				id: `d${next++}`,
				section: [n.headingPath.at(-1), n.title].filter(Boolean).join(" > "),
				text: a.text,
				nodeId: n.id,
				a,
				root: g.root,
			})),
		),
	);
	const chunks: (typeof lines)[number][] = [];
	for (const g of lines) {
		const last = chunks.at(-1);
		if (last && last.length + g.length <= STAGE_CHUNK) last.push(...g);
		else
			for (let i = 0; i < g.length; i += STAGE_CHUNK)
				chunks.push(g.slice(i, i + STAGE_CHUNK));
	}
	const raw = (
		await Promise.all(chunks.map((c) => stageModel(title, c, family)))
	).flat();
	const settled = settleStages(lines.flat(), raw);
	const rawStage = new Map(raw.map((x) => [x.id, x.stage]));
	const moved: string[] = [];
	for (const g of groups.values()) {
		if (g.root.kind !== "schedule") continue;
		const own = lines.flat().filter((l) => l.root === g.root);
		const kinds = own
			.map((l) => rawStage.get(l.id))
			.filter((st) => st && st !== "none");
		const initial = kinds.filter(
			(st) =>
				st === "primary" ||
				st === "molecular" ||
				st === "extent" ||
				st === "baseline",
		).length;
		if (initial >= 5 && initial >= kinds.length / 2) {
			for (const n of g.nodes) n.kind = "diagnostics";
			moved.push(g.root.id);
		}
	}
	let staged = 0;
	for (const l of lines.flat()) {
		if (l.root.kind !== "diagnostics") continue;
		const st = settled.get(l.id);
		if (st?.stage) ((l.a.stage = st.stage), staged++);
		if (st?.technique) l.a.technique = true;
	}
	return { staged, moved };
}

/** At least this many items make a list of distinct investigations rather than one procedure's parts. */
const LIST_PER_ITEM = 5;

export function settleStages(lines: LineIn[], raw: RawStages) {
	const res = new Map<string, { stage?: Stage4; technique?: boolean }>();
	const lists = workupLists(lines);
	const ids = new Set(lines.map((l) => l.id));
	for (const x of raw) {
		if (!ids.has(x.id)) continue;
		res.set(x.id, {
			...(x.stage !== "none" && x.stage !== "on_treatment"
				? { stage: x.stage }
				: {}),
			...(x.role === "technique" ? { technique: true } : {}),
		});
	}
	const stageOf = (id: string) => res.get(id)?.stage;
	const setStage = (id: string, st: Stage4) =>
		res.set(id, { ...res.get(id), stage: st });
	const later = (st: Stage4 | undefined) => st === "relapse" || st === "follow_up";
	// A section titled for relapse/recurrence or follow-up is that work-up, whatever stage its investigations got.
	for (const l of lines) {
		if (!stageOf(l.id)) continue; // not an investigation (statistics, administration under a mislabelled heading)
		const own = l.section.split(" > ").at(-1) ?? "";
		if (/\bdiagnos/i.test(own) && !RELAPSE_TITLE.test(own)) continue;
		if (RELAPSE_TITLE.test(own)) setStage(l.id, "relapse");
		else if (FOLLOW_TITLE.test(own)) setStage(l.id, "follow_up");
	}
	for (const l of lists) {
		const its = l.items.map((i) => i.id);
		const intro = stageOf(l.intro.id);
		const counts = new Map<Stage4, number>();
		for (const id of its) {
			const st = stageOf(id);
			if (st) counts.set(st, (counts.get(st) ?? 0) + 1);
		}
		const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
		const staged = [...counts.values()].reduce((a, b) => a + b, 0);
		// An intro about relapse or follow-up decides the whole list.
		if (later(intro)) {
			for (const id of its) setStage(id, intro!);
			continue;
		}
		// A long list of distinct investigations spanning initial stages (morphology, genetics, CNS, organ function)
		// keeps a stage per item; stray relapse/follow-up items and unstaged continuation lines follow their neighbours.
		const initial = [...counts].filter(([st]) => !later(st));
		const spans =
			its.length >= LIST_PER_ITEM &&
			initial.length >= 2 &&
			initial.filter(([, k]) => k >= 2).length >= 2;
		if (spans) {
			const [main] = initial.sort((a, b) => b[1] - a[1])[0]!;
			if (!intro) setStage(l.intro.id, main);
			let prev: Stage4 = intro ?? main;
			for (const id of its) {
				const cur = stageOf(id);
				if (!cur || later(cur)) setStage(id, prev);
				else prev = cur;
			}
			continue;
		}
		// Otherwise the list is one unit: the intro's stage, else the items' clear majority.
		const st =
			intro && (counts.get(intro) ?? 0) >= staged / 3
				? intro
				: top && n >= 0.6 * staged
					? top
					: intro;
		if (!st) continue;
		for (const id of [l.intro.id, ...its]) setStage(id, st);
	}
	return res;
}

const Matrix = z.object({
	rows: z
		.array(
			z.object({
				label: z
					.string()
					.describe(
						"Short name of what is checked or given, 1-4 words (e.g. 'Echocardiography', 'Renal function / GFR', 'Audiometry', 'PJP prophylaxis', 'Antiemetics', 'G-CSF').",
					),
				group: z.enum(["monitoring", "prophylaxis", "dose_modification"]),
				cells: z.array(
					z.object({
						timepoint: Timepoint,
						detail: z
							.string()
							.optional()
							.describe(
								"Only for before_specific_course (the course or drug, e.g. 'anthracycline courses') and on_toxicity (the trigger, e.g. 'grade 3 neuropathy'): 1-5 words.",
							),
						lines: z
							.array(z.string())
							.describe(
								"Ids of the lines (e.g. m12) that state this item at this timepoint. Only ids from the list.",
							),
					}),
				),
			}),
		)
		.describe(
			"One row per thing checked or given; one cell per timepoint the lines mention.",
		),
});

/**
 * Supportive care & toxicity as a monitoring matrix: rows = what is checked or given, columns = timepoints.
 * The model sees line ids with their text and points at ids; it writes only row labels and column qualifiers.
 * Code resolves ids to the verbatim anchors and drops anything that does not resolve.
 */
async function monitoringMatrix(
	title: string,
	lines: { id: string; section: string; a: Anchor }[],
): Promise<Monitoring | undefined> {
	if (!lines.length) return undefined;
	const prompt = [
		`Paediatric oncology protocol "${title}". Below are lines from its baseline work-up, supportive care, toxicity / dose modification, drug information and schedule-of-assessment sections, each with an id and its section.`,
		"Build a monitoring matrix a clinician reads at a glance: rows = what is checked or given (an investigation such as echocardiography, renal function/GFR, audiometry, blood counts, liver function; a prophylaxis or supportive measure such as PJP prophylaxis, antifungal prophylaxis, antiemetics, G-CSF, hydration, transfusion; a dose modification such as 'Vincristine neuropathy' or 'Methotrexate delayed clearance'),",
		"columns = the timepoints the lines state (see the timepoint definitions in the schema), cells = the ids of the lines that say it.",
		"Group rows: monitoring = investigations; prophylaxis = prophylaxis and supportive care; dose_modification = dose modifications or holds for toxicity.",
		"Baseline (pre-treatment) lines are at_diagnosis. A dose modification triggered by a toxicity is on_toxicity with the trigger as detail.",
		"Only use ids from the list; a cell must cite at least one line that actually states it. Merge duplicates into one row. Leave out lines that are not about monitoring, prophylaxis, supportive care or toxicity. At most 40 rows.",
		"",
		...lines.map(
			(l) =>
				`${l.id} [${l.section.slice(-110)}] ${l.a.text.replace(/\s+/g, " ").slice(0, 300)}`,
		),
	].join("\n");
	const byId = new Map(lines.map((l) => [l.id, l.a]));
	let last: unknown;
	for (const { location, model } of MODELS) {
		try {
			const vertex = createVertex({ project: PROJECT, location });
			const thinkingConfig = thinkingFor(model);
			const r = await generateText({
				model: vertex(model),
				output: Output.object({ schema: Matrix }),
				prompt,
				temperature: 0,
				providerOptions: { vertex: { thinkingConfig } },
			});
			track("monitoring", r.usage);
			const rows: Monitoring["rows"] = [];
			for (const [i, row] of r.output.rows.entries()) {
				const cells = row.cells
					.map((c) => {
						const anchors = [...new Set(c.lines)]
							.map((id) => byId.get(id))
							.filter((a): a is Anchor => !!a);
						// A qualifier is a label: keep it only when every number in it is printed in the cited lines.
						const d = c.detail?.trim();
						const cited = normalize(anchors.map((a) => a.text).join(" "));
						const grounded =
							!!d &&
							(d.match(/\d+(?:[.,]\d+)?/g) ?? []).every((x) =>
								cited.includes(x),
							);
						const qualifies =
							c.timepoint === "before_specific_course" ||
							c.timepoint === "on_toxicity";
						return {
							timepoint: c.timepoint,
							...(d && grounded && qualifies ? { detail: d } : {}),
							lines: anchors,
						};
					})
					.filter((c) => c.lines.length);
				if (cells.length && row.label.trim())
					rows.push({
						id: `m${i}`,
						label: row.label.trim(),
						group: row.group,
						cells,
					});
			}
			return rows.length ? { model, rows } : undefined;
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

async function label(title: string, sections: Section[]) {
	const prompt = [
		`You label the structure of a paediatric oncology clinical trial protocol: "${title}".`,
		"Below is every heading code found in the PDF: id, page, indentation = nesting, title, then the first words under it.",
		"Assign a kind to headings a clinician navigates to (see the kind definitions in the schema), fix parents only where the nesting is clearly wrong, and give the treatment flow as edges.",
		"Prefer the most specific heading: a 'Requirements for beginning X' or 'Starting Criteria' heading is start_requirements and its parent is the step X.",
		"Investigations repeated before or during each treatment course ('Investigations for course 2') are kind schedule, not diagnostics.",
		"The diagnostic work-up (investigations at diagnosis, biopsy, pathology, molecular/genetic tests, imaging, staging, metastatic work-up, 'assessment prior to start of treatment', baseline organ function) is kind diagnostics, never start_requirements, and each such heading gets a stage: primary, molecular, extent or baseline; a work-up at relapse/recurrence gets stage relapse and investigations during follow-up get stage follow_up. Label every heading of the work-up, including its imaging and sub-sections.",
		"Headings that are table rows, drug lines or fragments are 'other' (omit them). Never invent ids.",
		"Treatment flow rules: steps are treatment elements a patient receives (courses, blocks, cycles, induction/consolidation/maintenance elements); surgery, radiotherapy or other guideline chapters, appendices, biobanking and trial administration are NOT steps and get no flow edges.",
		"Alternatives: when sibling steps share a stem with a letter or variant (Induction A..F, Course 4 hA / HA, standard vs experimental arm), they are mutually exclusive options: give an 'alternative' edge from the preceding step (or decision point) to EACH option, never a 'next' chain between them.",
		"Evidence: for every edge, give the sentence that decides it. For alternatives and re-stratification that is the decision rule (MRD level, response, risk group, randomisation, age, eligibility), not timing text; for 'next' it is the sentence stating that the next element follows (e.g. 'commences at least 28 days after').",
		"Every risk_groups/risk_group heading must define how patients are assigned to groups (criteria, strata, MRD/genetic rules); objectives, aims, endpoints and rationale sections are 'other'.",
		"",
		outlineForModel(sections),
	].join("\n");
	let last: unknown;
	for (const { location, model } of MODELS) {
		try {
			const vertex = createVertex({ project: PROJECT, location });
			// Labelling is pattern matching on headings: low thinking cuts the call from minutes to seconds.
			const thinkingConfig = thinkingFor(model);
			const r = await generateText({
				model: vertex(model),
				output: Output.object({ schema: Labels }),
				prompt,
				temperature: 0,
				providerOptions: { vertex: { thinkingConfig } },
			});
			track("label", r.usage);
			return {
				labels: r.output,
				model,
				tokens: (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0),
			};
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

// --- Assembly -----------------------------------------------------------------------------

const slug = (s: string) =>
	s
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60) || "x";

/** Find the lines on a page that cover a quote; returns an Anchor with code-copied text, or null. */
function anchorFor(pages: PdfPage[], page: number, quote: string): Anchor | null {
	const p = pages[page - 1];
	if (!p || !locate(quote, p.text).verified) return null;
	const q = normalize(quote);
	const lines = p.lines;
	// The shortest run of lines that contains the quote: never pad the evidence with neighbouring text.
	let best: [number, number] | null = null;
	for (let i = 0; i < lines.length; i++) {
		let acc = "";
		for (let j = i; j < Math.min(lines.length, i + 12); j++) {
			acc = normalize(`${acc} ${lines[j].text}`);
			if (acc.length >= q.length * 0.8 && locate(quote, acc).verified) {
				if (!best || j - i < best[1] - best[0]) best = [i, j];
				break;
			}
		}
	}
	if (!best) return null;
	const span = lines.slice(best[0], best[1] + 1);
	return {
		page,
		text: span.map((l) => l.text).join("\n"),
		bbox: span.map((l) => l.bbox),
	};
}

export async function buildSpec(input: BuildInput): Promise<ProtocolSpec> {
	usage = {};
	const emit = input.onStage ?? (() => {});
	const timings: Record<string, number> = {};
	const warnings: Warning[] = [];
	let t = performance.now();
	const lap = (stage: Stage) => {
		const now = performance.now();
		timings[stage] = Math.round(now - t);
		t = now;
		return timings[stage];
	};

	const doc: mupdf.Document = openPdf(input.pdf);
	const pages = readPages(doc);
	const hash = sha256(input.pdf);
	emit({
		stage: "parse",
		message: `Read ${pages.length} pages`,
		ms: lap("parse"),
		counts: { pages: pages.length },
	});

	const id = identity(pages);
	const lang = languageOf(pages);
	const match = (input.known ?? [])
		.map((k) => {
			const a = new Set(normalize(k.title).split(" "));
			const b = normalize(id.title).split(" ");
			const overlap = b.filter((w) => a.has(w)).length / Math.max(1, b.length);
			const shortHit = normalize(
				id.title + " " + (id.evidence?.text ?? ""),
			).includes(normalize(k.short));
			return { k, score: overlap + (shortHit ? 1 : 0) };
		})
		.sort((a, b) => b.score - a.score)[0];
	const known = match && match.score >= 0.8 ? match.k : undefined;
	emit({
		stage: "identity",
		message: known
			? `Recognised ${known.short}: version ${id.version || "?"}${known.sha256 === hash ? " (identical to the published PDF)" : `, replaces ${known.version}`}`
			: `New protocol: ${id.title.slice(0, 80)}${id.version ? `, version ${id.version}` : ""}`,
		ms: lap("identity"),
	});

	// Code-only figure analysis (no model): widen text-table crops to their drawing, cut verified grids.
	const figs = createFigureAnalyser(doc);
	const headings =
		outlineHeadings(doc, pages) ??
		dropGridHeadings(detectHeadings(pages), pages, figs);
	const sections = buildSections(pages, headings);
	emit({
		stage: "sections",
		message: `Found ${sections.length} sections`,
		ms: lap("sections"),
		counts: { sections: sections.length },
	});

	const kinds = new Map<string, z.infer<typeof NodeKind>>();
	const stages = new Map<string, z.infer<typeof DiagnosticStage>>();
	const parents = new Map<string, string | null>();
	let rawEdges: z.infer<typeof Labels>["edges"] = [];
	let model: string | null = null;
	if (!input.offline) {
		const r = await label(id.title, sections);
		model = r.model;
		const ids = new Set(sections.map((s) => s.heading.id));
		for (const n of r.labels.nodes) {
			if (!ids.has(n.id)) continue;
			kinds.set(n.id, n.kind);
			if (n.stage && n.kind === "diagnostics") stages.set(n.id, n.stage);
			if (
				n.parent !== undefined &&
				(n.parent === null || ids.has(n.parent)) &&
				n.parent !== n.id
			)
				parents.set(n.id, n.parent);
		}
		rawEdges = r.labels.edges.filter(
			(e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
		);
		emit({
			stage: "label",
			message: `Labelled ${kinds.size} sections and ${rawEdges.length} links with ${model}`,
			ms: lap("label"),
			counts: { labelled: kinds.size, edges: rawEdges.length, tokens: r.tokens },
		});
	} else {
		emit({ stage: "label", message: "Skipped (offline build)", ms: lap("label") });
	}

	// Node ids: slug of kind + title, unique.
	const nodeId = new Map<string, string>();
	const used = new Set<string>();
	for (const s of sections) {
		const base = slug(`${kinds.get(s.heading.id) ?? "s"}-${s.heading.title}`);
		let idv = base;
		for (let i = 2; used.has(idv); i++) idv = `${base}-${i}`;
		used.add(idv);
		nodeId.set(s.heading.id, idv);
	}
	const lastPage = pages.length;
	const nextStart = new Map<string, number>();
	sections.forEach((s, i) => {
		const later = sections
			.slice(i + 1)
			.find((x) => x.heading.rank >= s.heading.rank);
		nextStart.set(s.heading.id, later ? later.heading.page : lastPage);
	});
	const boiler = boilerplate(pages);
	// A grid spanning several sections (one drug per row group) is cropped whole once; later sections crop their own rows.
	const usedCrops = new Set<string>();
	const siblingsOrder = new Map<string, number>();
	const segInputs: SegInput[] = [];
	const nodes: Node[] = sections.map((s) => {
		const parentHeading = parents.has(s.heading.id)
			? parents.get(s.heading.id)!
			: s.parent;
		const parent = parentHeading ? nodeId.get(parentHeading)! : null;
		const key = parent ?? "root";
		const order = siblingsOrder.get(key) ?? 0;
		siblingsOrder.set(key, order + 1);
		const to = Math.max(
			s.heading.page,
			Math.min(lastPage, nextStart.get(s.heading.id)!),
		);
		const asFigure = FIGURE_TITLE.test(s.heading.title);
		const regions = regionsOf(
			s,
			sections,
			pages,
			boiler,
			asFigure ? (pg) => figs.bands(pg) : undefined,
		);
		// A "Figure/Table/Algorithm N" section is shown whole, as printed; its text only feeds search.
		// Prose after the crop (the outline missed the next heading) stays readable as text.
		const cropped = (l: Line) =>
			regions.some(
				(r) =>
					r.page === l.page &&
					l.bbox[1] >= r.bbox[1] - 2 &&
					l.bbox[3] <= r.bbox[3] + 2,
			);
		const { text, tables } = asFigure
			? {
					// (not the bits above the first crop of a page: table header rows, wrapped title lines)
					text: s.lines.filter(
						(l) =>
							l.page <= s.heading.page + 2 &&
							!cropped(l) &&
							!regions.some(
								(r) =>
									r.page === l.page &&
									l.bbox[3] <= r.bbox[1] + 2 &&
									!regions.some(
										(q) =>
											q.page === l.page &&
											q.bbox[3] <= l.bbox[1] + 2,
									),
							),
					),
					tables: [],
				}
			: splitTables(
					s.lines,
					(pg) => figs.bands(pg),
					(pg, b) => !!figs.table(pg, figs.widen(pg, b)),
				);
		const caption = (lines: Line[], page: number): Anchor | undefined =>
			lines.length
				? {
						page,
						text: lines.map((l) => l.text).join("\n"),
						bbox: lines.map((l) => l.bbox),
					}
				: undefined;
		const figures = [
			...(asFigure
				? regions.map((r) => ({
						page: r.page,
						bbox: r.bbox,
						raster: false,
						...withCaption(
							caption(
								s.lines.filter((l) => l.page === r.page && cropped(l)),
								r.page,
							),
						),
					}))
				: []),
			...tables.map((t) => {
				// Widen to the drawing, but not down a whole page-long grid (a synopsis): keep to this section's rows.
				const w = figs.widen(t.page, t.bbox);
				const key = `${t.page}:${w.map(Math.round).join(",")}`;
				const own =
					usedCrops.has(key) ||
					(w[3] - w[1] > 2 * (t.bbox[3] - t.bbox[1]) + 40 &&
						!figs.table(t.page, w));
				usedCrops.add(key);
				const bbox: Box = own ? [w[0], t.bbox[1] - 3, w[2], t.bbox[3] + 3] : w;
				return {
					page: t.page,
					bbox,
					raster: false,
					...withCaption(caption(t.lines, t.page)),
				};
			}),
			// Embedded images (flowcharts, scanned tables) inside this section, cropped.
			...(asFigure
				? []
				: regions.flatMap((r) =>
						pages[r.page - 1].images
							.filter(
								(b) => b[1] >= r.bbox[1] - 4 && b[3] <= r.bbox[3] + 4,
							)
							.map((b) => ({ page: r.page, bbox: b, raster: true })),
					)),
		];
		if (!asFigure)
			segInputs.push({
				key: nodeId.get(s.heading.id)!,
				title: [...s.path.slice(0, -1).slice(-1), s.heading.title].join(" > "),
				lines: text,
			});
		return {
			id: nodeId.get(s.heading.id)!,
			kind: kinds.get(s.heading.id) ?? "other",
			...(stages.has(s.heading.id) ? { stage: stages.get(s.heading.id) } : {}),
			title: s.heading.title,
			headingPath: s.path.slice(0, -1),
			pages: {
				from: s.heading.page,
				to: Math.max(s.heading.page, Math.min(to, s.endPage)),
			},
			parent,
			order,
			blocks: blocksOf(text),
			...(figures.length ? { figures } : {}),
		};
	});

	// Blocks by the model (segment.ts): paragraphs/list items and their role; the layout heuristics stay as the fallback per section.
	if (!input.offline && process.env.SEGMENT !== "off") {
		const tSeg = performance.now();
		const { blocks, failed } = await segmentAll(id.title, segInputs, askSegments);
		for (const n of nodes) {
			const b = blocks.get(n.id);
			if (b) n.blocks = b;
		}
		timings.segment = Math.round(performance.now() - tSeg);
		usage.segmentedSections = blocks.size;
		usage.segmentFallbacks = failed.length;
		emit({
			stage: "anchors",
			message: `Segmented ${blocks.size} sections into blocks with roles (${failed.length} kept the layout heuristics)`,
		});
	}

	const tFig = performance.now();
	let structured = 0;
	for (const n of nodes)
		for (const f of n.figures ?? []) {
			if (f.raster || !f.bbox) continue;
			const s = figs.table(f.page, f.bbox) ?? figs.definitions(f.page, f.bbox);
			if (s) {
				f.structure = s;
				structured++;
			}
		}
	const figureMs = Math.round(performance.now() - tFig);
	timings.figures = figureMs;

	const edges: Edge[] = [];
	for (const e of rawEdges) {
		const edge: Edge = {
			from: nodeId.get(e.from)!,
			to: nodeId.get(e.to)!,
			kind: e.kind,
		};
		if (e.evidenceQuote && e.evidencePage) {
			const a = anchorFor(pages, e.evidencePage, e.evidenceQuote);
			if (a) edge.evidence = a;
			else
				warnings.push({
					code: "edge_evidence_unresolved",
					message: `Could not find the sentence for ${e.kind} ${edge.from} → ${edge.to} on p${e.evidencePage}; drawn as inferred.`,
					page: e.evidencePage,
				});
		}
		edges.push(edge);
	}
	emit({
		stage: "anchors",
		message: `Cut ${nodes.reduce((n, x) => n + x.blocks.length, 0)} verbatim blocks, ${edges.filter((e) => e.evidence).length}/${edges.length} links with verified evidence`,
		ms: lap("anchors"),
	});

	// Diagnostic work-up: a stage for every line (protocols often keep the whole work-up in one section).
	if (!input.offline) {
		try {
			const { staged, moved } = await stageWorkup(nodes, id.title, input.family);
			emit({
				stage: "check",
				message: `Sorted ${staged} diagnostic lines into the work-up stages${moved.length ? `; ${moved.length} assessment sections hold the work-up at diagnosis` : ""}`,
				counts: { diagnosticLines: staged },
			});
		} catch {
			warnings.push({
				code: "diagnostic_stages_failed",
				message:
					"Could not sort the diagnostic work-up into stages; shown as written.",
			});
		}
	}

	// Supportive care & toxicity over time: baseline lines + care/toxicity/drug/schedule lines, arranged by timepoint.
	let monitoring: Monitoring | undefined;
	if (!input.offline) {
		const careKinds = new Set<string>([
			"supportive_care",
			"toxicity",
			"schedule",
			"drug_info",
		]);
		const byNode = new Map(nodes.map((n) => [n.id, n]));
		// The labeller sometimes leaves per-course "Supportive Care" sub-sections as "other": catch them by title too.
		const CARE_TITLE =
			/supportive care|toxicit|prophyla|dose modif|dose[- ]adapt|monitoring|side effects|late effects|follow[- ]up/i;
		const inCare = (n: Node): boolean =>
			careKinds.has(n.kind) ||
			CARE_TITLE.test(n.title) ||
			(n.parent !== null &&
				!!byNode.get(n.parent) &&
				inCare(byNode.get(n.parent)!));
		const baseline = nodes.flatMap((n) =>
			n.blocks
				.filter((a) => a.stage === "baseline")
				.map((a) => ({ a, section: n.title })),
		);
		const care = nodes.filter(inCare).flatMap((n) =>
			n.blocks
				.filter((a) => a.text.trim().length > 3)
				.map((a) => ({
					a,
					section: [n.headingPath.at(-1), n.title]
						.filter(Boolean)
						.join(" > "),
				})),
		);
		const pool = [...baseline, ...care]
			.slice(0, 600)
			.map((p, i) => ({ id: `m${i}`, ...p }));
		try {
			monitoring = await monitoringMatrix(id.title, pool);
			emit({
				stage: "check",
				message: `Arranged ${monitoring?.rows.length ?? 0} monitoring rows by timepoint`,
				counts: { monitoringRows: monitoring?.rows.length ?? 0 },
			});
		} catch {
			warnings.push({
				code: "monitoring_failed",
				message:
					"Could not arrange supportive care and toxicity by timepoint; shown as written.",
			});
		}
	}

	// Checks: every step should have start requirements; raster pages can't be searched.
	const children = new Map<string, Node[]>();
	for (const n of nodes)
		if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
	const descendants = (id: string): Node[] =>
		(children.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id)]);
	const derived: Node[] = [];
	for (const n of nodes) {
		if (
			n.kind !== "step" ||
			(children.get(n.id) ?? []).some((c) => c.kind === "start_requirements")
		)
			continue;
		// Many protocols state start criteria inline ("...providing haematological recovery to ANC ≥1.0 x109/L").
		// Collect those passages verbatim from the step and its subsections (not from toxicity/dose tables).
		const pool = [
			n,
			...descendants(n.id).filter(
				(d) =>
					d.kind !== "toxicity" &&
					d.kind !== "drug_info" &&
					d.kind !== "diagnostics" &&
					d.kind !== "eligibility",
			),
		];
		// Only sentences that read as a condition to START (not diagnostic criteria that merely mention counts).
		const hits = pool
			.flatMap((d) => d.blocks)
			.filter(
				(b) =>
					COUNT_CRITERION.test(b.text) &&
					START_CUE.test(b.text) &&
					/\d/.test(b.text) &&
					b.text.length < 900,
			);
		if (hits.length) {
			derived.push({
				id: `${n.id}-start-criteria`,
				kind: "start_requirements",
				title: "Count and recovery criteria in this step's text",
				headingPath: [...n.headingPath, n.title],
				pages: {
					from: Math.min(...hits.map((h) => h.page)),
					to: Math.max(...hits.map((h) => h.page)),
				},
				parent: n.id,
				order: 0,
				blocks: hits.slice(0, 8),
			});
		} else {
			n.notFound = [{ kind: "start_requirements", searched: n.pages }];
		}
	}
	nodes.push(...derived);
	const raster = pages.filter((p) => p.imageCover > 0.45 && p.lines.length < 8);
	for (const p of raster)
		warnings.push({
			code: "raster_page",
			message: `Page ${p.page} is an image (figure or scanned table): shown as-is, not searchable.`,
			page: p.page,
		});
	const steps = nodes.filter((n) => n.kind === "step").length;
	const missing = nodes.filter((n) => n.notFound?.length).length;
	emit({
		stage: "check",
		message: `${steps} treatment steps, ${steps - missing} with start requirements found; ${raster.length} image-only pages`,
		ms: lap("check"),
		counts: { steps, missingStart: missing, rasterPages: raster.length },
	});

	// "Check these": code findings always; model findings over the whole protocol, ids only.
	const findings: Finding[] = codeFindings(
		nodes,
		pages.flatMap((p) => p.lines.map((l) => ({ page: l.page, text: l.text }))),
	);
	let consistencyModel: string | undefined;
	if (!input.offline) {
		const draft = {
			specVersion: SPEC_VERSION,
			doc: {
				id: "draft",
				short: known?.short ?? id.title.slice(0, 40),
				title: id.title,
				version: id.version,
				date: id.date,
				sha256: hash,
				pageCount: pages.length,
				supersedes: null,
			},
			nodes,
			edges,
			build: {
				pipelineVersion: PIPELINE_VERSION,
				model,
				builtAt: new Date().toISOString(),
				timingsMs: {},
				counts: {},
				warnings: [],
			},
		} satisfies ProtocolSpec;
		try {
			const r = await modelFindings(
				draft,
				known?.short ?? id.title.slice(0, 60),
				(u) => track("consistency", u),
			);
			consistencyModel = r.model;
			findings.push(...r.findings);
		} catch (e) {
			warnings.push({
				code: "consistency_failed",
				message: `Could not run the consistency check: ${(e as Error).message?.slice(0, 160)}`,
			});
		}
	}
	const byKind = (k: Finding["kind"]) => findings.filter((f) => f.kind === k).length;
	emit({
		stage: "consistency",
		message: `Check these: ${byKind("contradiction")} contradictions, ${byKind("gap") + byKind("ambiguity")} gaps/ambiguities${consistencyModel ? ` (${consistencyModel})` : ""}, ${byKind("delegation")} left to local guidelines, ${byKind("dangling_ref")} broken references, ${byKind("missing_start")} steps without start requirements`,
		ms: lap("consistency"),
		counts: { findings: findings.length },
	});

	const spec = ProtocolSpec.parse({
		specVersion: SPEC_VERSION,
		doc: {
			id: known?.id ?? slug(id.title).slice(0, 40),
			short: known?.short ?? id.title.slice(0, 40),
			title: id.title,
			version: id.version,
			date: id.date,
			...(id.evidence ? { versionEvidence: id.evidence } : {}),
			sha256: hash,
			pageCount: pages.length,
			language: lang,
			supersedes:
				known && known.sha256 !== hash
					? { version: known.version, sha256: known.sha256 }
					: null,
		},
		nodes,
		edges,
		...(monitoring ? { monitoring } : {}),
		...(findings.length ? { findings } : {}),
		build: {
			pipelineVersion: PIPELINE_VERSION,
			model,
			builtAt: new Date().toISOString(),
			timingsMs: timings,
			counts: {
				pages: pages.length,
				headings: headings.length,
				nodes: nodes.length,
				labelled: kinds.size,
				edges: edges.length,
				rasterPages: raster.length,
				structuredFigures: structured,
				findings: findings.length,
				...usage,
			},
			warnings,
		},
	});
	emit({ stage: "done", message: "Spec ready" });
	return spec;
}

export type { Box };
