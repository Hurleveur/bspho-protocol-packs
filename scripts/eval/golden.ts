/**
 * Golden-dataset scorer: runs the organisers' UC1 questions (Q1-Q7) through the app's two Q&A
 * paths (per-protocol agent, cross-protocol Ask) and scores mode, protocols, pages, key-fact
 * recall (Gemini 3.1 Pro judge) and citation faithfulness (numbers in the answer vs the cited text).
 * Q8-Q9 (Dutch patient folder) are not scorable and are skipped.
 *
 *   bun scripts/eval/golden.ts            reuse cached app runs / facts / verdicts
 *   bun scripts/eval/golden.ts --fresh    re-run the app paths (facts stay cached)
 *
 * Writes store/eval/golden.{json,md}; caches golden-facts.json, golden-runs.json, golden-judge.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { createVertex } from "../../packages/protocol/node_modules/@ai-sdk/google-vertex";
import { generateText, Output } from "../../packages/protocol/node_modules/ai";
import { z } from "../../packages/protocol/node_modules/zod";
import { answer, corpus } from "@bspho/protocol/agent";
import { ask } from "@bspho/protocol/ask";
import type { ProtocolSpec } from "@bspho/protocol/spec";
import { store } from "@bspho/protocol/store";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(store.root, "eval");
mkdirSync(OUT, { recursive: true });
const FRESH = process.argv.includes("--fresh");
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "qwiklabs-gcp-01-ce74ae98024d";
const PRO = { location: "global", model: "gemini-3.1-pro-preview" };

// ---------------------------------------------------------------- golden data

interface Golden {
	q: number;
	scope: string;
	question: string;
	detailed: string;
	short: string;
}

function readGolden(): Golden[] {
	const wb = XLSX.readFile(
		join(ROOT, "data", "SwG-UC1-Golden Dataset and mapping table.xlsx"),
	);
	const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], {
		header: 1,
	});
	return rows
		.slice(1)
		.filter((r) => r?.[1])
		.map((r, i) => ({
			q: i + 1,
			scope: r[0],
			question: String(r[1])
				.trim()
				.replace(/^[“"]|[”"]$/g, ""),
			detailed: String(r[2] ?? ""),
			short: String(r[3] ?? ""),
		}));
}

/** Per question: expected mode, expected protocols, and the runs to make (first = primary). */
const PLAN: Record<
	number,
	{
		mode: "answer" | "refuse";
		protocols: string[];
		runs: { path: "agent" | "ask"; protocol?: string; note?: string }[];
	}
> = {
	1: {
		mode: "answer",
		protocols: ["beacon2", "hrnbl2"],
		runs: [
			{ path: "ask" },
			{ path: "agent", protocol: "beacon2" },
			{ path: "agent", protocol: "hrnbl2" },
		],
	},
	2: {
		mode: "answer",
		protocols: ["hrnbl2"],
		runs: [
			{ path: "agent", protocol: "hrnbl2" },
			{
				path: "agent",
				protocol: "lines",
				note: "exploratory: a non-stage-M MYCN-non-amp case belongs in LINES; scored against the HR-NBL2 key",
			},
		],
	},
	3: {
		mode: "answer",
		protocols: ["far-rms"],
		runs: [{ path: "agent", protocol: "far-rms" }],
	},
	4: {
		mode: "answer",
		protocols: ["chip-aml22", "alltogether1"],
		runs: [
			{ path: "ask" },
			{ path: "agent", protocol: "chip-aml22" },
			{ path: "agent", protocol: "alltogether1" },
		],
	},
	5: { mode: "refuse", protocols: [], runs: [{ path: "ask" }] },
	6: { mode: "refuse", protocols: [], runs: [{ path: "ask" }] },
	7: {
		mode: "answer",
		protocols: ["alltogether1"],
		runs: [{ path: "agent", protocol: "alltogether1" }],
	},
};

// ---------------------------------------------------------------- gemini pro

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const readCache = <T>(f: string): Record<string, T> =>
	existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), "utf8")) : {};
const writeCache = (f: string, v: unknown) =>
	writeFileSync(join(OUT, f), JSON.stringify(v, null, 1));

