/**
 * Summary pass: a short EN/FR/NL version of every verbatim line, plus translated node titles.
 *
 * The model writes the summaries; code checks every one of them against its original
 * (numbers, comparison signs, length) and drops what fails after one retry, so the UI
 * falls back to the verbatim text. `Anchor.text` is never touched.
 */
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { Anchor, Lang, Node, ProtocolSpec, Summaries } from "./spec.ts";
import { normalize, numbers } from "./verify.ts";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "qwiklabs-gcp-01-ce74ae98024d";
const LANGS: Lang[] = ["en", "fr", "nl"];

const MODELS =
	process.env.SUMMARY_MODEL === "flash"
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
	if (model.startsWith("gemini-3")) return { thinkingLevel: "low" };
	return { thinkingBudget: model.includes("pro") ? 1024 : 512 };
}

// --- Code checks -------------------------------------------------------------------------

const SIGN = /≥|≤|>=|<=|[<>]/g;

/** Comparison signs of a text, as a sorted unique list (">=" spelled "≥"). */
export function signs(s: string): string {
	const found = (s.normalize("NFKC").match(SIGN) ?? []).map((x) => (x === ">=" ? "≥" : x === "<=" ? "≤" : x));
	return [...new Set(found)].sort().join("");
}

/** Numbers of a text as a set of values ("0,5" and "0.5" are the same; "1,000" and "1 000" are 1000). */
export function numberSet(s: string): Set<string> {
	const t = normalize(s)
		// Thousands separators: "1,000" / "1.000" / "1 000" followed by exactly 3 digits and no further digit.
		.replace(/(?<![\d.,])(\d{1,3})(?:[ ,.  ](\d{3}))+(?![\d.,]?\d)/g, (m) => m.replace(/[ ,.  ]/g, ""));
	return new Set(numbers(t).map((n) => String(Number(n))));
}

export type Reject = "numbers" | "missing" | "signs" | "length" | "empty";

// A number is decisive when it carries a unit or a comparison sign: thresholds, doses, durations, timings.
const UNIT = String.raw`(?:%|gpl\b|×|mg|g\b|µg|mcg|ug|ng|ml|l\b|dl|gy|mmol|µmol|umol|iu|u/|units?|kg|m²|m2|cm|mm|mmhg|/l|/µl|/mm|hours?|hrs?|h\b|min|days?|d\b|weeks?|wks?|months?|years?|y\b|jours?|semaines?|mois|ans?|dagen|dag|weken|week|maanden|jaar|uur)`;
const DECISIVE = new RegExp(String.raw`(?:[≥≤<>]\s*(\d+(?:[.,]\d+)?))|(?:(?<![\d.,])(\d+(?:[.,]\d+)?)(?:\s*-\s*\d+(?:[.,]\d+)?)?\s*${UNIT})`, "g");

/** Decisive numbers of a text (next to a unit or a comparison sign), as values. */
export function decisive(s: string): Set<string> {
	const t = normalize(s).replace(/(?<![\d.,])(\d{1,3})(?:[ ,.\u202f\u00a0](\d{3}))+(?![\d.,]?\d)/g, (m) => m.replace(/[ ,.\u202f\u00a0]/g, ""));
	const out = new Set<string>();
	for (const m of t.replaceAll("x10^9/l", " gpl").matchAll(DECISIVE)) {
		const all = m[0].match(/\d+(?:[.,]\d+)?/g) ?? [];
		for (const n of all) out.add(String(Number(n.replace(",", "."))));
	}
	return out;
}

/**
 * Why a summary may not be shown, or null when it passes. Rule: every number in the summary is a
 * number of the original; every decisive number of the original (with a unit or a comparison sign)
 * is in the summary; the comparison signs are the same; never longer than the original.
 */
export function checkSummary(original: string, summary: string, lang: Lang): Reject | null {
	const s = summary.trim();
	if (!s) return "empty";
	const o = original.replace(/\s+/g, " ").trim();
	// A translation of an already short line may run a little longer than the original (French especially).
	const limit = lang !== "en" && o.length <= 80 ? Math.ceil(o.length * 1.35) + 4 : o.length;
	if (s.length > limit) return "length";
	const a = numberSet(o);
	const b = numberSet(s);
	if ([...b].some((n) => !a.has(n))) return "numbers";
	if ([...decisive(o)].some((n) => !b.has(n))) return "missing";
	if (signs(o) !== signs(s)) return "signs";
	return null;
}

// --- Model calls -------------------------------------------------------------------------

