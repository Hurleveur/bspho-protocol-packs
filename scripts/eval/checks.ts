/**
 * Deterministic extraction-quality checks over every published spec, with the PDF text layer
 * as ground truth where a check needs it. Precision first: each check fires only on shapes the
 * team lead found by hand, so a count going down after a pipeline fix means a real improvement.
 *
 *   bun scripts/eval/checks.ts [protocolId...]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as mupdf from "mupdf";
import { openPdf, type PdfPage, readPage } from "@bspho/protocol/pdf";
import { boilerplate, norm } from "@bspho/protocol/sections";
import type { Anchor, Node, ProtocolSpec } from "@bspho/protocol/spec";

export const ROOT = join(import.meta.dir, "..", "..");
export const STORE = join(ROOT, "store");

export type Severity = "high" | "medium" | "low";
export interface Issue {
	protocol: string;
	class: string;
	severity: Severity;
	page: number | null;
	nodeId: string | null;
	title: string | null;
	detail: string;
	sample: string;
	source: "check" | "judge";
}

export interface Loaded {
	id: string;
	short: string;
	sha: string;
	spec: ProtocolSpec;
	doc: mupdf.Document;
	page: (n: number) => PdfPage;
}

export function registry(): { id: string; short: string; published: string | null }[] {
	return JSON.parse(readFileSync(join(STORE, "registry.json"), "utf8")).protocols;
}

export function load(id: string): Loaded | null {
	const p = registry().find((x) => x.id === id);
	if (!p?.published) return null;
	// EVAL_SPECS points at another specs directory (same layout), to measure a candidate pipeline change before a rebuild.
	const spec = JSON.parse(
		readFileSync(
			join(
				process.env.EVAL_SPECS ?? join(STORE, "specs"),
				id,
				`${p.published}.json`,
			),
			"utf8",
		),
	) as ProtocolSpec;
	const doc = openPdf(
		new Uint8Array(readFileSync(join(STORE, "pdfs", `${p.published}.pdf`))),
	);
	const cache = new Map<number, PdfPage>();
	const page = (n: number) => {
		let pg = cache.get(n);
		if (!pg) cache.set(n, (pg = readPage(doc, n)));
		return pg;
	};
	return { id, short: p.short, sha: p.published, spec, doc, page };
}

// ---------------------------------------------------------------- app mirrors (pack.tsx)

export const BULLET = /^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–]\s*|o\s+)/;
const ENUM = /^\(?[a-z0-9]{1,2}[.)]\s/i;
export const isListItem = (t: string) => BULLET.test(t.trim()) || ENUM.test(t.trim());
/** pack.tsx isItem: what renders as a tickable checklist row. */
export const isItem = (t: string) => {
	const x = t.trim();
	if (/^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–]|o\s|\(?[a-z0-9]{1,2}[.)]\s)/i.test(x)) return true;
	return x.length <= 140 && (x.match(/[.!?](\s|$)/g)?.length ?? 0) <= 1;
};
export const isHeadingLine = (t: string) =>
	t.trim().length < 90 &&
	/:\s*$/.test(t.trim()) &&
	!/[≥≤<>]|x\s*10|×10|\/mm|\/µl/i.test(t);
const SPECIFIC_SECTION =
	/baseline|organ function|prior (?:to )?start|before treatment|staging|metasta|extension|imaging|scintigraph|tomograph|PET|MRI|\bCT\b|biops|patholog|histolog|molecular|genetic|cytogenetic|immunohisto/i;
export const sameTitle = (text: string, title: string) => {
	const n = (t: string) =>
		t
			.replace(/^[\d.\s]+/, "")
			.replace(/\W+/g, " ")
			.trim()
			.toLowerCase();
	return n(text) === n(title);
};

export interface Tree {
	byId: Map<string, Node>;
	kids: Map<string, Node[]>;
}
export function tree(spec: ProtocolSpec): Tree {
	const byId = new Map(spec.nodes.map((n) => [n.id, n]));
	const kids = new Map<string, Node[]>();
	for (const n of spec.nodes)
		if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
	for (const k of kids.values()) k.sort((a, b) => a.order - b.order);
	return { byId, kids };
}

export interface DiagItem {
	a: Anchor;
	node: Node;
	idx: number;
	stage: string | undefined;
}
/** The diagnosis work-up as the sheet builds it: top diagnostics nodes and their descendants, minus start_requirements. */
export function diagItems(spec: ProtocolSpec, t: Tree): DiagItem[] {
	const tops = spec.nodes.filter(
		(n) =>
			n.kind === "diagnostics" &&
			!(n.parent && t.byId.get(n.parent)?.kind === "diagnostics"),
	);
	const out: DiagItem[] = [];
	const seen = new Set<string>();
	const walk = (n: Node) => {
		if (seen.has(n.id)) return;
		seen.add(n.id);
		n.blocks.forEach((a, idx) => {
			const later = a.stage === "relapse" || a.stage === "follow_up";
			const stage =
				!later && n.stage && SPECIFIC_SECTION.test(n.title)
					? n.stage
					: (a.stage ?? n.stage);
			out.push({ a, node: n, idx, stage });
		});
		for (const c of t.kids.get(n.id) ?? [])
			if (c.kind !== "start_requirements") walk(c);
	};
	for (const n of tops) walk(n);
	return out;
}

// ---------------------------------------------------------------- helpers

const clip = (s: string, n = 160) => {
	const x = s.replace(/\s+/g, " ").trim();
	return x.length > n ? `${x.slice(0, n)}…` : x;
};
const inside = (b: number[], f: number[], tol = 2) =>
	b[0] >= f[0] - tol &&
	b[1] >= f[1] - tol &&
	b[2] <= f[2] + tol &&
	b[3] <= f[3] + tol;
const overlapY = (a: number[], b: number[]) =>
	Math.min(a[3], b[3]) - Math.max(a[1], b[1]);

