/**
 * Block-segmenter scorer: runs the real segmenter (segmentAll + askSegments) on the hand-labelled
 * fixture store/eval/segments-fixture.json and scores block boundaries (precision/recall/F1 over
 * block starts, the forced first line excluded), role and depth accuracy on blocks whose start
 * matches, per section and overall. Several runs measure run-to-run variance.
 *
 *   bun scripts/eval/segments.ts                     askSegments' default chain (PIPELINE_MODEL)
 *   bun scripts/eval/segments.ts --model flash       flash chain; --model pro forces the pro chain
 *   bun scripts/eval/segments.ts --runs 3            repeat; mismatches ranked by how often they recur
 *   bun scripts/eval/segments.ts far-rms hlh-2004    some protocols (or section ids "far-rms#9")
 *
 * Writes store/eval/segments-report.json. The fixture holds protocol text: it stays in store/.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Line } from "@bspho/protocol/pdf";
import {
	chunk,
	type Role,
	type SegInput,
	type SegmentAnswer,
	promptFor,
	segmentable,
	segmentAll,
} from "@bspho/protocol/segment";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const STORE = join(import.meta.dir, "..", "..", "store");
const EVAL = join(STORE, "eval");

const args = process.argv.slice(2);
const opt = (k: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const model = opt("--model");
const RUNS = Number(opt("--runs") ?? 1);
const filter = args.filter((a) => !a.startsWith("--"));
// build.ts reads PIPELINE_MODEL once at load: set it before the import.
if (model === "flash") process.env.PIPELINE_MODEL = "flash";
else if (model === "pro") delete process.env.PIPELINE_MODEL;
else if (model) throw new Error(`--model flash|pro, not ${model}`);
const { askSegments } = await import("@bspho/protocol/build");
const chain = process.env.PIPELINE_MODEL === "flash" ? "flash" : "pro";

interface Label {
	start: boolean;
	role?: Role;
	depth?: number;
}
interface FixtureSection {
	id: string;
	protocol: string;
	sha: string;
	title: string;
	note: string;
	lines: Line[];
	labels: Label[];
}
interface Block {
	line: number;
	role: Role;
	depth: number;
}
interface Mismatch {
	section: string;
	line: number;
	kind: "missed" | "spurious" | "role" | "depth";
	text: string;
	expected: string;
	got: string;
}

const fixture = JSON.parse(
	readFileSync(join(EVAL, "segments-fixture.json"), "utf8"),
) as { sections: FixtureSection[] };
const sections = fixture.sections.filter(
	(s) => !filter.length || filter.includes(s.protocol) || filter.includes(s.id),
);
const titles = new Map<string, string>(
	JSON.parse(readFileSync(join(STORE, "registry.json"), "utf8")).protocols.map(
		(p: { id: string; title: string }) => [p.id, p.title],
	),
);

const expectedOf = (s: FixtureSection): Block[] =>
	s.labels.flatMap((l, i) =>
		l.start ? [{ line: i, role: l.role!, depth: l.depth ?? 0 }] : [],
	);

/** One run: segmentAll per protocol as the build calls it, with the raw answers kept to read block starts. */
async function run(): Promise<Map<string, Block[] | null>> {
	const out = new Map<string, Block[] | null>();
	const byProtocol = Map.groupBy(sections, (s) => s.protocol);
	await Promise.all(
		[...byProtocol].map(async ([protocol, list]) => {
			const title = titles.get(protocol) ?? protocol;
			const inputs: SegInput[] = list.map((s) => ({
				key: s.id,
				title: s.title,
				lines: s.lines,
			}));
			const answers = new Map<string, SegmentAnswer>();
			const { blocks } = await segmentAll(title, inputs, async (prompt) => {
				const a = await askSegments(prompt);
				answers.set(prompt, a);
				return a;
			});
			// Same chunking and ids as segmentAll: map each answer back to its sections' line indices.
			for (const group of chunk(
				inputs.map((s) => ({ ...s, lines: segmentable(s.lines) })),
			)) {
				const { prompt, ids } = promptFor(title, group);
				const ans = answers.get(prompt);
				group.forEach((s, i) => {
					const got = ans?.sections.find((x) => x.id.trim() === `S${i}`);
					if (!blocks.has(s.key) || !got) return out.set(s.key, null);
					const at = new Map(ids[i].map((id, k) => [id, k]));
					out.set(
						s.key,
						got.blocks.map((b) => ({
							line: at.get(b.start.trim())!,
							role: b.role,
							depth: b.depth,
						})),
					);
				});
			}
		}),
	);
	return out;
}