async function pro<T>(
	schema: z.ZodType<T>,
	prompt: string,
	thinkingLevel: "low" | "medium" | "high",
): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const vertex = createVertex({ project: PROJECT, location: PRO.location });
			const r = await generateText({
				model: vertex(PRO.model),
				output: Output.object({ schema }),
				prompt,
				temperature: 0,
				providerOptions: { vertex: { thinkingConfig: { thinkingLevel } } },
			});
			return r.output;
		} catch (e) {
			last = e;
			console.warn(
				`  [pro] attempt ${attempt + 1} failed: ${(e as Error).message?.slice(0, 120)}`,
			);
			await Bun.sleep(5000 * (attempt + 1));
		}
	}
	throw last;
}

const Facts = z.object({
	facts: z
		.array(
			z.object({
				id: z.string().describe("F1, F2, ..."),
				fact: z
					.string()
					.describe(
						"One atomic, checkable clinical statement, with its exact numbers/thresholds",
					),
				protocol: z
					.string()
					.describe("protocol id the fact is about (from the list)"),
				pages: z
					.array(z.number().int())
					.describe(
						"pages the oncologist cites for this fact; empty if none",
					),
			}),
		)
		.describe("5-10 facts, the most clinically important first"),
});
type Fact = z.infer<typeof Facts>["facts"][number];

async function facts(g: Golden, protocols: string[]): Promise<Fact[]> {
	const cache = readCache<Fact[]>("golden-facts.json");
	const key = `Q${g.q}`;
	if (cache[key]) return cache[key];
	console.log(`  extracting key facts for Q${g.q} (gemini 3.1 pro)`);
	const out = await pro(
		Facts,
		`You build an answer key. Below is a paediatric oncologist's reference answer to a clinician question about trial protocols. Extract 5-10 ATOMIC key facts a correct answer must contain (one claim each, keep exact numbers, thresholds and units; prefer facts with page citations; prefer what a clinician would act on). Attribute each to one protocol id from: ${protocols.join(", ")}. Give the page numbers the oncologist cites for that fact (parse "pp. 13 and 37", "p. 14", "pp. 87-88" = 87,88).\n\nQUESTION: ${g.question}\n\nREFERENCE ANSWER:\n${g.detailed}`,
		"high",
	);
	cache[key] = out.facts;
	writeCache("golden-facts.json", cache);
	return out.facts;
}

const Verdicts = z.object({
	verdicts: z.array(
		z.object({
			id: z.string(),
			verdict: z.enum(["supported", "contradicted", "missing"]),
			passages: z
				.array(z.string())
				.describe(
					"ids of the cited passages that state the fact (empty if none)",
				),
			note: z
				.string()
				.describe(
					"For contradicted: quote the app's conflicting statement verbatim. Otherwise one short phrase.",
				),
		}),
	),
});
type Verdict = z.infer<typeof Verdicts>["verdicts"][number];

async function judge(
	question: string,
	fs: Fact[],
	text: string,
	passages: CitedPassage[],
): Promise<Verdict[]> {
	if (!fs.length) return [];
	const pas = passages
		.slice(0, 80)
		.map((p) => `[${p.id}] ${p.protocolId} p.${p.page}: ${p.text.slice(0, 1500)}`)
		.join("\n");
	const prompt = `You grade a protocol assistant's answer against an answer key. For EACH key fact decide:
- supported: the app's answer states it (same meaning; numbers must match; paraphrase is fine).
- contradicted: the app's answer states something incompatible (different threshold, wrong protocol/arm, opposite recommendation).
- missing: the answer does not state it.
Judge the ANSWER text; the cited passages are given so you can tell which passage ids carry a fact (list them) and understand abbreviations. A fact present only in a passage but not in the answer is "missing".

QUESTION: ${question}

KEY FACTS:
${fs.map((f) => `${f.id} [${f.protocol}] ${f.fact}`).join("\n")}

APP ANSWER:
${text}

CITED PASSAGES (verbatim protocol text):
${pas || "(none)"}`;
	const key = hash(prompt);
	const cache = readCache<Verdict[]>("golden-judge.json");
	if (cache[key]) return cache[key];
	const out = await pro(Verdicts, prompt, "medium");
	cache[key] = out.verdicts;
	writeCache("golden-judge.json", cache);
	return out.verdicts;
}

const Diagnosis = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			inSpecText: z
				.enum(["yes", "partly", "no"])
				.describe("Does the protocol text below state this fact?"),
			passageIds: z.array(z.string()).describe("block ids stating it"),
			note: z
				.string()
				.describe(
					"If no: likely why (e.g. the page shows only an image-only table marker, text garbled/flattened, page not present, protocol version differs)",
				),
		}),
	),
});
type Diag = z.infer<typeof Diagnosis>["items"][number];

