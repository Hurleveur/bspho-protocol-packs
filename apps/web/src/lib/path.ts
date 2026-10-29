/**
 * Risk-group paths: which treatment steps one risk group goes through, so the sheet can show that
 * path and fold the others away. Read from the spec's own structure, never guessed from wording alone:
 *
 * 1. Arms by re-stratification: one arm (induction) has restratify_to edges into two or more phase
 *    arms (SR, IR-Low, IR-High...). Each target arm is a group; its path is the source arm, then it.
 * 2. Steps by their title's risk prefix: one arm holds steps titled "Very High Risk: CT1A",
 *    "HR: CT2B", "Standard Risk Induction". Each prefix is a group; untitled steps of that arm are
 *    shared. Dropped when a next edge links two different prefixes (the titles would be lying).
 *
 * 3. Arms titled by risk group (see byArmTitles).
 *
 * Anything else gets no groups: a wrong path shown to a doctor is worse than none.
 */
import type { Edge, Node, Treatment } from "@bspho/protocol/spec";
import { type Arm, armsOf } from "./flow";

export interface Segment {
	/** The arm the steps come from (its label heads the segment). */
	arm: Arm;
	steps: Node[];
	/** The re-stratification edge that leads into this segment, when there is one. */
	entry?: Edge;
}

export interface RiskPath {
	/** URL slug (?g=). */
	id: string;
	/** Chip label. */
	label: string;
	/** Full name, as the protocol titles the arm. */
	title: string;
	segments: Segment[];
	/** Every step on the path. */
	steps: Set<string>;
	/** Arm keys on the path. */
	arms: Set<string>;
	/** Arm keys that belong to this group only (not the shared trunk). */
	own: Set<string>;
}

const FLOW = new Set<Edge["kind"]>(["next", "alternative", "restratify_to"]);

export const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** "High-Risk (HR) for BCP-patients" → "HR BCP"; "Therapy for Down Patients" → "Down". */
export function groupLabel(short: string): string {
	let s = short
		.split(/\s+[–—-]\s+/)[0]
		.replace(/^post[\s-]+induction\s+/i, "")
		.replace(/\s+treatment\b/i, "")
		.replace(/^therapy\s+for\s+/i, "")
		.replace(/^patients\s+with\s+/i, "")
		.trim();
	const m = /^.*\(([A-Z][A-Za-z-]*)\)\s+for\s+(.+)$/.exec(s);
	if (m) s = `${m[1]} ${m[2]}`;
	return s.replace(/[-\s]patients?$/i, "").trim() || short;
}

/** An arm's short name: the group's chip label when the arm is one group's own, else its tab label. */
export function armName(arm: Arm, paths: RiskPath[]): string {
	const own = paths.filter((p) => p.own.size === 1 && p.own.has(arm.key));
	return own.length === 1 ? own[0].label : arm.short;
}

export function riskPaths(
	steps: Node[],
	byId: Map<string, Node>,
	edges: Edge[],
	treatment?: Treatment,
): RiskPath[] {
	if (treatment)
		return fromTreatment(treatment, armsOf(steps, byId, treatment), edges);
	const arms = armsOf(steps, byId);
	return (
		byArms(arms, edges, byId) ?? byArmTitles(arms) ?? byTitles(arms, edges) ?? []
	);
}

/** The spec's risk groups: each a path through its arms, entered by the flow edge that leads into each segment. */
function fromTreatment(t: Treatment, arms: Arm[], edges: Edge[]): RiskPath[] {
	const byKey = new Map(arms.map((a) => [a.key, a]));
	const groupsOf = new Map<string, number>();
	for (const g of t.riskGroups)
		for (const a of g.arms) groupsOf.set(a, (groupsOf.get(a) ?? 0) + 1);
	const flow = edges.filter((e) => FLOW.has(e.kind) && e.kind !== "next");
	return t.riskGroups.map((g) => {
		const on = new Set(g.steps);
		const segments: Segment[] = [];
		for (const key of g.arms) {
			const arm = byKey.get(key);
			if (!arm) continue;
			const steps = arm.steps.filter((s) => on.has(s.id));
			const prev = new Set(
				segments.flatMap((x) => [x.arm.key, ...x.steps.map((s) => s.id)]),
			);
			const into = new Set([arm.key, ...steps.map((s) => s.id)]);
			const entry =
				flow.find((e) => e.evidence && prev.has(e.from) && into.has(e.to)) ??
				flow.find((e) => prev.has(e.from) && into.has(e.to));
			if (steps.length)
				segments.push({ arm, steps, ...(entry ? { entry } : {}) });
		}
		return {
			id: g.id,
			label: g.label,
			title: g.title,
			segments,
			steps: on,
			arms: new Set(g.arms),
			own: new Set(g.arms.filter((a) => groupsOf.get(a) === 1)),
		};
	});
}

