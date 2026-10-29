/**
 * Extraction-quality eval: deterministic checks on every published protocol + an LLM-vision judge
 * on a sample of sections. Writes store/eval/report.json and report.md; the previous report is kept
 * as report.prev.json and the per-class delta is printed, so a pipeline fix shows up as a number.
 *
 *   bun scripts/eval/run.ts                 all protocols, checks + judge
 *   bun scripts/eval/run.ts --no-judge      checks only (~15 s)
 *   bun scripts/eval/run.ts alltogether1    some protocols
 *   JUDGE_K=3 JUDGE_CONCURRENCY=2
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Issue, load, registry, runChecks, STORE } from "./checks.ts";
import { judgeAll, judgeIssues, type JudgeResult } from "./judge.ts";

const args = process.argv.slice(2);
const noJudge = args.includes("--no-judge");
const ids = args.filter((a) => !a.startsWith("--"));
const K = Number(process.env.JUDGE_K ?? 3);
const CONC = Number(process.env.JUDGE_CONCURRENCY ?? 2);
const OUT = join(STORE, "eval");
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const protos = registry().filter((p) => p.published && (!ids.length || ids.includes(p.id)));
const checkIssues: Issue[] = [];
const stats: Record<string, Record<string, number>> = {};
const flagged = new Map<string, Issue[]>();
for (const p of protos) {
	const L = load(p.id);
	if (!L) continue;
	const r = runChecks(L);
	checkIssues.push(...r.issues);
	stats[p.id] = r.stats;
	flagged.set(p.id, r.issues);
}
const checksMs = Date.now() - t0;
console.log(`checks: ${checkIssues.length} issues over ${protos.length} protocols in ${(checksMs / 1000).toFixed(1)}s`);

let judged: JudgeResult[] = [];
if (!noJudge) {
	const t1 = Date.now();
	judged = await judgeAll(
		protos.map((p) => p.id),
		flagged,
		K,
		CONC,
	);
	console.log(`judge: ${judged.length} sections in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
}
const jIssues = judgeIssues(judged);
const totalMs = Date.now() - t0;

// ---------------------------------------------------------------- aggregate

const SEV = { high: 0, medium: 1, low: 2 } as const;
type Row = { class: string; count: number; high: number; protocols: string[]; examples: Issue[] };
function byClass(issues: Issue[]): Row[] {
	const m = new Map<string, Issue[]>();
	for (const i of issues) m.set(i.class, [...(m.get(i.class) ?? []), i]);
	return [...m]
		.map(([cls, xs]) => {
			// examples: high severity first, one per protocol before repeating
			const sorted = [...xs].sort((a, b) => SEV[a.severity] - SEV[b.severity]);
			const ex: Issue[] = [];
			const seen = new Set<string>();
			for (const i of sorted) if (!seen.has(i.protocol) && ex.length < 5) (ex.push(i), seen.add(i.protocol));
			for (const i of sorted) if (ex.length < 5 && !ex.includes(i)) ex.push(i);
			return { class: cls, count: xs.length, high: xs.filter((x) => x.severity === "high").length, protocols: [...new Set(xs.map((x) => x.protocol))], examples: ex };
		})
		.sort((a, b) => b.count - a.count);
}

const report = {
	generatedAt: new Date().toISOString(),
	runtimeMs: { checks: checksMs, total: totalMs },
	protocols: protos.map((p) => ({ id: p.id, short: p.short, sha: p.published })),
	judge: {
		k: K,
		sections: judged.length,
		ok: judged.filter((r) => !r.error && r.verdict === "ok").length,
		withIssues: judged.filter((r) => r.issues.length).length,
		errors: judged.filter((r) => r.error).length,
		models: [...new Set(judged.map((r) => r.model).filter(Boolean))],
	},
	counts: Object.fromEntries(byClass(checkIssues).map((r) => [r.class, r.count])),
	judgeCounts: Object.fromEntries(byClass(jIssues).map((r) => [r.class, r.count])),
	stats,
	issues: checkIssues,
	judged,
};

// ---------------------------------------------------------------- deltas

const jsonPath = join(OUT, "report.json");
const prevPath = join(OUT, "report.prev.json");
let prev: typeof report | null = null;
if (existsSync(jsonPath)) {
	copyFileSync(jsonPath, prevPath);
	prev = JSON.parse(readFileSync(prevPath, "utf8"));
}
writeFileSync(jsonPath, JSON.stringify(report, null, 1));

const delta = (cur: Record<string, number>, old: Record<string, number> | undefined) =>
	[...new Set([...Object.keys(cur), ...Object.keys(old ?? {})])]
		.sort()
		.map((c) => ({ c, now: cur[c] ?? 0, before: old?.[c] ?? 0 }))
		.filter((d) => d.now || d.before);

// ---------------------------------------------------------------- markdown

const esc = (s: string | null) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const md: string[] = [];
md.push(`# Extraction eval`, "", `${report.generatedAt} · ${protos.length} protocols · checks ${(checksMs / 1000).toFixed(1)}s · total ${(totalMs / 1000).toFixed(0)}s`, "");
if (prev) {
	md.push(`## Delta vs previous run (${prev.generatedAt})`, "", "| class | before | now | Δ |", "|---|---:|---:|---:|");
	for (const d of delta(report.counts, prev.counts)) md.push(`| ${d.c} | ${d.before} | ${d.now} | ${d.now - d.before > 0 ? "+" : ""}${d.now - d.before} |`);
	md.push("");
}
md.push("## Deterministic checks by class", "", "| class | count | high | protocols |", "|---|---:|---:|---:|");
const rows = byClass(checkIssues);
for (const r of rows) md.push(`| ${r.class} | ${r.count} | ${r.high} | ${r.protocols.length} |`);
md.push("");
for (const r of rows) {
	md.push(`### ${r.class} (${r.count})`, "");
	for (const e of r.examples) md.push(`- **${e.protocol}** p${e.page ?? "-"} ${e.title ? `"${esc(e.title).slice(0, 70)}"` : ""} [${e.severity}] ${esc(e.detail)}${e.sample ? `\n  > ${esc(e.sample).slice(0, 200)}` : ""}`);
	md.push("");
}
if (!noJudge) {
	md.push(
		"## Vision judge",
		"",
		`${report.judge.sections} sections judged (K=${K}/protocol), ${report.judge.ok} ok, ${report.judge.withIssues} with issues, ${report.judge.errors} errors · models: ${report.judge.models.join(", ")}`,
		"",
		"| class | count | high | protocols |",
		"|---|---:|---:|---:|",
	);
	const jr = byClass(jIssues);
	for (const r of jr) md.push(`| ${r.class} | ${r.count} | ${r.high} | ${r.protocols.length} |`);
	md.push("");
	for (const r of jr) {
		md.push(`### judge: ${r.class} (${r.count})`, "");
		for (const e of r.examples) md.push(`- **${e.protocol}** p${e.page} "${esc(e.title).slice(0, 70)}" [${e.severity}] ${esc(e.detail)}\n  > page: ${esc(e.sample)}`);
		md.push("");
	}
}
md.push("## Per protocol", "");
for (const p of protos) {
	const mine = checkIssues.filter((i) => i.protocol === p.id);
	const jm = judged.filter((r) => r.protocol === p.id);
	const c: Record<string, number> = {};
	for (const i of mine) c[i.class] = (c[i.class] ?? 0) + 1;
	const s = stats[p.id] ?? {};
	md.push(
		`### ${p.short} (${p.id})`,
		"",
		`checks: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
		s.diagItems ? `work-up lines: ${s.diagItems} (primary ${s.stage_primary ?? 0}, molecular ${s.stage_molecular ?? 0}, extent ${s.stage_extent ?? 0}, baseline ${s.stage_baseline ?? 0}, other ${s.stage_other ?? 0}); steps ${s.steps ?? 0}, without start requirements ${s.stepsMissingStart ?? 0}` : `no diagnosis work-up; steps ${s.steps ?? 0}, without start requirements ${s.stepsMissingStart ?? 0}`,
		"",
	);
	for (const i of mine.filter((x) => x.severity === "high").slice(0, 8)) md.push(`- [${i.class}] p${i.page} ${esc(i.detail)} — ${esc(i.sample).slice(0, 140)}`);
	for (const r of jm) {
		md.push(`- judge p${r.pages.join(",")} "${esc(r.title).slice(0, 60)}" (${r.kind}): ${r.error ? `error: ${esc(r.error).slice(0, 100)}` : r.verdict}`);
		for (const i of r.issues) md.push(`  - [${i.class}/${i.severity}] ${esc(i.description)} > ${esc(i.evidence).slice(0, 140)}`);
	}
	md.push("");
}
writeFileSync(join(OUT, "report.md"), md.join("\n"));

// ---------------------------------------------------------------- console

console.log("\nclass                    count  high  protos" + (prev ? "   Δprev" : ""));
const prevCounts = prev?.counts ?? {};
for (const d of delta(report.counts, prev ? prevCounts : undefined)) {
	const r = rows.find((x) => x.class === d.c);
	const dd = d.now - d.before;
	console.log(`${d.c.padEnd(24)} ${String(d.now).padStart(5)} ${String(r?.high ?? 0).padStart(5)} ${String(r?.protocols.length ?? 0).padStart(7)}` + (prev ? `   ${dd > 0 ? "+" : ""}${dd}` : ""));
}
if (!noJudge) {
	console.log(`\njudge: ${report.judge.withIssues}/${report.judge.sections} sections with issues`);
	for (const [k, v] of Object.entries(report.judgeCounts)) console.log(`  ${k.padEnd(22)} ${v}`);
}
console.log(`\nwrote ${join(OUT, "report.md")} (${(totalMs / 1000).toFixed(0)}s)`);