/** For facts the app missed: is the fact in our extracted spec text near the expected pages? */
async function diagnose(spec: ProtocolSpec, fs: Fact[]): Promise<Diag[]> {
	if (!fs.length) return [];
	const pages = new Set(
		fs.flatMap((f) =>
			f.pages.flatMap((p) => [p - 3, p - 2, p - 1, p, p + 1, p + 2, p + 3]),
		),
	);
	const lines: string[] = [];
	for (const n of spec.nodes) {
		for (const [j, a] of n.blocks.entries())
			if (!pages.size || pages.has(a.page))
				lines.push(`[${n.id}.b${j} p${a.page}] ${a.text}`);
		for (const f of n.figures ?? [])
			if (!pages.size || pages.has(f.page))
				lines.push(
					`(p${f.page}: IMAGE-ONLY figure/table${f.caption ? `, caption: ${f.caption.text}` : ", no text"})`,
				);
	}
	let text = lines.join("\n");
	if (!pages.size || text.length < 200)
		text = spec.nodes
			.flatMap((n) =>
				n.blocks.map((a, j) => `[${n.id}.b${j} p${a.page}] ${a.text}`),
			)
			.join("\n");
	text = text.slice(0, 600_000);
	const prompt = `Below is the extracted text of protocol ${spec.doc.id} v${spec.doc.version} (${pages.size ? "pages near the expected ones" : "whole document"}). For each fact decide whether this text states it.\n\nFACTS:\n${fs.map((f) => `${f.id} (expected pp. ${f.pages.join(",") || "?"}) ${f.fact}`).join("\n")}\n\nPROTOCOL TEXT:\n${text}`;
	const key = hash(prompt);
	const cache = readCache<Diag[]>("golden-judge.json");
	if (cache[key]) return cache[key];
	const out = await pro(Diagnosis, prompt, "low");
	cache[key] = out.items;
	writeCache("golden-judge.json", cache as never);
	return out.items;
}

// ---------------------------------------------------------------- app runs

interface CitedPassage {
	id: string;
	protocolId: string;
	page: number;
	text: string;
}
interface AppRun {
	key: string;
	path: "agent" | "ask";
	protocol?: string;
	mode: "answer" | "clarify" | "refuse";
	text: string;
	passages: CitedPassage[];
	model: string;
	latencyMs: number;
	error?: string;
}

const registry = await store.registry();
const overlay = await store.overlay();

async function runAgent(
	protocolId: string,
	question: string,
): Promise<Omit<AppRun, "key">> {
	const entry = registry.protocols.find((p) => p.id === protocolId);
	const spec = entry ? await store.publishedSpec(entry.id) : null;
	if (!entry || !spec) throw new Error(`unknown protocol ${protocolId}`);
	const subs = await Promise.all(
		registry.protocols
			.filter((p) => p.parentId === protocolId && p.kind === "subprotocol")
			.map(async (p) => ({
				spec: await store.publishedSpec(p.id),
				name: p.short,
			})),
	);
	const c = corpus(
		{ spec, name: entry.short },
		subs.filter((s): s is { spec: ProtocolSpec; name: string } => !!s.spec),
	);
	const t0 = Date.now();
	const stream = answer(c, [{ role: "user", content: question }], undefined);
	let raw = "";
	const dec = new TextDecoder();
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
		raw += dec.decode(chunk, { stream: true });
	const latencyMs = Date.now() - t0;
	const [text, trailer] = raw.split("\u001e");
	const t = JSON.parse(trailer ?? "{}") as {
		model: string;
		passages: { id: string; protocolId: string; page: number; text: string }[];
		error?: boolean;
	};
	const refused =
		/does not cover this|I can only answer from/i.test(text) && text.length < 400;
	return {
		path: "agent",
		protocol: protocolId,
		mode: refused ? "refuse" : "answer",
		text,
		passages: t.passages.map((p) => ({
			id: p.id,
			protocolId: p.protocolId,
			page: p.page,
			text: p.text,
		})),
		model: t.model,
		latencyMs,
		error: t.error ? "agent busy (both models failed)" : undefined,
	};
}

