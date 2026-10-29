"use client";

import type { Anchor, FigureRef } from "@bspho/protocol/spec";
import { useState } from "react";

type Table = NonNullable<NonNullable<FigureRef["structure"]>["table"]>;
type Cell = Table["rows"][number][number];

// Schedule marks as printed ("X", "x", "•", Wingdings ticks) render as a check; footnote letters stay ("Xa" → ✓a).
const MARK = /^(?:x|✓|✔|√|•|||)$/i;
const MARK_WITH_NOTE = /^(?:[xX]|•)([a-z*†‡]{1,2})?\s*(\(.+\))?$/;

function CellText({ text, schedule }: { text: string; schedule: boolean }) {
	const t = text.trim();
	if (schedule && MARK.test(t))
		return (
			<span
				aria-label={`marked (${t})`}
				title={`Printed as “${t}”`}
				className="text-lg font-semibold text-go"
			>
				✓
			</span>
		);
	const m = schedule ? MARK_WITH_NOTE.exec(t) : null;
	if (m)
		return (
			<span title={`Printed as “${t}”`}>
				<span className="text-lg font-semibold text-go">✓</span>
				{m[1] ? <sup className="ml-0.5 text-xs text-muted">{m[1]}</sup> : null}
				{m[2] ? <span className="ml-1 text-xs text-muted">{m[2]}</span> : null}
			</span>
		);
	return <>{text}</>;
}

/**
 * A protocol table or schedule as a real HTML table. Every cell is verbatim text from the
 * PDF text layer, placed by the drawn rules; the build attaches it only when every cell checks out.
 * Clicking a cell shows it highlighted on the source page.
 */
export function FigureTable({
	figure,
	cropSrc,
	active,
	onCell,
}: {
	figure: FigureRef;
	cropSrc: string;
	active?: Anchor;
	onCell: (a: Anchor) => void;
}) {
	const [printed, setPrinted] = useState(false);
	const s = figure.structure;
	const table = s?.table;
	if (!s || !table) return null;
	const schedule = s.type === "schedule";
	// Header = first row, extended by any header cell that spans down (two-level headers).
	const headerRows = table.headerRows
		? Math.max(
				table.headerRows,
				...(table.rows[0] ?? []).map((c) => c.rowSpan ?? 1),
			)
		: 0;
	const anchorOf = (c: Cell): Anchor | null =>
		c.bbox && c.text.trim()
			? { page: figure.page, text: c.text, bbox: [c.bbox] }
			: null;
	const isActive = (c: Cell) =>
		!!active &&
		active.page === figure.page &&
		active.bbox.length === 1 &&
		!!c.bbox &&
		!!active.bbox[0]?.every((v, i) => v === c.bbox?.[i]);

	return (
		<div className="min-w-0">
			<div className="mb-1 flex flex-wrap items-center justify-between gap-2">
				<p className="text-[13px] text-muted">p. {figure.page}</p>
				<button
					type="button"
					onClick={() => setPrinted((v) => !v)}
					className="no-print text-sm text-accent hover:underline"
				>
					{printed ? "Show as table" : "Show as printed"}
				</button>
			</div>
			{printed ? (
				<div className="overflow-hidden rounded-md border border-line bg-white p-2">
					{/* biome-ignore lint: rendered page region */}
					<img
						src={cropSrc}
						alt={
							figure.caption?.text.slice(0, 120) ??
							`As printed on page ${figure.page}`
						}
						loading="lazy"
						className="mx-auto block w-full"
					/>
				</div>
			) : (
				<div className="overflow-x-auto rounded-md border border-line bg-surface">
					<table className="w-full border-collapse text-[15px] leading-snug">
						{[
							["thead", table.rows.slice(0, headerRows), 0],
							["tbody", table.rows.slice(headerRows), headerRows],
						].map(([part, rows, offset]) => {
							const Part = part as "thead" | "tbody";
							return (
								<Part key={Part}>
									{(rows as Table["rows"]).map((row, ri) => (
										<tr
											key={`${Part}-${ri + (offset as number)}`}
											className={
												Part === "tbody"
													? "even:bg-paper/60"
													: ""
											}
										>
											{row.map((c, ci) => {
												if (c.covered) return null;
												const Tag =
													Part === "thead" ||
													(ci === 0 && schedule)
														? "th"
														: "td";
												const a = anchorOf(c);
												const centred =
													Part === "thead" ||
													(schedule && ci > 0);
												return (
													<Tag
														key={`${ri}-${ci}`}
														rowSpan={c.rowSpan}
														colSpan={c.colSpan}
														scope={
															Part === "thead"
																? "col"
																: Tag === "th"
																	? "row"
																	: undefined
														}
														onClick={
															a
																? () => onCell(a)
																: undefined
														}
														title={
															a
																? `Show on page ${figure.page}`
																: undefined
														}
														className={[
															"border border-line px-2 py-1 align-top whitespace-pre-line",
															Part === "thead"
																? "bg-paper font-semibold text-[13px] text-ink align-bottom"
																: "",
															Tag === "th" &&
															Part === "tbody"
																? "min-w-[12rem] text-left font-medium"
																: "",
															centred
																? "text-center"
																: "text-left",
															a
																? "cursor-pointer hover:bg-accent-soft"
																: "",
															isActive(c)
																? "bg-mark/70 outline-2 -outline-offset-2 outline-accent"
																: "",
														].join(" ")}
													>
														<CellText
															text={c.text}
															schedule={
																schedule &&
																Part === "tbody" &&
																ci > 0
															}
														/>
													</Tag>
												);
											})}
										</tr>
									))}
								</Part>
							);
						})}
					</table>
				</div>
			)}
		</div>
	);
}
