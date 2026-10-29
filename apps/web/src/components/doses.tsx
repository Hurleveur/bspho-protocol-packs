"use client";

import type { Anchor, FigureRef, Node } from "@bspho/protocol/spec";
import { useMemo, useState } from "react";
import { FigureTable } from "./figure-table";

type Show = (a: Anchor | undefined, page: number, nodeId: string) => void;

const KINDS = new Set<Node["kind"]>(["schedule", "drug_info", "step", "phase"]);
const DOSING = /dos(?:e|es|age|ing)\b|\bagents?\b|\bdrugs?\b|\bmg\b|\/m[²2]\b/i;
// An "Agent | Dose" overview table counts wherever the outline filed it (ML-DS p. 17 sits under kind "other").
const OVERVIEW = /\b(?:agents?|drugs?)\b[\s\S]*\bdoses?\b|\bdoses?\b[\s\S]*\b(?:agents?|drugs?)\b/i;

export interface DoseGroup {
	title: string;
	items: { node: Node; figure: FigureRef; text: string }[];
}

/** Verified dosing tables (every cell copied from the PDF), grouped by node title in document order. */
export function doseGroups(nodes: Node[]): DoseGroup[] {
	const groups: DoseGroup[] = [];
	const byTitle = new Map<string, DoseGroup>();
	const seen = new Set<string>();
	for (const node of nodes) {
		for (const f of node.figures ?? []) {
			const s = f.structure;
			const t = s?.table;
			if (f.raster || !f.bbox || !s?.allVerified || !t?.rows.length) continue;
			const head = t.rows
				.slice(0, Math.max(1, t.headerRows))
				.flat()
				.map((c) => c.text)
				.join(" ");
			if (!(KINDS.has(node.kind) ? DOSING : OVERVIEW).test(head)) continue;
			const key = `${f.page}:${f.bbox.join(",")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			let g = byTitle.get(node.title);
			if (!g) {
				g = { title: node.title, items: [] };
				byTitle.set(node.title, g);
				groups.push(g);
			}
			g.items.push({
				node,
				figure: f,
				text: t.rows
					.flat()
					.map((c) => c.text)
					.join(" ")
					.toLowerCase(),
			});
		}
	}
	return groups;
}

export function Doses({
	groups,
	sha,
	active,
	show,
}: {
	groups: DoseGroup[];
	sha: string;
	active?: Anchor;
	show: Show;
}) {
	const [group, setGroup] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const visible = useMemo(
		() =>
			groups
				.filter((g) => group === null || g.title === group)
				.map((g) => ({
					...g,
					items: q ? g.items.filter((i) => i.text.includes(q)) : g.items,
				}))
				.filter((g) => g.items.length > 0),
		[groups, group, q],
	);
	const pill = (on: boolean) =>
		`shrink-0 rounded-full border px-3 py-1 text-sm ${
			on
				? "border-accent bg-accent-soft font-medium text-ink"
				: "border-line bg-surface text-muted hover:text-ink"
		}`;

	return (
		<div>
			<p className="mb-3 text-[15px] text-muted">
				Tables copied cell by cell from the protocol and checked against the
				PDF. Click a cell to see it on the page.
			</p>
			<div className="no-print mb-5 flex flex-wrap items-center gap-3">
				<div
					role="tablist"
					aria-label="Course or block"
					className="flex min-w-0 flex-1 flex-wrap gap-1.5 pb-1"
				>
					<button
						type="button"
						role="tab"
						aria-selected={group === null}
						onClick={() => setGroup(null)}
						className={pill(group === null)}
					>
						All
					</button>
					{groups.map((g) => (
						<button
							key={g.title}
							type="button"
							role="tab"
							aria-selected={group === g.title}
							onClick={() => setGroup(g.title)}
							className={pill(group === g.title)}
						>
							{g.title}
						</button>
					))}
				</div>
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter by cell text"
					aria-label="Filter tables by cell text"
					className="w-56 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
				/>
			</div>
			{visible.length === 0 ? (
				<p className="text-[15px] text-muted">No table matches.</p>
			) : (
				<div className="grid gap-8">
					{visible.map((g) => (
						<div key={g.title} className="min-w-0">
							<h3 className="mb-2 text-lg font-semibold">{g.title}</h3>
							<div className="grid gap-5">
								{g.items.map(({ node, figure: f }) => {
									const crop = (f.bbox ?? [])
										.map((v) => Math.round(v))
										.join(",");
									return (
										<figure
											key={`${node.id}-${f.page}-${crop}`}
											className="m-0 min-w-0"
										>
											<FigureTable
												figure={f}
												cropSrc={`/internal/page/${sha}/${f.page}?crop=${crop}`}
												active={active}
												onCell={(a) => show(a, f.page, node.id)}
											/>
										</figure>
									);
								})}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
