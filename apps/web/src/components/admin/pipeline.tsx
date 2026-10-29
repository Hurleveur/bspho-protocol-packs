"use client";

import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { StageEvent, StageName } from "./types";

export const STAGES: { id: StageName; label: string }[] = [
	{ id: "parse", label: "Reading pages" },
	{ id: "identity", label: "Recognising the protocol" },
	{ id: "sections", label: "Finding sections" },
	{ id: "label", label: "Labelling sections with Gemini" },
	{ id: "anchors", label: "Copying verbatim text from the PDF" },
	{ id: "check", label: "Checking" },
];

const COUNT_LABELS: Record<string, string> = {
	pages: "pages",
	sections: "sections",
	labelled: "labelled",
	edges: "links",
	steps: "treatment steps",
	missingStart: "without start requirements",
	rasterPages: "image-only pages",
};

const seconds = (ms: number) =>
	ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/** Live elapsed time for the stage being worked on. */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(t);
	}, []);
	return (
		<span className="shrink-0 font-mono text-xs whitespace-nowrap text-faint tabular-nums">
			{seconds(Math.max(0, now - since))}
		</span>
	);
}

export function Pipeline({
	events,
	failed,
	activeSince,
}: {
	events: Partial<Record<StageName, StageEvent>>;
	failed: boolean;
	activeSince: number;
}) {
	const activeIndex = STAGES.findIndex((s) => !events[s.id]);
	return (
		<ol className="relative">
			{STAGES.map((s, i) => {
				const e = events[s.id];
				const state = e
					? "done"
					: i === activeIndex
						? failed
							? "error"
							: "active"
						: "pending";
				const last = i === STAGES.length - 1;
				const counts = Object.entries(e?.counts ?? {}).filter(
					([k]) => k in COUNT_LABELS,
				);
				return (
					<li key={s.id} className="relative flex gap-4 pb-6 last:pb-0">
						{!last && (
							<span
								className={`absolute top-8 bottom-0 left-[15px] w-px ${e ? "bg-go/40" : "bg-line"}`}
								aria-hidden
							/>
						)}
						<span
							className={`relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium transition-colors duration-500 ${
								state === "done"
									? "border-go bg-go text-white"
									: state === "active"
										? "border-accent bg-accent-soft text-accent"
										: state === "error"
											? "border-warn bg-warn-soft text-warn"
											: "border-line bg-surface text-faint"
							}`}
						>
							{state === "done" ? (
								<CheckIcon className="size-4" strokeWidth={2.5} />
							) : state === "error" ? (
								<CircleAlertIcon className="size-4" />
							) : (
								i + 1
							)}
							{state === "active" && (
								<span className="absolute inset-0 animate-ping rounded-full border border-accent/40 [animation-duration:2s]" />
							)}
						</span>
						<div className="min-w-0 flex-1 pt-1">
							<div className="flex items-baseline justify-between gap-4">
								<span
									className={`font-medium ${state === "pending" ? "text-faint" : "text-ink"}`}
								>
									{s.label}
								</span>
								{e?.ms !== undefined ? (
									<span className="shrink-0 font-mono text-xs whitespace-nowrap text-faint tabular-nums">
										{seconds(e.ms)}
									</span>
								) : state === "active" ? (
									<Elapsed since={activeSince} />
								) : null}
							</div>
							{e ? (
								<p className="mt-0.5 text-sm text-muted">{e.message}</p>
							) : state === "active" ? (
								<p className="mt-0.5 text-sm text-faint">Working…</p>
							) : null}
							{counts.length > 0 && (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{counts.map(([k, v]) => (
										<span
											key={k}
											className="rounded bg-paper px-1.5 py-0.5 font-mono text-[11px] text-muted"
										>
											{v.toLocaleString("en")} {COUNT_LABELS[k]}
										</span>
									))}
								</div>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
