/**
 * Ask: the long-tail fallback. Retrieval runs over the verbatim blocks of the published
 * specs (no embeddings, nothing per page to pay for); the model answers by pointing at
 * block ids, and the UI shows those blocks verbatim. Out-of-scope questions are refused.
 */
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText, Output } from "ai";
import { z } from "zod";
import { checklist, countNotes, FACETS, listHeads, QUESTION_TYPES } from "./facets.ts";
import type { Anchor, Node, ProtocolSpec } from "./spec.ts";
import { normalize } from "./verify.ts";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "qwiklabs-gcp-01-ce74ae98024d";
/** Planning (scope + search terms) needs speed; the answer over whole sections needs care. */
const FAST = [
	{ location: "global", model: "gemini-3-flash-preview", thinking: "minimal" },
	{ location: "europe-west1", model: "gemini-2.5-flash", thinking: "low" },
];
const CAREFUL = [
	...(process.env.ASK_MODEL ? [{ location: "global", model: process.env.ASK_MODEL, thinking: process.env.ASK_THINKING ?? "high" }] : []),
	{ location: "global", model: "gemini-3-flash-preview", thinking: process.env.ASK_THINKING ?? "low" },
	{ location: "europe-west1", model: "gemini-2.5-flash", thinking: "low" },
];
/** Characters of verbatim section text handed to the answer model (~40k tokens). */
const BUDGET = 120_000;
const MAX_SECTION = 24_000;
/** Kinds that hold conditions, work-up and management: what clinicians ask about most. */
const BOOST_KINDS = new Set(["start_requirements", "eligibility", "diagnostics", "supportive_care", "toxicity"]);
const CRITERIA = /criteria|requirement|prior to|before|eligib|starting|conditions|minimum/;
/** A criteria list's own heading, often a line inside a section titled after something else ("4.1.4 - Chemoimmunotherapy arm eligibility Criteria"). */
const CRITERIA_HEAD = /criteria|requirements?|eligib|prior to|before (start|begin)|conditions? (to|for)/;
/** Words in step titles too generic to say which step a criteria heading belongs to. */
const STEP_KINDS = new Set(["step", "phase", "risk_group", "risk_groups"]);
const GENERIC = new Set("step course cycle cycles block phase treatment therapy arm arms part tier with without and the for of in patients standard".split(" "));

export interface Passage {
	id: string; // "b12"
	protocolId: string;
	protocol: string;
	version: string;
	nodeId: string;
	section: string;
	anchor: Anchor;
}

/** A section's verbatim lines: its blocks, then the captions of its figures and tables (some criteria lists are only extracted as a table caption). */
const lines = (n: Node): Anchor[] => [...n.blocks, ...(n.figures ?? []).flatMap((f) => (f.caption ? [f.caption] : []))];

const STOP = new Set("the a an of to in for and or on with what is are be by at as do does should how which when patient patients protocol".split(" "));
const terms = (s: string) => normalize(s).split(/[^a-z0-9.^/<>≥≤]+/).filter((t) => t.length > 1 && !STOP.has(t));

async function generate<T>(schema: z.ZodType<T>, prompt: string, models = FAST): Promise<{ output: T; model: string }> {
	let last: unknown;
	for (const { location, model, thinking } of models) {
		const t0 = Date.now();
		try {
			const vertex = createVertex({ project: PROJECT, location });
			const thinkingConfig = model.startsWith("gemini-3") ? { thinkingLevel: thinking } : { thinkingBudget: thinking === "high" ? 4096 : 1024 };
			const r = await generateText({ model: vertex(model), output: Output.object({ schema }), prompt, temperature: 0, maxRetries: 1, abortSignal: AbortSignal.timeout(models === FAST ? 15_000 : 40_000), providerOptions: { vertex: { thinkingConfig } } });
			if (process.env.ASK_DEBUG) console.info(`[ask] ${model} ${thinking} ${Date.now() - t0}ms in=${r.usage.inputTokens} out=${r.usage.outputTokens}`);
			return { output: r.output, model };
		} catch (e) {
			if (process.env.ASK_DEBUG) console.info(`[ask] ${model} failed ${Date.now() - t0}ms ${(e as Error).message?.slice(0, 100)}`);
			last = e;
		}
	}
	throw last;
}

