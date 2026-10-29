/**
 * Figures → standardized structure, with per-element verification.
 *
 * Trust rule: the model may point and label; code verifies. Concretely:
 *   - Vector figures (text layer present): every box/cell text is COPIED by code from the
 *     text layer (never the model's transcription). Boxes come from the PDF's own drawn
 *     rectangles; connectors from its drawn line paths, so an edge is `verified` only when
 *     a drawn connector joins the two boxes (arrowhead → target). The model only proposes
 *     the figure type and edges between code-made box ids; a model edge with no drawn
 *     connector stays `unverified`, a drawn connector the model missed is still kept.
 *   - Raster figures (no text layer): nothing can be verified against the PDF. The model
 *     transcribes twice, independently; elements both runs agree on are `agreed` (still
 *     not verified), the rest `disputed`. The UI must show raster structure as a reading
 *     aid next to the crop, never instead of it.
 *   - Tables/schedules (vector): the grid is cut by code from the text layer (rows by
 *     baseline, columns by x-clusters of header cells); a schedule mark ("X", "✓") is
 *     verified only when a mark glyph sits at the row × column intersection.
 */
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText, Output } from "ai";
import * as mupdf from "mupdf";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Box, openPdf, renderRegion, sha256 } from "./pdf.ts";
import { normalize } from "./verify.ts";

// --- Output shape -------------------------------------------------------------------------

/** How much an element can be trusted. */
export type Status =
	| "verified" // text copied from the text layer / connector drawn in the PDF / mark glyph at the cell
	| "agreed" // raster only: two independent model readings agree. Not verified.
	| "disputed" // raster only: the readings disagree; show the crop, flag for review
	| "unverified"; // model claim with no PDF evidence (e.g. an edge with no drawn connector)

export interface FigNode {
	id: string;
	text: string;
	/** Page-space box (PDF points). For raster nodes: the model's box, approximate. */
	bbox: Box;
	status: Status;
	/** "box" = text inside a drawn shape; "label" = free text (arrow condition, heading). */
	role: "box" | "label";
}

export interface FigEdge {
	from: string;
	to: string;
	/** Condition text on the arrow (e.g. "MRD ≥ 0.1%"); a FigNode id of role "label". */
	label?: string;
	status: Status;
	/** Where the edge's evidence comes from. */
	evidence: ("connector" | "model" | "model2")[];
}

export interface FigTable {
	/** Rows of cells; row 0..headerRows-1 are headers. Each cell is code-copied text (vector) or model text (raster). */
	rows: { text: string; bbox?: Box; status: Status; rowSpan?: number; colSpan?: number; covered?: boolean }[][];
	headerRows: number;
}

export type FigureType = "flowchart" | "treatment_schema" | "table" | "schedule" | "timeline" | "other";

export interface FigureStructure {
	type: FigureType;
	source: "vector" | "raster";
	nodes?: FigNode[];
	edges?: FigEdge[];
	table?: FigTable;
	/** Counts per status, so the UI can decide to show the structure or keep the crop. */
	summary: Record<Status, number>;
	/** true only when every element is verified: then the UI may render the structure as primary. */
	allVerified: boolean;
	model: string | null;
	notes: string[];
}

// --- PDF region content -------------------------------------------------------------------

export interface Piece {
	text: string;
	bbox: Box;
	bold?: boolean;
}
interface Seg {
	a: [number, number];
	b: [number, number];
}
interface Region {
	pieces: Piece[];
	rects: Box[];
	segs: Seg[];
	arrowheads: { at: [number, number]; bbox: Box }[];
	imageArea: number;
	images: Box[];
}

const inside = (b: Box, r: Box, tol = 2) => b[0] >= r[0] - tol && b[1] >= r[1] - tol && b[2] <= r[2] + tol && b[3] <= r[3] + tol;
const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const center = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
/** Distance from a point to a box (0 inside). */
const distToBox = ([x, y]: [number, number], b: Box) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));

