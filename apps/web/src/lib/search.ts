/**
 * In-browser search over one protocol: every section title and verbatim line.
 * Beats Ctrl+F on three counts: units and spellings are normalised, clinical synonyms and
 * Dutch/French terms match (ANC = neutrophils = granulocytes, LP = lumbar puncture...), and
 * typos within one or two letters still match. Ranking knows the sheet's structure: "before",
 * "start", "criteria" favour requirements-to-start sections, and a named step narrows to it.
 * Nothing leaves the browser; no model call per keystroke.
 */
import type { Anchor, Lang, NodeKind, ProtocolSpec } from "@bspho/protocol/spec";

export interface Hit {
	nodeId: string;
	kind: NodeKind;
	title: string;
	path: string;
	text: string;
	anchor?: Anchor;
	isTitle: boolean;
	label?: string;
	score: number;
	/** Terms (folded) that matched, for highlighting. */
	matched: string[];
}

export function fold(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[x×]\s*10\s*(?:\^|\s)?\s*(?:9|⁹)\s*\/\s*l\b/g, " x10^9/l ")
		.replace(/[‐-―]/g, "-")
		.replace(/≥/g, ">=")
		.replace(/≤/g, "<=");
}

/** Clinical synonym groups: English, abbreviations, Dutch, French. Any member finds the others. */
const GROUPS: string[][] = [
	[
		"anc",
		"neutrophil",
		"neutrophils",
		"granulocytes",
		"granulocyte",
		"neutrophiles",
		"neutrofielen",
		"polynucleaires",
	],
	[
		"platelets",
		"platelet",
		"plt",
		"thrombocytes",
		"plaquettes",
		"bloedplaatjes",
		"trombocyten",
	],
	[
		"wbc",
		"white blood cells",
		"leukocytes",
		"leucocytes",
		"leukocyten",
		"globules blancs",
		"witte bloedcellen",
	],
	["lp", "lumbar puncture", "ponction lombaire", "lumbaalpunctie", "csf", "liquor"],
	["bm", "bone marrow", "bma", "marrow", "beenmerg", "moelle", "myelogram"],
	["mtx", "methotrexate", "methotrexaat"],
	["hd-mtx", "hdmtx", "high-dose methotrexate", "high dose methotrexate"],
	["it", "intrathecal", "intrathecaal", "intrathecale"],
	["vcr", "vincristine"],
	["dnr", "daunorubicin", "daunorubicine"],
	["ara-c", "cytarabine", "aracytine"],
	["6mp", "6-mp", "mercaptopurine", "6-mercaptopurine"],
	["peg-asp", "pegaspargase", "asparaginase", "peg-asparaginase"],
	[
		"echo",
		"echocardiography",
		"echocardiogram",
		"lvef",
		"shortening fraction",
		"cardiac function",
		"echografie",
	],
	["mri", "magnetic resonance", "irm"],
	["ct", "computed tomography", "scanner"],
	["mrd", "minimal residual disease"],
	["tls", "tumour lysis", "tumor lysis"],
	["hyperleukocytosis", "hyperleucocytosis", "leukostasis", "hyperleucocytose"],
	["fever", "febrile", "koorts", "fievre"],
	["infection", "infectie", "infections"],
	["creatinine", "gfr", "renal function", "kidney", "nierfunctie"],
	[
		"bilirubin",
		"transaminases",
		"alt",
		"ast",
		"liver function",
		"leverfunctie",
		"hepatic",
	],
	["dose", "dosage", "dosing", "posologie", "dosis"],
	["biopsy", "biopsie"],
	["consolidation", "consolidatie"],
	["induction", "inductie"],
	["maintenance", "onderhoud", "entretien"],
	["relapse", "recidief", "rechute"],
	["thrombosis", "thrombose", "trombose", "cvst", "sinus venous thrombosis"],
	["pancreatitis", "pancreatite", "pancreatitis"],
];
const SYN = new Map<string, string[]>();
for (const g of GROUPS) for (const w of g) SYN.set(w, g);

