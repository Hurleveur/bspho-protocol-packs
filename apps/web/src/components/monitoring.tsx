"use client";

import type { Anchor, Monitoring, Node, Timepoint } from "@bspho/protocol/spec";
import { Fragment, useMemo, useState } from "react";
import { FigureTable } from "./figure-table";
import { summaryOf, useProtoLang } from "./proto-lang";

const TIMEPOINTS: { key: Timepoint; label: string }[] = [
	{ key: "at_diagnosis", label: "At diagnosis" },
	{ key: "before_each_course", label: "Before each course" },
	{ key: "during_treatment", label: "During treatment" },
	{ key: "before_specific_course", label: "Before specific courses" },
	{ key: "end_of_treatment", label: "End of treatment" },
	{ key: "follow_up", label: "Follow-up" },
	{ key: "on_toxicity", label: "If toxicity occurs" },
];

const GROUPS: { key: Monitoring["rows"][number]["group"]; label: string }[] = [
	{ key: "monitoring", label: "Monitoring" },
	{ key: "prophylaxis", label: "Prophylaxis & supportive care" },
	{ key: "dose_modification", label: "Dose modifications" },
];

const display = (t: string) =>
	t
		.replace(/^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–]\s*|o\s+)/, "")
		.replace(/\n/g, " ")
		.replace(
			/\s?[x×]\s?10\s?\^?\s?(9|12)\s?\/\s?l\b/gi,
			(_, e: string) => ` ×10${e === "9" ? "⁹" : "¹²"}/L`,
		)
		.replace(/\b((?:m|µ|u)?g|IU|U|mL|ml)\/m2\b/g, "$1/m²");

type Show = (a: Anchor | undefined, page: number, nodeId: string) => void;

/**
 * Supportive care & toxicity over time: the protocol's own schedule-of-assessment tables first,
 * then the AI-arranged matrix (rows = what is checked or given, columns = timepoints). Every cell
 * holds only code-copied protocol lines; the model chose the row labels and which lines go where.
 */