/** Text pieces (MuPDF stext lines, already split at wide gaps), drawn rectangles, line segments and arrowheads inside `bbox`. */
export function readRegion(doc: mupdf.Document, page: number, bbox: Box): Region {
	const p = doc.loadPage(page - 1);
	// Pieces: runs of characters on one line, split wherever the gap exceeds ~1.5 spaces
	// (diagram labels side by side on one baseline are separate pieces).
	const pieces: Piece[] = [];
	let run: { c: string; q: number[]; size: number; bold: boolean }[] = [];
	const flushRun = () => {
		const t = run.map((r) => r.c).join("").replace(/\s+/g, " ").trim();
		if (t) {
			const box: Box = [
				Math.min(...run.map((r) => Math.min(r.q[0], r.q[4]))),
				Math.min(...run.map((r) => Math.min(r.q[1], r.q[3]))),
				Math.max(...run.map((r) => Math.max(r.q[2], r.q[6]))),
				Math.max(...run.map((r) => Math.max(r.q[5], r.q[7]))),
			];
			const ink = run.filter((r) => r.c.trim());
			if (inside(box, bbox, 4)) pieces.push({ text: t, bbox: box, bold: ink.filter((r) => r.bold).length >= 0.8 * ink.length });
		}
		run = [];
	};
	let wmode = 0;
	p.toStructuredText("preserve-whitespace").walk({
		beginLine: (_b: mupdf.Rect, wm: number) => {
			wmode = wm;
			run = [];
		},
		onChar: (c: string, _o: mupdf.Point, font: mupdf.Font, size: number, quad: mupdf.Quad) => {
			if (wmode) return;
			const ink = run.filter((r) => r.c.trim());
			if (!c.trim()) {
				if (ink.length) run.push({ c: " ", q: ink.at(-1)!.q, size, bold: false });
				return;
			}
			if (ink.length) {
				// Gap from the last inked glyph: spaces do not bridge two labels.
				const gap = quad[0] - Math.max(...ink.map((r) => r.q[2]));
				if (gap > Math.max(size * 0.6, 3) || gap < -size * 2) flushRun();
			}
			run.push({ c, q: [...quad], size, bold: font.isBold() || /bold|black|heavy|semibold|demi/i.test(font.getName()) });
		},
		endLine: () => flushRun(),
	} as Parameters<mupdf.StructuredText["walk"]>[0]);
	const rects: Box[] = [];
	const segs: Seg[] = [];
	const arrowheads: Region["arrowheads"] = [];
	let imageArea = 0;
	const images: Box[] = [];
	const tf = (m: mupdf.Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
	const walk = (path: mupdf.Path, ctm: mupdf.Matrix, filled: boolean) => {
		// Split into subpaths; each subpath is a polyline (curves flattened to their end points).
		const subs: [number, number][][] = [];
		let cur: [number, number][] = [];
		let closed = false;
		const flush = () => {
			if (cur.length > 1) subs.push(closed ? [...cur, cur[0]] : cur);
			cur = [];
			closed = false;
		};
		path.walk({
			moveTo: (x: number, y: number) => {
				flush();
				cur.push(tf(ctm, x, y));
			},
			lineTo: (x: number, y: number) => void cur.push(tf(ctm, x, y)),
			curveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => void cur.push(tf(ctm, x, y)),
			closePath: () => {
				closed = true;
			},
		} as Parameters<mupdf.Path["walk"]>[0]);
		flush();
		for (const pts of subs) {
			const xs = pts.map((q) => q[0]);
			const ys = pts.map((q) => q[1]);
			const bb: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
			if (!inside(bb, bbox, 6)) continue;
			const w = bb[2] - bb[0];
			const h = bb[3] - bb[1];
			const isClosed = pts.length >= 4 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1;
			if (isClosed && w > 15 && h > 8) {
				rects.push(bb);
				continue;
			}
			// Distinct vertices: a triangle (or notched arrow) is not an axis-aligned rectangle.
			const distinct = pts.filter((q, i) => pts.findIndex((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) < 0.5) === i);
			const axisRect = distinct.length === 4 && distinct.every((q) => (Math.abs(q[0] - bb[0]) < 0.5 || Math.abs(q[0] - bb[2]) < 0.5) && (Math.abs(q[1] - bb[1]) < 0.5 || Math.abs(q[1] - bb[3]) < 0.5));
			if (filled && w < 14 && h < 14 && w > 2 && h > 2 && distinct.length >= 3 && distinct.length <= 5 && !axisRect) {
				// Small filled polygon = arrowhead; its tip is the vertex farthest from the centroid.
				const c: [number, number] = [xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length];
				const tip = pts.reduce((best, q) => (Math.hypot(q[0] - c[0], q[1] - c[1]) > Math.hypot(best[0] - c[0], best[1] - c[1]) ? q : best));
				arrowheads.push({ at: tip, bbox: bb });
				continue;
			}
			if (filled && w > 15 && h > 8) {
				rects.push(bb); // filled shape without explicit close (shaded box)
				continue;
			}
			// Thin filled rectangles are lines drawn as fills (common in Word exports).
			if (filled && (w <= 2.5 || h <= 2.5) && Math.max(w, h) > 4) {
				segs.push(w <= 2.5 ? { a: [(bb[0] + bb[2]) / 2, bb[1]], b: [(bb[0] + bb[2]) / 2, bb[3]] } : { a: [bb[0], (bb[1] + bb[3]) / 2], b: [bb[2], (bb[1] + bb[3]) / 2] });
				continue;
			}
			if (!filled) for (let i = 1; i < pts.length; i++) segs.push({ a: pts[i - 1], b: pts[i] });
		}
	};
	const dev = new mupdf.Device({
		fillPath: (path: mupdf.Path, _eo: boolean, ctm: mupdf.Matrix) => walk(path, ctm, true),
		strokePath: (path: mupdf.Path, _s: mupdf.StrokeState, ctm: mupdf.Matrix) => walk(path, ctm, false),
		fillImage: (img: mupdf.Image, ctm: mupdf.Matrix) => {
			const [x0, y0] = tf(ctm, 0, 0);
			const [x1, y1] = tf(ctm, 1, 1);
			const b: Box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
			const ix: Box = [Math.max(b[0], bbox[0]), Math.max(b[1], bbox[1]), Math.min(b[2], bbox[2]), Math.min(b[3], bbox[3])];
			imageArea += area(ix);
			if (area(ix) > 400) images.push(ix);
		},
	} as unknown as ConstructorParameters<typeof mupdf.Device>[0]);
	p.run(dev, mupdf.Matrix.identity);
	dev.close();
	// Dedupe rects (fill + stroke of the same box).
	const uniq: Box[] = [];
	for (const r of rects) if (!uniq.some((u) => u.every((v, i) => Math.abs(v - r[i]) < 1.5))) uniq.push(r);
	return { pieces, rects: uniq, segs, arrowheads, imageArea, images };
}

// --- Vector flowcharts --------------------------------------------------------------------

/** Boxes = smallest drawn rectangle containing each text piece; text copied in reading order. Free text = labels. */
function vectorNodes(reg: Region): FigNode[] {
	const owner = new Map<number, Piece[]>();
	const free: Piece[] = [];
	for (const pc of reg.pieces) {
		let best = -1;
		for (let i = 0; i < reg.rects.length; i++)
			if (inside(pc.bbox, reg.rects[i], 1.5) && (best < 0 || area(reg.rects[i]) < area(reg.rects[best]))) best = i;
		// A rect that contains other rects with text is a frame/panel, not a box: handled by smallest-first.
		if (best < 0) free.push(pc);
		else owner.set(best, [...(owner.get(best) ?? []), pc]);
	}
	const read = (ps: Piece[]) =>
		ps
			.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
			.map((p) => p.text)
			.join("\n");
	const nodes: FigNode[] = [];
	for (const [i, ps] of [...owner.entries()].sort((a, b) => reg.rects[a[0]][1] - reg.rects[b[0]][1] || reg.rects[a[0]][0] - reg.rects[b[0]][0]))
		nodes.push({ id: `b${nodes.length + 1}`, text: read(ps), bbox: reg.rects[i], status: "verified", role: "box" });
	// Free pieces: merge vertically adjacent ones (wrapped labels).
	const groups: Piece[][] = [];
	for (const pc of free.sort((a, b) => a.bbox[1] - b.bbox[1])) {
		const g = groups.find((g) => {
			const l = g.at(-1)!;
			return pc.bbox[1] - l.bbox[3] < 4 && pc.bbox[1] >= l.bbox[1] && Math.min(pc.bbox[2], l.bbox[2]) - Math.max(pc.bbox[0], l.bbox[0]) > 0;
		});
		if (g) g.push(pc);
		else groups.push([pc]);
	}
	for (const g of groups)
		nodes.push({
			id: `l${nodes.length + 1}`,
			text: read(g),
			bbox: [Math.min(...g.map((p) => p.bbox[0])), Math.min(...g.map((p) => p.bbox[1])), Math.max(...g.map((p) => p.bbox[2])), Math.max(...g.map((p) => p.bbox[3]))],
			status: "verified",
			role: "label",
		});
	return nodes;
}

/**
 * Connector networks from drawn segments: segments touching end to end (or T-junction) are one
 * network. A network touching box A (no arrowhead) and box B (arrowhead tip at B) gives A → B.
 * Segments lying along a box border are the box itself, not connectors.
 */
function connectorEdges(reg: Region, nodes: FigNode[]): { from: string; to: string }[] {
	const boxes = nodes.filter((n) => n.role === "box");
	const onBorder = (s: Seg) =>
		boxes.some((n) => {
			const b = n.bbox;
			const t = 1.5;
			const horiz = Math.abs(s.a[1] - s.b[1]) < t && (Math.abs(s.a[1] - b[1]) < t || Math.abs(s.a[1] - b[3]) < t);
			const vert = Math.abs(s.a[0] - s.b[0]) < t && (Math.abs(s.a[0] - b[0]) < t || Math.abs(s.a[0] - b[2]) < t);
			return (horiz || vert) && inside([Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])], b, t);
		});
	const segs = reg.segs.filter((s) => Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) > 1 && !onBorder(s));
	// Union-find over segments that touch.
	const parent = segs.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const near = (p: [number, number], s: Seg, tol = 2.5) => {
		const [dx, dy] = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
		const len2 = dx * dx + dy * dy || 1;
		const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / len2));
		return Math.hypot(p[0] - (s.a[0] + t * dx), p[1] - (s.a[1] + t * dy)) < tol;
	};
	for (let i = 0; i < segs.length; i++)
		for (let j = i + 1; j < segs.length; j++)
			if (near(segs[i].a, segs[j]) || near(segs[i].b, segs[j]) || near(segs[j].a, segs[i]) || near(segs[j].b, segs[i])) parent[find(i)] = find(j);
	const nets = new Map<number, Seg[]>();
	segs.forEach((s, i) => nets.set(find(i), [...(nets.get(find(i)) ?? []), s]));
	const edges: { from: string; to: string }[] = [];
	// Boxes are hit at their border; free text (no frame) a few points away from its glyphs.
	const attach = (pt: [number, number]) =>
		nodes
			.map((n) => ({ n, d: distToBox(pt, n.bbox) - (n.role === "box" ? 0 : 4) }))
			.filter((x) => x.d < 7)
			.sort((a, b) => a.d - b.d)[0]?.n;
	for (const net of nets.values()) {
		// Free endpoints of the network (not touching another segment of it).
		const ends: [number, number][] = [];
		for (const s of net) for (const p of [s.a, s.b]) if (!net.some((o) => o !== s && near(p, o))) ends.push(p);
		// A "V" or "T" fan has no free end at its source: every vertex is a candidate source.
		const verts = net.flatMap((s) => [s.a, s.b]);
		const targets = new Set<string>();
		const sources = new Set<string>();
		for (const e of ends) {
			const head = reg.arrowheads.find((h) => Math.hypot(h.bbox[0] - e[0], 0) < 14 && distToBox(e, h.bbox) < 4);
			const probe = head ? head.at : e;
			const box = attach(probe);
			if (!box) continue;
			(head ? targets : sources).add(box.id);
		}
		// Arrowheads drawn on the line itself (not at a free end) also mark targets.
		for (const h of reg.arrowheads)
			if (net.some((s) => near(h.at, s, 8) || distToBox(h.at, [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])]) < 3)) {
				const box = attach(h.at);
				if (box) {
					targets.add(box.id);
					sources.delete(box.id);
				}
			}
		if (!sources.size)
			for (const v of verts) {
				const n = attach(v);
				if (n && !targets.has(n.id)) sources.add(n.id);
			}
		for (const t of targets) sources.delete(t);
		for (const s of sources) for (const t of targets) edges.push({ from: s, to: t });
	}
	// Box-to-box arrows with no line (arrowhead sitting between two stacked boxes).
	for (const h of reg.arrowheads) {
		const to = boxes.map((n) => ({ n, d: distToBox(h.at, n.bbox) })).filter((x) => x.d < 3).sort((a, b) => a.d - b.d)[0]?.n;
		if (!to || edges.some((e) => e.to === to.id)) continue;
		const from = boxes
			.filter((n) => n !== to && n.bbox[3] <= h.bbox[1] + 2 && n.bbox[3] > h.bbox[1] - 25 && n.bbox[0] < h.at[0] && n.bbox[2] > h.at[0])
			.sort((a, b) => b.bbox[3] - a.bbox[3])[0];
		if (from) edges.push({ from: from.id, to: to.id });
	}
	const seen = new Set<string>();
	return edges.filter((e) => e.from !== e.to && !seen.has(`${e.from}>${e.to}`) && seen.add(`${e.from}>${e.to}`));
}