/** Words that say what kind of section is wanted, not what text it contains. */
const CUES: { re: RegExp; kinds: NodeKind[] }[] = [
	{
		re: /^(before|start|starting|begin|beginning|requirement|requirements|criteria|needed|need|required|voor|nodig|avant|conditions?|can|allowed)$/,
		kinds: ["start_requirements"],
	},
	{
		re: /^(diagnosis|diagnostic|diagnostics|work-up|workup|staging|confirm)$/,
		kinds: ["diagnostics"],
	},
	{
		re: /^(risk|group|groups|stratification|strata)$/,
		kinds: ["risk_groups", "risk_group", "restratification"],
	},
	{
		re: /^(side|effects|toxicity|modification|modifications|reduce|reduction)$/,
		kinds: ["toxicity", "drug_info"],
	},
];
const STOP = new Set([
	"the",
	"a",
	"an",
	"of",
	"to",
	"in",
	"for",
	"and",
	"or",
	"on",
	"with",
	"what",
	"is",
	"are",
	"do",
	"does",
	"i",
	"my",
	"patient",
	"when",
	"how",
	"which",
	"de",
	"het",
	"een",
	"le",
	"la",
	"les",
	"des",
	"du",
]);

function editDistanceAtMost(a: string, b: string, max: number): boolean {
	if (Math.abs(a.length - b.length) > max) return false;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
			// Transposition ("vincrisitne").
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				v = Math.min(v, (prev[j - 2] ?? 0) + 1);
			cur.push(v);
			rowMin = Math.min(rowMin, v);
		}
		if (rowMin > max) return false;
		prev = cur;
	}
	return prev[b.length] <= max;
}

interface Entry {
	nodeId: string;
	kind: NodeKind;
	title: string;
	path: string;
	text: string;
	hay: string;
	titleHay: string;
	anchor?: Anchor;
	isTitle: boolean;
	label?: string;
	stepId: string | null;
}

/** Does the folded text contain the term? Short terms must be whole words ("csf" is not in "g-csf"). */
function has(hay: string, term: string): boolean {
	if (term.length > 4) return hay.includes(term);
	let re = WHOLE_WORD.get(term);
	if (!re) {
		const esc = term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		re = new RegExp(`(?:^|[^a-z0-9-])${esc}(?![a-z0-9])`);
		WHOLE_WORD.set(term, re);
	}
	return re.test(hay);
}
/** Compiled once per short term: `has` runs per entry × term × synonym on every keystroke. */
const WHOLE_WORD = new Map<string, RegExp>();

/** Words that name a treatment step: only then does a query narrow to a step. */
const STEP_WORDS =
	/^(consolidation|consolidatie|induction|inductie|maintenance|intensification|reinduction|re-induction|course|cure|block|bloc|cycle|phase|arm|protocol|interim|delayed|di|cons|ib|ia|m)$/;

export class ProtocolIndex {
	private entries: Entry[] = [];
	private vocab = new Set<string>();
	private steps: { id: string; hay: string }[] = [];

