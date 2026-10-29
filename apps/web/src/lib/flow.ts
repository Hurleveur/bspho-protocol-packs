/**
 * Treatment map model: arms (the same step grouping the contents list uses), and a layered
 * left-to-right layout of one arm's steps, with forks and exits to other arms.
 */
import type { Anchor, Edge, Node, Treatment } from "@bspho/protocol/spec";

export interface Arm {
	/** Parent node id of the arm's steps ("" when the steps have no parent). */
	key: string;
	label: string;
	/** Short tab label. */
	short: string;
	/** The steps' parent is a phase/arm node (not a plain section that happens to hold steps). */
	phase: boolean;
	steps: Node[];
}

/** The spec's arms; specs built before the treatment pass group steps by their parent (arm, phase). */
export function armsOf(
	steps: Node[],
	byId: Map<string, Node>,
	treatment?: Treatment,
): Arm[] {
	if (treatment) {
		const on = new Set(steps.map((s) => s.id));
		return treatment.arms
			.map((a) => ({
				key: a.id,
				label: a.title,
				short: a.label,
				phase: true,
				steps: a.steps.filter((id) => on.has(id)).map((id) => byId.get(id)!),
			}))
			.filter((a) => a.steps.length);
	}
	const out: Arm[] = [];
	const at = new Map<string, Arm>();
	for (const s of steps) {
		const key = s.parent ?? "";
		let arm = at.get(key);
		if (!arm) {
			const label = armLabel(byId.get(key)?.title ?? "");
			arm = {
				key,
				label,
				short: shortLabel(label),
				phase: byId.get(key)?.kind === "phase",
				steps: [],
			};
			at.set(key, arm);
			out.push(arm);
		}
		arm.steps.push(s);
	}
	// A generic parent ("13 Treatment Details") holding mostly induction steps is the induction arm.
	for (const arm of out)
		if (
			GENERIC.test(arm.label) &&
			arm.steps.filter((s) => /\binduction\b/i.test(s.title)).length >=
				arm.steps.length / 2
		) {
			arm.label = "Induction";
			arm.short = "Induction";
		}
	// Arms proper (phase nodes) first, other step groupings after.
	return [...out.filter((a) => a.phase), ...out.filter((a) => !a.phase)];
}

const GENERIC =
	/^(?:treatment|therapy)(?:\s+(?:details|overview|elements|plan|schedule))?$|^(?:overview|therapy elements|treatment and therapy|treatment overview(?: and details)?)$/i;

/** "Post-induction IR-High Treatment" → "IR-High"; "Experimental Arm: A Phase II…" → "Experimental Arm". */
export function shortLabel(label: string): string {
	const s = label
		.split(/\s+[–—-]\s+|:\s/)[0]
		.replace(/^post-induction\s+/i, "")
		.replace(/\s+(treatment|therapy)(\s+overview)?$/i, "")
		.replace(/\s+treatment(?=\s+for\b)/i, "")
		.replace(/\s+overview$/i, "")
		.trim();
	return s || label;
}

export const armLabel = (title: string) =>
	title.replace(/^[\d.]+\s*/, "").trim() || "Treatment";

/** "13.9.2 Standard risk consolidation 1" → ["13.9.2", "Standard risk consolidation 1"]. */
export function splitNumber(title: string): [string, string] {
	const m = /^((?:\d+\.)*\d+\.?|[IVX]+\.)\s+(.+)$/.exec(title.trim());
	return m ? [m[1].replace(/\.$/, ""), m[2]] : ["", title.trim()];
}

const FLOW = new Set<Edge["kind"]>(["next", "alternative", "restratify_to"]);
const DECISION = new Set<Node["kind"]>(["response_assessment", "restratification"]);

export const NODE_W = 150;
export const NODE_H = 64;
export const DEC_H = 56;
export const CHIP_W = 150;
export const CHIP_H = 36;
export const GAP_X = 42;
export const GAP_Y = 12;
export const PAD = 10;

export interface MapNode {
	id: string;
	node: Node;
	decision: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	rank: number;
}