async function runAsk(question: string): Promise<Omit<AppRun, "key">> {
	const runs = new Set(
		overlay.participation
			.filter((p) => p.hospital === "UZG" && p.participating)
			.map((p) => p.protocolId),
	);
	const entries = registry.protocols.filter((p) => p.published && runs.has(p.id));
	const specs = await Promise.all(entries.map((p) => store.spec(p.id, p.published!)));
	const names = Object.fromEntries(entries.map((p) => [p.id, p.short]));
	const t0 = Date.now();
	const r = await ask(question, specs, names);
	const latencyMs = Date.now() - t0;
	const passages = new Map<string, CitedPassage>();
	for (const pt of r.points)
		for (const c of pt.cites)
			passages.set(
				`${c.protocolId}:${c.anchor.page}:${c.anchor.text.slice(0, 30)}`,
				{
					id: c.id,
					protocolId: c.protocolId,
					page: c.anchor.page,
					text: c.anchor.text,
				},
			);
	const text = [
		r.summary,
		...r.points.map(
			(p) =>
				`- [${p.protocol}] ${p.text} ${p.cites.map((c) => `[${c.id}]`).join(" ")}`,
		),
		...(r.clarifyingQuestion ? [`Clarify: ${r.clarifyingQuestion}`] : []),
		...(r.notCovered.length ? [`Not covered: ${r.notCovered.join("; ")}`] : []),
	].join("\n");
	return {
		path: "ask",
		mode: r.mode,
		text,
		passages: [...passages.values()],
		model: r.model,
		latencyMs,
	};
}

// ---------------------------------------------------------------- scoring helpers

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** Numbers as comparable strings: "3,000" → 3000, "150 000" → 150000, "0,5" → 0.5; drops 10⁹/10^9 exponents. */
function numbers(s: string): string[] {
	const t = s
		.replace(/\[[^\]]*\]/g, " ") // citation ids
		.replace(/10\s*(?:\^|⁹|\*\*)\s*9?/g, " ")
		.replace(new RegExp(`[${SUP}]+`, "g"), " ")
		.replace(/(\d)[  ](?=\d{3}\b)/g, "$1")
		.replace(/(\d),(?=\d{3}\b)/g, "$1")
		.replace(/(\d),(?=\d)/g, "$1.");
	return [...new Set(t.match(/\d+(?:\.\d+)?/g) ?? [])].map((n) =>
		n.replace(/\.0+$/, ""),
	);
}

function faithfulness(text: string, passages: CitedPassage[], question: string) {
	const have = new Set(numbers(passages.map((p) => p.text).join(" ")));
	const q = new Set(numbers(question));
	const nums = numbers(text).filter((n) => !q.has(n));
	const unsupported = nums.filter((n) => !have.has(n));
	return {
		total: nums.length,
		supported: nums.length - unsupported.length,
		unsupported,
	};
}

const DRIFT_NOTE: Record<string, string> = {
	beacon2:
		"answer key cites BEACON2 pp. 13, 37; criteria are on our PDF pp. 16, 40, 43",
	alltogether1: "answer key cites ALLTogether1 v6.2; we have v6.0",
};

// ---------------------------------------------------------------- main

const golden = readGolden();
console.log(
	`golden dataset: ${golden.length} questions; scoring Q1-Q7, skipping ${golden
		.filter((g) => g.q > 7)
		.map((g) => `Q${g.q}`)
		.join(", ")} (Dutch patient folder, no golden answer)`,
);
const runCache = readCache<AppRun>("golden-runs.json");
const specCache = new Map<string, ProtocolSpec>();
const specOf = async (id: string) => {
	if (!specCache.has(id)) {
		const s = await store.publishedSpec(id);
		if (s) specCache.set(id, s);
	}
	return specCache.get(id);
};

interface Scored {
	q: number;
	question: string;
	primary: boolean;
	path: string;
	protocol?: string;
	note?: string;
	run: AppRun;
	modeOk: boolean;
	expectedProtocols: string[];
	citedProtocols: string[];
	protocolsHit: string[];
	pages: {
		protocol: string;
		page: number;
		hit: "exact" | "near" | "fact" | "miss";
		via?: number;
	}[];
	facts: (Fact & Verdict & { diag?: Diag })[];
	recall: { supported: number; total: number };
	contradictions: { id: string; fact: string; note: string }[];
	faithfulness: ReturnType<typeof faithfulness>;
	drift: string[];
}
const results: Scored[] = [];

