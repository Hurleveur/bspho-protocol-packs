/**
 * A case, without storing the case.
 *
 * The app keeps nothing about a patient: the whole state of a case is a short code the clinician
 * pastes into the EHR note, and pasting it back (or opening /p/<id>#case=<code>) rebuilds the view.
 * The code holds protocol coordinates only (node references, protocol day numbers, indices of the
 * protocol's own lines that were ticked): no names, dates, lab values or free text. It is read in the
 * browser; the fragment form never reaches the server.
 *
 * Node references are a 5-character hash of the node id, so a code stays short and still resolves on a
 * later version where the section kept its heading.
 */
import type { Anchor, Edge, Node, Treatment } from "@bspho/protocol/spec";

export const DELAY_REASONS = [
	"count recovery",
	"toxicity",
	"infection",
	"other per protocol",
] as const;

export interface CaseDelay {
	step: string;
	reason: number;
	day: number;
}

export interface CaseState {
	protocolId: string;
	/** First 8 hex characters of the PDF sha256 the case started on. */
	sha8: string;
	/** Arm / risk group node id. */
	arm?: string;
	/** Indices into the arm node's blocks: the criteria the clinician ticked for that choice. */
	why: number[];
	done: string[];
	cur?: string;
	started: boolean;
	/** Indices into the current step's requirement lines, ticked by the clinician. */
	req: number[];
	delays: CaseDelay[];
	/** Forks and re-stratifications taken: the edge followed. */
	forks: { from: string; to: string }[];
	rulesAck: boolean;
}

/* ------------------------------------------------------------------ refs + code */

export function ref(id: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(7, "0").slice(-5);
}

interface Wire {
	a?: string;
	w?: number[];
	d?: string[];
	c?: string;
	s?: 1;
	q?: number[];
	x?: [string, number, number][];
	f?: [string, string][];
	l?: 1;
}

const b64 = (s: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
const unb64 = (s: string) =>
	new TextDecoder().decode(
		Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
			c.charCodeAt(0),
		),
	);

export function encodeCase(c: CaseState): string {
	const w: Wire = {};
	if (c.arm) w.a = ref(c.arm);
	if (c.why.length) w.w = c.why;
	if (c.done.length) w.d = c.done.map(ref);
	if (c.cur) w.c = ref(c.cur);
	if (c.started) w.s = 1;
	if (c.req.length) w.q = c.req;
	if (c.delays.length) w.x = c.delays.map((d) => [ref(d.step), d.reason, d.day]);
	if (c.forks.length) w.f = c.forks.map((f) => [ref(f.from), ref(f.to)]);
	if (c.rulesAck) w.l = 1;
	return `${c.protocolId}.${c.sha8}.${b64(JSON.stringify(w))}`;
}

const ints = (v: unknown): number[] =>
	Array.isArray(v)
		? v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < 1000)
		: [];
const strs = (v: unknown): string[] =>
	Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string" && /^[0-9a-z]{5}$/.test(x))
		: [];

/** Parse a pasted code (or a URL holding one). Unknown references are dropped and counted. */
export function decodeCase(
	raw: string,
	nodes: Node[],
	treatment?: Treatment,
): { state: CaseState; dropped: number } | { error: string } {
	const text = raw.trim();
	const m = /(?:case=)?([a-z0-9][a-z0-9-]*)\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)/.exec(
		text,
	);
	if (!m)
		return {
			error: "This is not a case code. It looks like protocol.version.code.",
		};
	let w: Wire;
	try {
		const parsed: unknown = JSON.parse(unb64(m[3]));
		if (!parsed || typeof parsed !== "object") throw new Error();
		w = parsed as Wire;
	} catch {
		return { error: "The case code is damaged (copy it again from the EHR note)." };
	}
	const ids = [
		...nodes.map((n) => n.id),
		...(treatment?.arms.map((a) => a.id) ?? []),
		...(treatment?.riskGroups.map((g) => g.id) ?? []),
	];
	const byRef = new Map(ids.map((x) => [ref(x), x]));
	let dropped = 0;
	const id = (r: unknown) => {
		if (typeof r !== "string") return undefined;
		const v = byRef.get(r);
		if (!v) dropped++;
		return v;
	};
	const delays: CaseDelay[] = [];
	if (Array.isArray(w.x))
		for (const x of w.x) {
			if (!Array.isArray(x)) continue;
			const step = id(x[0]);
			const reason = Number(x[1]);
			const day = Number(x[2]);
			if (
				step &&
				Number.isInteger(reason) &&
				reason >= 0 &&
				reason < DELAY_REASONS.length &&
				Number.isInteger(day)
			)
				delays.push({ step, reason, day });
		}
	const forks: { from: string; to: string }[] = [];
	if (Array.isArray(w.f))
		for (const f of w.f) {
			if (!Array.isArray(f)) continue;
			const from = id(f[0]);
			const to = id(f[1]);
			if (from && to) forks.push({ from, to });
		}
	return {
		dropped,
		state: {
			protocolId: m[1],
			sha8: m[2],
			arm: w.a ? id(w.a) : undefined,
			why: ints(w.w),
			done: strs(w.d)
				.map(id)
				.filter((x): x is string => !!x),
			cur: w.c ? id(w.c) : undefined,
			started: w.s === 1,
			req: ints(w.q),
			delays,
			forks,
			rulesAck: w.l === 1,
		},
	};
}