	/** `lang`: also index the summaries and translated headings in that language, and show them in hits. */
	constructor(spec: ProtocolSpec, lang?: Lang) {
		const byId = new Map(spec.nodes.map((n) => [n.id, n]));
		const stepOf = (id: string | null): string | null => {
			for (
				let n = id ? byId.get(id) : undefined;
				n;
				n = n.parent ? byId.get(n.parent) : undefined
			)
				if (n.kind === "step" || n.kind === "phase") return n.id;
			return null;
		};
		for (const n of spec.nodes) {
			if (n.kind === "step" || n.kind === "phase")
				this.steps.push({ id: n.id, hay: fold(n.title) });
			const title = (lang && n.titles?.[lang]?.trim()) || n.title;
			const alt = title === n.title ? "" : ` ${title}`;
			const path = [...n.headingPath, title].join(" › ");
			const titleHay = fold(`${n.title}${alt} ${n.headingPath.slice(-2).join(" ")}`);
			const base = {
				nodeId: n.id,
				kind: n.kind,
				title,
				path,
				titleHay,
				stepId: stepOf(n.id),
			};
			this.entries.push({
				...base,
				text: title,
				hay: fold(`${n.title}${alt}`),
				isTitle: true,
			});
			const seen = new Set<string>();
			for (const a of n.blocks) {
				const key = `${a.page}:${a.text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const sum = (lang && a.sum?.[lang]?.trim()) || "";
				this.entries.push({
					...base,
					text: sum || a.text,
					hay: fold(sum ? `${a.text} ${sum}` : a.text),
					anchor: a,
					isTitle: false,
				});
			}
			for (const f of n.figures ?? [])
				if (f.caption)
					this.entries.push({
						...base,
						text: f.caption.text,
						hay: fold(f.caption.text),
						anchor: f.caption,
						isTitle: false,
						label: `Table, p. ${f.page}`,
					});
		}
		for (const e of this.entries)
			for (const w of e.hay.split(/[^a-z0-9^/.+-]+/))
				if (w.length >= 4) this.vocab.add(w);
	}

	/** Alternatives for one query term: itself, its synonym group, close spellings found in this protocol. */
	private expand(term: string): string[] {
		const alts = new Set([term, ...(SYN.get(term) ?? [])]);
		if (term.length >= 5 && !this.entries.some((e) => has(e.hay, term))) {
			const max = term.length >= 8 ? 2 : 1;
			for (const w of this.vocab)
				if (w[0] === term[0] && editDistanceAtMost(term, w, max)) alts.add(w);
			for (const w of [...alts]) for (const s of SYN.get(w) ?? []) alts.add(s);
		}
		return [...alts];
	}

	search(query: string, limit = 40): Hit[] {
		const q = fold(query).trim();
		if (!q) return [];
		// Multi-word synonyms first ("lumbar puncture"), then single words.
		let rest = ` ${q} `;
		const groups: string[][] = [];
		for (const g of GROUPS)
			for (const w of g)
				if (w.includes(" ") && rest.includes(` ${w} `)) {
					groups.push(g);
					rest = rest.replace(` ${w} `, " ");
				}
		const words = rest.split(/\s+/).filter(Boolean);
		const wantKinds = new Set<NodeKind>();
		const terms: string[][] = [...groups];
		for (const w of words) {
			const cue = CUES.find((c) => c.re.test(w));
			if (cue) {
				for (const k of cue.kinds) wantKinds.add(k);
				continue;
			}
			if (STOP.has(w)) continue;
			terms.push(this.expand(w));
		}
		// A named step ("consolidation 2", "course 3 ham") narrows the ranking to it; only when the query says so.
		const namesStep = words.some((w) => STEP_WORDS.test(w));
		const stepTerms = namesStep
			? terms.filter((alts) =>
					alts.some((a) => this.steps.some((s) => has(s.hay, a))),
				)
			: [];
		const steps = new Set(
			this.steps
				.filter(
					(s) =>
						stepTerms.length &&
						stepTerms.every((alts) => alts.some((a) => has(s.hay, a))),
				)
				.map((s) => s.id),
		);
		const content = terms.filter(
			(alts) => !stepTerms.includes(alts) || !steps.size,
		);
		if (!content.length && !wantKinds.size && !steps.size) return [];

		const hits: Hit[] = [];
		for (const e of this.entries) {
			const inStep = e.stepId !== null && steps.has(e.stepId);
			let score = 0;
			const matched: string[] = [];
			let ok = true;
			for (const alts of content) {
				const a = alts.find((x) => has(e.hay, x));
				const t = !a ? alts.find((x) => has(e.titleHay, x)) : undefined;
				if (a) {
					score += e.isTitle ? 4 : 2;
					matched.push(a);
				} else if (t) score += 1;
				else {
					ok = false;
					break;
				}
			}
			if (!ok) continue;
			if (!content.length && !(inStep || wantKinds.has(e.kind))) continue;
			if (wantKinds.size) score += wantKinds.has(e.kind) ? 6 : -1;
			if (steps.size) score += inStep ? 5 : -2;
			if (
				content.length > 1 &&
				e.hay.includes(content.map((a) => a[0]).join(" "))
			)
				score += 2;
			if (e.kind === "other") score -= 1.5;
			score -= e.hay.length / 3000;
			hits.push({
				nodeId: e.nodeId,
				kind: e.kind,
				title: e.title,
				path: e.path,
				text: e.text,
				anchor: e.anchor,
				isTitle: e.isTitle,
				label: e.label,
				score,
				matched,
			});
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}
