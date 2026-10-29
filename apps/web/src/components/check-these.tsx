"use client";

import type { Anchor, Finding } from "@bspho/protocol/spec";
import { ChevronDown, Flag } from "lucide-react";
import { formatVersion } from "@/lib/format";
import { LocalRuleForm } from "./local-rule-form";

/** Code-certain findings first; model-flagged contradictions and gaps last, folded (about half are real). */
const GROUPS: {
	id: string;
	label: string;
	hint: string;
	match: (f: Finding) => boolean;
}[] = [
	{
		id: "delegation",
		label: "Left to local guidelines",
		hint: "The protocol defers to local, national or institutional practice: a place for a local rule.",
		match: (f) => f.kind === "delegation",
	},
	{
		id: "dangling_ref",
		label: "Broken references",
		hint: "Refers to a section, table, figure or appendix not found in the document's text (it may be an image).",
		match: (f) => f.kind === "dangling_ref",
	},
	{
		id: "missing_start",
		label: "Steps without start requirements",
		hint: "No start requirements found in the step's pages.",
		match: (f) => f.kind === "missing_start",
	},
	{
		id: "cross",
		label: "Differences with sub-protocols / other protocols",
		hint: "Where two protocols a patient can be under at the same time disagree.",
		match: (f) => !!f.otherProtocol,
	},
	{
		id: "contradiction",
		label: "Contradictions",
		hint: "The same thing stated differently in two places.",
		match: (f) => !f.otherProtocol && f.kind === "contradiction",
	},
	{
		id: "gap",
		label: "Gaps & ambiguities",
		hint: "Left undefined, or readable two ways.",
		match: (f) => !f.otherProtocol && (f.kind === "gap" || f.kind === "ambiguity"),
	},
];

const AI = new Set(["contradiction", "gap", "cross"]);

const KIND_LABEL: Record<Finding["kind"], string> = {
	contradiction: "Contradiction",
	gap: "Gap",
	ambiguity: "Ambiguity",
	delegation: "Left to local guidelines",
	dangling_ref: "Broken reference",
	missing_start: "No start requirements",
};

const SEV: Record<Finding["severity"], string> = {
	high: "bg-warn text-white",
	medium: "bg-warn-soft text-warn",
	low: "bg-paper text-ink/80",
};

const flat = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** One line of protocol text inside a finding: verbatim, with its page; click opens the page. */
function FindingLine({
	a,
	label,
	onClick,
}: {
	a: Anchor;
	label?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={`Show on page ${a.page}`}
			className="group flex w-full items-start gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-accent"
		>
			<span className="verbatim min-w-0 flex-1 text-[15px] leading-relaxed text-pretty line-clamp-4">
				{flat(a.text)}
			</span>
			<span className="mt-0.5 shrink-0 font-mono text-[13px] text-accent tabular-nums">
				{label ? `${label} ` : ""}p. {a.page}
			</span>
		</button>
	);
}