export interface MapExit {
	key: string;
	edge: Edge;
	/** Source node on the map; null when the edge leaves from the arm node itself. */
	from: string | null;
	to: Node;
	/** Arm the target belongs to (a tab), when it is one. */
	arm?: Arm;
	/** Step to land on in that arm. */
	step?: string;
	label: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MapEdge {
	key: string;
	edge: Edge;
	d: string;
	/** Midpoint, for hover popovers. */
	mx: number;
	my: number;
}

export interface ArmMap {
	nodes: MapNode[];
	exits: MapExit[];
	edges: MapEdge[];
	/** Junction lines for arm-level exits (sinks → junction), drawn muted. */
	joins: string[];
	width: number;
	height: number;
	/** Fork node id → the alternative edges leaving it. */
	forks: Map<string, Edge[]>;
}

export function layoutArm(
	arm: Arm,
	arms: Arm[],
	allEdges: Edge[],
	byId: Map<string, Node>,
): ArmMap {
	const order = new Map([...byId.keys()].map((id, i) => [id, i]));
	const doc = (id: string) => order.get(id) ?? 0;
	const inArm = new Set(arm.steps.map((s) => s.id));
	const flow = allEdges.filter(
		(e) =>
			FLOW.has(e.kind) && e.from !== e.to && byId.has(e.from) && byId.has(e.to),
	);
	// Response assessments that bridge two steps of the arm sit on the map as decision nodes.
	for (const n of byId.values())
		if (
			DECISION.has(n.kind) &&
			flow.some((e) => e.to === n.id && inArm.has(e.from)) &&
			flow.some((e) => e.from === n.id && inArm.has(e.to))
		)
			inArm.add(n.id);
	const ids = [...inArm].sort((a, b) => doc(a) - doc(b));
	const internal = flow.filter((e) => inArm.has(e.from) && inArm.has(e.to));

	const armOfStep = new Map<string, Arm>();
	for (const a of arms) for (const s of a.steps) armOfStep.set(s.id, a);
	const armByKey = new Map(arms.filter((a) => a.key).map((a) => [a.key, a]));
	const exitEdges = flow.filter(
		(e) =>
			(inArm.has(e.from) || e.from === arm.key) &&
			!inArm.has(e.to) &&
			e.to !== arm.key,
	);
	const seen = new Set<string>();
	const exits: MapExit[] = [];
	for (const e of exitEdges) {
		const key = `${e.from}>${e.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const to = must(byId, e.to);
		const target = armByKey.get(e.to) ?? armOfStep.get(e.to);
		const step = armByKey.has(e.to)
			? target?.steps[0]?.id
			: armOfStep.has(e.to)
				? e.to
				: undefined;
		// The arm's name, or the step's when the edge lands mid-arm.
		const label =
			target && step === target.steps[0]?.id
				? target.short
				: splitNumber(to.title)[1];
		exits.push({
			key,
			edge: e,
			from: inArm.has(e.from) ? e.from : null,
			to,
			arm: target,
			step,
			label,
			x: 0,
			y: 0,
			w: CHIP_W,
			h: CHIP_H,
		});
	}

	// Rank = longest path from a source, along the arm's own edges.
	const rank = new Map(ids.map((id) => [id, 0]));
	for (let pass = 0; pass < ids.length; pass++) {
		let changed = false;
		for (const e of internal) {
			const r = must(rank, e.from) + 1;
			if (r > must(rank, e.to) && r < ids.length) {
				rank.set(e.to, r);
				changed = true;
			}
		}
		if (!changed) break;
	}

	// Connected components, laid out one under the other.
	const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const e of internal) {
		must(adj, e.from).push(e.to);
		must(adj, e.to).push(e.from);
	}
	const comp = new Map<string, number>();
	let nComp = 0;
	for (const id of ids) {
		if (comp.has(id)) continue;
		for (const q = [id]; q.length;) {
			const c = q.pop() ?? id;
			if (comp.has(c)) continue;
			comp.set(c, nComp);
			q.push(...must(adj, c));
		}
		nComp++;
	}

	const nodes = new Map<string, MapNode>();
	for (const id of ids) {
		const node = must(byId, id);
		const decision = DECISION.has(node.kind);
		nodes.set(id, {
			id,
			node,
			decision,
			rank: must(rank, id),
			x: 0,
			y: 0,
			w: NODE_W,
			h: decision ? DEC_H : NODE_H,
		});
	}
	const colX = (r: number) => PAD + r * (NODE_W + GAP_X);
	let top = PAD;
	let maxRank = 0;
	for (let c = 0; c < nComp; c++) {
		const members = ids.filter((id) => comp.get(id) === c);
		const items: {
			id: string;
			rank: number;
			h: number;
			preds: string[];
			set: (y: number) => void;
			get: () => number;
		}[] = [];
		for (const id of members) {
			const n = must(nodes, id);
			items.push({
				id,
				rank: n.rank,
				h: n.h,
				preds: internal.filter((e) => e.to === id).map((e) => e.from),
				set: (y) => (n.y = y),
				get: () => n.y,
			});
		}
		for (const x of exits)
			if (x.from && comp.get(x.from) === c)
				items.push({
					id: x.key,
					rank: must(nodes, x.from).rank + 1,
					h: x.h,
					preds: [x.from],
					set: (y) => (x.y = y),
					get: () => x.y,
				});
		const center = new Map<string, number>();
		const ranks = [...new Set(items.map((i) => i.rank))].sort((a, b) => a - b);
		let minY = Infinity;
		let maxY = -Infinity;
		for (const r of ranks) {
			const col = items
				.filter((i) => i.rank === r)
				.map((i) => {
					const ps = i.preds.filter((p) => center.has(p));
					return {
						i,
						want: ps.length
							? ps.reduce((s, p) => s + must(center, p), 0) / ps.length
							: null,
					};
				})
				.sort(
					(a, b) =>
						(a.want ?? 1e9) - (b.want ?? 1e9) || doc(a.i.id) - doc(b.i.id),
				);
			// Siblings wanting the same centre are centred around it as a group.
			let bottom = -Infinity;
			for (let k = 0; k < col.length;) {
				let j = k;
				while (j + 1 < col.length && col[j + 1].want === col[k].want) j++;
				const group = col.slice(k, j + 1);
				const h =
					group.reduce((s, g) => s + g.i.h, 0) + GAP_Y * (group.length - 1);
				let y =
					col[k].want === null
						? Number.isFinite(bottom)
							? bottom + GAP_Y
							: 0
						: (col[k].want ?? 0) - h / 2;
				if (Number.isFinite(bottom)) y = Math.max(y, bottom + GAP_Y);
				for (const g of group) {
					g.i.set(y);
					center.set(g.i.id, y + g.i.h / 2);
					minY = Math.min(minY, y);
					y += g.i.h + GAP_Y;
				}
				bottom = y - GAP_Y;
				maxY = Math.max(maxY, bottom);
				k = j + 1;
			}
			maxRank = Math.max(maxRank, r);
		}
		for (const i of items) i.set(i.get() - minY + top);
		top += maxY - minY + GAP_Y * 2.5;
	}
	for (const n of nodes.values()) n.x = colX(n.rank);
	for (const x of exits) if (x.from) x.x = colX(must(nodes, x.from).rank + 1);
	let height = Math.max(top - GAP_Y * 2.5 + PAD, PAD * 2 + NODE_H);

	// Arm-level exits (from the arm node itself): one column after everything, fed by the sinks.
	const armExits = exits.filter((x) => !x.from);
	const joins: string[] = [];
	let junction: { x: number; y: number } | null = null;
	if (armExits.length) {
		const cx = colX(maxRank + 1);
		const total = armExits.length * CHIP_H + (armExits.length - 1) * GAP_Y;
		height = Math.max(height, total + PAD * 2);
		let y = (height - total) / 2;
		for (const x of armExits) {
			x.x = cx;
			x.y = y;
			y += CHIP_H + GAP_Y;
		}
		const jx = cx - GAP_X / 2;
		const jy = height / 2;
		const fed = new Set(internal.map((e) => e.from));
		for (const n of nodes.values())
			if (!fed.has(n.id)) joins.push(curve(n.x + n.w, n.y + n.h / 2, jx, jy));
		// Junction → chips are proper edges below (they carry evidence).
		junction = { x: jx, y: jy };
	}

	const edges: MapEdge[] = [];
	for (const e of internal) {
		const a = must(nodes, e.from);
		const b = must(nodes, e.to);
		edges.push(
			mk(
				`${e.from}>${e.to}:${e.kind}`,
				e,
				a.x + a.w,
				a.y + a.h / 2,
				b.x,
				b.y + b.h / 2,
			),
		);
	}
	for (const x of exits) {
		const a = x.from ? must(nodes, x.from) : null;
		const [sx, sy] = a
			? [a.x + a.w, a.y + a.h / 2]
			: [junction?.x ?? 0, junction?.y ?? 0];
		edges.push(mk(`${x.key}:exit`, x.edge, sx, sy, x.x, x.y + x.h / 2));
	}
	const forks = new Map<string, Edge[]>();
	for (const e of internal)
		if (
			e.kind === "alternative" ||
			(e.kind === "restratify_to" &&
				internal.filter((f) => f.from === e.from).length > 1)
		)
			forks.set(e.from, [...(forks.get(e.from) ?? []), e]);

	const right = Math.max(
		...[...nodes.values()].map((n) => n.x + n.w),
		...exits.map((x) => x.x + x.w),
	);
	return {
		nodes: [...nodes.values()],
		exits,
		edges,
		joins,
		width: right + PAD,
		height,
		forks,
	};
}

function curve(x1: number, y1: number, x2: number, y2: number) {
	const dx = Math.max(18, (x2 - x1) / 2);
	return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function mk(
	key: string,
	edge: Edge,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): MapEdge {
	return {
		key,
		edge,
		d: curve(x1, y1, x2 - 6, y2),
		mx: (x1 + x2) / 2,
		my: (y1 + y2) / 2,
	};
}

/** The evidence sentences of a fork: what decides between the branches. */
export const forkEvidence = (edges: Edge[]): Anchor[] =>
	edges.flatMap((e) => (e.evidence ? [e.evidence] : []));

/** Map lookup of a key the layout put there itself. */
function must<K, V>(m: Map<K, V>, k: K): V {
	const v = m.get(k);
	if (v === undefined) throw new Error(`treatment map: missing ${String(k)}`);
	return v;
}

/** A parent title that names no arm ("Therapy Elements", "13 Treatment Details"). */
export const isGenericArm = (label: string) =>
	GENERIC.test(label.replace(/^[\d.]+\s*/, "").trim());
