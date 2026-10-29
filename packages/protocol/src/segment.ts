/**
 * Block segmentation by the model: a section's visual lines (ids, indent, bold, size, page breaks)
 * go to the model, which says where each block starts and what it is for the reader
 * (item to tick, rule to read, heading, prose) and its list depth. It points at line ids only;
 * code cuts the verbatim text. Every answer is validated (starts exist, belong to the section,
 * strictly increase, the first block starts at the section's first line): a section whose answer
 * fails falls back to the layout heuristics (`blocksOf`).
 */
import { z } from "zod";
import type { Line } from "./pdf.ts";
import type { Anchor } from "./spec.ts";

export const Role = z.enum(["item", "rule", "heading", "prose"]);
export type Role = z.infer<typeof Role>;

export const Segments = z.object({
	sections: z
		.array(
			z.object({
				id: z.string().describe("Section id from the input (e.g. S3)."),
				blocks: z
					.array(
						z.object({
							start: z
								.string()
								.describe(
									"Id of the first line of the block (e.g. L12). A block runs until the next block's start.",
								),
							role: Role,
							depth: z
								.number()
								.int()
								.min(0)
								.max(5)
								.describe(
									"List nesting depth: 0 top level, 1 a sub-item of the item above, ...",
								),
						}),
					)
					.describe(
						"Blocks in reading order. The first block starts at the section's first line.",
					),
			}),
		)
		.describe("One entry per section of the input."),
});
export type SegmentAnswer = z.infer<typeof Segments>;

/** Typed rules ("________", "-------") drawn as text: decoration, not content (as in blocksOf). */
const RULE_LINE = /^[\s_\-=–—~.·]{5,}$/;
export const segmentable = (lines: Line[]) =>
	lines.filter((l) => !RULE_LINE.test(l.text));

export interface SegInput {
	key: string;
	title: string;
	lines: Line[];
}

export const INSTRUCTIONS = [
	"You segment sections of a paediatric oncology protocol PDF into blocks for a clinician's reading/checklist view.",
	"Each input line is one visual line of the PDF text layer: `Lid p<page> x=<left indent> [b=bold] [s=font size] [gap=<blank space above, in line heights>] | text`. A `--- page N ---` marker shows a page break.",
	"Group consecutive lines into blocks: a block is one paragraph, one list item (with its wrapped lines), one heading or one list intro.",
	"- A line that ends mid-sentence continues in the next line: a line-end hyphen ('COPDAC-' then '28) or ...'), a missing final full stop, a next line starting lowercase or with a closing bracket or number continuing the phrase. Never split a sentence across blocks, even across a page break (code splits at page breaks itself).",
	"- A new bullet ('•', '-', 'o', ''), a number/letter enumerator ('1.', 'a)', '(ii)') or a sub-number ('3.1 Morphology') starts a new block; each sub-numbered item is its own block. Its wrapped lines stay with it.",
	"- 'OR' / 'AND' / 'unless' lines joining alternatives of one criterion stay in that criterion's block.",
	"- A short bold line, or an unbulleted line ending ':' introducing a list, is its own block (role heading).",
	"- One bullet is one block: lines at the bullet's hanging indent that continue or explain it (even full sentences) stay in its block, unless they start with their own bullet or enumerator.",
	"- Short unbulleted entries one per line at a deeper indent under an item (a list of translocations, drugs or sites, without full sentences) are each their own block, as sub-items of that item.",
	"Role of each block: item = a single investigation, action or criterion a clinician would tick off (an examination to do, a drug/dose to give, a condition to check such as 'ANC ≥ 1.0 x 10^9/l' or 'No IR criterion fulfilled'); rule = a statement to read, not tick: a decision, consequence, eligibility/treatment rule, definition or instruction stated as a sentence ('Patients with AR do not receive radiotherapy.', 'A site is PET-positive if ...'); heading = a run-in heading, side heading or list intro ('The following investigations are required:'); prose = explanation, context, rationale, references.",
	"Bullets do not make something an item: a bulleted sentence that states a rule or consequence is a rule. An item is short and checkable.",
	"- A bulleted or numbered line ending ':' that names an investigation or criterion ('- Physical examination including:', '6. Adequate hepatic function:') is an item; its sub-bullets are its sub-items. An unbulleted intro ending ':' is a heading.",
	"- A paragraph that states content and then introduces a list ('Induction consists of the following drugs:', 'is defined as:') is a rule; a one-sentence intro is a heading.",
	"- A bold run-in heading on the same line as its sentence ('Medical history at diagnosis includes ...') takes the role of the sentence.",
	"- Choose-one categories (diagnostic groups, strata) and lists of acceptable options (contraception methods) are rules, not items: nobody ticks all of them.",
	"- Cross-references ('Please refer to ...', 'See section ...') are prose.",
	"depth counts list nesting only, never headings: the items of a list directly under a heading or list intro are depth 0 (the intro does not add a level); sub-items indented under an item are 1; their sub-items 2. Rules and prose are depth 0 unless they sit inside an item's sub-list.",
	"Return every section of the input, with block starts that are line ids of that section, in increasing order, the first one being the section's first line.",
].join("\n");