const fmt = (b: Block | undefined) => (b ? `${b.role}/${b.depth}` : "-");
const pct = (n: number, d: number) => (d ? n / d : Number.NaN);
const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0);

function score(s: FixtureSection, got: Block[]) {
	const exp = expectedOf(s);
	const E = new Map(exp.map((b) => [b.line, b]));
	const G = new Map(got.map((b) => [b.line, b]));
	// Line 0 always starts a block (validated): boundaries are scored on the others.
	const eB = exp.filter((b) => b.line > 0);
	const gB = got.filter((b) => b.line > 0);
	const tp = gB.filter((b) => E.has(b.line)).length;
	const matched = got.filter((b) => E.has(b.line));
	const roleOk = matched.filter((b) => E.get(b.line)!.role === b.role).length;
	const depthOk = matched.filter((b) => E.get(b.line)!.depth === b.depth).length;
	const mm: Mismatch[] = [];
	const text = (i: number) => s.lines[i].text;
	const blockAt = (bs: Block[], i: number) => bs.filter((b) => b.line <= i).at(-1);
	for (const b of eB)
		if (!G.has(b.line))
			mm.push({
				section: s.id,
				line: b.line,
				kind: "missed",
				text: text(b.line),
				expected: fmt(b),
				got: `joined ${fmt(blockAt(got, b.line))} above`,
			});
	for (const b of gB)
		if (!E.has(b.line))
			mm.push({
				section: s.id,
				line: b.line,
				kind: "spurious",
				text: text(b.line),
				expected: `continues ${fmt(blockAt(exp, b.line))}`,
				got: fmt(b),
			});
	for (const b of matched) {
		const e = E.get(b.line)!;
		if (e.role !== b.role)
			mm.push({
				section: s.id,
				line: b.line,
				kind: "role",
				text: text(b.line),
				expected: fmt(e),
				got: fmt(b),
			});
		else if (e.depth !== b.depth)
			mm.push({
				section: s.id,
				line: b.line,
				kind: "depth",
				text: text(b.line),
				expected: fmt(e),
				got: fmt(b),
			});
	}
	return {
		tp,
		nExp: eB.length,
		nGot: gB.length,
		matched: matched.length,
		roleOk,
		depthOk,
		mm,
	};
}

type Tally = {
	tp: number;
	nExp: number;
	nGot: number;
	matched: number;
	roleOk: number;
	depthOk: number;
};
const metrics = (t: Tally) => {
	const p = pct(t.tp, t.nGot);
	const r = pct(t.tp, t.nExp);
	return {
		precision: p,
		recall: r,
		f1: f1(p || 0, r || 0),
		role: pct(t.roleOk, t.matched),
		depth: pct(t.depthOk, t.matched),
	};
};
const add = (a: Tally, b: Tally): Tally => ({
	tp: a.tp + b.tp,
	nExp: a.nExp + b.nExp,
	nGot: a.nGot + b.nGot,
	matched: a.matched + b.matched,
	roleOk: a.roleOk + b.roleOk,
	depthOk: a.depthOk + b.depthOk,
});
const zero: Tally = { tp: 0, nExp: 0, nGot: 0, matched: 0, roleOk: 0, depthOk: 0 };
const p2 = (x: number) => (Number.isNaN(x) ? "  -  " : x.toFixed(3));

console.log(
	`segments: ${sections.length} sections, ${sections.reduce((n, s) => n + s.lines.length, 0)} lines, ${sections.reduce((n, s) => n + expectedOf(s).length, 0)} labelled blocks; model chain ${chain}, ${RUNS} run(s)`,
);
const runs: {
	ms: number;
	overall: ReturnType<typeof metrics> & { fallbacks: number };
	sections: {
		id: string;
		failed: boolean;
		blocks: Block[] | null;
		metrics: ReturnType<typeof metrics> | null;
	}[];
	mismatches: Mismatch[];
}[] = [];
for (let r = 0; r < RUNS; r++) {
	const t0 = Date.now();
	const got = await run();
	let total = zero;
	const rows: (typeof runs)[number]["sections"] = [];
	const mismatches: Mismatch[] = [];
	for (const s of sections) {
		const g = got.get(s.id) ?? null;
		if (!g) {
			rows.push({ id: s.id, failed: true, blocks: null, metrics: null });
			continue;
		}
		const sc = score(s, g);
		total = add(total, sc);
		mismatches.push(...sc.mm);
		rows.push({ id: s.id, failed: false, blocks: g, metrics: metrics(sc) });
	}
	const overall = {
		...metrics(total),
		fallbacks: rows.filter((x) => x.failed).length,
	};
	runs.push({ ms: Date.now() - t0, overall, sections: rows, mismatches });
	console.log(
		`run ${r + 1}: P ${p2(overall.precision)} R ${p2(overall.recall)} F1 ${p2(overall.f1)} | role ${p2(overall.role)} depth ${p2(overall.depth)} | fallbacks ${overall.fallbacks} | ${((Date.now() - t0) / 1000).toFixed(0)}s`,
	);
}