for (const g of golden.filter((x) => x.q <= 7)) {
	const plan = PLAN[g.q];
	console.log(`\nQ${g.q} ${g.question.slice(0, 90)}`);
	const allFacts = plan.mode === "answer" ? await facts(g, plan.protocols) : [];
	for (const f of allFacts)
		console.log(`  ${f.id} [${f.protocol} pp.${f.pages.join(",")}] ${f.fact}`);
	for (const [ri, r] of plan.runs.entries()) {
		const key = `Q${g.q}:${r.path}:${r.protocol ?? "UZG"}`;
		let run = FRESH ? undefined : runCache[key];
		if (!run) {
			console.log(`  running ${key}`);
			try {
				run = {
					key,
					...(r.path === "agent"
						? await runAgent(r.protocol!, g.question)
						: await runAsk(g.question)),
				};
			} catch (e) {
				run = {
					key,
					path: r.path,
					protocol: r.protocol,
					mode: "answer",
					text: "",
					passages: [],
					model: "",
					latencyMs: 0,
					error: (e as Error).message,
				};
			}
			runCache[key] = run;
			writeCache("golden-runs.json", runCache);
		}
		console.log(
			`  ${key}: mode=${run.mode} ${run.latencyMs}ms cites=${run.passages.length}${run.error ? ` ERROR ${run.error}` : ""}`,
		);
		// agent on one protocol is scored against that protocol's facts only (except the exploratory LINES run)
		const scope =
			r.path === "agent" && plan.protocols.includes(r.protocol!)
				? [r.protocol!]
				: plan.protocols;
		const fs = allFacts.filter((f) => scope.includes(f.protocol));
		const verdicts =
			run.mode === "answer" && run.text
				? await judge(g.question, fs, run.text, run.passages)
				: fs.map((f) => ({
						id: f.id,
						verdict: "missing" as const,
						passages: [],
						note: "no answer",
					}));
		const vById = new Map(verdicts.map((v) => [v.id, v]));
		const scoredFacts = fs.map((f) => ({
			...f,
			...(vById.get(f.id) ?? {
				id: f.id,
				verdict: "missing" as const,
				passages: [],
				note: "not judged",
			}),
		}));
		// why each missed fact was missed
		for (const p of scope) {
			const missed = scoredFacts.filter(
				(f) => f.protocol === p && f.verdict !== "supported",
			);
			const spec = await specOf(p);
			if (!missed.length || !spec) continue;
			const d = await diagnose(spec, missed);
			for (const x of d) {
				const f = scoredFacts.find((y) => y.id === x.id);
				if (f) (f as { diag?: Diag }).diag = x;
			}
		}
		const citedProtocols = [...new Set(run.passages.map((p) => p.protocolId))];
		const passageById = new Map(run.passages.map((p) => [p.id, p]));
		const expectedPages = [
			...new Map(
				fs.flatMap((f) =>
					f.pages.map((pg) => [
						`${f.protocol}:${pg}`,
						{ protocol: f.protocol, page: pg },
					]),
				),
			).values(),
		];
		const pages = expectedPages.map(({ protocol, page }) => {
			const mine = run.passages.filter((p) => p.protocolId === protocol);
			const exact = mine.find((p) => p.page === page);
			if (exact) return { protocol, page, hit: "exact" as const, via: page };
			const near = mine
				.filter((p) => Math.abs(p.page - page) <= 3)
				.sort((a, b) => Math.abs(a.page - page) - Math.abs(b.page - page))[0];
			if (near) return { protocol, page, hit: "near" as const, via: near.page };
			// drift rule: a supported fact citing this page, carried by a passage of the right protocol, counts
			const viaFact = scoredFacts
				.filter(
					(f) =>
						f.protocol === protocol &&
						f.pages.includes(page) &&
						f.verdict === "supported",
				)
				.flatMap((f) => f.passages.map((id) => passageById.get(id)))
				.find((p) => p?.protocolId === protocol);
			if (viaFact)
				return { protocol, page, hit: "fact" as const, via: viaFact.page };
			return { protocol, page, hit: "miss" as const };
		});
		const drift = [
			...pages
				.filter((p) => p.hit === "near" || p.hit === "fact")
				.map((p) => `${p.protocol} p.${p.page} → our p.${p.via} (${p.hit})`),
			...scope.filter((p) => DRIFT_NOTE[p]).map((p) => DRIFT_NOTE[p]),
		];
		const expectedProtocols = r.path === "agent" ? scope : plan.protocols;
		results.push({
			q: g.q,
			question: g.question,
			primary: ri === 0,
			path: r.path === "agent" ? `agent:${r.protocol}` : "ask:UZG",
			protocol: r.protocol,
			note: r.note,
			run,
			modeOk: run.mode === plan.mode && !run.error,
			expectedProtocols,
			citedProtocols,
			protocolsHit: expectedProtocols.filter((p) => citedProtocols.includes(p)),
			pages,
			facts: scoredFacts,
			recall: {
				supported: scoredFacts.filter((f) => f.verdict === "supported").length,
				total: scoredFacts.length,
			},
			contradictions: scoredFacts
				.filter((f) => f.verdict === "contradicted")
				.map((f) => ({ id: f.id, fact: f.fact, note: f.note })),
			faithfulness: faithfulness(run.text, run.passages, g.question),
			drift,
		});
	}
}