// --- Vector tables ------------------------------------------------------------------------

const MARK = /^(?:x|✓|✔|√|•|✓|✔||||y|yes|\*)$/i;

/**
 * Rules implied by cell rectangles (filled cell backgrounds, or cells drawn as closed boxes) when
 * the table draws no rule lines: the rect edges, but only when the rects tile a grid. That is at
 * least two stacked rows of two or more cells, neighbours touching (no gap an arrow could run
 * through), and the rows sharing their column edges. A callout or a highlight behind a line of
 * prose is one rect; flowchart boxes stand apart. Neither tiles, so neither gets rules.
 */
function cellRules(reg: Region): Seg[] {
	const near = (a: number, b: number, t = 2) => Math.abs(a - b) <= t;
	// A frame around the table holds several cells: not a cell. An inset copy of a cell (fill + padding box) is the same cell.
	const holds = (r: Box, o: Box) => r !== o && inside(o, r, 0.5);
	const notFrame = reg.rects.filter((r) => reg.rects.filter((o) => holds(r, o)).length < 2);
	const cells = notFrame.filter((r) => !notFrame.some((o) => holds(o, r)));
	const rows: Box[][] = [];
	for (const r of [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
		const row = rows.find((w) => near(w[0][1], r[1]) && near(w[0][3], r[3]));
		if (row) row.push(r);
		else rows.push([r]);
	}
	// Each row: cells side by side, touching.
	const tiled = rows
		.map((w) => w.sort((a, b) => a[0] - b[0]))
		.filter((w) => w.length >= 2 && w.every((r, i) => i === 0 || (r[0] - w[i - 1][2] >= -1 && r[0] - w[i - 1][2] <= 3)))
		.sort((a, b) => a[0][1] - b[0][1]);
	// Stacked rows: touching vertically and sharing at least three column edges (outer edges included).
	const edges = (w: Box[]) => [w[0][0], ...w.map((r) => r[2])];
	const grid: Box[][] = [];
	for (const w of tiled) {
		const last = grid.at(-1);
		const touches = last && w[0][1] - last[0][3] >= -1 && w[0][1] - last[0][3] <= 3;
		const shared = last ? edges(w).filter((x) => edges(last).some((y) => near(x, y, 3))).length : 0;
		if (last && touches && shared >= 3) grid.push(w);
		else if (grid.length < 2) grid.splice(0, grid.length, w);
		else break;
	}
	if (grid.length < 2) return [];
	// The cells must hold all the text: a few filled header cells over an unruled body would cut only part of the grid.
	if (!reg.pieces.every((p) => grid.flat().some((r) => inside(p.bbox, r, 2)))) return [];
	return grid.flat().flatMap(([x0, y0, x1, y1]): Seg[] => [
		{ a: [x0, y0], b: [x1, y0] },
		{ a: [x0, y1], b: [x1, y1] },
		{ a: [x0, y0], b: [x0, y1] },
		{ a: [x1, y0], b: [x1, y1] },
	]);
}

/**
 * Grid from the text layer: rows by baseline, columns from the x-starts of the widest
 * row (usually the header). Each cell's text is the pieces whose centre falls in it.
 */
function vectorTable(reg: Region, notes: string[]): FigTable {
	const ps = [...reg.pieces].sort((a, b) => a.bbox[3] - b.bbox[3] || a.bbox[0] - b.bbox[0]);
	const lines: Piece[][] = [];
	for (const p of ps) {
		const l = lines.at(-1);
		if (l && Math.abs(l[0].bbox[3] - p.bbox[3]) < 2.5) l.push(p);
		else lines.push([p]);
	}
	const vOf = (segs: Seg[]) => segs.filter((s) => Math.abs(s.a[0] - s.b[0]) < 1 && Math.abs(s.a[1] - s.b[1]) > 8);
	const hOf = (segs: Seg[]) => segs.filter((s) => Math.abs(s.a[1] - s.b[1]) < 1 && Math.abs(s.a[0] - s.b[0]) > 8);
	const cluster = (vs: number[]) => vs.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 4);
	// No drawn rules (fewer than 3 either way): a grid of cell rectangles draws them instead.
	const drawnRules = (segs: Seg[]) =>
		cluster([...new Set(vOf(segs).map((s) => Math.round(s.a[0])))]).length >= 3 && cluster([...new Set(hOf(segs).filter((s) => Math.abs(s.a[0] - s.b[0]) > 20).map((s) => Math.round(s.a[1])))]).length >= 3;
	const fromCells = drawnRules(reg.segs) ? [] : cellRules(reg);
	if (fromCells.length) notes.push(`rules from ${fromCells.length / 4} cell rectangles (filled/boxed cells, no rule lines)`);
	const vSegs = vOf([...reg.segs, ...fromCells]);
	const hSegs = hOf([...reg.segs, ...fromCells]);
	// Column boundaries: vertical rules if drawn, else x-starts clustered across all lines.
	const vRules = cluster([...new Set(vSegs.map((s) => Math.round(s.a[0])))]);
	let cols: number[];
	if (vRules.length >= 3) cols = vRules;
	else {
		cols = cluster(ps.map((p) => p.bbox[0] - 1));
		cols.push(Math.max(...ps.map((p) => p.bbox[2])) + 1);
	}
	// Rows: horizontal rules when drawn (multi-line cells), else one visual line per row.
	const hRules = cluster([...new Set(hSegs.filter((s) => Math.abs(s.a[0] - s.b[0]) > 20).map((s) => Math.round(s.a[1])))]);
	const ruled = hRules.length >= 3;
	if (!ruled) notes.push("borderless table: row spans cannot be checked; blank cells are flagged");
	const bands: [number, number][] = ruled
		? hRules.slice(1).map((y, i) => [hRules[i], y] as [number, number])
		: lines.map((l) => [Math.min(...l.map((p) => p.bbox[1])) - 0.5, Math.max(...l.map((p) => p.bbox[3])) + 0.5]);
	// Merged cells from the drawing: two neighbouring grid cells are one cell unless a rule separates them.
	const hRuleAt = (y: number, c: number) => {
		const xm = (cols[c] + cols[c + 1]) / 2;
		return hSegs.some((s) => Math.abs(s.a[1] - y) < 2.5 && Math.min(s.a[0], s.b[0]) <= xm && Math.max(s.a[0], s.b[0]) >= xm);
	};
	const vRuleAt = (x: number, r: number) => {
		const ym = (bands[r][0] + bands[r][1]) / 2;
		return vSegs.some((s) => Math.abs(s.a[0] - x) < 2.5 && Math.min(s.a[1], s.b[1]) <= ym && Math.max(s.a[1], s.b[1]) >= ym);
	};
	const nC = cols.length - 1;
	// Two side-by-side cells that each hold their own text are never merged (headers separated by fill colour, not rules).
	const hasText = (r: number, c: number) =>
		ps.some((p) => {
			const [cx, cy] = center(p.bbox);
			return cx >= cols[c] && cx < cols[c + 1] && cy >= bands[r][0] && cy < bands[r][1];
		});
	const id = (r: number, c: number) => r * nC + c;
	const uf = Array.from({ length: bands.length * nC }, (_, i) => i);
	const find = (i: number): number => (uf[i] === i ? i : (uf[i] = find(uf[i])));
	if (ruled && vRules.length >= 3)
		for (let r = 0; r < bands.length; r++)
			for (let c = 0; c < nC; c++) {
				if (c + 1 < nC && !vRuleAt(cols[c + 1], r) && !(hasText(r, c) && hasText(r, c + 1))) uf[find(id(r, c + 1))] = find(id(r, c));
				if (r + 1 < bands.length && !hRuleAt(bands[r][1], c)) uf[find(id(r + 1, c))] = find(id(r, c));
			}
	type Cell = FigTable["rows"][number][number];
	const grid: Cell[][] = bands.map(() => []);
	const vertical = (p: Piece) => p.bbox[3] - p.bbox[1] > 2 * (p.bbox[2] - p.bbox[0]) && p.text.length > 2;
	let irregular = 0;
	const placed = new Set<Piece>();
	for (let r = 0; r < bands.length; r++)
		for (let c = 0; c < nC; c++) {
			const root = find(id(r, c));
			if (root !== id(r, c) && grid[r][c] === undefined) {
				grid[r][c] = { text: "", status: "verified", covered: true };
				continue;
			}
			if (grid[r][c]) continue;
			// Extent of this merged cell (a component should be a rectangle; anything else is flagged).
			let r1 = r;
			let c1 = c;
			while (c1 + 1 < nC && find(id(r, c1 + 1)) === root) c1++;
			while (r1 + 1 < bands.length && find(id(r1 + 1, c)) === root) r1++;
			let size = 0;
			for (let k = 0; k < uf.length; k++) if (find(k) === root) size++;
			const rect = size === (r1 - r + 1) * (c1 - c + 1);
			if (!rect) irregular++;
			const box: Box = [cols[c], bands[r][0], cols[c1 + 1], bands[r1][1]];
			const inCell = ps.filter((p) => {
				const [cx, cy] = center(p.bbox);
				return cx >= box[0] && cx < box[2] && cy >= box[1] && cy < box[3];
			});
			for (const p of inCell) placed.add(p);
			// Reading order: rotated header lines (taller than wide) go left to right; others top to bottom.
			const text = inCell
				.sort((a, b) => (vertical(a) && vertical(b) ? a.bbox[0] - b.bbox[0] : a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]))
				.map((p) => p.text)
				.join(" ");
			grid[r][c] = {
				text,
				bbox: box,
				status: (!ruled && !text) || !rect ? "unverified" : "verified",
				...(r1 > r ? { rowSpan: r1 - r + 1 } : {}),
				...(c1 > c ? { colSpan: c1 - c + 1 } : {}),
			};
			for (let rr = r; rr <= r1; rr++) for (let cc = c; cc <= c1; cc++) if (rr !== r || cc !== c) grid[rr][cc] = { text: "", status: "verified", covered: true };
		}
	if (irregular) notes.push(`${irregular} merged cells are not rectangles (missing rule?): flagged`);
	// Every piece of text in the region must land in a cell; text outside the grid means the grid is wrong.
	const lost = ps.length - placed.size;
	if (lost) notes.push(`${lost} text pieces fall outside the grid`);
	const rows = grid.filter((row) => row.some((c) => c.text || c.covered));
	if (lost && rows[0]?.[0]) rows[0][0].status = "unverified";
	// Row 0 is a header only when it is set in bold and the body is not (key/value tables have no header).
	const boldCell = (c: { bbox?: Box; text: string }) => !!c.text && ps.filter((p) => c.bbox && inside(p.bbox, c.bbox, 1)).every((p) => p.bold);
	const head = rows[0]?.filter((c) => c.text) ?? [];
	const bodyPlain = rows.slice(1).some((r) => r.slice(1).some((c) => c.text && !boldCell(c)));
	return { rows, headerRows: head.length && head.every(boldCell) && bodyPlain ? 1 : 0 };
}