/** PDF lines of a page that a block line box covers. */
function pdfLinesFor(pg: PdfPage, box: number[]) {
	return pg.lines.filter(
		(l) =>
			overlapY(l.bbox, box) > 0.5 * (l.bbox[3] - l.bbox[1]) &&
			l.bbox[0] < box[2] &&
			l.bbox[2] > box[0],
	);
}

function figureBoxes(spec: ProtocolSpec): Map<number, number[][]> {
	const m = new Map<number, number[][]>();
	for (const n of spec.nodes)
		for (const f of n.figures ?? [])
			if (f.bbox) m.set(f.page, [...(m.get(f.page) ?? []), f.bbox]);
	return m;
}

const RELAPSE = /\b(relaps\w*|recurren\w*|progressi(?:on|ve disease)|follow[- ]up)\b/i;
const STOP = new Set([
	"the",
	"and",
	"or",
	"of",
	"to",
	"in",
	"a",
	"for",
	"with",
	"on",
	"at",
	"by",
	"be",
	"is",
	"mg",
	"day",
	"days",
	"x",
	"per",
]);

// ---------------------------------------------------------------- checks

export function runChecks(L: Loaded): {
	issues: Issue[];
	stats: Record<string, number>;
} {
	const { spec, id } = L;
	const t = tree(spec);
	const issues: Issue[] = [];
	const add = (
		cls: string,
		severity: Severity,
		n: Node | null,
		page: number | null,
		detail: string,
		sample: string,
	) =>
		issues.push({
			protocol: id,
			class: cls,
			severity,
			page,
			nodeId: n?.id ?? null,
			title: n?.title ?? null,
			detail,
			sample: clip(sample, 220),
			source: "check",
		});
	const stats: Record<string, number> = {};
	const figs = figureBoxes(spec);

	// --- running headers/footers: lines repeated on many pages of the PDF (digits ignored)
	const pages: PdfPage[] = [];
	for (let i = 1; i <= spec.doc.pageCount; i++) pages.push(L.page(i));
	const boiler = new Set(
		[...boilerplate(pages)].filter((k) => k.replace(/[#\s\W]/g, "").length >= 12),
	);

	// --- diagnostics: split lists, relapse in diagnosis, staging coverage
	const items = diagItems(spec, t);
	stats.diagItems = items.length;
	const byNode = new Map<string, DiagItem[]>();
	for (const it of items)
		byNode.set(it.node.id, [...(byNode.get(it.node.id) ?? []), it]);
	const diagNodeIds = new Set(byNode.keys());

	// A list = an intro (block ending ":" or a node title that reads as an intro) + the bullet items after it.
	const lists: { intro: string; node: Node; page: number; items: DiagItem[] }[] = [];
	for (const [, its] of byNode) {
		const node = its[0].node;
		let cur: (typeof lists)[number] | null = null;
		const titleIntro =
			/:\s*$|\b(should|must|will) (have|be|include|receive)\b|\bincludes?:?$|following\s*:?$/i.test(
				node.title,
			);
		if (titleIntro)
			cur = { intro: node.title, node, page: node.pages.from, items: [] };
		for (const it of its) {
			const tx = it.a.text.trim();
			if (isListItem(tx)) {
				if (cur) cur.items.push(it);
			} else if (/:\s*$/.test(tx) && tx.length < 200) {
				if (cur?.items.length) lists.push(cur);
				cur = { intro: tx, node, page: it.a.page, items: [] };
			} else if (cur && cur.items.length && /^[a-z]/.test(tx)) {
				// wrapped continuation, stays in the list
			} else {
				if (cur?.items.length) lists.push(cur);
				cur = null;
			}
		}
		if (cur?.items.length) {
			// list that continues in the next node of the work-up (intro in one node, items in another)
			lists.push(cur);
		} else if (cur && !cur.items.length && cur.intro !== node.title) {
			const next = (t.kids.get(node.id) ?? [])[0];
			const nb = next?.blocks.filter((b) => isListItem(b.text)) ?? [];
			if (nb.length >= 2)
				add(
					"split_list",
					"high",
					node,
					cur.page,
					`intro ends this section; its ${nb.length} items land in child section "${clip(next.title, 60)}"`,
					cur.intro,
				);
		}
	}
	for (const l of lists) {
		if (l.items.length < 3) continue;
		const stages = new Map<string, number>();
		for (const it of l.items)
			stages.set(
				it.stage ?? "(other)",
				(stages.get(it.stage ?? "(other)") ?? 0) + 1,
			);
		const staged = [...stages].filter(([k]) => k !== "(other)");
		if (stages.size >= 3 || (staged.length >= 2 && l.items.length >= 4)) {
			const dist = [...stages].map(([k, v]) => `${k}:${v}`).join(", ");
			add(
				"split_list",
				stages.size >= 3 ? "high" : "medium",
				l.node,
				l.page,
				`${l.items.length}-item list scattered over stages {${dist}}`,
				l.intro,
			);
		}
	}

	// relapse/recurrence/follow-up text inside initial-diagnosis stages
	const relapseSeen = new Map<string, Issue>();
	for (const [, its] of byNode) {
		const node = its[0].node;
		const ctxTitle = [node.title, ...node.headingPath].join(" / ");
		const sectionRelapse =
			RELAPSE.test(node.title) ||
			RELAPSE.test(node.headingPath.slice(-2).join(" "));
		const staged = its.filter(
			(i) =>
				i.stage === "primary" ||
				i.stage === "molecular" ||
				i.stage === "extent",
		);
		if (!staged.length) continue;
		if (sectionRelapse) {
			if (
				/\b(at|initial|primary) diagnos/i.test(
					[node.title, ...node.headingPath.slice(-2)].join(" "),
				) &&
				!RELAPSE.test(node.title)
			)
				continue;
			const anc = RELAPSE.test(node.title)
				? node.title
				: (node.headingPath.slice(-2).find((h) => RELAPSE.test(h)) ??
					node.title);
			const prev = relapseSeen.get(anc);
			if (prev) {
				prev.detail = prev.detail.replace(
					/(\d+) lines/,
					(_, k) => `${+k + staged.length} lines`,
				);
				continue;
			}
			add(
				"relapse_in_diagnosis",
				"high",
				node,
				node.pages.from,
				`relapse/follow-up section "${clip(anc, 70)}" has ${staged.length} lines in initial work-up stages (${[...new Set(staged.map((s) => s.stage))].join("/")})`,
				staged[0].a.text,
			);
			relapseSeen.set(anc, issues.at(-1)!);
		} else {
			const hits = staged.filter(
				(i) =>
					/\b(at|of|suspected|in case of|diagnosis of) (the )?(relapse|recurrence|progression)\b|\brelapsed\b|\brecurrent (disease|tumou?r)/i.test(
						i.a.text,
					) && !/\b(diagnosis|initial|baseline|primary)\b/i.test(i.a.text),
			);
			if (hits.length)
				add(
					"relapse_in_diagnosis",
					"medium",
					node,
					hits[0].a.page,
					`${hits.length} relapse/recurrence lines placed in initial work-up stage ${hits[0].stage}`,
					hits[0].a.text,
				);
		}
	}

	// staging coverage
	if (items.length) {
		const cnt: Record<string, number> = {
			primary: 0,
			molecular: 0,
			extent: 0,
			baseline: 0,
			relapse: 0,
			follow_up: 0,
			other: 0,
		};
		for (const it of items)
			if (!isHeadingLine(it.a.text) && it.a.text.trim().length > 2)
				cnt[it.stage ?? "other"]++;
		Object.assign(
			stats,
			Object.fromEntries(Object.entries(cnt).map(([k, v]) => [`stage_${k}`, v])),
		);
		const total = items.length;
		for (const st of ["primary", "molecular", "extent", "baseline"])
			if (!cnt[st] && total >= 8)
				add(
					"stage_coverage",
					"low",
					null,
					null,
					`work-up stage "${st}" is empty (${total} work-up lines)`,
					"",
				);
		if (cnt.other >= 5 && cnt.other / total > 0.35)
			add(
				"stage_coverage",
				"medium",
				null,
				null,
				`${cnt.other}/${total} work-up lines fall in "Other" (no stage)`,
				items.find((i) => !i.stage)?.a.text ?? "",
			);
		for (const [, its] of byNode) {
			const node = its[0].node;
			if (
				node.kind === "diagnostics" &&
				its.length >= 3 &&
				its.every((i) => !i.stage)
			)
				add(
					"stage_coverage",
					"low",
					node,
					node.pages.from,
					`diagnostics section with ${its.length} lines, none staged`,
					its[0].a.text,
				);
		}
		// imaging-technique paragraphs sorted into work-up stages as if they were investigations
		for (const [, its] of byNode) {
			const tech = its.filter(
				(it) =>
					it.stage &&
					!it.a.technique &&
					/\b(slice thickness|sequences?|T1|T2|contrast agent|field strength|Tesla|kV|mAs|gadolinium|FOV|axial|coronal|weighted)\b/.test(
						it.a.text,
					) &&
					it.a.text.length > 120,
			);
			if (tech.length)
				add(
					"technique_in_workup",
					"low",
					tech[0].node,
					tech[0].a.page,
					`${tech.length} imaging-technique lines sorted into work-up stage(s) ${[...new Set(tech.map((x) => x.stage))].join("/")}`,
					tech[0].a.text,
				);
		}
	} else if (spec.doc && !spec.nodes.some((n) => n.kind === "diagnostics"))
		stats.noDiagnostics = 1;

	// --- per-block checks
	const figSeen = new Set<string>();
	const REFS = /\b(references?|bibliograph\w*|literature|publications?)\b/i;
	for (const n of spec.nodes) {
		const inRefs = REFS.test(n.title) || n.headingPath.some((h) => REFS.test(h));
		// truncated / repeated titles
		const bare = n.title
			.replace(
				/^(?:\d{1,2}(?:\.\d{1,2})*\.?|[A-Z]\d*(?:\.\d{1,2})+\.?|[A-Z][.)]|(?:appendix|annex|chapter|section)\s+[\dA-Z]+[.:]?)\s+/i,
				"",
			)
			.trim();
		if (
			/^[a-z]/.test(bare) &&
			!/^[a-z]+[A-Z]/.test(bare) &&
			!/^[ivx]{1,4}[.)]\s/.test(bare) &&
			!/^(e\.g|i\.e|vs|pH|mRNA|n=|iv|sc|po|cfDNA|ctDNA|de novo)\b/.test(bare)
		)
			add(
				"truncated_title",
				"high",
				n,
				n.pages.from,
				"title starts lowercase (wrapped heading cut)",
				n.title,
			);
		else if (n.blocks[0] && !sameTitle(n.blocks[0].text, n.title)) {
			const b0 = n.blocks[0].text
				.split("\n")[0]
				.replace(/^[\d.\s]+/, "")
				.trim()
				.toLowerCase();
			const tt = bare.toLowerCase();
			const pl = pdfLinesFor(L.page(n.blocks[0].page), n.blocks[0].bbox[0])[0];
			if (
				tt.length >= 4 &&
				b0.length > tt.length &&
				b0.startsWith(tt) &&
				pl?.bold &&
				n.blocks[0].text.length < 160
			)
				add(
					"truncated_title",
					"medium",
					n,
					n.blocks[0].page,
					"first block repeats the heading in heading style (heading line duplicated or wrapped heading tail)",
					n.blocks[0].text,
				);
		}
		// heading's own visual line: wrapped heading where the detected title is only one line of it
		if (bare.length >= 6) {
			const pg = L.page(n.pages.from);
			const i = pg.lines.findIndex((l) =>
				l.text
					.replace(/\s+/g, " ")
					.endsWith(n.title.replace(/\s+/g, " ").slice(-40)),
			);
			const hl = pg.lines[i];
			if (hl) {
				const prev = pg.lines[i - 1];
				const next = pg.lines[i + 1];
				const h = hl.bbox[3] - hl.bbox[1];
				const sameStyle = (o: (typeof pg.lines)[number]) =>
					o.bold === hl.bold &&
					Math.abs(o.size - hl.size) < 0.6 &&
					(hl.bold || hl.size > 11);
				if (
					next &&
					sameStyle(next) &&
					next.bbox[1] - hl.bbox[3] < 0.6 * h &&
					/^[a-z(]/.test(next.text) &&
					next.text.length < 80
				)
					add(
						"truncated_title",
						"medium",
						n,
						n.pages.from,
						`heading wraps: next line "${clip(next.text, 50)}" is not in the title`,
						n.title,
					);
				if (
					prev &&
					sameStyle(prev) &&
					hl.bbox[1] - prev.bbox[3] < 0.6 * h &&
					/^[a-z]/.test(n.title) &&
					!/[.:]$/.test(prev.text)
				)
					add(
						"truncated_title",
						"medium",
						n,
						n.pages.from,
						`heading wraps: previous line "${clip(prev.text, 50)}" is not in the title`,
						n.title,
					);
			}
		}

		let prevBlock: Anchor | null = null;
		// Table rows split one per block (each row's text breaks the paragraph): consecutive short blocks on one
		// page, each a row of three or more cells in the PDF, stacked close together, outside any figure crop.
		let rowRun: Anchor[] = [];
		const flushRows = () => {
			const text = rowRun.map((r) => r.text).join("\n");
			const toks = text.split(/\s+/).filter(Boolean);
			const num =
				toks.filter((w) => /^[\d.,%<>≥≤±–\-/x×]+$/.test(w) && /\d/.test(w))
					.length / (toks.length || 1);
			if (rowRun.length >= 2)
				add(
					"flattened_table",
					num > 0.3 ? "high" : "medium",
					n,
					rowRun[0].page,
					`${rowRun.length} table rows of 3+ cells shown as separate text blocks (numeric ${(num * 100) | 0}%)`,
					text,
				);
			rowRun = [];
		};
		for (const a of n.blocks) {
			const tx = a.text;
			const lines = tx.split("\n");
			const pg = L.page(a.page);
			const fboxes = figs.get(a.page) ?? [];
			const covered =
				fboxes.length > 0 &&
				a.bbox.every((b) => fboxes.some((f) => inside(b, f, 4)));
			const isRow =
				!covered &&
				lines.length <= 2 &&
				!/\.{5,}|…{3,}|@|_{5,}|\bSignature\b/.test(tx) &&
				a.bbox.flatMap((b) => pdfLinesFor(pg, b)).some((l) => l.cells >= 2);
			const lastRow = rowRun.at(-1);
			// (a one-cell row between two rows, "Single Mtx dosing", does not break the run)
			const gapTo = (r: Anchor) =>
				Math.min(...a.bbox.map((b) => b[1])) -
				Math.max(...r.bbox.map((b) => b[3]));
			if (isRow && lastRow && (lastRow.page !== a.page || gapTo(lastRow) > 40))
				flushRows();
			if (isRow) rowRun.push(a);
			else if (
				!(
					lastRow &&
					lastRow.page === a.page &&
					lines.length === 1 &&
					a.text.length < 60 &&
					gapTo(lastRow) < 20
				)
			)
				flushRows();

			// footer/header leak: a line of the block is a running header/footer of the document
			for (const ln of lines) {
				const k = norm(ln);
				if (k.replace(/[#\s\W]/g, "").length >= 12 && boiler.has(k)) {
					add(
						"footer_leak",
						"high",
						n,
						a.page,
						"running header/footer line inside content",
						ln,
					);
					break;
				}
			}
			if (
				!lines.some((ln) => boiler.has(norm(ln))) &&
				/\b(version|protocol)\b.{0,40}\b\d{1,2}[ .-](?:\w{3,9}|\d{1,2})[ .-]\d{4}\b.{0,6}\b\d{1,3}\s*$/i.test(
					tx.split("\n").at(-1) ?? "",
				)
			)
				add(
					"footer_leak",
					"medium",
					n,
					a.page,
					"block ends with a version/date/page-number footer",
					tx.split("\n").at(-1) ?? "",
				);

			// tables flattened into text: block lines that are several side-by-side cells in the PDF
			const contactOrToc =
				/\.{5,}|…{3,}|\b(Tel|Fax|Phone|E-?mail|Hospital|University|Universit\w+|Department|Dept|Centre|Center|Institut\w*|Laborato\w+|Servicio|Prof|M\.?D\.?|PhD|gGmbH|Stra(ss|ß)e)\b|@/.test(
					tx,
				);
			if (!covered && !contactOrToc && lines.length >= 3) {
				const pls = a.bbox.flatMap((b) => pdfLinesFor(pg, b));
				const uniq = [...new Set(pls)];
				const celled = uniq.filter((l) => l.cells >= 1).length;
				const toks = tx.split(/\s+/).filter(Boolean);
				const num =
					toks.filter((w) => /^[\d.,%<>≥≤±–\-/x×]+$/.test(w) && /\d/.test(w))
						.length / (toks.length || 1);
				const avgLen = lines.reduce((s, l) => s + l.length, 0) / lines.length;
				if (uniq.length >= 3 && celled / uniq.length >= 0.6) {
					add(
						num > 0.35 ? "flattened_table" : "interleaved_columns",
						num > 0.35 ? "high" : "medium",
						n,
						a.page,
						`${celled}/${uniq.length} lines are multi-column table rows in the PDF, shown as text (numeric ${(num * 100) | 0}%)`,
						tx,
					);
				} else if (
					lines.filter((l) => {
						const lt = l.split(/\s+/).filter(Boolean);
						return (
							lt.length >= 3 &&
							lt.filter(
								(w) => /^[\d.,%<>≥≤±–\-/x×]+$/.test(w) && /\d/.test(w),
							).length /
								lt.length >=
								0.6
						);
					}).length >= 3 &&
					!/\b(Tel|Fax|Phone)\b|@/.test(tx)
				) {
					add(
						"flattened_table",
						"high",
						n,
						a.page,
						`numeric run: ${(num * 100) | 0}% of ${toks.length} tokens are numbers`,
						tx,
					);
				} else if (
					lines.length >= 6 &&
					avgLen < 22 &&
					!lines.some((l) => isListItem(l))
				) {
					add(
						"flattened_table",
						"medium",
						n,
						a.page,
						`${lines.length} short fragments (avg ${avgLen | 0} chars): table or flowchart text`,
						tx,
					);
				}
			}

			// doubled words / sequences from interleaved columns ("Cyclophosphamide Cyclophosphamide 1000 mg/m2")
			const flat = tx
				.replace(/\s+/g, " ")
				.replace(/^(?:[•\-–]\s*)?(?:\d{1,2}(?:\.\d{1,2})*\.?\s*[-–]?\s*)?/, "");
			const dbl =
				/\b([A-Za-z][A-Za-z-]{5,}(?: [A-Za-z][A-Za-z-]{2,}){0,3}) \1\b/.exec(
					flat,
				);
			const single = dbl ? !dbl[1].includes(" ") : false;
			const after = dbl ? flat.slice(dbl.index + 2 * dbl[1].length + 2) : "";
			const before = dbl ? flat.slice(0, dbl.index) : "";
			const placeName =
				single && (/\b(of|in)\s*$/.test(before) || /^,/.test(after));
			const typo = single && /^[a-z]/.test(dbl![1]);
			if (
				dbl &&
				!STOP.has(dbl[1].toLowerCase()) &&
				!covered &&
				!inRefs &&
				!placeName &&
				!typo
			) {
				if (
					/^[a-z]/.test(after) &&
					/^[A-Z]/.test(dbl[1]) &&
					dbl[1] !== dbl[1].toUpperCase()
				)
					add(
						"runin_merged",
						"medium",
						n,
						a.page,
						`run-in heading "${dbl[1]}" merged into its paragraph ("${dbl[1]} ${dbl[1]} ...")`,
						flat,
					);
				else
					add(
						"interleaved_columns",
						"high",
						n,
						a.page,
						`repeated sequence "${clip(dbl[1], 40)} ${clip(dbl[1], 40)}"`,
						flat.slice(Math.max(0, dbl.index - 40), dbl.index + 120),
					);
			}

			// bold run-in heading merged into the paragraph
			const m = /^([A-Z][A-Za-z/&,()' -]{3,70}):\s+(\S.{60,})/s.exec(
				tx.replace(/^[\d.]+\s+/, ""),
			);
			if (
				m &&
				m[1].split(/\s+/).length <= 9 &&
				m[1].split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length >= 3
			) {
				const first = pdfLinesFor(pg, a.bbox[0])[0];
				const boldPrefix = first
					? boldPrefixOf(L.doc, a.page, first.bbox, m[1])
					: false;
				if (boldPrefix)
					add(
						"runin_merged",
						"medium",
						n,
						a.page,
						`bold run-in heading "${m[1]}:" merged into the paragraph`,
						tx,
					);
			}

			// list items glued together or split mid-item
			if (isListItem(tx) && /\n\s*[•●▪◦■]\s*\S/.test(tx))
				add(
					"list_item_glue",
					"medium",
					n,
					a.page,
					"several bullet items glued into one block",
					tx,
				);
			if (
				!inRefs &&
				prevBlock &&
				isListItem(prevBlock.text) &&
				!/\bet al\b|\(\d{4}\)|\b(19|20)\d\d;/.test(prevBlock.text) &&
				!isListItem(tx) &&
				/^[a-z]/.test(tx.trim()) &&
				prevBlock.page === a.page &&
				!/[.:;]\s*$/.test(prevBlock.text.trim())
			)
				add(
					"list_item_glue",
					"medium",
					n,
					a.page,
					"bullet item split: next block continues it in lowercase",
					`${clip(prevBlock.text, 80)} ‖ ${tx}`,
				);
			if (
				/^(?:[•\-–]\s*)?(OR|AND|or|and)\s*$/.test(tx.trim()) ||
				(isListItem(tx) && /\b(OR|AND)\s*$/.test(tx.trim()))
			)
				add(
					"list_item_glue",
					"medium",
					n,
					a.page,
					"OR/AND logic split from the items it joins",
					prevBlock ? `${clip(prevBlock.text, 80)} ‖ ${tx}` : tx,
				);
			prevBlock = a;
		}
		flushRows();

		// figures: caption overrunning into prose, prose inside crops
		for (const f of n.figures ?? []) {
			// the caption is not shown as text, except as start-requirement chips (one chip per caption line)
			const cap = f.caption?.text ?? "";
			if (n.kind === "start_requirements" && cap) {
				const cl = cap.split("\n");
				const toks = cap.split(/\s+/).filter(Boolean);
				const num =
					toks.filter((w) => /^[\d.,%<>≥≤±–\-/x×]+$/.test(w) && /\d/.test(w))
						.length / (toks.length || 1);
				const dbl = /\b([A-Za-z][A-Za-z-]{5,}) \1\b/.exec(
					cap.replace(/\s+/g, " "),
				);
				if (dbl)
					add(
						"interleaved_columns",
						"high",
						n,
						f.page,
						`start-requirement chips from table text repeat "${dbl[1]} ${dbl[1]}"`,
						cap,
					);
				else if (cl.length >= 6 && num > 0.4)
					add(
						"flattened_table",
						"medium",
						n,
						f.page,
						`start-requirement chips are ${cl.length} lines of table numbers`,
						cap,
					);
				const capLong = cl.filter(
					(l) => l.length > 60 && l.split(" ").length >= 9,
				).length;
				if (capLong > 8)
					add(
						"figure_overrun",
						"medium",
						n,
						f.page,
						`figure text shown as chips has ${capLong} long prose lines`,
						cap,
					);
			}
			const fk = `${f.page}:${f.bbox?.map(Math.round).join(",")}`;
			if (f.bbox && !f.structure?.table && !figSeen.has(fk)) {
				figSeen.add(fk);
				const pg = L.page(f.page);
				const prose = pg.lines.filter(
					(l) =>
						inside(l.bbox, f.bbox!, 1) &&
						l.text.length >= 75 &&
						l.text.split(" ").length >= 12 &&
						!l.cells,
				);
				const areaShare =
					((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) /
					(pg.width * pg.height);
				if (prose.length >= 4)
					add(
						"figure_overrun",
						prose.length >= 8 ? "high" : "medium",
						n,
						f.page,
						`figure crop contains ${prose.length} full prose lines (crop overruns into text, or a text box shown as an image) (crop ${(areaShare * 100) | 0}% of page)`,
						prose[0].text,
					);
			}
		}
	}

	// --- edges (and footer lines inside evidence / monitoring cells)
	const leak = (a: Anchor | undefined, n: Node | null, where: string) => {
		const ln = a?.text
			.split("\n")
			.find(
				(x) =>
					boiler.has(norm(x)) && norm(x).replace(/[#\s\W]/g, "").length >= 12,
			);
		if (a && ln)
			add(
				"footer_leak",
				"high",
				n,
				a.page,
				`running header/footer inside ${where}`,
				ln,
			);
	};
	for (const r of spec.monitoring?.rows ?? [])
		for (const c of r.cells)
			for (const a of c.lines) leak(a, null, `monitoring cell "${r.label}"`);
	for (const e of spec.edges) {
		leak(e.evidence, t.byId.get(e.from) ?? null, "edge evidence");
		const ev = e.evidence?.text ?? "";
		if (ev.length > 400)
			add(
				"long_evidence",
				ev.length > 800 ? "high" : "medium",
				t.byId.get(e.from) ?? null,
				e.evidence!.page,
				`${e.kind} edge ${e.from} -> ${e.to}: evidence ${ev.length} chars`,
				ev,
			);
	}

	// --- treatment flow
	const FLOW = new Set(["next", "alternative", "restratify_to"]);
	const flow = spec.edges.filter((e) => FLOW.has(e.kind));
	const outE = new Map<string, typeof flow>();
	const inE = new Map<string, typeof flow>();
	for (const e of flow) {
		outE.set(e.from, [...(outE.get(e.from) ?? []), e]);
		inE.set(e.to, [...(inE.get(e.to) ?? []), e]);
	}
	// (1) steps outside the flow
	const stepNodes = spec.nodes.filter((n) => n.kind === "step");
	if (flow.length) {
		const loose = stepNodes.filter((n) => !outE.has(n.id) && !inE.has(n.id));
		for (const n of loose)
			add(
				"flow_unconnected",
				"medium",
				n,
				n.pages.from,
				`step has no next/alternative/restratify edge in or out (${loose.length}/${stepNodes.length} steps loose)`,
				n.title,
			);
		for (const n of stepNodes) {
			if (!outE.has(n.id) || inE.has(n.id)) continue;
			const sibs =
				(n.parent
					? t.kids.get(n.parent)
					: spec.nodes.filter((x) => !x.parent)
				)?.filter((x) => x.kind === "step") ?? [];
			if (sibs[0] && sibs[0].id !== n.id)
				add(
					"flow_unconnected",
					"low",
					n,
					n.pages.from,
					"step has outgoing flow but no incoming edge and is not the first step of its arm",
					n.title,
				);
		}
	} else if (stepNodes.length >= 2)
		add(
			"flow_unconnected",
			"high",
			null,
			null,
			`${stepNodes.length} steps and no flow edges at all`,
			"",
		);
	// (2) share of flow edges drawn without evidence
	const na = spec.edges.filter((e) => e.kind === "next" || e.kind === "alternative");
	const inferred = na.filter((e) => !e.evidence);
	stats.flowEdges = na.length;
	stats.flowInferred = inferred.length;
	if (na.length >= 4 && inferred.length / na.length > 0.5)
		add(
			"flow_inferred_share",
			inferred.length / na.length > 0.8 ? "high" : "medium",
			null,
			null,
			`${inferred.length}/${na.length} next/alternative edges have no evidence (drawn dashed, inferred)`,
			inferred
				.slice(0, 3)
				.map(
					(e) => `${t.byId.get(e.from)?.title} -> ${t.byId.get(e.to)?.title}`,
				)
				.join("; "),
		);
	// (3) forks whose evidence is not a decision
	const CUE =
		/MRD|respon|risk|stratif|randomi|eligib|\bif\b|patients with|patients who|in case|<|>|≥|≤|positive|negative|group|arm\b|according to|depending|either|\bor\b/i;
	for (const e of spec.edges.filter((x) => x.kind === "alternative" && x.evidence))
		if (!CUE.test(e.evidence!.text))
			add(
				"fork_evidence_mismatch",
				"medium",
				t.byId.get(e.from) ?? null,
				e.evidence!.page,
				`alternative edge ${t.byId.get(e.from)?.title ?? e.from} -> ${t.byId.get(e.to)?.title ?? e.to}: evidence has no decision cue`,
				e.evidence!.text,
			);
	// (4) missing forks
	for (const [from, es] of outE) {
		const nx = es.filter((e) => e.kind === "next");
		if (nx.length >= 2)
			add(
				"missing_fork",
				"medium",
				t.byId.get(from) ?? null,
				t.byId.get(from)?.pages.from ?? null,
				`${nx.length} outgoing 'next' edges from one node (a fork drawn as sequence?): ${nx.map((e) => t.byId.get(e.to)?.title).join(" | ")}`,
				t.byId.get(from)?.title ?? from,
			);
	}
	const altTargets = new Set(
		spec.edges.filter((e) => e.kind === "alternative").map((e) => e.to),
	);
	const bareT = (x: string) =>
		x.replace(/^(?:\d{1,2}(?:\.\d{1,2})*\.?|[A-Z]\.)\s+/, "").trim();
	for (const [, kids] of [
		...t.kids,
		["(root)", spec.nodes.filter((x) => !x.parent)] as [string, Node[]],
	]) {
		const groups = new Map<string, Node[]>();
		for (const k of kids) {
			if (k.kind !== "step" && k.kind !== "phase") continue;
			// "Induction A".."Induction F", "Course 4 - hA" / "Course 4 - HA": same stem, letter or case variants
			const m =
				/^(.{3,}?)[\s:–-]+(?:arm\s+)?([A-F]|[a-z][A-Z]{1,3}|[A-Z]{2,3})$/.exec(
					bareT(k.title),
				);
			if (!m) continue;
			const key = `${m[1].toLowerCase()}|${m[2].length === 1 ? "letter" : m[2].toLowerCase()}`;
			groups.set(key, [...(groups.get(key) ?? []), k]);
		}
		for (const [key, g] of groups) {
			const stem = key.split("|")[0];
			const ids = new Set(g.map((x) => x.id));
			const chained = flow.some(
				(e) => e.kind === "next" && ids.has(e.from) && ids.has(e.to),
			); // A1 -> B1 -> C1 is a sequence
			if (g.length >= 2 && !chained && !g.some((x) => altTargets.has(x.id)))
				add(
					"missing_fork",
					"high",
					g[0],
					g[0].pages.from,
					`${g.length} variant sections "${stem} …" with no alternative edge to any of them`,
					g.map((x) => x.title).join(" | "),
				);
		}
	}
	// (5) non-treatment sections chained into the flow
	const NONSTEP =
		/guidelines?\b|appendix|annex|biobank|tissue bank|biolog(?:y|ical) stud|translational|sample (?:collection|shipment|handling)|quality of life|statistic|pharmacokinetic|data management|registration|reporting/i;
	const inFlow = new Set(flow.flatMap((e) => [e.from, e.to]));
	for (const id of inFlow) {
		const n = t.byId.get(id);
		if (
			n &&
			(n.kind === "step" || n.kind === "phase") &&
			!/guidelines? for (?:the )?(?:therapy|treatment)/i.test(n.title) &&
			(NONSTEP.test(n.title) ||
				n.headingPath.some((h) => /appendix|annex/i.test(h)))
		)
			add(
				"non_step_in_flow",
				"high",
				n,
				n.pages.from,
				`"${clip(n.title, 60)}" (${n.kind}) is chained into the treatment flow`,
				(inE.get(id) ?? outE.get(id) ?? [])
					.map(
						(e) =>
							`${t.byId.get(e.from)?.title} -> ${t.byId.get(e.to)?.title}`,
					)
					.join("; "),
			);
	}
	// (6) risk-group sections that read as trial aims
	const AIM =
		/\b(aims?|objectives?|end ?points?|hypothes[ie]s|rationale|primary outcome|secondary outcome|(?:main )?goal|to (?:evaluate|assess|investigate|determine|compare|test|examine)|whether)\b/i;
	const CRIT =
		/\b(stage|age[ds]?|MRD|metasta\w*|positive|negative|histolog\w*|resect\w*|volume|size|translocation|amplif\w*|criteria|defined as)\b|[<>≥≤]/i;
	for (const n of spec.nodes.filter(
		(x) => x.kind === "risk_groups" || x.kind === "risk_group",
	)) {
		const texts = n.blocks.map((b) => b.text);
		const aims = texts.filter((x) => AIM.test(x)).length;
		const crit = texts.filter((x) => CRIT.test(x)).length;
		const firstAim = texts[0] && AIM.test(texts[0].split(/[.;]/)[0]);
		if (
			(AIM.test(n.title) && !CRIT.test(n.title)) ||
			(aims >= 2 && aims > crit) ||
			(firstAim && aims >= texts.length / 2)
		)
			add(
				"risk_groups_content",
				"high",
				n,
				n.pages.from,
				`${n.kind} section reads as trial aims/endpoints (${aims} aim lines vs ${crit} criteria lines)`,
				texts.find((x) => AIM.test(x)) ?? n.title,
			);
	}

	// --- block segmentation: sentences cut in two, statements shown as tickable items, sub-items merged
	const CHECKLIST_TITLE =
		/investigation|examination|work-?up|assessment|required|requirement|before (the )?start|prior to|checklist|diagnos/i;
	const inChecklist = (n: Node): boolean =>
		n.kind === "start_requirements" ||
		n.kind === "diagnostics" ||
		CHECKLIST_TITLE.test(n.title) ||
		(!!n.parent && !!t.byId.get(n.parent) && inChecklist(t.byId.get(n.parent)!));
	stats.blocks = 0;
	stats.blocksWithRole = 0;
	for (const n of spec.nodes) {
		const bs = n.blocks;
		stats.blocks += bs.length;
		stats.blocksWithRole += bs.filter((b) => b.role).length;
		for (let i = 0; i < bs.length; i++) {
			const a = bs[i];
			const tx = a.text.trim();
			const b = bs[i + 1];
			// A sentence cut at a line end: "...the last COPDAC-" | "28) or DECOPDAC-21 cycle..." (same page: a page break is always two anchors).
			if (b && b.page === a.page) {
				const last = tx.split("\n").at(-1)!.trim();
				const next = b.text.trim();
				const hyphen =
					/[\p{L}\d]-$/u.test(last) && !/^[•●▪◦■□♦◆►▸➢➤✓✔\-–]/u.test(next);
				const open =
					!/[.:;!?)\]]$/.test(last) &&
					/^(?:\p{Ll}|\d+\)|\))/u.test(next) &&
					!isListItem(next) &&
					!/^[a-z]\s/.test(next) &&
					last.split(/\s+/).length >= 4; // (not footnote keys "a see section 6")
				if (hyphen || open)
					add(
						"split_sentence",
						"high",
						n,
						a.page,
						hyphen
							? "block ends in a line-end hyphen, the sentence continues in the next block"
							: "block ends mid-sentence and the next block continues it",
						`${last.slice(-80)} | ${next.slice(0, 80)}`,
					);
			}
			// A statement shown as something to tick: role "item" (or, without role, the app's isItem) on a declarative rule.
			const tickable = a.role
				? a.role === "item"
				: isItem(tx) && !isHeadingLine(tx);
			const body = tx.replace(
				/^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–\uf0b7\uf0a7]\s*|o\s+|\(?[a-z0-9]{1,2}[.)]\s+)/i,
				"",
			);
			const statement =
				/\.$/.test(body) &&
				body.split(/\s+/).length >= 5 &&
				!/[≥≤<>]/.test(body) &&
				/^(?:patients?|children|all patients|they|it|this|these|there|no patient|radiotherapy|treatment|the patient)\b[^.]{0,100}\b(?:do(?:es)? not receive|receives?|will (?:receive|be (?:treated|stratified|randomi[sz]ed|allocated|assigned|given))|are (?:treated|stratified|allocated|assigned|considered|defined|randomi[sz]ed|(?:not )?eligible)|is (?:defined|considered)|should be stratified|continues?|(?:will )?start)\b/i.test(
					body,
				);
			if (tickable && statement && inChecklist(n))
				add(
					"statement_as_item",
					"medium",
					n,
					a.page,
					"a declarative rule is shown as a tickable item",
					tx,
				);
			// Several (sub-)numbered items in one block: "3. Bone marrow:\n3.1 Morphology.\n3.2 Immunophenotyping".
			// (not a table of contents with dot leaders, nor prose wrapping before "11.3 Chemotherapy" mid-sentence)
			const ls = a.text.split("\n").map((x) => x.trim());
			const numbered = /^\d{1,2}(?:\.\d{1,2}){0,2}[.)]?\s/.test(ls[0]);
			if (
				!/\.{5,}|…{2,}/.test(a.text) &&
				ls.some(
					(x, k) =>
						k > 0 &&
						(/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\.?\s+\p{Lu}/u.test(x) ||
							(numbered && /^\d{1,2}[.)]\s+\p{Lu}/u.test(x))) &&
						(numbered || /[.:;]$/.test(ls[k - 1])),
				)
			)
				add(
					"sub_numbered_merge",
					"medium",
					n,
					a.page,
					"several numbered (sub-)items merged into one block",
					tx,
				);
		}
	}

	// --- steps without start requirements (count only)
	const steps = spec.nodes.filter((n) => n.kind === "step");
	const withStart = steps.filter((s) =>
		(t.kids.get(s.id) ?? []).some((c) => c.kind === "start_requirements"),
	);
	stats.steps = steps.length;
	stats.stepsMissingStart = steps.length - withStart.length;
	if (steps.length - withStart.length > 0)
		add(
			"missing_start",
			"low",
			null,
			null,
			`${steps.length - withStart.length}/${steps.length} steps have no start_requirements child`,
			"",
		);
	stats.diagNodes = diagNodeIds.size;
	return { issues: dedupe(issues), stats };
}