// ---------------------------------------------------------------- report

const frac = (a: number, b: number) => (b ? a / b : 1);
function score(s: Scored): number {
	if (!s.expectedProtocols.length) return s.modeOk ? 1 : 0;
	const parts = [
		s.modeOk ? 1 : 0,
		frac(s.protocolsHit.length, s.expectedProtocols.length),
		frac(s.pages.filter((p) => p.hit !== "miss").length, s.pages.length),
		frac(s.recall.supported, s.recall.total),
	];
	return parts.reduce((a, b) => a + b, 0) / parts.length;
}
const primaries = results.filter((r) => r.primary);
const overall = primaries.reduce((a, r) => a + score(r), 0) / primaries.length;
const tot = (rs: Scored[]) => ({
	modeOk: rs.filter((r) => r.modeOk).length,
	n: rs.length,
	facts: `${rs.reduce((a, r) => a + r.recall.supported, 0)}/${rs.reduce((a, r) => a + r.recall.total, 0)}`,
	pages: `${rs.reduce((a, r) => a + r.pages.filter((p) => p.hit !== "miss").length, 0)}/${rs.reduce((a, r) => a + r.pages.length, 0)}`,
	contradictions: rs.reduce((a, r) => a + r.contradictions.length, 0),
	numbers: `${rs.reduce((a, r) => a + r.faithfulness.supported, 0)}/${rs.reduce((a, r) => a + r.faithfulness.total, 0)}`,
});

// failures: missed/contradicted facts on primary runs, ranked contradicted > missed-but-in-spec > absent
const reason = (r: Scored, f: Scored["facts"][number]) => {
	if (f.verdict === "contradicted") return `CONTRADICTED: ${f.note}`;
	const d = f.diag;
	if (!d) return "not diagnosed";
	if (d.inSpecText === "no")
		return `fact absent from our spec text near pp. ${f.pages.join(",")}: ${d.note}`;
	const where = d.passageIds.length
		? ` (spec has it: ${d.passageIds.slice(0, 3).join(", ")})`
		: "";
	return r.run.path === "ask"
		? `in spec text${where} but Ask did not surface it (keyword retrieval missed it or answer dropped it)`
		: `in spec text${where} and in the agent's context, but the agent did not state it`;
};
const failures = primaries
	.flatMap((r) =>
		r.facts
			.filter((f) => f.verdict !== "supported")
			.map((f) => ({
				r,
				f,
				w:
					f.verdict === "contradicted"
						? 3
						: f.diag?.inSpecText === "no"
							? 1
							: 2,
			})),
	)
	.concat(
		primaries
			.filter((r) => !r.modeOk)
			.map((r) => ({
				r,
				f: {
					id: "mode",
					fact: `mode should be ${PLAN[r.q].mode}, got ${r.run.mode}`,
					verdict: "contradicted",
				} as never,
				w: 4,
			})),
	)
	.sort((a, b) => b.w - a.w || a.r.q - b.r.q)
	.slice(0, 5);