// --- Model calls --------------------------------------------------------------------------

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "qwiklabs-gcp-01-ce74ae98024d";
const MODEL = "gemini-3-flash-preview";
let calls = 0;
export const modelCalls = () => calls;

async function vision<T extends z.ZodType>(png: Uint8Array, prompt: string, schema: T): Promise<z.infer<T>> {
	// Optional on-disk cache (FIGURES_CACHE=dir) so re-scoring does not spend quota.
	const dir = process.env.FIGURES_CACHE;
	const key = dir ? `${dir}/${sha256(new Uint8Array([...png, ...new TextEncoder().encode(prompt)]))}.json` : "";
	if (dir && existsSync(key)) return JSON.parse(readFileSync(key, "utf8"));
	calls++;
	const vertex = createVertex({ project: PROJECT, location: "global" });
	const r = await generateText({
		model: vertex(MODEL),
		output: Output.object({ schema }),
		messages: [{ role: "user", content: [{ type: "image", image: png, mediaType: "image/png" }, { type: "text", text: prompt }] }],
		temperature: 0,
		providerOptions: { vertex: { thinkingConfig: { thinkingLevel: "low" } } },
	});
	if (dir) writeFileSync(key, JSON.stringify(r.output));
	return r.output as z.infer<T>;
}

const TYPE_HELP =
	"flowchart = decision/stratification algorithm with branches; treatment_schema = ordered treatment blocks/phases over time; table = rows/columns of values; schedule = schedule of assessments (timepoints x investigations with marks); timeline = single time axis; other.";