const LineOut = z.object({
	lines: z.array(
		z.object({
			i: z.number().int().describe("Index of the line, as given in the input."),
			en: z.string(),
			fr: z.string(),
			nl: z.string(),
		}),
	),
});
const TitleOut = z.object({ titles: z.array(z.object({ i: z.number().int(), en: z.string(), fr: z.string(), nl: z.string() })) });

const RULES = [
	"You write scan-lines for a paediatric oncology treatment protocol: a doctor skims them to find the information fast, then clicks through to the original PDF line.",
	"For EVERY input line, write a short version of THAT line in English (en), French (fr) and Dutch (nl).",
	"Style:",
	"- Lead with the key term (the investigation, drug, threshold, decision or timing) so the eye finds it. Telegraphic clinical style, noun phrases: '≥ 50 ×10⁹/L platelets before LP', 'Echocardiography before each anthracycline course'.",
	"- Drop context, rationale, references to other sections and administrative wording unless that IS the point of the line.",
	"- Prose lines: well under half the original length. A long paragraph can become one line naming what it covers, e.g. 'Pathology review: mandatory for all patients, at diagnosis and relapse; national reference pathologist'.",
	"- Never longer than the original. A list item stays a list item (no bullet character).",
	"- If the line is already short (about 60 characters or less) or is a table fragment, keep it as is in its own language and translate it literally for the others.",
	"Hard rules (code rejects the line otherwise):",
	"- Only that one line: never merge lines, never add facts, numbers or advice.",
	"- Keep the logic exactly: negations, conditions and exceptions ('not', 'unless', 'even if', 'only', 'except', 'or' vs 'and') must survive in every language.",
	"- Every threshold, dose, count, duration and timing (any number with a unit, %, ×10⁹/L, mg, Gy, days, weeks, or with ≥ ≤ < >) appears exactly as written, with its comparison sign. Do not convert units, round, or spell numbers as words. Any number you write must be in the original. Drug, gene and test names unchanged.",
	"- French and Dutch: correct Belgian clinical terminology (e.g. 'ponction lombaire', 'moelle osseuse', 'beenmergpunctie', 'lumbaalpunctie').",
	"Return one entry per input index, all indices.",
].join("\n");

export interface Usage {
	inputTokens?: number;
	outputTokens?: number;
}

function isQuota(e: unknown): boolean {
	const s = `${(e as { message?: string })?.message ?? ""} ${(e as { statusCode?: number })?.statusCode ?? ""} ${JSON.stringify((e as { responseBody?: unknown })?.responseBody ?? "")}`;
	return /429|RESOURCE_EXHAUSTED|quota|rate limit|overloaded|503|UNAVAILABLE/i.test(s);
}

/** Models that just hit a quota error are skipped until this time (ms). */
const cooling = new Map<string, number>();

async function callModel<T>(schema: z.ZodType<T>, prompt: string, onUsage: (model: string, u: Usage) => void): Promise<{ out: T; model: string }> {
	let last: unknown;
	for (let round = 0; round < 3; round++) {
		for (const { location, model } of MODELS) {
			if ((cooling.get(model) ?? 0) > Date.now() && model !== MODELS.at(-1)?.model) continue;
			const t0 = Date.now();
			try {
				const vertex = createVertex({ project: PROJECT, location });
				const r = await generateText({
					model: vertex(model),
					output: Output.object({ schema }),
					prompt,
					temperature: 0,
					maxOutputTokens: 32768,
					maxRetries: 0,
					abortSignal: AbortSignal.timeout(240_000),
					providerOptions: { vertex: { thinkingConfig: thinkingFor(model) } },
				});
				onUsage(model, r.usage);
				if (process.env.SUMMARY_DEBUG) console.log(`    call ${model} ${((Date.now() - t0) / 1000).toFixed(0)}s in ${r.usage.inputTokens} out ${r.usage.outputTokens}`);
				return { out: r.output, model };
			} catch (e) {
				last = e;
				if (process.env.SUMMARY_DEBUG) console.log(`    fail ${model} ${((Date.now() - t0) / 1000).toFixed(0)}s ${String((e as Error).message).slice(0, 160)}`);
				if (isQuota(e)) cooling.set(model, Date.now() + 60_000);
			}
		}
		await new Promise((r) => setTimeout(r, 5_000 * (round + 1)));
	}
	throw last;
}

// --- The pass ----------------------------------------------------------------------------

export interface SummarizeOptions {
	force?: boolean;
	/** Max lines per call. */
	batch?: number;
	/** Max characters of original text per call. */
	batchChars?: number;
	/** Run a model call; lets the caller share one concurrency limit across protocols. */
	limit?: <T>(fn: () => Promise<T>) => Promise<T>;
	onProgress?: (done: number, total: number) => void;
	/** Called with the partial spec now and then, so a long protocol can be saved as it goes. */
	onCheckpoint?: (spec: ProtocolSpec) => Promise<void>;
}