/** An arm the protocol itself titles by its patients: "Post-induction IR-Low Treatment", "Therapy for Down Patients". */
const GROUP_ARM =
	/post[\s-]+induction|standard[\s-]+risk|intermediate[\s-]+risk|high[\s-]+risk|\b(?:SR|IR|HR|VHR)\b|\bdown\b/i;

/**
 * 3. Arms titled by risk group: two or more phase arms named after their patients, after one
 *    induction arm. Each is a group; its path is induction, then that arm. The protocol's own
 *    section titles say it, so no edge is needed (the deciding rule is in Risk groups).
 */
function byArmTitles(arms: Arm[]): RiskPath[] | null {
	const groups = arms.filter((a) => a.phase && GROUP_ARM.test(a.label));
	if (groups.length < 2) return null;
	const trunk = arms.find(
		(a) =>
			!groups.includes(a) &&
			a.steps.length >= 2 &&
			a.steps.filter((s) => /\binduction\b/i.test(s.title)).length >=
				a.steps.length / 2,
	);
	if (!trunk) return null;
	return unique(
		groups.map((arm) => {
			const label = groupLabel(arm.short || arm.label);
			return {
				id: slug(label),
				label,
				title: arm.label,
				segments: [
					{ arm: trunk, steps: trunk.steps },
					{ arm, steps: arm.steps },
				],
				steps: new Set([...trunk.steps, ...arm.steps].map((s) => s.id)),
				arms: new Set([trunk.key, arm.key]),
				own: new Set([arm.key]),
			};
		}),
	);
}

function byArms(
	arms: Arm[],
	edges: Edge[],
	byId: Map<string, Node>,
): RiskPath[] | null {
	const armByKey = new Map(
		arms.filter((a) => a.key && a.phase).map((a) => [a.key, a]),
	);
	const armOfStep = new Map<string, Arm>();
	for (const a of arms) for (const s of a.steps) armOfStep.set(s.id, a);
	// Source arm → the phase arms it re-stratifies into.
	const out = new Map<string, Map<string, Edge>>();
	for (const e of edges) {
		if (e.kind !== "restratify_to") continue;
		const to = armByKey.get(e.to);
		const from = armByKey.get(e.from) ?? armOfStep.get(e.from);
		if (!to || !from || to === from) continue;
		const m = out.get(from.key) ?? new Map<string, Edge>();
		// Keep the edge with evidence when there are several.
		if (!m.get(to.key)?.evidence) m.set(to.key, e);
		out.set(from.key, m);
	}
	const best = [...out.entries()].sort((a, b) => b[1].size - a[1].size)[0];
	if (!best || best[1].size < 2) return null;
	const trunk = arms.find((a) => a.key === best[0]);
	if (!trunk) return null;
	const order = new Map([...byId.keys()].map((id, i) => [id, i]));
	const targets = [...best[1].entries()].sort(
		(a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0),
	);
	const paths: RiskPath[] = [];
	for (const [key, entry] of targets) {
		const arm = armByKey.get(key);
		if (!arm || arm === trunk) continue;
		const label = groupLabel(arm.short);
		paths.push({
			id: slug(label),
			label,
			title: arm.label,
			segments: [
				{ arm: trunk, steps: trunk.steps },
				{ arm, steps: arm.steps, entry },
			],
			steps: new Set([...trunk.steps, ...arm.steps].map((s) => s.id)),
			arms: new Set([trunk.key, arm.key]),
			own: new Set([arm.key]),
		});
	}
	return unique(paths);
}

/** Risk prefixes at the start of a step title (after its number), most specific first. */
const PREFIXES: [string, string, RegExp][] = [
	["vhr", "Very high risk", /^(?:very[\s-]+high[\s-]+risk|VHR)\b/i],
	["hr", "High risk", /^(?:high[\s-]+risk|HR)\b/i],
	["ir", "Intermediate risk", /^(?:intermediate[\s-]+risk|IR)\b/i],
	["sr", "Standard risk", /^(?:standard[\s-]+risk|SR)\b/i],
	["lr", "Low risk", /^(?:low[\s-]+risk|LR)\b/i],
];

const prefixOf = (title: string) => {
	const t = title.replace(/^(?:\d+\.)*\d+\.?\s+/, "").trim();
	return PREFIXES.find(([, , re]) => re.test(t));
};