const Plan = z.object({
	inScope: z.boolean().describe("false for anything that is not paediatric haematology/oncology protocol content (adult medicine, general paediatrics such as asthma, non-clinical)"),
	keywords: z.array(z.string()).describe("10-25 English search terms and synonyms as they would appear in protocol text (drug names, lab values, procedures, e.g. 'hyperleukocytosis', 'leukostasis', 'platelets', 'dinutuximab')"),
	diagnosis: z.string().default("").describe("The diagnosis or special population the question states (e.g. 'AML', 'infant ALL', 'relapsed neuroblastoma'), or 'not stated'"),
	protocols: z.array(z.string()).describe("ids of the protocols that hold the answer (from the list), most relevant first, following the protocol rules in the prompt (with diagnosis 'not stated' and a presentation question: only the frontline protocols for the general population of each disease it may be); empty = all"),
	sectionHints: z.array(z.string()).default([]).describe("3-8 short phrases likely in the TITLES of the sections that hold the answer, e.g. 'eligibility', 'starting criteria', 'requirements prior to', 'hyperleukocytosis', 'staging', 'thrombosis'"),
	type: z.enum(QUESTION_TYPES).default("other").describe("Question type, from the list in the prompt"),
	treatments: z.array(z.string()).default([]).describe("Drugs or treatment elements the question names (e.g. 'dinutuximab', 'PEG-asparaginase', 'induction'); empty if none"),
	facets: z
		.array(z.object({ facet: z.string(), keywords: z.array(z.string()).describe("3-8 terms likely in the protocol text that answers this facet") }))
		.describe("REQUIRED for every type except 'other': one entry per facet of the chosen type's checklist, in order"),
});

const Answer = z.object({
	mode: z.enum(["answer", "clarify", "refuse"]),
	summary: z.string().describe("One or two sentences. For refuse: 'I cannot answer this question.' plus why. For clarify: why the answer depends on missing information."),
	clarifyingQuestion: z.string().optional(),
	points: z
		.array(
			z.object({
				facet: z.string().default("").describe("Short name of the checklist facet this point answers (e.g. 'Haematological'), or '' when there is no checklist"),
				protocol: z.string().describe("Protocol id this point is about"),
				text: z.string().describe("One statement that the cited passages state, with its exact numbers and conditions; no facts beyond them"),
				cites: z.array(z.string()).describe("Passage ids (b...) that state it"),
			}),
		)
		.default([]),
	notCovered: z.array(z.string()).default([]).describe("Parts of the question the passages do not answer"),
});

export interface AskResult {
	mode: "answer" | "clarify" | "refuse";
	summary: string;
	clarifyingQuestion?: string;
	points: { protocol: string; facet?: string; text: string; cites: Passage[] }[];
	notCovered: string[];
	model: string;
	searched: number;
}