export function MonitoringView({
	monitoring,
	nodes,
	sha,
	active,
	show,
}: {
	monitoring?: Monitoring;
	nodes: Node[];
	sha: string;
	active?: Anchor;
	show: Show;
}) {
	const [sel, setSel] = useState<{ row: string; tp: Timepoint } | null>(null);
	const { lang } = useProtoLang();
	const { schedules, nodeOf } = useMemo(() => {
		// The protocol's own schedule-of-assessments grids, wherever they sit: header names investigations, not doses.
		const ASSESS =
			/examination|echocardio|\bECG\b|audiometr|assessment|investigation|after end of therapy|follow-?up|blood count|urine|MRI|x-ray/i;
		const DOSING = /\bdoses?\b|\bagent\b|\bmg\b|\bGy\b/i;
		const schedules = nodes
			.flatMap((n) =>
				(n.figures ?? [])
					.filter((f) => {
						const t = f.structure?.table;
						if (f.raster || !f.bbox || !t) return false;
						const head = t.rows
							.slice(0, Math.max(1, t.headerRows) + 1)
							.flat()
							.map((c) => c.text)
							.join(" ");
						return (
							(t.rows[0]?.length ?? 0) >= 3 &&
							ASSESS.test(head) &&
							!DOSING.test(head)
						);
					})
					.map((f) => ({ f, n })),
			)
			.filter(
				(x, i, all) =>
					all.findIndex(
						(y) =>
							y.f.page === x.f.page &&
							y.f.bbox!.join() === x.f.bbox!.join(),
					) === i,
			);
		const nodeOf = new Map<string, string>();
		for (const n of nodes)
			for (const b of n.blocks) nodeOf.set(`${b.page}:${b.text}`, n.id);
		return { schedules, nodeOf };
	}, [nodes]);
	const nodeFor = (a: Anchor) =>
		nodeOf.get(`${a.page}:${a.text}`) ?? nodes[0]?.id ?? "";

	const rows = monitoring?.rows ?? [];
	const cols = TIMEPOINTS.filter((t) =>
		rows.some((r) => r.cells.some((c) => c.timepoint === t.key)),
	);
	const cellsAt = (r: Monitoring["rows"][number], tp: Timepoint) =>
		r.cells.filter((c) => c.timepoint === tp);
	const selRow = sel ? rows.find((r) => r.id === sel.row) : undefined;
	const selCells = selRow && sel ? cellsAt(selRow, sel.tp) : [];
	const selLines = [...new Set(selCells.flatMap((c) => c.lines))];

	return (
		<div className="mb-8 grid gap-6">
			{schedules.length > 0 && (
				<div className="grid gap-5">
					<h3 className="text-xl font-semibold">
						Schedule of assessments
					</h3>
					{schedules.map(({ f, n }) => {
						const crop = f.bbox!.map((v) => Math.round(v)).join(",");
						return (
							<figure
								key={`${n.id}-${f.page}-${crop}`}
								className="m-0 min-w-0"
							>
								<FigureTable
									figure={f}
									cropSrc={`/internal/page/${sha}/${f.page}?crop=${crop}`}
									active={active}
									onCell={(a) => show(a, f.page, n.id)}
								/>
							</figure>
						);
					})}
				</div>
			)}

			{rows.length > 0 && (
				<div className="min-w-0">
					<h3 className="mb-2 text-xl font-semibold">
						What to check and give, by timepoint
					</h3>
					<div className="overflow-x-auto rounded-md border border-line bg-surface">
						<table className="w-full border-collapse text-[15px] leading-snug">
							<thead>
								<tr>
									<th
										scope="col"
										className="sticky left-0 border border-line bg-paper px-2 py-1.5 text-left text-[13px] font-semibold"
									>
										&nbsp;
									</th>
									{cols.map((c) => (
										<th
											key={c.key}
											scope="col"
											className="border border-line bg-paper px-2 py-1.5 align-bottom text-[13px] font-semibold"
										>
											{c.label}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{GROUPS.map((g) => {
									const gr = rows.filter((r) => r.group === g.key);
									if (!gr.length) return null;
									return (
										<Fragment key={g.key}>
											<tr>
												<th
													colSpan={cols.length + 1}
													scope="colgroup"
													className="border border-line bg-paper/70 px-2 py-1 text-left text-[13px] font-semibold text-ink/80"
												>
													{g.label}
												</th>
											</tr>
											{gr.map((r) => (
												<tr key={r.id}>
													<th
														scope="row"
														className="sticky left-0 min-w-[11rem] border border-line bg-surface px-2 py-1 text-left font-medium"
													>
														{r.label}
													</th>
													{cols.map((c) => {
														const here = cellsAt(r, c.key);
														if (!here.length)
															return (
																<td
																	key={c.key}
																	className="border border-line"
																/>
															);
														const on =
															sel?.row === r.id &&
															sel.tp === c.key;
														const lines = here.flatMap(
															(x) => x.lines,
														);
														const details = [
															...new Set(
																here
																	.map(
																		(x) => x.detail,
																	)
																	.filter(Boolean),
															),
														];
														return (
															<td
																key={c.key}
																className="border border-line p-0 text-center align-top"
															>
																<button
																	type="button"
																	title={lines
																		.map(
																			(a) =>
																				`p. ${a.page}: ${display(a.text).slice(0, 220)}`,
																		)
																		.join("\n\n")}
																	onClick={() => {
																		setSel(
																			on
																				? null
																				: {
																						row: r.id,
																						tp: c.key,
																					},
																		);
																		if (!on)
																			show(
																				lines[0],
																				lines[0]
																					.page,
																				nodeFor(
																					lines[0],
																				),
																			);
																	}}
																	className={`block h-full w-full px-2 py-1 transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent ${on ? "bg-accent-soft outline-2 outline-accent" : ""}`}
																>
																	<span className="text-lg font-semibold text-go">
																		✓
																	</span>
																	{details.length >
																		0 && (
																		<span className="block text-[13px] text-muted">
																			{details.join(
																				"; ",
																			)}
																		</span>
																	)}
																</button>
															</td>
														);
													})}
												</tr>
											))}
										</Fragment>
									);
								})}
							</tbody>
						</table>
					</div>
					{selRow && sel && selLines.length > 0 && (
						<div className="mt-2 rounded-md border border-line bg-surface p-3">
							<p className="mb-1 text-sm font-semibold">
								{selRow.label} ·{" "}
								{TIMEPOINTS.find((t) => t.key === sel.tp)?.label}
								<span className="ml-2 font-normal text-muted">
									{lang === "orig"
										? "as written in the protocol"
										: "in short; hover a line for the original"}
								</span>
							</p>
							<div className="grid gap-0.5">
								{selLines.map((a, i) => (
									<button
										key={`${a.page}-${i}`}
										type="button"
										onClick={() => show(a, a.page, nodeFor(a))}
										title={summaryOf(a, lang) ? display(a.text) : undefined}
										className={`group flex w-full items-start gap-3 rounded-md px-2 py-1 text-left transition-colors ${active === a ? "bg-mark/70" : "hover:bg-paper"}`}
									>
										<span className="verbatim min-w-0 flex-1 text-[16px] leading-relaxed text-pretty">
											{summaryOf(a, lang) ?? display(a.text)}
										</span>
										<span
											className={`page-ref mt-1 shrink-0 font-mono text-[13px] tabular-nums transition-opacity ${active === a ? "text-ink opacity-100" : "text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}
										>
											p. {a.page}
										</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