function byTitles(arms: Arm[], edges: Edge[]): RiskPath[] | null {
	let best: { arm: Arm; tags: Map<string, string> } | null = null;
	for (const arm of arms) {
		const tags = new Map<string, string>();
		for (const s of arm.steps) {
			const p = prefixOf(s.title);
			if (p) tags.set(s.id, p[0]);
		}
		const n = new Set(tags.values()).size;
		if (n >= 2 && (!best || n > new Set(best.tags.values()).size))
			best = { arm, tags };
	}
	if (!best) return null;
	const { arm, tags } = best;
	// A flow edge between two different prefixes means the titles do not partition the arm.
	for (const e of edges)
		if (
			FLOW.has(e.kind) &&
			tags.has(e.from) &&
			tags.has(e.to) &&
			tags.get(e.from) !== tags.get(e.to)
		)
			return null;
	// And at least one evidenced flow edge inside a prefix confirms the titles describe a path.
	if (
		!edges.some(
			(e) =>
				FLOW.has(e.kind) &&
				e.evidence &&
				e.from !== e.to &&
				tags.has(e.from) &&
				tags.get(e.from) === tags.get(e.to),
		)
	)
		return null;
	const paths: RiskPath[] = [];
	for (const [code, label] of PREFIXES) {
		if (![...tags.values()].includes(code)) continue;
		const steps = arm.steps.filter(
			(s) => !tags.has(s.id) || tags.get(s.id) === code,
		);
		paths.push({
			id: code,
			label,
			title: label,
			segments: [{ arm, steps }],
			steps: new Set(steps.map((s) => s.id)),
			arms: new Set([arm.key]),
			own: new Set(),
		});
	}
	return paths;
}

const unique = (paths: RiskPath[]) => {
	const seen = new Set<string>();
	return paths.map((p) => {
		let id = p.id || "group";
		for (let i = 2; seen.has(id); i++) id = `${p.id}-${i}`;
		seen.add(id);
		return { ...p, id };
	});
};

export interface Slot {
	steps: Node[];
	/** Arm shown as one entry: its steps carry no flow between them (Induction A-F). */
	folded?: Arm;
	/** Fork / re-stratification edges into this slot, with the deciding sentences. */
	via: Edge[];
}

/**
 * A segment's steps in reading order, alternatives of one fork merged into one slot. A segment of
 * three or more steps with no flow edges between them, or with several separate chains (Down SR /
 * IR / HR in one arm), is folded into one entry: read in a row they would look like one sequence.
 */
export function slotsOf(seg: Segment, edges: Edge[]): Slot[] {
	const ids = new Set(seg.steps.map((s) => s.id));
	const flow = edges.filter((e) => FLOW.has(e.kind) && e.from !== e.to);
	const internal = flow.filter((e) => ids.has(e.from) && ids.has(e.to));
	if (seg.steps.length >= 3 && (!internal.length || chains(ids, internal) > 1))
		return [{ steps: seg.steps, folded: seg.arm, via: [] }];
	// Branching edges: a source with two or more alternative / re-stratification targets on the path.
	const branching = (e: Edge) =>
		(e.kind === "alternative" || e.kind === "restratify_to") &&
		ids.has(e.to) &&
		flow.filter((f) => f.from === e.from && f.kind === e.kind && ids.has(f.to))
			.length >= 2;
	const out: Slot[] = [];
	const byKey = new Map<string, Slot>();
	for (const s of seg.steps) {
		const into = flow.filter(
			(e) =>
				e.to === s.id &&
				(e.kind === "alternative" || e.kind === "restratify_to"),
		);
		const fork = into.find(branching);
		const key = fork ? `${fork.from}:${fork.kind}` : undefined;
		const slot = key ? byKey.get(key) : undefined;
		if (slot) {
			slot.steps.push(s);
			slot.via.push(...into);
			continue;
		}
		const next: Slot = { steps: [s], via: into };
		if (key) byKey.set(key, next);
		out.push(next);
	}
	return out;
}

/** Number of connected chains of two or more steps. */
function chains(ids: Set<string>, internal: Edge[]): number {
	const adj = new Map<string, string[]>([...ids].map((id) => [id, []]));
	for (const e of internal) {
		adj.get(e.from)?.push(e.to);
		adj.get(e.to)?.push(e.from);
	}
	const seen = new Set<string>();
	let n = 0;
	for (const id of ids) {
		if (seen.has(id)) continue;
		let size = 0;
		for (const q = [id]; q.length;) {
			const c = q.pop() ?? id;
			if (seen.has(c)) continue;
			seen.add(c);
			size++;
			q.push(...(adj.get(c) ?? []));
		}
		if (size >= 2) n++;
	}
	return n;
}
