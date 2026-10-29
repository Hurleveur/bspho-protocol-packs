/**
 * What changed between two versions of a protocol: pure, spec in, summary out.
 *
 * Nodes are matched by (kind, normalised title), falling back to the normalised title
 * alone (the labeller may give a heading another kind from one version to the next).
 * A matched node is "changed" when any of its block texts differ; its blocks are aligned
 * and diffed word by word, numbers emphasised. Running headers and footers (lines repeated
 * on many pages, digits ignored) are dropped first, or every page would differ by its
 * version stamp.
 *
 * Order: numeric changes first (doses, counts, thresholds), then textual, then structural
 * (sections added or removed).
 */
import type { Node, NodeKind, ProtocolSpec } from "./spec.ts";
import { normalize } from "./verify.ts";

export type Segment = { op: "same" | "del" | "add"; text: string };

export interface NumberChange {
	before: string;
	old: string;
	new: string;
	after: string;
}

export interface BlockChange {
	op: "changed" | "added" | "removed";
	/** Word-level diff; for added/removed blocks a single add/del segment. */
	segments: Segment[];
	/** Edits that touch a number, e.g. { before: "platelets", old: ">50", new: ">75", after: "x10^9/L" }. */
	numbers: NumberChange[];
	page: { old: number | null; new: number | null };
}

export interface NodeChange {
	status: "added" | "removed" | "changed";
	category: "numeric" | "textual" | "structural";
	kind: NodeKind;
	title: string;
	/** Node id in the new spec (added/changed) or the old one (removed). */
	nodeId: string;
	headingPath: string[];
	pages: { old: Node["pages"] | null; new: Node["pages"] | null };
	blocks: BlockChange[];
}

export interface SpecDiff {
	from: { version: string; sha256: string };
	to: { version: string; sha256: string };
	counts: {
		added: number;
		removed: number;
		changed: number;
		numeric: number;
		unchanged: number;
	};
	changes: NodeChange[];
}

const HAS_DIGIT = /\d/;
const titleKey = (t: string) => normalize(t).replace(/^[\d.\s]+/, "");

/** Lines that repeat on many pages (running header/footer), digits masked. */
function boilerplate(spec: ProtocolSpec): Set<string> {
	const pages = new Map<string, Set<number>>();
	for (const n of spec.nodes)
		for (const b of n.blocks)
			for (const l of b.text.split("\n")) {
				const k = mask(l);
				if (!k) continue;
				let s = pages.get(k);
				if (!s) pages.set(k, (s = new Set()));
				s.add(b.page);
			}
	const min = Math.max(10, 0.2 * spec.doc.pageCount);
	return new Set([...pages].filter(([, s]) => s.size >= min).map(([k]) => k));
}
const mask = (l: string) => normalize(l).replace(/\d+/g, "#");

type Blk = { text: string; norm: string; page: number };

function blocksOf(n: Node, boiler: Set<string>): Blk[] {
	const out: Blk[] = [];
	for (const b of n.blocks) {
		const text = b.text
			.split("\n")
			.filter((l) => !boiler.has(mask(l)))
			.join("\n")
			.trim();
		if (text) out.push({ text, norm: normalize(text), page: b.page });
	}
	return out;
}

