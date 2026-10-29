/**
 * Locate a quote on a page and check its numbers against the matched passage.
 *
 * A quote is verified only if (1) a contiguous passage of the page matches it closely
 * and (2) every number in the quote appears, with the same value, in that passage.
 * The second gate is what stops "WBC >3.0" from verifying against "WBC >1.5".
 */

export const MIN_SCORE = 0.9;

// Bullets, private-use glyphs (Wingdings ticks) that PDF extraction scatters.
const JUNK = /[•●▪◦■□♦◆►▸➢➤✓✔•▪-]/g;
// ×10⁹/L in all the ways the corpus spells it ("x109/L" is the superscript flattened).
const COUNT_UNIT = /[x×]\s*10\s*(?:\^|\s)?\s*(?:9|⁹)\s*\/\s*l\b/g;
const NUMBER = /(?<![\d.,])\d+(?:[.,]\d+)?(?!\d)/g;

export function normalize(s: string): string {
	let t = s.normalize("NFKC").replace(/(\w)-\s*\n\s*(\w)/g, "$1$2").replace(JUNK, " ");
	for (const [a, b] of [["’", "'"], ["‘", "'"], ["“", '"'], ["”", '"'], ["–", "-"], ["—", "-"], ["…", "..."]] as const) {
		t = t.replaceAll(a, b);
	}
	return t.replace(/\s+/g, " ").trim().toLowerCase().replace(COUNT_UNIT, "x10^9/l");
}

/** Numbers in a normalized string, ignoring the exponent in the count unit. */
export function numbers(s: string): string[] {
	return (s.replaceAll("x10^9/l", " ").match(NUMBER) ?? []).map((n) => n.replace(",", "."));
}

/** Similarity ratio (2*matches / total) via longest common subsequence on characters; strings here are short. */
function ratio(a: string, b: string): number {
	if (!a.length && !b.length) return 1;
	const prev = new Uint16Array(b.length + 1);
	const cur = new Uint16Array(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
		}
		prev.set(cur);
	}
	return (2 * prev[b.length]) / (a.length + b.length);
}

/** Best ratio of q against a contiguous window of t of about the same length, anchored on shared 8-grams. */
function bestWindow(q: string, t: string): { score: number; start: number; passage: string } {
	const exact = t.indexOf(q);
	if (exact >= 0) return { score: 1, start: exact, passage: q };
	const starts = new Set<number>();
	for (let k = 0; k + 8 <= q.length; k += 4) {
		const gram = q.slice(k, k + 8);
		for (let i = t.indexOf(gram); i >= 0; i = t.indexOf(gram, i + 1)) starts.add(Math.max(0, i - k));
	}
	let best = { score: 0, start: -1, passage: "" };
	for (const s of starts) {
		for (const w of [q.length, Math.round(q.length * 1.1), Math.round(q.length * 0.9)]) {
			const win = t.slice(s, s + w);
			const r = ratio(win, q);
			if (r > best.score) best = { score: r, start: s, passage: win };
		}
	}
	return best;
}

export interface Located {
	score: number;
	verified: boolean;
	/** The normalized page passage the quote matched. */
	passage: string;
}

/** Elided quotes ("A ... B") must match every segment, in order, within 600 characters of each other. */
export function locate(quote: string, pageText: string): Located {
	const q = normalize(quote);
	const t = normalize(pageText);
	if (!q || !t) return { score: 0, verified: false, passage: "" };
	const segs = q.split(/\.{3,}/).map((s) => s.trim()).filter(Boolean);
	let score: number;
	let passage: string;
	if (segs.length > 1) {
		let pos = 0;
		const parts: string[] = [];
		const scores: number[] = [];
		for (const seg of segs) {
			const rest = t.slice(pos);
			const w = bestWindow(seg, rest);
			if (w.start < 0 || (parts.length && w.start > 600)) return { score: 0, verified: false, passage: "" };
			scores.push(w.score);
			parts.push(w.passage);
			pos += w.start + w.passage.length;
		}
		score = Math.min(...scores);
		passage = parts.join(" ... ");
	} else {
		({ score, passage } = bestWindow(q, t));
	}
	const qn = numbers(q).sort().join("|");
	const numbersOk = qn === "" || qn === numbers(passage).sort().join("|");
	return { score: Math.round(score * 1000) / 1000, verified: score >= MIN_SCORE && numbersOk, passage };
}