const VectorLabels = z.object({
	type: z.enum(["flowchart", "treatment_schema", "table", "schedule", "timeline", "other"]).describe(TYPE_HELP),
	edges: z
		.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional().describe("id of an l* label node written on/next to this arrow, if any") }))
		.describe("Every arrow in the figure, from box id to box id. Use only the given ids."),
});

const RasterRead = z.object({
	type: z.enum(["flowchart", "treatment_schema", "table", "schedule", "timeline", "other"]).describe(TYPE_HELP),
	boxes: z
		.array(z.object({ id: z.string(), text: z.string().describe("exact text in the box, line breaks as \\n"), box_2d: z.array(z.number()).length(4).describe("[ymin, xmin, ymax, xmax] normalized 0-1000") }))
		.describe("Every box or text label, transcribed exactly."),
	edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional().describe("text written on the arrow") })).describe("Every arrow, from box id to box id."),
	table: z.array(z.array(z.string())).optional().describe("For table/schedule: all rows including header, cell text exactly as printed, empty string for empty cells."),
});

// --- Main entry ---------------------------------------------------------------------------

const tally = (els: { status: Status }[]): Record<Status, number> => {
	const s: Record<Status, number> = { verified: 0, agreed: 0, disputed: 0, unverified: 0 };
	for (const e of els) s[e.status]++;
	return s;
};