/* ------------------------------------------------------------------ protocol model */

/** Same rules as the consult sheet: a line ending in ":" with no threshold introduces a list. */
const isHeading = (t: string) =>
	t.trim().length < 90 &&
	/:\s*$/.test(t.trim()) &&
	!/[≥≤<>]|x\s*10|×10|\/mm|\/µl/i.test(t);
const cssKey = (s: string) => s.slice(0, 40).replace(/["\\\n]/g, " ");
export const lineKey = (a: Anchor) => `${a.page}:${cssKey(a.text)}`;

/** The current step's requirement lines that can be ticked (as counted on the step card). */
export function requirementLines(stepId: string, nodes: Node[]): Anchor[] {
	return nodes
		.filter((n) => n.parent === stepId && n.kind === "start_requirements")
		.flatMap((r) => r.blocks)
		.filter((a) => a.text.trim() && !isHeading(a.text) && isItem(a.text));
}

/** Same rule as the sheet's checklist: list items and short criteria are tickable, prose is not. */
const isItem = (t: string) => {
	const x = t.trim();
	if (/^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–\uf0b7\uf0a7]|o\s|\(?[a-z0-9]{1,2}[.)]\s)/i.test(x))
		return true;
	return x.length <= 140 && (x.match(/[.!?](\s|$)/g)?.length ?? 0) <= 1;
};

export interface ArmOption {
	id: string;
	label: string;
	/** "risk_group" options come from the protocol's risk group sections; "arm" from the step groups. */
	source: "risk_group" | "arm";
	criteria: Anchor[];
	firstStep?: string;
}

/** Risk groups (with their verbatim criteria), then the arms/phases that group treatment steps. */
export function armOptions(
	nodes: Node[],
	edges: Edge[],
	treatment?: Treatment,
): ArmOption[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const steps = nodes.filter((n) => n.kind === "step");
	const roots = flowRoots(steps, edges);
	if (treatment) {
		const rules = treatment.riskGroups.map((g) => {
			const rule = g.rule ? byId.get(g.rule) : undefined;
			return {
				id: g.id,
				label: g.title,
				source: "risk_group" as const,
				criteria: rule ? criteriaOf(rule) : [],
				firstStep: g.steps[0] ?? roots[0],
			};
		});
		const arms = treatment.arms.map((a) => {
			const p = a.node ? byId.get(a.node) : undefined;
			return {
				id: a.id,
				label: a.title,
				source: "arm" as const,
				criteria: p ? criteriaOf(p) : [],
				firstStep: a.steps[0],
			};
		});
		return [...rules, ...arms];
	}
	const out: ArmOption[] = nodes
		.filter((n) => n.kind === "risk_group")
		.map((n) => ({
			id: n.id,
			label: n.title,
			source: "risk_group" as const,
			criteria: criteriaOf(n),
			firstStep: roots[0],
		}));
	const seen = new Set<string>();
	for (const s of steps) {
		const key = s.parent ?? "";
		if (seen.has(key)) continue;
		seen.add(key);
		const p = byId.get(key);
		out.push({
			id: key || s.id,
			label: p?.title ?? "Treatment",
			source: "arm",
			criteria: p ? criteriaOf(p) : [],
			firstStep: s.id,
		});
	}
	return out;
}

/** Steps where a flow starts: no incoming next/alternative/restratify_to edge from another step. */
function flowRoots(steps: Node[], edges: Edge[]): string[] {
	const ids = new Set(steps.map((s) => s.id));
	const reached = new Set(
		edges.filter((e) => e.kind !== "see_also" && ids.has(e.from)).map((e) => e.to),
	);
	const fed = new Set(edges.filter((e) => e.kind !== "see_also").map((e) => e.from));
	return steps.filter((s) => !reached.has(s.id) && fed.has(s.id)).map((s) => s.id);
}

const sameTitle = (text: string, title: string) => {
	const n = (t: string) =>
		t
			.replace(/^[\d.\s]+/, "")
			.replace(/\W+/g, " ")
			.trim()
			.toLowerCase();
	return n(text) === n(title);
};

/** Where a step can lead: forks/next (flow) and re-stratification (another arm). */
export function stepExits(stepId: string, nodes: Node[], edges: Edge[]) {
	const ids = new Set(nodes.map((n) => n.id));
	const out = edges.filter(
		(e) => e.from === stepId && ids.has(e.to) && e.to !== stepId,
	);
	const flow = out.filter((e) => e.kind === "next" || e.kind === "alternative");
	const flowTo = new Set(flow.map((e) => e.to));
	const restrat = out.filter((e) => e.kind === "restratify_to" && !flowTo.has(e.to));
	return { flow, restrat };
}

export const quote = (a: Anchor) => a.text.replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ notes */

