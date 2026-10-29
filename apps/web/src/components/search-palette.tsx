"use client";

import type { ProtocolSpec } from "@bspho/protocol/spec";
import { History, ListChecks, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fold, type Hit, ProtocolIndex } from "@/lib/search";
import type { Recent } from "./jump-history";
import { summaryOf, titleOf, useProtoLang } from "./proto-lang";
import type { Target } from "./pack";

/**
 * Protocol search: synonyms (ANC = neutrophils, LP = lumbar puncture, Dutch/French terms),
 * typo tolerance, units in any spelling, and ranking that knows the sheet. When the best match is a
 * "requirements to start" section, it opens as an answer card with the whole verbatim block.
 */
/** The last query, kept for the next Ctrl+K in this tab (selected on open, so typing replaces it). */
let lastQuery = "";

export function SearchPalette({
	spec,
	recents = [],
	onClose,
	onPick,
}: {
	spec: ProtocolSpec;
	/** Last places jumped to in this tab, newest first: shown while the query is empty. */
	recents?: Recent[];
	onClose: () => void;
	onPick: (t: Target) => void;
}) {
	const { lang } = useProtoLang();
	const index = useMemo(
		() => new ProtocolIndex(spec, lang === "orig" ? undefined : lang),
		[spec, lang],
	);
	const byId = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec]);
	const [q, setQ] = useState(lastQuery);
	const [sel, setSel] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);

	// The same sentence is often restated in several sections: show it once, at its best-ranked place.
	const hits = useMemo(() => {
		const seen = new Set<string>();
		return index.search(q).filter((h) => {
			const k = fold(h.text).replace(/\s+/g, " ").trim();
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	}, [index, q]);
	// Answer card: the top hit sits in (or is) a requirements-to-start section: show that whole block.
	const card = useMemo(() => {
		const top = hits[0];
		if (!top) return null;
		const node = byId.get(top.nodeId);
		const req = node?.kind === "start_requirements" ? node : undefined;
		if (!req || !req.blocks.length) return null;
		const step = req.parent ? byId.get(req.parent) : undefined;
		return { req, step };
	}, [hits, byId]);
	// Group the rest by section, keeping rank order of each section's best line.
	const groups = useMemo(() => {
		const m = new Map<string, Hit[]>();
		for (const h of hits) m.set(h.nodeId, [...(m.get(h.nodeId) ?? []), h]);
		return [...m.values()];
	}, [hits]);
	const flat = groups.flat();
	const showRecents = !q.trim() && recents.length > 0;
	const count = showRecents ? recents.length : flat.length;
	const setQuery = (v: string) => {
		lastQuery = v;
		setQ(v);
		setSel(0);
	};

	const pick = (h: Hit) => onPick({ nodeId: h.nodeId, anchor: h.anchor });

	return (
		<div
			className="no-print fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-[8vh]"
			onMouseDown={onClose}
		>
			<div
				className="w-[820px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-3 border-b border-line px-4">
					<Search size={18} className="text-muted" />
					<input
						ref={input}
						value={q}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") onClose();
							else if (e.key === "ArrowDown") {
								e.preventDefault();
								setSel((s) => Math.min(s + 1, count - 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setSel((s) => Math.max(s - 1, 0));
							} else if (
								e.key === "Enter" &&
								showRecents &&
								recents[sel]
							) {
								const r = recents[sel];
								onPick({ nodeId: r.nodeId, anchor: r.anchor });
							} else if (e.key === "Enter" && flat[sel]) pick(flat[sel]);
						}}
						aria-label="Search this protocol"
						placeholder="platelets before consolidation 2, LP, bloedplaatjes, vincristine…"
						className="h-14 flex-1 bg-transparent text-lg outline-none placeholder:text-muted"
					/>
					{q && (
						<button
							type="button"
							onClick={() => {
								setQuery("");
								input.current?.focus();
							}}
							aria-label="Clear search"
							title="Clear search"
							className="rounded p-1 text-muted hover:bg-paper hover:text-ink"
						>
							<X size={16} />
						</button>
					)}
					<kbd className="rounded border border-line px-1.5 font-mono text-xs text-muted">
						Esc
					</kbd>
				</div>
				<div className="max-h-[70vh] overflow-y-auto">
					{showRecents && (
						<div className="border-b border-line py-1">
							<p className="flex items-center gap-1.5 px-4 pt-1.5 pb-1 text-[13px] font-medium text-muted">
								<History size={14} aria-hidden /> Recent places
							</p>
							{recents.map((r, i) => (
								<button
									key={i}
									type="button"
									onMouseEnter={() => setSel(i)}
									onClick={() =>
										onPick({ nodeId: r.nodeId, anchor: r.anchor })
									}
									className={`block w-full px-4 py-1.5 text-left ${i === sel ? "bg-accent-soft" : ""}`}
								>
									<div className="flex items-baseline gap-2">
										<span className="min-w-0 flex-1 truncate text-[15px]">
											{r.label}
										</span>
										{r.anchor && (
											<span className="shrink-0 font-mono text-[13px] text-muted tabular-nums">
												p. {r.anchor.page}
											</span>
										)}
									</div>
									{r.path && (
										<p className="truncate text-[13px] text-muted">
											{r.path}
										</p>
									)}
								</button>
							))}
						</div>
					)}
					{!q && (
						<p className="px-4 py-5 text-sm text-muted">
							Finds synonyms and abbreviations (ANC, neutrophils,
							granulocytes), Dutch and French terms, and small typos. Add
							“before” or “start” to jump to requirements.{" "}
							<kbd className="font-mono">↑</kbd>{" "}
							<kbd className="font-mono">↓</kbd> to move,{" "}
							<kbd className="font-mono">Enter</kbd> to open.
						</p>
					)}
					{q && !hits.length && (
						<p className="px-4 py-6 text-center text-muted">
							Nothing in this protocol matches “{q}”.
						</p>
					)}

					{card && (
						<button
							type="button"
							onClick={() => onPick({ nodeId: card.req.id })}
							className="block w-full border-b border-line bg-go-soft px-4 py-3 text-left hover:bg-go-soft/70"
						>
							<p className="flex items-center gap-2 text-sm font-semibold text-go">
								<ListChecks size={16} />{" "}
								{card.step
									? `Requirements to start: ${titleOf(card.step, lang)}`
									: titleOf(card.req, lang)}
								<span className="ml-auto font-mono text-[13px] font-normal text-muted">
									p. {card.req.pages.from}
								</span>
							</p>
							<ul className="mt-1.5 grid gap-1">
								{card.req.blocks.slice(0, 8).map((b, i) => (
									<li
										key={i}
										className="verbatim text-[15px] leading-snug"
									>
										{(summaryOf(b, lang) ?? b.text).replace(
											/x\s*10\s*9\s*\/\s*l/gi,
											"×10⁹/L",
										)}
									</li>
								))}
							</ul>
						</button>
					)}

					<div className="py-1">
						{groups.map((g) => {
							const head = g[0];
							return (
								<div key={head.nodeId} className="py-1">
									<p className="truncate px-4 pt-1 text-[13px] text-muted">
										{head.path}
									</p>
									{g.map((h) => {
										const i = flat.indexOf(h);
										return (
											<button
												key={i}
												type="button"
												onMouseEnter={() => setSel(i)}
												onClick={() => pick(h)}
												className={`block w-full px-4 py-1.5 text-left ${i === sel ? "bg-accent-soft" : ""}`}
											>
												<div className="flex items-baseline gap-2">
													{h.isTitle ? (
														<span className="text-base font-semibold">
															{h.title}
														</span>
													) : (
														<Snippet
															text={h.text}
															terms={h.matched}
														/>
													)}
													<span className="ml-auto shrink-0 font-mono text-[13px] text-muted tabular-nums">
														{h.label ??
															`p. ${h.anchor?.page ?? byId.get(h.nodeId)?.pages.from}`}
													</span>
												</div>
											</button>
										);
									})}
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}

/** The matched line, cut around the first match, with every matched term (synonyms included) marked. */
function Snippet({ text, terms }: { text: string; terms: string[] }) {
	const flat = text.replace(/\s+/g, " ");
	// Fold character by character, keeping where each folded character came from, so marks found in
	// the folded text land on the same letters of the displayed text (unit rewrites change length).
	let folded = "";
	const src: number[] = [];
	for (let i = 0; i < flat.length; i++) {
		const f = fold(flat[i]);
		folded += f;
		for (let k = 0; k < f.length; k++) src.push(i);
	}
	src.push(flat.length);
	// Short terms (ANC, LP, CT) are marked as whole words only: never "anc" inside "guidance".
	const found: [number, number][] = [];
	for (const t of terms) {
		if (!t) continue;
		const esc = t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		const re =
			t.length <= 4
				? new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "g")
				: new RegExp(esc, "g");
		for (const m of folded.matchAll(re))
			found.push([src[m.index], src[m.index + m[0].length - 1] + 1]);
	}
	found.sort((a, b) => a[0] - b[0]);
	const start = Math.max(0, (found[0]?.[0] ?? 0) - 60);
	const slice = flat.slice(start, start + 220);
	const marks = found.map(([a, b]): [number, number] => [a - start, b - start]);
	const parts: React.ReactNode[] = [];
	let at = 0;
	for (const [a, b] of marks) {
		if (a < at || b > slice.length) continue;
		parts.push(
			slice.slice(at, a),
			<mark key={a} className="rounded bg-mark px-0.5">
				{slice.slice(a, b)}
			</mark>,
		);
		at = b;
	}
	parts.push(slice.slice(at));
	return (
		<p className="min-w-0 flex-1 text-[15px] leading-snug">
			{start > 0 && "…"}
			{parts}
			{start + 220 < flat.length && "…"}
		</p>
	);
}