export interface AnalyseOptions {
	/** Skip the model: vector structure from geometry only. */
	offline?: boolean;
	/** Force a type (e.g. a figure the builder already knows is a text table). */
	type?: FigureType;
}

export async function analyseFigure(pdfBytes: Uint8Array, page: number, bbox: Box, opts: AnalyseOptions = {}): Promise<FigureStructure> {
	const doc = openPdf(pdfBytes);
	const reg = readRegion(doc, page, bbox);
	// Raster when images cover the region and almost no text sits on them (captions beside an image do not count).
	const onImage = reg.pieces.filter((p) => reg.images.some((i) => inside(p.bbox, i, 2))).length;
	const raster = reg.imageArea > 0.3 * area(bbox) && onImage < 3 && reg.rects.length < 3;
	const png = renderRegion(doc, page, bbox, 2, 0);
	const notes: string[] = [];
	if (!raster) return analyseVector(reg, png, bbox, opts, notes);
	return analyseRaster(png, bbox, opts, notes);
}

async function analyseVector(reg: Region, png: Uint8Array, bbox: Box, opts: AnalyseOptions, notes: string[]): Promise<FigureStructure> {
	// No arrowheads = no flow to read: treat as a grid (shaded cells and bullets are not boxes).
	const tableLike = reg.arrowheads.length === 0 || reg.rects.length < 3 || opts.type === "table" || opts.type === "schedule";
	if (tableLike && opts.type !== "flowchart") {
		const table = vectorTable(reg, notes);
		let type: FigureType = opts.type ?? "table";
		// Schedule marks: a mark glyph inside a body cell is verified by construction (it IS the text layer).
		const marks = table.rows.slice(1).flat().filter((c) => MARK.test(c.text.trim())).length;
		if (!opts.type && marks >= 4) type = "schedule";
		notes.push(`grid ${table.rows.length}x${table.rows[0]?.length ?? 0} from text layer; ${marks} mark cells`);
		const cells = table.rows.flat();
		const summary = tally(cells);
		return { type, source: "vector", table, summary, allVerified: summary.verified === cells.length, model: null, notes };
	}
	const nodes = vectorNodes(reg);
	const geo = connectorEdges(reg, nodes);
	notes.push(`${reg.rects.length} drawn boxes, ${reg.segs.length} segments, ${reg.arrowheads.length} arrowheads → ${geo.length} connector edges`);
	let type: FigureType = opts.type ?? "flowchart";
	const edges: FigEdge[] = // Two keys: an edge is verified only when the drawn connector AND the model reading agree.
	// Connector-only edges stay unverified (label grouping can attach a line to the wrong text).
	geo.map((e) => ({ ...e, status: "unverified", evidence: ["connector"] }));
	let model: string | null = null;
	if (!opts.offline) {
		model = MODEL;
		const toPx = (b: Box) => [b[0] - bbox[0], b[1] - bbox[1], b[2] - bbox[0], b[3] - bbox[1]].map((v) => Math.round(v * 2));
		const listing = nodes.map((n) => `${n.id} [${toPx(n.bbox).join(",")}] ${JSON.stringify(n.text.slice(0, 120))}`).join("\n");
		const out = await vision(
			png,
			[
				"This is a figure from a paediatric oncology protocol. Code already extracted its boxes (b*) and free text labels (l*) from the PDF.",
				"Each line: id [x0,y0,x1,y1 in image pixels] text. Give the figure type and EVERY arrow as from/to box ids; if an arrow carries a condition label, give that l* id as label.",
				"Do not transcribe text; use only these ids.",
				listing,
			].join("\n"),
			VectorLabels,
		);
		if (!opts.type) type = out.type;
		const ids = new Set(nodes.map((n) => n.id));
		// The model often folds a condition label into the arrow (A -[L]-> B) where the drawing has A -> L -> B:
		// such an edge supports both drawn hops.
		const support = (from: string, to: string) => {
			const g = edges.find((x) => x.from === from && x.to === to);
			if (!g) return false;
			if (!g.evidence.includes("model")) g.evidence.push("model");
			g.status = "verified";
			return true;
		};
		for (const e of out.edges) {
			if (!ids.has(e.from) || !ids.has(e.to)) continue;
			const label = e.label && ids.has(e.label) ? e.label : undefined;
			const direct = support(e.from, e.to);
			const viaLabel = !!label && support(e.from, label) && support(label, e.to);
			if (!direct && !viaLabel) edges.push({ from: e.from, to: e.to, ...(label ? { label } : {}), status: "unverified", evidence: ["model"] });
		}
		const missed = edges.filter((e) => !e.evidence.includes("model")).length;
		if (missed) notes.push(`${missed} drawn connectors the model did not list (kept: geometry is the evidence)`);
	}
	// Labels are attached to an edge by the model only; a label's text is verified (text layer) but its attachment is not.
	const els = [...nodes, ...edges];
	const summary = tally(els);
	return { type, source: "vector", nodes, edges, summary, allVerified: summary.verified === els.length, model, notes };
}

const RASTER_PROMPT_A =
	"This is a figure from a paediatric oncology protocol. Transcribe every box and free text label exactly (keep numbers, symbols and units exactly), give each an id (n1, n2...) and box_2d, then list every arrow from box to box with any condition text written on it. For a table or schedule, also fill `table`.";
const RASTER_PROMPT_B =
	"Read this protocol figure. First trace every arrow: where it starts and where its head points. Then list all boxes and labels (id, exact text, box_2d [ymin,xmin,ymax,xmax] 0-1000) and the arrows between ids (with the text on the arrow, if any). If it is a table or schedule of assessments, also give all rows in `table`, cells verbatim.";

/** Model text with literal "\n" escapes unescaped; equality key ignores whitespace and case only (Induction E ≠ Induction F). */
const unescape = (s: string) => s.replaceAll("\\n", "\n");
const key = (s: string) => normalize(unescape(s)).replace(/\s+/g, "");

