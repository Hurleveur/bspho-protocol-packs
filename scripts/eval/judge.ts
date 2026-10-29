/**
 * LLM-vision judge: for a sample of sections per protocol, show Gemini the PDF page(s) and the
 * section exactly as the consult sheet presents it, and ask what the extraction got wrong.
 * Verdicts are cached by content hash (store/eval/judge-cache), so a re-run only re-judges
 * sections whose extraction changed.
 *
 *   bun scripts/eval/judge.ts [protocolId...]      (JUDGE_K=3, JUDGE_CONCURRENCY=2)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVertex } from "../../packages/protocol/node_modules/@ai-sdk/google-vertex";
import { generateText, Output } from "../../packages/protocol/node_modules/ai";
import { z } from "../../packages/protocol/node_modules/zod";
import { renderPage, renderRegion } from "@bspho/protocol/pdf";
import type { Node } from "@bspho/protocol/spec";
import {
	BULLET,
	diagItems,
	type Issue,
	isHeadingLine,
	isItem,
	isListItem,
	type Loaded,
	load,
	registry,
	runChecks,
	sameTitle,
	STORE,
	tree,
} from "./checks.ts";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "qwiklabs-gcp-01-ce74ae98024d";
const MODELS = [
	{
		location: "global",
		model: "gemini-3.1-pro-preview",
		thinking: { thinkingLevel: "high" },
	},
	{
		location: "europe-west1",
		model: "gemini-2.5-pro",
		thinking: { thinkingBudget: 8192 },
	},
];
const CACHE = join(STORE, "eval", "judge-cache");

export const JUDGE_CLASSES = [
	"split_list",
	"relapse_in_diagnosis",
	"wrong_stage",
	"flattened_table",
	"interleaved_columns",
	"truncated_title",
	"runin_merged",
	"footer_leak",
	"list_item_glue",
	"figure_overrun",
	"missing_content",
	"prose_as_checklist",
	"wrong_section",
	"other",
] as const;

const Verdict = z.object({
	verdict: z.enum(["ok", "issues"]),
	issues: z
		.array(
			z.object({
				class: z.enum(JUDGE_CLASSES),
				severity: z
					.enum(["high", "medium", "low"])
					.describe(
						"high = a clinician could miss or misread an instruction; medium = confusing but recoverable; low = cosmetic",
					),
				description: z
					.string()
					.describe(
						"One or two sentences: what the app shows wrongly compared with the page.",
					),
				evidence: z
					.string()
					.describe(
						"Short verbatim quote from the PDF page (not from the extraction) that shows the problem.",
					),
				page: z
					.number()
					.int()
					.optional()
					.describe("PDF page the evidence is on"),
			}),
		)
		.describe(
			"Empty when verdict is ok. Only real extraction defects; do not critique the protocol itself.",
		),
});
type Verdict = z.infer<typeof Verdict>;

const CLASS_HELP = `Defect classes:
split_list = one list in the PDF (an intro line + its bullet items) is split across sections or work-up stages, or items are missing;
relapse_in_diagnosis = relapse / recurrence / follow-up investigations shown as part of the initial diagnosis work-up;
wrong_stage = a work-up line sorted into the wrong stage (primary / molecular / extent / baseline);
flattened_table = a table shown as running text (a run of numbers or cells) instead of as a table/figure;
interleaved_columns = text of two columns or table cells interleaved into chopped sentences ("Cyclophosphamide Cyclophosphamide 1000 mg/m2 ...");
truncated_title = section title cut (from a wrapped heading) or heading text repeated as the first block;
runin_merged = a bold run-in heading merged into the following paragraph;
footer_leak = running header/footer/page number text inside content;
list_item_glue = bullet items glued together or one item split in two, AND/OR logic split from the items it joins;
figure_overrun = a figure crop that cuts the figure or overruns into prose; a flowchart shown as text fragments;
missing_content = text in this section on the page that the extraction lost;
prose_as_checklist = explanatory prose (e.g. imaging technique) presented as a tickable checklist item;
wrong_section = content that belongs to another section, or section kind obviously wrong;
other = anything else that would mislead a clinician.`;

// ---------------------------------------------------------------- sampling

export function sample(L: Loaded, flagged: Issue[], k: number): Node[] {
	const t = tree(L.spec);
	const flagCount = new Map<string, number>();
	for (const i of flagged)
		if (i.nodeId && i.class !== "missing_start")
			flagCount.set(
				i.nodeId,
				(flagCount.get(i.nodeId) ?? 0) + (i.severity === "high" ? 2 : 1),
			);
	const diag = new Set(diagItems(L.spec, t).map((i) => i.node.id));
	const scored = L.spec.nodes
		.filter((n) => n.blocks.length >= 2 || n.figures?.length)
		.map((n) => {
			let s = 0;
			if (diag.has(n.id)) s += 2.5;
			if (n.kind === "start_requirements") s += 2.5;
			if (n.kind === "supportive_care" || n.kind === "toxicity") s += 1.5;
			if (n.figures?.length) s += 1;
			s += Math.min(4, 1.5 * (flagCount.get(n.id) ?? 0));
			// deterministic tie-break
			s +=
				(parseInt(
					createHash("md5").update(n.id).digest("hex").slice(0, 4),
					16,
				) /
					0xffff) *
				0.5;
			return { n, s };
		})
		.sort((a, b) => b.s - a.s);
	const out: Node[] = [];
	const kinds = new Map<string, number>();
	while (out.length < k && scored.length) {
		// diversity: penalise kinds already picked
		scored.sort(
			(a, b) =>
				b.s -
				1.5 * (kinds.get(b.n.kind) ?? 0) -
				(a.s - 1.5 * (kinds.get(a.n.kind) ?? 0)),
		);
		const { n } = scored.shift()!;
		out.push(n);
		kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
	}
	return out;
}

// ---------------------------------------------------------------- representation

export function represent(L: Loaded, n: Node): string {
	const t = tree(L.spec);
	const diag = new Map(
		diagItems(L.spec, t)
			.filter((i) => i.node.id === n.id)
			.map((i) => [i.idx, i.stage]),
	);
	const inDiag = diag.size > 0;
	const out: string[] = [
		`Section title: "${n.title}"`,
		`Breadcrumb: ${n.headingPath.join(" > ") || "(top level)"}`,
		`Kind: ${n.kind}${n.stage ? `, section stage: ${n.stage}` : ""}   PDF pages ${n.pages.from}-${n.pages.to}`,
		inDiag
			? "Shown in the DIAGNOSIS WORK-UP, where each line is sorted into a stage: 1 primary, 2 molecular, 3 extent, 4 baseline; lines without a stage go to 'Other'."
			: "",
		n.kind === "start_requirements"
			? "Shown as START REQUIREMENTS of a treatment step: each line becomes a tickable chip."
			: "",
		"",
		"Blocks in display order (one per paragraph / list item):",
	];
	n.blocks.forEach((a, i) => {
		if (i === 0 && sameTitle(a.text, n.title)) return;
		const tags = [
			`p${a.page}`,
			// (the app uses the pipeline's block role when present: item ticks, heading is a subheading, rule/prose is read)
			a.role
				? {
						item: "CHECKABLE",
						heading: "SUBHEADING",
						rule: "PROSE",
						prose: "PROSE",
					}[a.role] + (a.depth ? ` depth ${a.depth}` : "")
				: isListItem(a.text)
					? "LIST ITEM"
					: isHeadingLine(a.text)
						? "SUBHEADING"
						: isItem(a.text)
							? "CHECKABLE"
							: "PROSE",
			inDiag ? `stage=${diag.get(i) ?? "Other"}` : "",
		].filter(Boolean);
		out.push(
			`[${i}] (${tags.join(", ")}) ${a.text.replace(BULLET, "").replace(/\n/g, " ⏎ ")}`,
		);
	});
	if (!n.blocks.length) out.push("(no blocks)");
	(n.figures ?? []).forEach((f, fi) => {
		if (f.structure?.table && !f.raster && f.bbox) {
			const rows = f.structure.table.rows.slice(0, 40).map(
				(r) =>
					`| ${r
						.filter((c) => !c.covered)
						.map((c) => c.text.replace(/\n/g, " "))
						.join(" | ")} |`,
			);
			out.push(
				`FIGURE #${fi + 1} p${f.page}: rendered by the app as an HTML TABLE re-typeset from the text layer (${f.structure.table.headerRows} header rows), exactly these rows/cells:`,
				...rows,
				f.structure.table.rows.length > 40
					? `... ${f.structure.table.rows.length} rows in total`
					: "",
				`(The attached CROP #${fi + 1} image is the region the table was cut from.)`,
			);
		} else if (f.bbox)
			out.push(
				`FIGURE #${fi + 1} p${f.page}: shown by the app as the image in attached CROP #${fi + 1} (exactly what the clinician sees).`,
			);
		else out.push(`FIGURE #${fi + 1} p${f.page}: shown as the whole page image.`);
	});
	for (const c of t.kids.get(n.id) ?? [])
		out.push(`Child section: "${c.title}" (${c.kind}, p${c.pages.from})`);
	return out.filter((x) => x !== "").join("\n");
}

function pagesOf(n: Node): number[] {
	const ps = [
		...new Set([
			...n.blocks.map((b) => b.page),
			...(n.figures ?? []).map((f) => f.page),
		]),
	].sort((a, b) => a - b);
	return (ps.length ? ps : [n.pages.from]).slice(0, 2);
}

// ---------------------------------------------------------------- model call

let degraded = false;
async function callModel(
	content: (
		| { type: "text"; text: string }
		| { type: "file"; data: Uint8Array; mediaType: string }
	)[],
): Promise<{ v: Verdict; model: string }> {
	let last: unknown;
	for (const [mi, m] of MODELS.entries()) {
		if (mi === 0 && degraded) continue;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const vertex = createVertex({ project: PROJECT, location: m.location });
				const r = await generateText({
					model: vertex(m.model),
					output: Output.object({ schema: Verdict }),
					messages: [{ role: "user", content }],
					temperature: 0,
					providerOptions: { vertex: { thinkingConfig: m.thinking } },
				});
				return { v: r.output as Verdict, model: m.model };
			} catch (e) {
				last = e;
				const msg = String((e as Error)?.message ?? e);
				const quota = /429|RESOURCE_EXHAUSTED|quota|rate/i.test(msg);
				if (!quota) {
					if (attempt < 1) continue;
					break;
				}
				if (attempt < 1) {
					await new Promise((r) => setTimeout(r, 15000));
					continue;
				}
				if (mi === 0) {
					console.warn(`  [judge] ${m.model} quota exhausted, falling back`);
					degraded = true;
				}
				break;
			}
		}
	}
	throw last;
}

export interface JudgeResult {
	protocol: string;
	nodeId: string;
	title: string;
	kind: string;
	pages: number[];
	model: string;
	verdict: Verdict["verdict"];
	issues: Verdict["issues"];
	cached: boolean;
	ms: number;
	error?: string;
}

export async function judgeNode(L: Loaded, n: Node): Promise<JudgeResult> {
	const rep = represent(L, n);
	const pages = pagesOf(n);
	const imgs = pages.map((p) =>
		renderPage(
			L.doc,
			p,
			n.blocks.filter((b) => b.page === p).flatMap((b) => b.bbox),
			1.6,
		),
	);
	const figs = (n.figures ?? [])
		.map((f, fi) => ({ fi, f }))
		.filter(({ f }) => f.bbox);
	const crops = figs.map(({ f }) =>
		renderRegion(
			L.doc,
			f.page,
			f.bbox!.map((v) => Math.round(v)) as [number, number, number, number],
		),
	);
	const prompt = [
		"You audit a medical app that turns paediatric oncology protocol PDFs into consult sheets. Clinical text is copied verbatim from the PDF text layer; the risk is STRUCTURE: wrong splitting, ordering, grouping or classification of that text.",
		`Attached: the PDF page(s) ${pages.join(", ")} of protocol ${L.short}. Text the app extracted for this section is tinted yellow on the page.`,
		crops.length
			? `Also attached, after the pages: CROP #n images, the exact figure/table crops the app displays.`
			: "",
		"Below: the section as the app presents it. Compare it with the page and report only defects a clinician would notice: content missing, merged, misordered or mislabelled compared with the page. Judge only what the app does with the page's content in this section, not the protocol's clinical quality.",
		"Figures: compare each CROP image against the page. A crop is 'cut off' ONLY if content of the same table/figure that is visible on the page is missing from the crop image; extra margin or a neighbouring caption is not a defect. Do not infer crop problems from coordinates. For re-typeset tables, compare the listed rows/cells with the table on the page.",
		"Every issue must quote the page verbatim as evidence. When unsure, say ok: a false alarm costs more than a missed cosmetic issue. If the section looks faithful, answer verdict ok with no issues.",
		"",
		CLASS_HELP,
		"",
		"=== APP REPRESENTATION ===",
		rep,
	].join("\n");
	const key = createHash("sha256")
		.update(prompt)
		.update(Buffer.concat([...imgs, ...crops].map((i) => Buffer.from(i))))
		.digest("hex");
	const file = join(CACHE, `${key}.json`);
	const t0 = Date.now();
	if (existsSync(file)) {
		const c = JSON.parse(readFileSync(file, "utf8"));
		return {
			protocol: L.id,
			nodeId: n.id,
			title: n.title,
			kind: n.kind,
			pages,
			...c,
			cached: true,
			ms: 0,
		};
	}
	try {
		const { v, model } = await callModel([
			...imgs.flatMap((data, i) => [
				{ type: "text" as const, text: `PAGE ${pages[i]} (full page):` },
				{ type: "file" as const, data, mediaType: "image/png" },
			]),
			...crops.flatMap((data, i) => [
				{
					type: "text" as const,
					text: `CROP #${figs[i].fi + 1} (figure on page ${figs[i].f.page}, as shown in the app):`,
				},
				{ type: "file" as const, data, mediaType: "image/png" },
			]),
			{ type: "text" as const, text: prompt },
		]);
		mkdirSync(CACHE, { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ model, verdict: v.verdict, issues: v.issues }),
		);
		return {
			protocol: L.id,
			nodeId: n.id,
			title: n.title,
			kind: n.kind,
			pages,
			model,
			verdict: v.verdict,
			issues: v.issues,
			cached: false,
			ms: Date.now() - t0,
		};
	} catch (e) {
		return {
			protocol: L.id,
			nodeId: n.id,
			title: n.title,
			kind: n.kind,
			pages,
			model: "",
			verdict: "ok",
			issues: [],
			cached: false,
			ms: Date.now() - t0,
			error: String((e as Error)?.message ?? e).slice(0, 300),
		};
	}
}

export async function judgeAll(
	ids: string[],
	flaggedBy: Map<string, Issue[]>,
	k: number,
	concurrency: number,
	log = console.log,
): Promise<JudgeResult[]> {
	const queue = [...ids];
	const results: JudgeResult[] = [];
	const worker = async () => {
		while (queue.length) {
			const id = queue.shift()!;
			const L = load(id);
			if (!L) continue;
			for (const n of sample(L, flaggedBy.get(id) ?? [], k)) {
				const r = await judgeNode(L, n);
				results.push(r);
				log(
					`  [judge] ${id} p${r.pages.join(",")} ${n.title.slice(0, 50)}: ${r.error ? `ERROR ${r.error.slice(0, 80)}` : `${r.verdict} (${r.issues.length})`}${r.cached ? " cached" : ` ${(r.ms / 1000) | 0}s ${r.model}`}`,
				);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return results;
}

export function judgeIssues(results: JudgeResult[]): Issue[] {
	return results.flatMap((r) =>
		r.issues.map((i) => ({
			protocol: r.protocol,
			class: i.class,
			severity: i.severity,
			page: i.page ?? r.pages[0],
			nodeId: r.nodeId,
			title: r.title,
			detail: i.description,
			sample: i.evidence.slice(0, 220),
			source: "judge" as const,
		})),
	);
}

if (import.meta.main && process.argv.slice(2).some((a) => a.includes(":"))) {
	// bun scripts/eval/judge.ts proto:nodeIdPrefix ...   judge exactly these sections, write store/eval/judge-targets.json
	const targets = process.argv.slice(2).map((a) => a.split(":") as [string, string]);
	const queue = [...targets];
	const results: JudgeResult[] = [];
	const worker = async () => {
		while (queue.length) {
			const [id, pref] = queue.shift()!;
			const L = load(id);
			const n = L?.spec.nodes.find((x) => x.id.startsWith(pref));
			if (!L || !n) {
				console.warn(`  [judge] not found ${id}:${pref}`);
				continue;
			}
			const r = await judgeNode(L, n);
			results.push(r);
			console.log(
				`  [judge] ${id} p${r.pages.join(",")} ${n.title.slice(0, 50)}: ${r.error ? `ERROR ${r.error.slice(0, 80)}` : `${r.verdict} (${r.issues.length})`}${r.cached ? " cached" : ` ${(r.ms / 1000) | 0}s ${r.model}`}`,
			);
		}
	};
	await Promise.all(
		Array.from({ length: Number(process.env.JUDGE_CONCURRENCY ?? 2) }, worker),
	);
	writeFileSync(
		join(STORE, "eval", "judge-targets.json"),
		JSON.stringify(results, null, 1),
	);
	for (const i of judgeIssues(results))
		console.log(
			`[${i.class}/${i.severity}] ${i.protocol} p${i.page} ${i.title}: ${i.detail} :: "${i.sample}"`,
		);
} else if (import.meta.main) {
	const ids = process.argv.slice(2);
	const list = registry()
		.filter((p) => p.published && (!ids.length || ids.includes(p.id)))
		.map((p) => p.id);
	const flagged = new Map<string, Issue[]>();
	for (const id of list) flagged.set(id, runChecks(load(id)!).issues);
	const res = await judgeAll(
		list,
		flagged,
		Number(process.env.JUDGE_K ?? 3),
		Number(process.env.JUDGE_CONCURRENCY ?? 2),
	);
	for (const i of judgeIssues(res))
		console.log(
			`[${i.class}/${i.severity}] ${i.protocol} p${i.page} ${i.title}: ${i.detail} :: "${i.sample}"`,
		);
}