function dedupe(issues: Issue[]): Issue[] {
	const seen = new Set<string>();
	return issues.filter((i) => {
		const k = `${i.class}|${i.nodeId}|${i.page}|${i.sample.slice(0, 60)}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** True when the run-in phrase at the start of a line is set in bold in the PDF while the rest of the line is not. */
const stextCache = new WeakMap<
	mupdf.Document,
	Map<number, { text: string; bold: boolean; bbox: number[] }[]>
>();
function boldPrefixOf(
	doc: mupdf.Document,
	page: number,
	lineBox: number[],
	phrase: string,
): boolean {
	let m = stextCache.get(doc);
	if (!m) stextCache.set(doc, (m = new Map()));
	let pieces = m.get(page);
	if (!pieces) {
		const st = doc.loadPage(page - 1).toStructuredText("preserve-whitespace");
		const json = JSON.parse(st.asJSON()) as {
			blocks: {
				lines?: {
					text: string;
					bbox: { x: number; y: number; w: number; h: number };
					font?: { name: string; weight: string };
				}[];
			}[];
		};
		pieces = json.blocks.flatMap((b) =>
			(b.lines ?? []).map((l) => ({
				text: l.text,
				bold:
					l.font?.weight === "bold" ||
					/bold|black|heavy|semibold|demi/i.test(l.font?.name ?? ""),
				bbox: [l.bbox.x, l.bbox.y, l.bbox.x + l.bbox.w, l.bbox.y + l.bbox.h],
			})),
		);
		m.set(page, pieces);
	}
	const row = pieces
		.filter((p) => overlapY(p.bbox, lineBox) > 2)
		.sort((a, b) => a.bbox[0] - b.bbox[0]);
	if (row.length < 2) return false;
	const head = row[0].text.trim().replace(/:$/, "");
	const word = phrase.split(/\s+/)[0];
	return (
		row[0].bold &&
		head.startsWith(word) &&
		row.slice(1).some((p) => !p.bold && p.text.trim().length > 20)
	);
}

if (import.meta.main) {
	const ids = process.argv.slice(2);
	const all = registry().filter(
		(p) => p.published && (!ids.length || ids.includes(p.id)),
	);
	const counts: Record<string, number> = {};
	for (const p of all) {
		const L = load(p.id);
		if (!L) continue;
		const { issues } = runChecks(L);
		for (const i of issues) counts[i.class] = (counts[i.class] ?? 0) + 1;
		console.log(p.id, issues.length);
		if (ids.length)
			for (const i of issues)
				console.log(
					`  [${i.class}/${i.severity}] p${i.page} ${i.detail} :: ${i.sample.slice(0, 120)}`,
				);
	}
	console.log(counts);
}