export function CheckThese({
	findings,
	title,
	show,
	showOther,
	protocol,
	hospital,
}: {
	findings: Finding[];
	/** Section title of a node (for missing start requirements). */
	title: (nodeId?: string) => string | undefined;
	show: (a: Anchor, nodeId: string | undefined) => void;
	showOther: (otherId: string, a: Anchor) => void;
	protocol: { id: string; short: string; version: string };
	hospital: { id: string; name: string };
}) {
	if (!findings.length) return null;
	const groups = GROUPS.map((g) => ({
		...g,
		items: findings.filter(g.match),
	})).filter((g) => g.items.length);
	const sure = groups.filter((g) => !AI.has(g.id));
	const leads = groups.filter((g) => AI.has(g.id));
	const leadCount = leads.reduce((n, g) => n + g.items.length, 0);
	const group = (g: (typeof groups)[number]) => (
		<section key={g.id}>
			<h3 className="text-base font-semibold">
				{g.label}{" "}
				<span className="font-normal text-muted tabular-nums">
					({g.items.length})
				</span>
			</h3>
			<p className="mb-2 text-[15px] text-muted">{g.hint}</p>
			<ul className="grid gap-2">
				{g.items.map((f) => (
					<li
						key={`${f.otherProtocol?.id ?? ""}${f.id}`}
						className="rounded-md border border-line bg-surface p-3"
					>
						<div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
							{AI.has(g.id) && (
								<span
									className={`rounded px-1.5 py-0.5 text-[13px] font-semibold ${SEV[f.severity]}`}
								>
									{f.severity}
								</span>
							)}
							<span className="font-medium">{KIND_LABEL[f.kind]}</span>
							{f.otherProtocol && (
								<span className="text-muted">
									{protocol.short} vs {f.otherProtocol.short}{" "}
									{formatVersion(f.otherProtocol.version)}
								</span>
							)}
							{f.kind === "missing_start" && (
								<span className="text-muted">{title(f.nodeId)}</span>
							)}
						</div>
						{f.note && (
							<p className="mb-2 text-[15px]">
								<span className="mr-1.5 rounded bg-accent-soft px-1.5 py-0.5 text-[13px] font-semibold text-accent">
									AI-flagged, please verify
								</span>
								{f.note}
							</p>
						)}
						<div className="grid gap-0.5 rounded-md bg-paper/60 p-1">
							{f.lines.map((a, i) => (
								<FindingLine
									key={`a${i}`}
									a={a}
									label={f.otherProtocol ? protocol.short : undefined}
									onClick={() => show(a, f.nodeId)}
								/>
							))}
							{(f.otherLines ?? []).map((a, i) => (
								<FindingLine
									key={`b${i}`}
									a={a}
									label={f.otherProtocol?.short}
									onClick={() =>
										f.otherProtocol &&
										showOther(f.otherProtocol.id, a)
									}
								/>
							))}
						</div>
						{f.kind === "delegation" && f.nodeId && (
							<LocalRuleForm
								protocolId={protocol.id}
								hospital={hospital.id}
								hospitalName={hospital.name}
								nodeId={f.nodeId}
							/>
						)}
					</li>
				))}
			</ul>
		</section>
	);
	return (
		<details
			id="check"
			data-spy="check"
			className="no-print group/check mt-12 mb-10 scroll-mt-(--stick) rounded-lg border border-line bg-surface"
		>
			<summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden">
				<Flag size={18} className="text-muted" aria-hidden />
				<span className="text-lg font-semibold whitespace-nowrap">
					Check these
				</span>
				<span className="rounded-full border border-line px-2 py-0.5 text-sm font-semibold text-ink tabular-nums">
					{findings.length}
				</span>
				<span className="text-[15px] text-muted">
					Left to local practice, broken references
					{leadCount ? `, ${leadCount} AI-flagged leads` : ""}
				</span>
				<ChevronDown
					size={18}
					className="ml-auto shrink-0 text-muted transition-transform group-open/check:rotate-180"
				/>
			</summary>
			<div className="grid gap-6 border-t border-line px-5 pt-4 pb-5">
				{sure.map(group)}
				{leads.length > 0 && (
					<details className="group/leads rounded-md border border-line">
						<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 font-semibold [&::-webkit-details-marker]:hidden">
							AI-flagged leads (please verify)
							<span className="font-normal text-muted tabular-nums">
								({leadCount})
							</span>
							<ChevronDown
								size={16}
								className="ml-auto text-muted transition-transform group-open/leads:rotate-180"
							/>
						</summary>
						<div className="grid gap-6 border-t border-line px-4 pt-3 pb-4">
							<p className="text-[15px] text-muted">
								A model pointed at these lines; many are not real
								problems. Read the lines and the page before acting on
								any of them.
							</p>
							{leads.map(group)}
						</div>
					</details>
				)}
			</div>
		</details>
	);
}

/** Small flag next to a protocol line that is part of a finding; the tooltip says why. */
export function FindingFlag({ findings }: { findings?: Finding[] }) {
	if (!findings?.length) return null;
	const tip = findings
		.map(
			(f) =>
				`${KIND_LABEL[f.kind]}${f.otherProtocol ? ` (vs ${f.otherProtocol.short})` : ""}${f.note ? `: ${f.note} (AI-flagged, please verify)` : ""}`,
		)
		.join("\n");
	const strong = findings.some(
		(f) => f.kind === "contradiction" || f.kind === "gap" || f.kind === "ambiguity",
	);
	return (
		<span
			title={tip}
			aria-label={tip}
			className={`no-print mt-1.5 shrink-0 ${strong ? "text-warn" : "text-muted"}`}
		>
			<Flag size={14} />
		</span>
	);
}