/** Longest-common-subsequence alignment of two sequences; returns the edit script. */
function align<T>(
	a: T[],
	b: T[],
	eq: (x: T, y: T) => boolean,
): ({ op: "same"; a: T; b: T } | { op: "del"; a: T } | { op: "add"; b: T })[] {
	const n = a.length;
	const m = b.length;
	// Trim common prefix/suffix: most blocks and words are unchanged.
	let pre = 0;
	while (pre < n && pre < m && eq(a[pre], b[pre])) pre++;
	let suf = 0;
	while (suf < n - pre && suf < m - pre && eq(a[n - 1 - suf], b[m - 1 - suf])) suf++;
	const A = a.slice(pre, n - suf);
	const B = b.slice(pre, m - suf);
	const dp: Uint32Array[] = Array.from(
		{ length: A.length + 1 },
		() => new Uint32Array(B.length + 1),
	);
	for (let i = A.length - 1; i >= 0; i--)
		for (let j = B.length - 1; j >= 0; j--)
			dp[i][j] = eq(A[i], B[j])
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
	const mid: ReturnType<typeof align<T>> = [];
	let i = 0;
	let j = 0;
	while (i < A.length || j < B.length) {
		if (i < A.length && j < B.length && eq(A[i], B[j]))
			mid.push({ op: "same", a: A[i++], b: B[j++] });
		else if (j < B.length && (i === A.length || dp[i][j + 1] >= dp[i + 1][j]))
			mid.push({ op: "add", b: B[j++] });
		else mid.push({ op: "del", a: A[i++] });
	}
	return [
		...a.slice(0, pre).map((x, k) => ({ op: "same" as const, a: x, b: b[k] })),
		...mid,
		...a
			.slice(n - suf)
			.map((x, k) => ({ op: "same" as const, a: x, b: b[m - suf + k] })),
	];
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const wordKey = (w: string) => normalize(w);

function wordDiff(
	oldText: string,
	newText: string,
): { segments: Segment[]; numbers: NumberChange[] } {
	const script = align(
		words(oldText),
		words(newText),
		(x, y) => wordKey(x) === wordKey(y),
	);
	// Group into runs: unchanged words, then each edit hunk as "removed words, added words".
	const segments: Segment[] = [];
	const numbers: NumberChange[] = [];
	const CONTEXT = 3;
	let waiting: { n: NumberChange; words: string[] }[] = [];
	let lastSame: string[] = [];
	let same: string[] = [];
	let del: string[] = [];
	let add: string[] = [];
	const flushEdit = () => {
		if (!del.length && !add.length) return;
		const d = del.join(" ");
		const a = add.join(" ");
		if (d) segments.push({ op: "del", text: d });
		if (a) segments.push({ op: "add", text: a });
		if (HAS_DIGIT.test(d) || HAS_DIGIT.test(a)) {
			const n = {
				before: lastSame.slice(-CONTEXT).join(" "),
				old: d,
				new: a,
				after: "",
			};
			numbers.push(n);
			waiting.push({ n, words: [] });
		}
		del = [];
		add = [];
	};
	for (const s of script) {
		if (s.op === "same") {
			flushEdit();
			same.push(s.b);
			lastSame = same;
			for (const w of waiting)
				if (w.words.length < CONTEXT)
					w.n.after = (w.words = [...w.words, s.b]).join(" ");
			waiting = waiting.filter((w) => w.words.length < CONTEXT);
			continue;
		}
		if (same.length) segments.push({ op: "same", text: same.join(" ") });
		same = [];
		if (s.op === "del") del.push(s.a);
		else add.push(s.b);
	}
	flushEdit();
	if (same.length) segments.push({ op: "same", text: same.join(" ") });
	return { segments, numbers };
}

function diffBlocks(oldB: Blk[], newB: Blk[]): BlockChange[] {
	const script = align(oldB, newB, (x, y) => x.norm === y.norm);
	const out: BlockChange[] = [];
	// Pair each run of removed blocks with the run of added blocks next to it: edited paragraphs.
	let dels: Blk[] = [];
	let adds: Blk[] = [];
	const flush = () => {
		const pairs = Math.min(dels.length, adds.length);
		for (let k = 0; k < pairs; k++) {
			const { segments, numbers } = wordDiff(dels[k].text, adds[k].text);
			out.push({
				op: "changed",
				segments,
				numbers,
				page: { old: dels[k].page, new: adds[k].page },
			});
		}
		for (const d of dels.slice(pairs))
			out.push({
				op: "removed",
				segments: [{ op: "del", text: d.text }],
				numbers: [],
				page: { old: d.page, new: null },
			});
		for (const a of adds.slice(pairs))
			out.push({
				op: "added",
				segments: [{ op: "add", text: a.text }],
				numbers: [],
				page: { old: null, new: a.page },
			});
		dels = [];
		adds = [];
	};
	for (const s of script) {
		if (s.op === "same") flush();
		else if (s.op === "del") dels.push(s.a);
		else adds.push(s.b);
	}
	flush();
	return out;
}

export function diffSpecs(prev: ProtocolSpec, next: ProtocolSpec): SpecDiff {
	const boilerOld = boilerplate(prev);
	const boilerNew = boilerplate(next);

	// Index old nodes by (kind, title) and by title; each old node is used once.
	const byKindTitle = new Map<string, Node[]>();
	const byTitle = new Map<string, Node[]>();
	for (const n of prev.nodes) {
		const t = titleKey(n.title);
		byKindTitle.set(`${n.kind}|${t}`, [
			...(byKindTitle.get(`${n.kind}|${t}`) ?? []),
			n,
		]);
		byTitle.set(t, [...(byTitle.get(t) ?? []), n]);
	}
	const used = new Set<string>();
	const take = (list: Node[] | undefined) => {
		const n = list?.find((x) => !used.has(x.id));
		if (n) used.add(n.id);
		return n;
	};

	const changes: NodeChange[] = [];
	let unchanged = 0;
	const pairs: [Node, Node][] = [];
	const added: Node[] = [];
	for (const n of next.nodes) {
		const t = titleKey(n.title);
		const o = take(byKindTitle.get(`${n.kind}|${t}`));
		if (o) pairs.push([o, n]);
		else added.push(n);
	}
	// Second pass for the title-only fallback, so exact (kind, title) matches win first.
	const stillAdded: Node[] = [];
	for (const n of added) {
		const o = take(byTitle.get(titleKey(n.title)));
		if (o) pairs.push([o, n]);
		else stillAdded.push(n);
	}

	for (const [o, n] of pairs) {
		const blocks = diffBlocks(blocksOf(o, boilerOld), blocksOf(n, boilerNew));
		if (!blocks.length) {
			unchanged++;
			continue;
		}
		changes.push({
			status: "changed",
			category: blocks.some((b) => b.numbers.length) ? "numeric" : "textual",
			kind: n.kind,
			title: n.title,
			nodeId: n.id,
			headingPath: n.headingPath,
			pages: { old: o.pages, new: n.pages },
			blocks,
		});
	}
	for (const n of stillAdded)
		changes.push({
			status: "added",
			category: "structural",
			kind: n.kind,
			title: n.title,
			nodeId: n.id,
			headingPath: n.headingPath,
			pages: { old: null, new: n.pages },
			blocks: [],
		});
	for (const o of prev.nodes)
		if (!used.has(o.id))
			changes.push({
				status: "removed",
				category: "structural",
				kind: o.kind,
				title: o.title,
				nodeId: o.id,
				headingPath: o.headingPath,
				pages: { old: o.pages, new: null },
				blocks: [],
			});

	const rank = { numeric: 0, textual: 1, structural: 2 };
	const page = (c: NodeChange) => (c.pages.new ?? c.pages.old)!.from;
	changes.sort((a, b) => rank[a.category] - rank[b.category] || page(a) - page(b));

	return {
		from: { version: prev.doc.version, sha256: prev.doc.sha256 },
		to: { version: next.doc.version, sha256: next.doc.sha256 },
		counts: {
			added: stillAdded.length,
			removed: prev.nodes.length - used.size,
			changed: changes.filter((c) => c.status === "changed").length,
			numeric: changes.filter((c) => c.category === "numeric").length,
			unchanged,
		},
		changes,
	};
}