const fmt = (lines: Line[], ids: string[]) => {
	const x0 = Math.min(...lines.map((l) => l.bbox[0]));
	const out: string[] = [];
	lines.forEach((l, i) => {
		const prev = lines[i - 1];
		if (prev && prev.page !== l.page) out.push(`--- page ${l.page} ---`);
		const h = Math.max(1, l.bbox[3] - l.bbox[1]);
		const gap = prev && prev.page === l.page ? (l.bbox[1] - prev.bbox[3]) / h : 0;
		const tags = [
			`${ids[i]} p${l.page} x=${Math.round(l.bbox[0] - x0)}`,
			l.bold ? "b" : "",
			`s=${Math.round(l.size)}`,
			gap > 0.4 ? `gap=${gap.toFixed(1)}` : "",
		]
			.filter(Boolean)
			.join(" ");
		out.push(`${tags} | ${l.text}`);
	});
	return out.join("\n");
};

/** Sections batched into calls of about `max` lines; ids are unique within a call. */
export function chunk(inputs: SegInput[], max = 220): SegInput[][] {
	const out: SegInput[][] = [];
	let cur: SegInput[] = [];
	let n = 0;
	for (const s of inputs) {
		if (!s.lines.length) continue;
		if (cur.length && n + s.lines.length > max) {
			out.push(cur);
			cur = [];
			n = 0;
		}
		cur.push(s);
		n += s.lines.length;
	}
	if (cur.length) out.push(cur);
	return out;
}

/** The prompt of one call and the line ids of each of its sections. */
export function promptFor(protocol: string, group: SegInput[]) {
	let k = 0;
	const ids = group.map((s) => s.lines.map(() => `L${k++}`));
	const body = group
		.map(
			(s, i) =>
				`## S${i} "${s.title.replace(/\s+/g, " ").slice(0, 120)}"\n${fmt(s.lines, ids[i])}`,
		)
		.join("\n\n");
	return { prompt: `${INSTRUCTIONS}\n\nProtocol: ${protocol}\n\n${body}`, ids };
}

/** Validate one section's answer and cut its anchors (one per block and page). Null when the answer is unusable. */
export function anchorsFrom(
	lines: Line[],
	ids: string[],
	blocks: SegmentAnswer["sections"][number]["blocks"] | undefined,
): Anchor[] | null {
	if (!blocks?.length || !lines.length) return null;
	const at = new Map(ids.map((id, i) => [id, i]));
	const starts = blocks.map((b) => at.get(b.start.trim()));
	if (starts[0] !== 0) return null;
	for (let i = 1; i < starts.length; i++)
		if (starts[i] === undefined || starts[i]! <= starts[i - 1]!) return null;
	const out: Anchor[] = [];
	blocks.forEach((b, i) => {
		const run = lines.slice(starts[i]!, starts[i + 1] ?? lines.length);
		// An anchor is one span on one page: a block crossing a page break is two anchors with the same role.
		let cur: Line[] = [];
		const flush = () => {
			if (cur.length)
				out.push({
					page: cur[0].page,
					text: cur.map((l) => l.text).join("\n"),
					bbox: cur.map((l) => l.bbox),
					role: b.role,
					...(b.depth ? { depth: b.depth } : {}),
				});
			cur = [];
		};
		for (const l of run) {
			if (cur.length && cur[0].page !== l.page) flush();
			cur.push(l);
		}
		flush();
	});
	return out;
}

/**
 * Segment every section. `ask` runs one model call (the caller owns model choice, fallbacks and token
 * accounting). Returns the anchors per key for the sections whose answer validated.
 */
export async function segmentAll(
	protocol: string,
	inputs: SegInput[],
	ask: (prompt: string) => Promise<SegmentAnswer>,
	concurrency = 8,
): Promise<{ blocks: Map<string, Anchor[]>; failed: string[] }> {
	const groups = chunk(inputs.map((s) => ({ ...s, lines: segmentable(s.lines) })));
	const blocks = new Map<string, Anchor[]>();
	const failed: string[] = [];
	let next = 0;
	const worker = async () => {
		while (next < groups.length) {
			const group = groups[next++];
			const { prompt, ids } = promptFor(protocol, group);
			let ans: SegmentAnswer | undefined;
			try {
				ans = await ask(prompt);
			} catch {
				ans = undefined;
			}
			group.forEach((s, i) => {
				const got = ans?.sections.find((x) => x.id.trim() === `S${i}`);
				const a = anchorsFrom(s.lines, ids[i], got?.blocks);
				if (a) blocks.set(s.key, a);
				else failed.push(s.key);
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, groups.length) }, worker),
	);
	return { blocks, failed };
}