const md: string[] = [
	"# Golden dataset (UC1) score",
	"",
	`Generated ${new Date().toISOString()} by \`bun scripts/eval/golden.ts\`. Hospital for Ask: UZG. Judge: ${PRO.model}.`,
	"",
	`**Overall score (primary run per question, mean of mode / protocols / pages / fact recall): ${(overall * 100).toFixed(0)}%**`,
	"",
	"Q8-Q9 (Dutch patient folder for FaR-RMS) are not scored: no golden answer, generative task.",
	"",
	"| | mode ok | facts supported | expected pages hit | contradictions | numbers in cited text |",
	"|---|---|---|---|---|---|",
	...(["primary", "all runs"] as const).map((k) => {
		const t = tot(k === "primary" ? primaries : results);
		return `| ${k} | ${t.modeOk}/${t.n} | ${t.facts} | ${t.pages} | ${t.contradictions} | ${t.numbers} |`;
	}),
	"",
	"Page hits: exact, `near` (within ±3 pages), or `fact` (a supported fact citing that page is carried by a passage of that protocol). Drift is listed separately.",
	"",
	"## Top failures",
	"",
	...failures.map(
		({ r, f }, i) =>
			`${i + 1}. **Q${r.q} ${r.path}** ${f.id}: ${f.fact}  \n   Reason: ${f.id === "mode" ? "wrong mode" : reason(r, f)}`,
	),
	"",
];
for (const g of golden.filter((x) => x.q <= 7)) {
	const rs = results.filter((r) => r.q === g.q);
	md.push(
		`## Q${g.q}. ${g.question}`,
		"",
		"| path | mode ok | protocols | page hits | fact recall | contradictions | numbers faithful | latency | score |",
		"|---|---|---|---|---|---|---|---|---|",
	);
	for (const r of rs) {
		const ph = r.pages.length
			? `${r.pages.filter((p) => p.hit !== "miss").length}/${r.pages.length} (${r.pages.map((p) => `${p.page}:${p.hit}`).join(" ")})`
			: "n/a";
		md.push(
			`| ${r.path}${r.primary ? " (primary)" : ""} | ${r.modeOk ? "yes" : `no (${r.run.mode}${r.run.error ? `, ${r.run.error}` : ""})`} | ${r.expectedProtocols.length ? `${r.protocolsHit.length}/${r.expectedProtocols.length} (cited: ${r.citedProtocols.join(", ") || "none"})` : `cited: ${r.citedProtocols.join(", ") || "none"}`} | ${ph} | ${r.recall.total ? `${r.recall.supported}/${r.recall.total}` : "n/a"} | ${r.contradictions.length} | ${r.faithfulness.supported}/${r.faithfulness.total}${r.faithfulness.unsupported.length ? ` (not in cites: ${r.faithfulness.unsupported.slice(0, 8).join(", ")})` : ""} | ${(r.run.latencyMs / 1000).toFixed(1)}s | ${(score(r) * 100).toFixed(0)}% |`,
		);
	}
	md.push("");
	for (const r of rs) {
		if (r.note) md.push(`*${r.path}: ${r.note}*`, "");
		if (r.contradictions.length)
			md.push(
				`**Contradictions (${r.path}):**`,
				...r.contradictions.map(
					(c) => `- ${c.id} ${c.fact}  \n  app: ${c.note}`,
				),
				"",
			);
		if (r.drift.length) md.push(`Drift (${r.path}): ${r.drift.join("; ")}`, "");
		if (r.facts.length) {
			md.push(`<details><summary>Facts (${r.path})</summary>`, "");
			for (const f of r.facts)
				md.push(
					`- ${f.verdict === "supported" ? "OK" : f.verdict.toUpperCase()} ${f.id} [${f.protocol} pp.${f.pages.join(",")}] ${f.fact}${f.verdict !== "supported" ? `  \n  why: ${reason(r, f)}` : ""}`,
				);
			md.push("", "</details>", "");
		}
		md.push(
			`<details><summary>Answer (${r.path}, ${r.run.model})</summary>`,
			"",
			"```",
			r.run.text.trim(),
			"```",
			"",
			"</details>",
			"",
		);
	}
}
writeFileSync(join(OUT, "golden.md"), md.join("\n"));
writeFileSync(
	join(OUT, "golden.json"),
	JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			overall,
			totals: { primary: tot(primaries), all: tot(results) },
			results: results.map((r) => ({ ...r, score: score(r) })),
		},
		null,
		1,
	),
);
console.log(
	`\noverall ${(overall * 100).toFixed(0)}%  primary ${JSON.stringify(tot(primaries))}  all ${JSON.stringify(tot(results))}`,
);
console.log(`wrote ${join(OUT, "golden.md")}`);