export async function ask(question: string, specs: ProtocolSpec[], names: Record<string, string>): Promise<AskResult> {
	const list = specs.map((s) => `- ${s.doc.id}: ${names[s.doc.id] ?? s.doc.short} (${s.doc.title.slice(0, 120)})`).join("\n");
	const types = Object.entries(FACETS)
		.map(([k, v]) => `- ${k} (${v.label}): facets ${v.facets.map((f) => f.split(":")[0]).join(" / ")}`)
		.join("\n");
	const { output: plan } = await generate(Plan, `Paediatric oncology protocol search. Protocols:\n${list}\n\nQuestion types (use 'other' if none fits):\n${types}\n\nProtocols: for a question about a drug or treatment, pick every protocol that gives it (frontline and relapse). For a presentation without a diagnosis (e.g. a lab value), pick the frontline protocol of each disease it may be (e.g. ALL and AML) and leave out protocols for special populations (infants, Down syndrome, relapse, a rare subtype) unless the question names that population.\nFacet keywords: include the parameter the question gives as protocols write it (e.g. 'WBC', 'white cell count', 'ANC') and the words of the section that holds it (e.g. 'stratification', 'induction', 'criteria').\n\nQuestion: ${question}\n\nPlan the search.`);
	if (!plan.inScope) {
		return {
			mode: "refuse",
			summary: "I cannot answer this question. It is outside the paediatric haematology/oncology protocols in this library.",
			points: [],
			notCovered: [],
			model: "",
			searched: 0,
		};
	}
	const scope = plan.protocols.length ? specs.filter((s) => plan.protocols.includes(s.doc.id)) : specs;
	const q = [...new Set([...terms(question), ...plan.keywords.flatMap(terms)])];
	const hints = [...new Set(plan.sectionHints.flatMap(terms))];
	const criteriaQuestion = CRITERIA.test(normalize(`${question} ${plan.sectionHints.join(" ")}`));
	// Score whole sections (nodes), not single blocks: eligibility thresholds rarely repeat the drug name.
	type Sec = { spec: ProtocolSpec; i: number; score: number; size: number };
	const pool = scope.length ? scope : specs;
	const texts = new Map(pool.flatMap((s) => s.nodes.map((n) => [n, { head: normalize(`${n.headingPath.join(" ")} ${n.title}`), body: normalize(lines(n).map((a) => a.text).join(" ")) }] as const)));
	const text = (n: Node) => texts.get(n) ?? { head: "", body: "" };
	let searched = 0;
	const rank = (q: string[], hints: string[], count = false, kinds: string[] = []): Sec[] => {
		const secs: Sec[] = [];
		for (const s of pool) {
			for (const [i, n] of s.nodes.entries()) {
				const { head, body } = text(n);
				let score = 0;
				let matched = 0;
				for (const term of q) {
					const inBody = body.includes(term);
					const inHead = head.includes(term);
					if (inBody || inHead) matched++;
					score += (inBody ? 1 : 0) + (inHead ? 1.5 : 0);
				}
				for (const h of hints) if (head.includes(h)) score += 1;
				if (!score) continue;
				if (count) searched += lines(n).length;
				if (BOOST_KINDS.has(n.kind)) score *= 1.3;
				if (kinds.includes(n.kind)) score *= 1.8;
				if (criteriaQuestion && (n.kind === "start_requirements" || n.kind === "eligibility" || CRITERIA.test(head))) score *= 1.6;
				score *= 1 + matched / 10;
				const size = lines(n).reduce((a, b) => a + b.text.length, 0);
				if (size) secs.push({ spec: s, i, score: score / Math.pow(1 + size / 4000, 0.25), size });
			}
		}
		return secs.sort((a, b) => b.score - a.score);
	};
	const secs = rank(q, hints, true);
	// Take the best sections whole, plus their start_requirements/eligibility siblings and children.
	const picked = new Map<string, { spec: ProtocolSpec; i: number }>();
	const perProtocol = new Map<string, number>();
	const multi = new Set(secs.map((x) => x.spec.doc.id)).size > 1;
	// Leave room for a second protocol; protocols the planner ranks third or later get a smaller share, so a side protocol cannot crowd out the main ones.
	const cap = (id: string) => (!multi ? BUDGET : plan.protocols.indexOf(id) >= 2 ? BUDGET * 0.2 : BUDGET * 0.6);
	let used = 0;
	const take = (spec: ProtocolSpec, i: number) => {
		const key = `${spec.doc.id}:${i}`;
		const n = spec.nodes[i];
		const size = Math.min(MAX_SECTION, (n ? lines(n) : []).reduce((a, b) => a + b.text.length, 0));
		const mine = perProtocol.get(spec.doc.id) ?? 0;
		if (picked.has(key) || !size || used + size > BUDGET || mine + size > cap(spec.doc.id)) return;
		picked.set(key, { spec, i });
		perProtocol.set(spec.doc.id, mine + size);
		used += size;
	};
	// 1. Structure: the start requirements / eligibility of every step that gives a named drug or treatment.
	//    Their titles rarely name the drug, and some criteria lists sit under a misleading section title,
	//    so also take sections holding a criteria heading line that names the drug or one of those steps.
	const treat = [...new Set(plan.treatments.flatMap(terms))].filter((t) => t.length > 3);
	if (treat.length && (criteriaQuestion || plan.type === "before_starting")) {
		for (const s of pool) {
			const steps = s.nodes.filter((n) => STEP_KINDS.has(n.kind) && treat.some((t) => text(n).head.includes(t) || text(n).body.includes(t)));
			if (!steps.length) continue;
			const ids = new Set(steps.map((n) => n.id));
			const names = new Set([...treat, ...steps.flatMap((n) => terms(n.title).filter((t) => t.length > 4 && !GENERIC.has(t) && !/\d/.test(t)))]);
			const n0 = picked.size;
			for (const [i, n] of s.nodes.entries()) {
				if (picked.size - n0 >= 8) break;
				const child = n.parent !== null && ids.has(n.parent) && (n.kind === "start_requirements" || n.kind === "eligibility");
				const head = lines(n).some((a) => a.text.split("\n").some((l) => l.length < 160 && CRITERIA_HEAD.test(normalize(l)) && [...names].some((t) => normalize(l).includes(t))));
				const titled = (n.kind === "start_requirements" || n.kind === "eligibility" || CRITERIA_HEAD.test(text(n).head)) && [...names].some((t) => text(n).head.includes(t));
				if (child || head || titled) take(s, i);
			}
		}
	}
	// 2. Facets: the best sections for each facet of the question type, so one facet's long section cannot crowd out the rest.
	//    Three sections per facet in each protocol the whole-question search found relevant (its top 12 sections).
	const relevant = new Set(secs.slice(0, 12).map((x) => x.spec.doc.id));
	for (const [fi, f] of (plan.type === "other" ? [] : plan.facets).entries()) {
		const done = new Map<string, number>();
		const kinds = plan.type === "other" ? [] : (FACETS[plan.type].kinds[fi] ?? []);
		for (const sec of rank([...new Set([...terms(question), ...f.keywords.flatMap(terms), ...terms(f.facet)])], [], false, kinds)) {
			const k = done.get(sec.spec.doc.id) ?? 0;
			if (!relevant.has(sec.spec.doc.id) || k >= 3) continue;
			done.set(sec.spec.doc.id, k + 1);
			take(sec.spec, sec.i);
		}
	}
	// 3. Fill with the best sections for the whole question.
	for (const sec of secs) {
		if (used >= BUDGET || picked.size >= 40) break;
		take(sec.spec, sec.i);
		const n = sec.spec.nodes[sec.i];
		if (!n) continue;
		for (const [j, m] of sec.spec.nodes.entries()) {
			const related = m.parent === n.id || (n.parent !== null && m.parent === n.parent);
			if (related && (m.kind === "start_requirements" || m.kind === "eligibility")) take(sec.spec, j);
		}
	}
	const top: Passage[] = [];
	const blocks: string[] = [];
	const seen = new Set<string>(); // protocols repeat criteria lists verbatim (synopsis, body, appendix): keep the first copy
	const order = [...picked.values()].sort((a, b) => a.spec.doc.id.localeCompare(b.spec.doc.id) || a.i - b.i);
	for (const { spec: s, i } of order) {
		const n = s.nodes[i];
		if (!n) continue;
		const section = [...n.headingPath, n.title].join(" › ");
		const protocol = names[s.doc.id] ?? s.doc.short;
		blocks.push(`=== ${protocol} (${s.doc.id}) v${s.doc.version} · ${section} {${n.kind}; pp.${n.pages.from}-${n.pages.to}}`);
		let size = 0;
		const all = lines(n);
		const heads = listHeads(all);
		const notes = countNotes(all);
		for (const [j, a] of all.entries()) {
			if (size > MAX_SECTION) break;
			const k = `${s.doc.id}:${normalize(a.text)}`;
			if (a.text.length > 25 && seen.has(k)) continue;
			seen.add(k);
			size += a.text.length;
			const id = `b${top.length}`;
			top.push({ id, protocolId: s.doc.id, protocol, version: s.doc.version, nodeId: n.id, section, anchor: a });
			blocks.push(`[${id} p.${a.page}] ${heads[j] ? `(in list "${heads[j]}") ` : ""}${a.text}${notes[j] ? ` (context note: ${notes[j]})` : ""}`);
		}
		blocks.push("");
	}
	const passages = blocks.join("\n");
	if (process.env.ASK_DEBUG === "2") console.info(JSON.stringify(plan.facets), "\n" + order.map(({ spec, i }) => `  ${spec.doc.id} ${spec.nodes[i]?.kind} ${spec.nodes[i]?.title.slice(0, 70)}`).join("\n"));
	// Ask has no label lines: its summary is the opening, and points carry the facet.
	const facetList = checklist(plan.type, question)
		.replace(/ \(give each its own label line and bullets; skip a facet only if the protocol says nothing about it\)/, "")
		.replace("Open with the direct answer to the question asked, in one or two sentences, before any label line or facet.", "Make the summary the direct answer to the question asked.")
		.replace("in those opening sentences", "in the summary");
	if (process.env.ASK_DEBUG) console.info(`[ask] type=${plan.type} protocols=${plan.protocols.join(",")} treatments=${plan.treatments.join(",")} ${picked.size} sections, ${top.length} blocks, ${passages.length} chars from ${[...perProtocol].map(([k, v]) => `${k}:${v}`).join(" ")}`);
	const { output, model } = await generate(
		Answer,
		[
			"You are a search assistant for paediatric haematology-oncology clinicians. You are not a medical device; the clinician decides.",
			"The passages below are whole protocol sections, grouped under '===' headers (protocol, section path, kind, pages). A criteria item may carry (in list \"...\"): the heading of the list it belongs to; name the branch of a point from that list heading (e.g. entry criteria vs criteria before each cycle), never from a neighbouring list. Answer ONLY from them; never use outside knowledge.",
			"Be comprehensive: read every section, including eligibility, start requirements, diagnostics, supportive care and toxicity sections that do not repeat the question's wording. Give every distinct threshold or step its own point with its exact value and condition (e.g. 'without transfusion for 72 hours', 'only if bone-marrow involvement'). Cover each relevant protocol and, where the answer differs by phase, arm, risk group or timepoint (e.g. trial entry vs before each cycle), give points per branch and name the branch in the point.",
			"When the passages give a reason for a recommendation (e.g. 'no proven benefit', 'risk of bleeding'), put the reason in the point and cite the passage that states it.",
			"Every point must be stated by the passages it cites; cite every passage it relies on. Every number in a point must appear verbatim in one of its cited passages. Never compute, convert or adjust doses.",
			"Write at most 28 short points, the ones that answer the question directly first (for 'conditions before starting X': haematological counts, organ function, performance status and toxicity requirements, before administrative exclusions, which you may group into one point). Cover every criterion of every list (haematological, organ function including coagulation and blood pressure, performance status, infection, prior toxicity) for every protocol and arm before any premedication, co-medication, vaccine or monitoring point. Short non-numeric conditions of one list (performance status, no active infection, no prior toxicity above a grade) go together in one point naming the list, so that none of them is dropped. Cite at most 4 passages per point.",
			...(facetList ? [facetList] : []),
			...(plan.type === "other" ? [] : ["Cover every facet for every relevant protocol before adding detail to any one of them; set each point's facet. Lines from technique or appendix sections (how an investigation is done or scored) count for the work-up facets."]),
			"When the question gives a patient value (e.g. a count), state for each relevant protocol whether that value crosses a cut-off there (a definition, a risk-group or stratification criterion, quoting the cut-off) and what follows from it (the group, induction or arm it assigns, with its drugs).",
			"When one phase has separate criteria lists (e.g. criteria to enter the phase and criteria before each cycle), give each list's points naming the list. A haematological question must not leave the reader thinking one list's blood counts apply to the other: if a list sets no blood-count threshold (a passage then ends with a '(context note: ...)' saying so), write a haematological point that says so, naming the list and citing that passage. Name each list exactly as its heading does (e.g. 'criteria to enter maintenance' is not 'criteria prior to each cycle').",
			"When the question names no diagnosis or special population, cover the frontline protocols for the general population first and completely; points from protocols for special populations (infants, Down syndrome, relapse, another disease) come after them, only as room remains.",
			"List in notCovered only parts of the question the passages genuinely do not answer.",
			"Ask a clarifying question only if no useful answer is possible without it. Refuse questions outside paediatric haematology/oncology protocols.",
			`\nPASSAGES:\n${passages}\n\nQUESTION: ${question}`,
		].join("\n"),
		CAREFUL,
	);
	const byId = new Map(top.map((p) => [p.id, p]));
	const points = output.points
		.map((pt) => ({ protocol: pt.protocol, facet: pt.facet || undefined, text: pt.text, cites: pt.cites.map((c) => byId.get(c)).filter((p): p is Passage => !!p) }))
		.filter((pt) => pt.cites.length > 0); // a point without a real passage behind it is dropped
	return {
		mode: output.mode === "answer" && !points.length ? "refuse" : output.mode,
		summary: output.mode === "answer" && !points.length ? "The protocols searched do not contain a passage that answers this." : output.summary,
		clarifyingQuestion: output.clarifyingQuestion,
		points,
		notCovered: output.notCovered,
		model,
		searched,
	};
}