async function analyseRaster(png: Uint8Array, bbox: Box, opts: AnalyseOptions, notes: string[]): Promise<FigureStructure> {
	notes.push("raster: no text layer; nothing below is verified against the PDF");
	if (opts.offline) return { type: opts.type ?? "other", source: "raster", summary: tally([]), allVerified: false, model: null, notes };
	const a = await vision(png, RASTER_PROMPT_A, RasterRead);
	const b = await vision(png, RASTER_PROMPT_B, RasterRead);
	const W = bbox[2] - bbox[0];
	const H = bbox[3] - bbox[1];
	const toPage = (q: number[]): Box => [bbox[0] + (q[1] / 1000) * W, bbox[1] + (q[0] / 1000) * H, bbox[0] + (q[3] / 1000) * W, bbox[1] + (q[2] / 1000) * H];
	// Pair B's boxes with A's: identical text (no fuzzy match: one letter is a different arm), nearest box when the text repeats.
	const bOf = new Map<string, string>(); // a.id -> b.id
	const used = new Set<string>();
	for (const n of a.boxes) {
		const c = (q: number[]) => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
		const m = b.boxes
			.filter((o) => !used.has(o.id) && key(o.text) === key(n.text))
			.sort((x, y) => Math.hypot(c(x.box_2d)[0] - c(n.box_2d)[0], c(x.box_2d)[1] - c(n.box_2d)[1]) - Math.hypot(c(y.box_2d)[0] - c(n.box_2d)[0], c(y.box_2d)[1] - c(n.box_2d)[1]))[0];
		if (m) {
			bOf.set(n.id, m.id);
			used.add(m.id);
		}
	}
	const aOf = new Map([...bOf].map(([x, y]) => [y, x]));
	const nodes: FigNode[] = a.boxes.map((n) => ({
		id: n.id,
		text: unescape(n.text),
		bbox: toPage(n.box_2d),
		status: bOf.has(n.id) ? "agreed" : "disputed",
		role: "box",
	}));
	const bEdge = new Set(b.edges.map((e) => `${e.from}>${e.to}`));
	const edges: FigEdge[] = a.edges.map((e) => {
		const agreed = bEdge.has(`${bOf.get(e.from)}>${bOf.get(e.to)}`);
		return { from: e.from, to: e.to, ...(e.label ? { label: unescape(e.label) } : {}), status: agreed ? "agreed" : "disputed", evidence: agreed ? ["model", "model2"] : ["model"] };
	});
	// Arrows only the second reading saw are kept as disputed: a reviewer must look.
	const aEdge = new Set(a.edges.map((e) => `${e.from}>${e.to}`));
	for (const e of b.edges) {
		const f = aOf.get(e.from);
		const t = aOf.get(e.to);
		if (f && t && !aEdge.has(`${f}>${t}`)) edges.push({ from: f, to: t, ...(e.label ? { label: unescape(e.label) } : {}), status: "disputed", evidence: ["model2"] });
		else if (!f || !t) notes.push(`second reading arrow ${e.from}>${e.to} between boxes the first reading did not transcribe identically`);
	}
	if (a.type !== b.type) notes.push(`readings disagree on type: ${a.type} / ${b.type}`);
	const type = opts.type ?? a.type;
	let table: FigTable | undefined;
	if (a.table?.length) {
		const bt = b.table ?? [];
		if (bt.length !== a.table.length) notes.push(`table rows: ${a.table.length} vs ${bt.length} in second reading`);
		table = {
			headerRows: 1,
			rows: a.table.map((row, i) => row.map((t, j) => ({ text: unescape(t), status: key(bt[i]?.[j] ?? "\u0000") === key(t) ? "agreed" : "disputed" }) as const)),
		};
	}
	const els = [...nodes, ...edges, ...(table?.rows.flat() ?? [])];
	return { type, source: "raster", nodes, edges, ...(table ? { table } : {}), summary: tally(els), allVerified: false, model: MODEL, notes };
}

// --- Build-time, code-only analysis (no model calls) --------------------------------------

const overlaps = (a: Box, b: Box, m = 0) => a[0] - m < b[2] && b[0] - m < a[2] && a[1] - m < b[3] && b[1] - m < a[3];
const segBox = (s: Seg): Box => [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];

function subRegion(full: Region, bbox: Box): Region {
	return {
		pieces: full.pieces.filter((p) => inside(p.bbox, bbox, 4)),
		rects: full.rects.filter((r) => inside(r, bbox, 6)),
		segs: full.segs.filter((s) => inside(segBox(s), bbox, 6)),
		arrowheads: full.arrowheads.filter((h) => inside(h.bbox, bbox, 6)),
		images: full.images.map((i): Box => [Math.max(i[0], bbox[0]), Math.max(i[1], bbox[1]), Math.min(i[2], bbox[2]), Math.min(i[3], bbox[3])]).filter((i) => i[2] > i[0] && i[3] > i[1]),
		imageArea: 0,
	};
}

/**
 * Code-only figure analysis for the build: one page read per page, no model.
 *   widen(page, bbox)  grow a text-table box to the drawing it sits in (boxes, rules, connectors
 *                      touching it), so a crop shows the whole table or flowchart, not just its text.
 *   table(page, bbox)  the grid of a vector table/schedule, or null unless every cell is verified.
 */