/**
 * A clinician's short note on a checklist line ("done 12/10, normal"). Free text, so it may hold
 * patient data: it stays in this tab (sessionStorage, next to the ticks), never in the case code or
 * a request, and only leaves through the EHR text the clinician copies.
 */
export interface LineNote {
	/** The protocol line, verbatim (for the EHR text). */
	line: string;
	page: number;
	note: string;
}

/** A case arm id's name and source section: a risk group (its defining section), a treatment arm (its phase) or a node. */
export function armSource(
	id: string,
	byId: Map<string, Node>,
	treatment?: Treatment,
): { title: string; node?: Node } {
	const g = treatment?.riskGroups.find((x) => x.id === id);
	if (g) return { title: g.title, node: g.rule ? byId.get(g.rule) : undefined };
	const a = treatment?.arms.find((x) => x.id === id);
	if (a) return { title: a.title, node: a.node ? byId.get(a.node) : undefined };
	const n = byId.get(id);
	return { title: n?.title ?? id, node: n };
}

/* ------------------------------------------------------------------ EHR text */

export function ehrSummary(opts: {
	state: CaseState;
	code: string;
	link: string;
	protocol: { short: string; version: string; sha: string };
	byId: Map<string, Node>;
	treatment?: Treatment;
	edges: Edge[];
	reqLines: Anchor[];
	hospital: string;
	hasRules: boolean;
	publishedNote?: string;
	/** Notes on checklist lines, in sheet order. */
	notes?: LineNote[];
}): string {
	const { state: c, byId } = opts;
	const t = (id?: string) => (id ? (byId.get(id)?.title ?? id) : "none");
	const src = c.arm ? armSource(c.arm, byId, opts.treatment) : undefined;
	const arm = src?.node;
	const crit = arm ? criteriaOf(arm).filter((_, i) => c.why.includes(i)) : [];
	const L: string[] = [];
	L.push(
		`Protocol: ${opts.protocol.short}, version ${opts.protocol.version} (PDF ${opts.protocol.sha.slice(0, 8)})`,
	);
	if (opts.publishedNote) L.push(opts.publishedNote);
	L.push(
		`Arm / risk group: ${src?.title ?? "none"}${arm ? ` (p. ${arm.pages.from})` : ""}`,
	);
	if (crit.length)
		for (const a of crit)
			L.push(`  criterion ticked: "${clip(quote(a))}" (p. ${a.page})`);
	else L.push("  criteria ticked: none");
	L.push(`Completed steps: ${c.done.length ? c.done.map(t).join("; ") : "none"}`);
	for (const f of c.forks) {
		const e = opts.edges.find(
			(x) => x.to === f.to && (x.from === f.from || x.kind === "restratify_to"),
		);
		L.push(
			`Branch taken: ${t(f.from)} -> ${t(f.to)}${e?.evidence ? `, per protocol: "${clip(quote(e.evidence))}" (p. ${e.evidence.page})` : ""}`,
		);
	}
	if (c.cur) {
		const n = byId.get(c.cur);
		L.push(
			`Current step: ${t(c.cur)}${n ? ` (p. ${n.pages.from})` : ""}, ${c.started ? "started" : "not started yet"}`,
		);
		if (opts.reqLines.length) {
			L.push(
				`  Requirements to start: ${c.req.length} of ${opts.reqLines.length} ticked by the clinician`,
			);
			opts.reqLines.forEach((a, i) =>
				L.push(
					`  [${c.req.includes(i) ? "x" : " "}] ${clip(quote(a), 110)} (p. ${a.page})`,
				),
			);
		} else
			L.push(
				"  Requirements to start: not found in the protocol text for this step",
			);
		if (opts.hasRules)
			L.push(
				`  ${opts.hospital} local rules for this step: ${c.rulesAck ? "read and acknowledged" : "not acknowledged"}`,
			);
	} else L.push("Current step: none (end of the protocol flow)");
	L.push(
		`Delays / deviations: ${
			c.delays.length
				? c.delays
						.map(
							(d) =>
								`${t(d.step)} postponed at protocol day ${d.day}, reason: ${DELAY_REASONS[d.reason]}`,
						)
						.join("; ")
				: "none"
		}`,
	);
	if (opts.notes?.length) {
		L.push("Notes on protocol lines:");
		for (const n of opts.notes)
			L.push(
				`  "${clip(n.line.replace(/\s+/g, " ").trim(), 90)}" (p. ${n.page}): ${n.note}`,
			);
	}
	L.push(
		"Ticks are the clinician's own; the app computes no eligibility and stores nothing.",
	);
	L.push(`Reopen: ${opts.link}`);
	L.push(`Case code: ${opts.code}`);
	return L.join("\n");
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Criteria lines of an arm node, in the same order the start screen numbered them. */
export function criteriaOf(arm: Node): Anchor[] {
	return arm.kind === "risk_group"
		? arm.blocks.filter(
				(a) => a.text.trim().length > 2 && !sameTitle(a.text, arm.title),
			)
		: arm.blocks
				.filter((a) => a.text.trim().length > 2 && a.text.length < 400)
				.slice(0, 12);
}
