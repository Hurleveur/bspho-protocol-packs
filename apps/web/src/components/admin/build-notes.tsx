import type { BuildReport } from "@/lib/admin";
import { when } from "./api";

const pageList = (pages: number[]) =>
	pages.length > 8
		? `${pages.slice(0, 8).join(", ")} and ${pages.length - 8} more`
		: pages.join(", ");

/** Things the pipeline could not do cleanly, in plain sentences. Empty when there is nothing to check. */
export function buildNotes(r: BuildReport): string[] {
	const out: string[] = [];
	if (!r.versionFound)
		out.push(
			"The version number was not found printed in the PDF. Check that the version shown is right.",
		);
	if (r.stepsMissingStart)
		out.push(
			`${r.stepsMissingStart} of ${r.steps} treatment steps have no "requirements to start" section. Doctors see "not found in these pages" for them.`,
		);
	if (r.imagePages.length)
		out.push(
			`${r.imagePages.length === 1 ? "1 page is a picture" : `${r.imagePages.length} pages are pictures`} (flowcharts or scanned tables), p. ${pageList(r.imagePages)}. Shown as the original page, not searchable.`,
		);
	if (r.linksInferred)
		out.push(
			`${r.linksInferred} of ${r.links} links between sections are not backed by a sentence in the PDF. They are shown as "inferred".`,
		);
	out.push(...r.otherWarnings);
	return out;
}

/** Short at-a-glance verdict for a version. */
export function NotesBadge({ report }: { report: BuildReport | undefined }) {
	if (!report) return <span className="text-xs text-faint">no report</span>;
	const n = buildNotes(report).length;
	return n ? (
		<span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-warn">
			{n} {n === 1 ? "thing" : "things"} to check
		</span>
	) : (
		<span className="rounded bg-go-soft px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-go">
			All clear
		</span>
	);
}

export function BuildReportView({ report }: { report: BuildReport }) {
	const notes = buildNotes(report);
	return (
		<div className="grid gap-3">
			<dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
				{(
					[
						["Pages", report.pages],
						["Sections", report.sections],
						["Treatment steps", report.steps],
						[
							"Steps with start requirements",
							report.steps - report.stepsMissingStart,
						],
						["Links between sections", report.links],
					] as const
				).map(([label, n]) => (
					<div
						key={label}
						className="rounded-md border border-line bg-surface px-3 py-2"
					>
						<dt className="text-xs text-muted">{label}</dt>
						<dd className="text-lg font-semibold tabular-nums">{n}</dd>
					</div>
				))}
			</dl>
			{notes.length > 0 ? (
				<ul className="grid gap-1.5 text-sm text-muted">
					{notes.map((w, i) => (
						<li key={i} className="border-l-2 border-warn/40 pl-3">
							{w}
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-go">Everything was read cleanly.</p>
			)}
			<p className="text-xs text-faint">
				Processed {when(report.builtAt)}
				{report.model ? ` with ${report.model}` : ""} in {report.seconds} s.
			</p>
		</div>
	);
}