export interface SummarizeStats {
	ok: number;
	rejected: number;
	retried: number;
	lines: number;
	titles: number;
	calls: number;
	tokensIn: number;
	tokensOut: number;
	models: Record<string, number>;
	failedCalls: number;
}

const complete = (s?: Summaries) => !!(s?.en && s.fr && s.nl);

interface Item {
	node: Node;
	block: Anchor;
}

function linePrompt(items: Item[], retry?: Map<number, string>) {
	let lastNode = "";
	const body: string[] = [];
	items.forEach((it, i) => {
		const head = [...it.node.headingPath, it.node.title].join(" > ");
		if (head !== lastNode) {
			body.push(`## Section: ${head}`);
			lastNode = head;
		}
		const why = retry?.get(i);
		body.push(`[${i}]${why ? ` (previous attempt rejected: ${why})` : ""} ${it.block.text.replace(/\s*\n\s*/g, " ").trim()}`);
	});
	return [
		RULES,
		retry ? "\nThese lines are a retry: a previous summary broke a rule (named per line). Keep every number and comparison sign of the original exactly once, nothing else numeric, and stay shorter than the original." : "",
		"\nLines (section headings are context only, do not summarise them):",
		...body,
	].join("\n");
}

function titlePrompt(nodes: Node[]) {
	return [
		"Translate these section headings of a paediatric oncology treatment protocol into English (en), French (fr) and Dutch (nl).",
		"Keep any section number exactly (e.g. '8.1.5'). Keep drug, gene and study names. Belgian clinical French and Dutch terminology. If a heading is already English, en is the heading itself (fix only all-caps to normal case).",
		"Return one entry per index.",
		"",
		...nodes.map((n, i) => `[${i}] ${n.title.replace(/\s+/g, " ").trim()}`),
	].join("\n");
}