// Per section: F1 / role / depth for each run.
console.log(
	`\n${"section".padEnd(28)} ${"lines".padStart(5)} ${"blocks".padStart(6)}  ${runs.map((_, i) => `run${i + 1} F1/role/depth`.padEnd(20)).join(" ")}`,
);
for (const s of sections) {
	const cells = runs.map((r) => {
		const m = r.sections.find((x) => x.id === s.id)!.metrics;
		return (m ? `${p2(m.f1)}/${p2(m.role)}/${p2(m.depth)}` : "fallback").padEnd(20);
	});
	console.log(
		`${s.id.padEnd(28)} ${String(s.lines.length).padStart(5)} ${String(expectedOf(s).length).padStart(6)}  ${cells.join(" ")}`,
	);
}

// Variance: mean ± sd of the overall numbers, and how often two runs agree on a line's start/role/depth.
if (RUNS > 1) {
	const stat = (k: "f1" | "role" | "depth") => {
		const xs = runs.map((r) => r.overall[k]);
		const m = xs.reduce((a, b) => a + b, 0) / xs.length;
		const sd = Math.sqrt(
			xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1),
		);
		return `${k} ${m.toFixed(3)} ± ${sd.toFixed(3)}`;
	};
	let same = 0;
	let n = 0;
	for (const s of sections)
		for (let a = 0; a < RUNS; a++)
			for (let b = a + 1; b < RUNS; b++) {
				const A = runs[a].sections.find((x) => x.id === s.id)!.blocks;
				const B = runs[b].sections.find((x) => x.id === s.id)!.blocks;
				if (!A || !B) continue;
				const key = (bs: Block[]) => new Map(bs.map((x) => [x.line, fmt(x)]));
				const ka = key(A);
				const kb = key(B);
				for (let i = 0; i < s.lines.length; i++, n++)
					if (ka.get(i) === kb.get(i)) same++;
			}
	console.log(
		`\nacross runs: ${stat("f1")}, ${stat("role")}, ${stat("depth")}; line-level run agreement ${p2(pct(same, n))}`,
	);
}

// Mismatches, ranked by how many runs repeat them.
const seen = new Map<string, Mismatch & { runs: number }>();
for (const r of runs)
	for (const m of r.mismatches) {
		const k = `${m.section}:${m.line}:${m.kind}:${m.got}`;
		const prev = seen.get(k);
		if (prev) prev.runs++;
		else seen.set(k, { ...m, runs: 1 });
	}
const order = { missed: 0, spurious: 1, role: 2, depth: 3 };
const ranked = [...seen.values()].sort(
	(a, b) => b.runs - a.runs || order[a.kind] - order[b.kind],
);
const counts = Object.fromEntries(
	Object.keys(order).map((k) => [
		k,
		runs.map((r) => r.mismatches.filter((m) => m.kind === k).length),
	]),
);
console.log(
	`\nmismatches per run: ${Object.entries(counts)
		.map(([k, v]) => `${k} ${v.join("/")}`)
		.join(", ")}`,
);
console.log(`worst (recurring first):`);
for (const m of ranked.slice(0, 25))
	console.log(
		`  ${m.runs}/${RUNS} ${m.kind.padEnd(8)} ${m.section} L${m.line}: "${m.text.slice(0, 70)}"  expected ${m.expected}, got ${m.got}`,
	);

writeFileSync(
	join(EVAL, "segments-report.json"),
	JSON.stringify(
		{
			at: new Date().toISOString(),
			chain,
			runs: RUNS,
			sections: sections.map((s) => s.id),
			results: runs,
			mismatches: ranked,
		},
		null,
		"\t",
	),
);
console.log(`\nwrote store/eval/segments-report.json`);