export function createFigureAnalyser(doc: mupdf.Document) {
	const cache = new Map<number, { region: Region; page: Box }>();
	const full = (page: number) => {
		let c = cache.get(page);
		if (!c) {
			const b = doc.loadPage(page - 1).getBounds();
			const pb: Box = [b[0], b[1], b[2], b[3]];
			c = { region: readRegion(doc, page, pb), page: pb };
			cache.set(page, c);
		}
		return c;
	};
	return {
		widen(page: number, bbox: Box): Box {
			const { region, page: pb } = full(page);
			const pageArea = area(pb);
			const drawn = [...region.rects, ...region.segs.map(segBox), ...region.arrowheads.map((h) => h.bbox)].filter((d) => area(d) < 0.5 * pageArea && d[2] - d[0] < 0.95 * (pb[2] - pb[0]));
			// Full-width prose lines: a drawing that would pull them into the crop is a frame or
			// a page decoration, not part of this table.
			const prose = region.pieces.filter((p) => p.text.length >= 70 && p.bbox[2] - p.bbox[0] > 0.6 * (pb[2] - pb[0]));
			let out: Box = [...bbox];
			for (let changed = true, n = 0; changed && n < 30; n++) {
				changed = false;
				for (const d of drawn) {
					if (!overlaps(d, out, 3) || inside(d, out, 0)) continue;
					const grown: Box = [Math.min(out[0], d[0]), Math.min(out[1], d[1]), Math.max(out[2], d[2]), Math.max(out[3], d[3])];
					if (prose.filter((p) => inside(p.bbox, grown, 2) && !inside(p.bbox, out, 2)).length >= 2) continue;
					out = grown;
					changed = true;
				}
			}
			return out.map((v) => Math.round(v * 10) / 10) as Box;
		},
		/** Vertical bands [y0, y1] of the page covered by drawn tables/diagrams (rules, boxes, connectors at least 100pt wide together). */
		bands(page: number): [number, number][] {
			const { region, page: pb } = full(page);
			const pageArea = area(pb);
			const drawn = [...region.rects, ...region.segs.map(segBox)]
				.filter((d) => area(d) < 0.5 * pageArea && d[2] - d[0] < 0.95 * (pb[2] - pb[0]) && d[3] - d[1] < 0.8 * (pb[3] - pb[1]))
				.sort((a, b) => a[1] - b[1]);
			const out: { y0: number; y1: number; x0: number; x1: number; n: number }[] = [];
			for (const d of drawn) {
				const last = out.at(-1);
				if (last && d[1] <= last.y1 + 4) {
					last.y1 = Math.max(last.y1, d[3]);
					last.x0 = Math.min(last.x0, d[0]);
					last.x1 = Math.max(last.x1, d[2]);
					last.n++;
				} else out.push({ y0: d[1], y1: d[3], x0: d[0], x1: d[2], n: 1 });
			}
			// A lone rule (footer line, underline) is not a drawing.
			// A frame around running prose (a synopsis grid, a text box) is not a table to crop.
			const prosy = (b: (typeof out)[number]) => {
				const ps = region.pieces.filter((p) => p.bbox[1] >= b.y0 - 3 && p.bbox[3] <= b.y1 + 3);
				return ps.filter((p) => p.text.length >= 75).length > Math.max(2, ps.length / 4);
			};
			return out.filter((b) => b.n >= 3 && b.y1 - b.y0 > 10 && b.x1 - b.x0 > 100 && !prosy(b)).map((b) => [b.y0, b.y1]);
		},
		/**
		 * A two-column definition layout (label column + description column, no rules: "DEXA | Dexamethasone
		 * 6 mg/m2 ..."), as a verified 2-column table. Null unless every text piece sits in one of the two columns.
		 */
		definitions(page: number, bbox: Box): FigureStructure | null {
			const reg = subRegion(full(page).region, bbox);
			if (reg.arrowheads.length || reg.images.length || reg.rects.length > 2 || reg.pieces.length < 6) return null;
			const rows: Piece[][] = [];
			for (const p of [...reg.pieces].sort((a, b) => a.bbox[3] - b.bbox[3] || a.bbox[0] - b.bbox[0])) {
				const row = rows.at(-1);
				if (row && Math.abs(row[0].bbox[3] - p.bbox[3]) < 3) row.push(p);
				else rows.push([p]);
			}
			for (const r of rows) r.sort((a, b) => a.bbox[0] - b.bbox[0]);
			const left = Math.min(...reg.pieces.map((p) => p.bbox[0]));
			// Description column: the most common start of the first piece right of the label column.
			const starts = new Map<number, number>();
			for (const r of rows) {
				const d = r.find((p) => p.bbox[0] > left + 40);
				if (d) starts.set(Math.round(d.bbox[0] / 4), (starts.get(Math.round(d.bbox[0] / 4)) ?? 0) + 1);
			}
			const top = [...starts].sort((a, b) => b[1] - a[1])[0];
			if (!top) return null;
			const D = top[0] * 4;
			const entries: { label: Piece[]; desc: Piece[] }[] = [];
			for (const r of rows) {
				const lab = r.filter((p) => p.bbox[0] < D - 4);
				// Every label piece starts at the left edge and stops before the description column.
				if (lab.some((p) => p.bbox[0] > left + 6 || p.bbox[2] > D - 4)) return null;
				const desc = r.filter((p) => p.bbox[0] >= D - 4);
				// The description is one run of text from the column start: a wide gap is a third column.
				if (desc.length && desc[0].bbox[0] > D + 8 && lab.length) return null;
				if (desc.some((p, k) => k > 0 && p.bbox[0] - desc[k - 1].bbox[2] > 12)) return null;
				// (a label wrapping onto a second line before its description starts stays one label)
				if (lab.length && entries.at(-1) && !entries.at(-1)!.desc.length) entries.at(-1)!.label.push(...lab);
				else if (lab.length) entries.push({ label: lab, desc: [] });
				else if (!entries.length) return null;
				entries.at(-1)!.desc.push(...desc);
			}
			const full2 = entries.filter((e) => e.desc.length);
			if (full2.length < 3 || full2.length < entries.length - 1) return null;
			const cell = (ps: Piece[]) => ({ text: ps.map((p) => p.text).join(" ").replace(/(\w)- (\p{Ll})/gu, "$1-$2"), status: "verified" as const });
			const table: FigTable = { rows: entries.map((e) => [cell(e.label), cell(e.desc)]), headerRows: 0 };
			const summary = tally(table.rows.flat());
			return { type: "table", source: "vector", table, summary, allVerified: true, model: null, notes: [`definition layout: ${entries.length} labels, description column at x=${D}`] };
		},
		table(page: number, bbox: Box): FigureStructure | null {
			const reg = subRegion(full(page).region, bbox);
			if (reg.arrowheads.length || reg.images.length || reg.pieces.length < 4) return null;
			const notes: string[] = [];
			const table = vectorTable(reg, notes);
			const width = table.rows[0]?.length ?? 0;
			if (table.rows.length < 2 || width < 2) return null;
			const marks = table.rows.slice(1).flat().filter((c) => MARK.test(c.text.trim())).length;
			const cells = table.rows.flat();
			const summary = tally(cells);
			if (summary.verified !== cells.length) return null;
			notes.push(`grid ${table.rows.length}x${width} from text layer; ${marks} mark cells`);
			// A schedule always has a timepoint header row.
			if (marks >= 4) table.headerRows = Math.max(1, table.headerRows);
			return { type: marks >= 4 ? "schedule" : "table", source: "vector", table, summary, allVerified: true, model: null, notes };
		},
	};
}