export async function summarizeSpec(spec: ProtocolSpec, opts: SummarizeOptions = {}): Promise<{ spec: ProtocolSpec; stats: SummarizeStats }> {
	const batch = opts.batch ?? 25;
	const batchChars = opts.batchChars ?? 6000;
	const limit = opts.limit ?? ((fn) => fn());
	const stats: SummarizeStats = { ok: 0, rejected: 0, retried: 0, lines: 0, titles: 0, calls: 0, tokensIn: 0, tokensOut: 0, models: {}, failedCalls: 0 };
	const onUsage = (model: string, u: Usage) => {
		stats.calls++;
		stats.tokensIn += u.inputTokens ?? 0;
		stats.tokensOut += u.outputTokens ?? 0;
		stats.models[model] = (stats.models[model] ?? 0) + 1;
	};

	// Pack lines of consecutive nodes into calls; a big node spans several calls.
	const todo: Item[] = spec.nodes.flatMap((node) => node.blocks.filter((b) => opts.force || !complete(b.sum)).map((block) => ({ node, block })));
	const chunks: Item[][] = [];
	let cur: Item[] = [];
	let chars = 0;
	for (const it of todo) {
		const len = it.block.text.length;
		if (cur.length && (cur.length >= batch || chars + len > batchChars)) {
			chunks.push(cur);
			cur = [];
			chars = 0;
		}
		cur.push(it);
		chars += len;
	}
	if (cur.length) chunks.push(cur);
	stats.lines = todo.length;

	const titleNodes = spec.nodes.filter((n) => opts.force || !complete(n.titles));
	const titleChunks: Node[][] = [];
	for (let i = 0; i < titleNodes.length; i += 150) titleChunks.push(titleNodes.slice(i, i + 150));
	stats.titles = titleNodes.length;

	const total = chunks.length + titleChunks.length;
	let done = 0;
	let lastCheckpoint = Date.now();
	const tick = async () => {
		done++;
		opts.onProgress?.(done, total);
		if (opts.onCheckpoint && Date.now() - lastCheckpoint > 90_000) {
			lastCheckpoint = Date.now();
			await opts.onCheckpoint(spec).catch(() => {});
		}
	};

	async function runChunk(items: Item[]) {
		const accepted: Summaries[] = items.map(() => ({}));
		let pending = new Map<number, string>(); // index → reason, lines needing a (re)try
		const apply = (out: z.infer<typeof LineOut>, idx: number[], final: boolean) => {
			const byI = new Map(out.lines.map((l) => [l.i, l]));
			const next = new Map<number, string>();
			idx.forEach((orig, j) => {
				const got = byI.get(j);
				const reasons: string[] = [];
				for (const lang of LANGS) {
					if (accepted[orig][lang]) continue;
					const s = got?.[lang]?.replace(/\s+/g, " ").trim() ?? "";
					const why = checkSummary(items[orig].block.text, s, lang);
					if (!why) accepted[orig][lang] = s;
					else reasons.push(`${lang}: ${why}`);
				}
				if (reasons.length) next.set(orig, reasons.join(", "));
			});
			if (!final) pending = next;
			return next;
		};

		const all = items.map((_, i) => i);
		try {
			const { out } = await limit(() => callModel(LineOut, linePrompt(items), onUsage));
			apply(out, all, false);
		} catch {
			stats.failedCalls++;
			pending = new Map(all.map((i) => [i, "no answer"]));
		}
		if (pending.size) {
			const idx = [...pending.keys()];
			stats.retried += idx.length;
			const sub = idx.map((i) => items[i]);
			const why = new Map(idx.map((orig, j) => [j, pending.get(orig) ?? ""]));
			try {
				const { out } = await limit(() => callModel(LineOut, linePrompt(sub, why), onUsage));
				apply(out, idx, true);
			} catch {
				stats.failedCalls++;
			}
		}
		items.forEach((it, i) => {
			const prev = opts.force ? {} : (it.block.sum ?? {});
			const merged: Summaries = { ...prev, ...accepted[i] };
			for (const lang of LANGS) {
				if (merged[lang]) stats.ok += accepted[i][lang] ? 1 : 0;
				else stats.rejected++;
			}
			it.block.sum = Object.keys(merged).length ? merged : undefined;
		});
		await tick();
	}

	async function runTitles(nodes: Node[]) {
		try {
			const { out } = await limit(() => callModel(TitleOut, titlePrompt(nodes), onUsage));
			for (const t of out.titles) {
				const n = nodes[t.i];
				if (!n) continue;
				const titles: Summaries = {};
				for (const lang of LANGS) {
					const s = t[lang]?.replace(/\s+/g, " ").trim();
					// Titles: numbers must survive too (section numbers, course numbers).
					if (s && checkSummary(n.title, s, "fr") !== "numbers" && signs(n.title) === signs(s)) titles[lang] = s;
				}
				n.titles = Object.keys(titles).length ? titles : n.titles;
			}
		} catch {
			stats.failedCalls++;
		}
		await tick();
	}

	await Promise.all([...titleChunks.map(runTitles), ...chunks.map(runChunk)]);

	const counts = spec.build.counts;
	const all = spec.nodes.flatMap((n) => n.blocks);
	counts.sumOk = all.reduce((a, b) => a + LANGS.filter((l) => b.sum?.[l]).length, 0);
	counts.sumRejected = all.length * 3 - counts.sumOk;
	counts.sumTitles = spec.nodes.filter((n) => complete(n.titles)).length;
	counts.summarizeTokensIn = (opts.force ? 0 : (counts.summarizeTokensIn ?? 0)) + stats.tokensIn;
	counts.summarizeTokensOut = (opts.force ? 0 : (counts.summarizeTokensOut ?? 0)) + stats.tokensOut;
	return { spec, stats };
}

/**
 * Copy summaries and titles from `from` onto `into` (a possibly rebuilt spec), matching lines
 * by page + text and nodes by id + title. Lines whose text changed keep no summary.
 */
export function mergeSummaries(into: ProtocolSpec, from: ProtocolSpec): number {
	const key = (b: Anchor) => `${b.page}\u0000${b.text}`;
	const sums = new Map<string, Summaries>();
	for (const n of from.nodes) for (const b of n.blocks) if (b.sum) sums.set(key(b), b.sum);
	const titles = new Map<string, Summaries>();
	for (const n of from.nodes) if (n.titles) titles.set(`${n.id}\u0000${n.title}`, n.titles);
	let merged = 0;
	for (const n of into.nodes) {
		const t = titles.get(`${n.id}\u0000${n.title}`) ?? from.nodes.find((m) => m.title === n.title && m.titles)?.titles;
		if (t) n.titles = { ...n.titles, ...t };
		for (const b of n.blocks) {
			const s = sums.get(key(b));
			if (s) {
				b.sum = { ...b.sum, ...s };
				merged++;
			}
		}
	}
	for (const k of ["sumOk", "sumRejected", "sumTitles", "summarizeTokensIn", "summarizeTokensOut"]) {
		if (from.build.counts[k] !== undefined) into.build.counts[k] = from.build.counts[k];
	}
	const all = into.nodes.flatMap((n) => n.blocks);
	into.build.counts.sumOk = all.reduce((a, b) => a + LANGS.filter((l) => b.sum?.[l]).length, 0);
	into.build.counts.sumRejected = all.length * 3 - into.build.counts.sumOk;
	return merged;
}
