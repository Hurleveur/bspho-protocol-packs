"use client";

import type { Anchor, Edge, Node } from "@bspho/protocol/spec";
import { ArrowRightIcon, CheckIcon, GitForkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { quoteLine } from "@/lib/format";
import type { CaseState } from "@/lib/case";
import { type Arm, armsOf, forkEvidence, layoutArm, splitNumber } from "@/lib/flow";
import { armName, type RiskPath } from "@/lib/path";

type Status = (id: string) => "done" | "current" | undefined;

interface Tip {
	x: number;
	y: number;
	title: string;
	anchors: Anchor[];
	nodeId: string;
	inferred?: boolean;
}

/**
 * The treatment overview at the top of the Treatment section: one arm at a time, steps left to
 * right, forks as branches, exits to other arms as chips. Clicking a step opens its card below.
 */
export function TreatmentMap({
	steps,
	byId,
	edges,
	spy: spyNow,
	status,
	kase,
	printing,
	path: riskPath,
	paths = [],
	open,
	show,
}: {
	steps: Node[];
	byId: Map<string, Node>;
	edges: Edge[];
	/** Step card the reader is on (scroll-spy). */
	spy?: string;
	status?: Status;
	kase?: CaseState | null;
	printing?: boolean;
	/** The chosen risk group's path: other arms and steps are faded. */
	path?: RiskPath | null;
	/** All risk-group paths: an arm that is one group's own is named like its chip. */
	paths?: RiskPath[];
	/** Open a step card on the sheet and scroll to it (or any node). */
	open: (nodeId: string) => void;
	/** Show a verbatim line on its page. */
	show: (a: Anchor, nodeId: string) => void;
}) {
	// The last step card read stays highlighted when the reader scrolls back up to the map.
	const [spy, setSpy] = useState(spyNow);
	if (spyNow && spyNow !== spy) setSpy(spyNow);
	const arms = useMemo(() => armsOf(steps, byId), [steps, byId]);
	const armOf = useMemo(() => {
		const m = new Map<string, Arm>();
		for (const a of arms) for (const s of a.steps) m.set(s.id, a);
		return m;
	}, [arms]);
	const caseArm =
		(kase?.cur && armOf.get(kase.cur)) ||
		arms.find((a) => a.key && a.key === kase?.arm) ||
		(kase?.done.length ? armOf.get(kase.done[kase.done.length - 1]) : undefined);
	const [tab, setTab] = useState<string>(() => (caseArm ?? arms[0])?.key ?? "");
	const [flash, setFlash] = useState<string | null>(null);
	const [tip, setTip] = useState<Tip | null>(null);
	const hideTip = useRef<ReturnType<typeof setTimeout>>(undefined);
	const scroller = useRef<HTMLDivElement>(null);
	const wrap = useRef<HTMLDivElement>(null);

	// Follow the case's arm, then the step card the reader scrolls to.
	const caseKey = caseArm?.key;
	const spyKey = spy ? armOf.get(spy)?.key : undefined;
	// A chosen path opens on the group's own arm.
	const pathKey = riskPath
		? ([...riskPath.own][0] ?? [...riskPath.arms][0])
		: undefined;
	const [seen, setSeen] = useState({ caseKey, spyKey, pathKey });
	if (
		seen.caseKey !== caseKey ||
		seen.spyKey !== spyKey ||
		seen.pathKey !== pathKey
	) {
		setSeen({ caseKey, spyKey, pathKey });
		if (pathKey !== undefined && pathKey !== seen.pathKey) setTab(pathKey);
		else if (caseKey !== undefined && caseKey !== seen.caseKey) setTab(caseKey);
		else if (spyKey !== undefined && spyKey !== seen.spyKey) setTab(spyKey);
	}

	const arm = arms.find((a) => a.key === tab) ?? arms[0];
	const map = useMemo(
		() => (arm ? layoutArm(arm, arms, edges, byId) : null),
		[arm, arms, edges, byId],
	);

	// Keep the node in focus horizontally visible (the map scrolls sideways on long arms).
	const focus = flash ?? (kase?.cur && armOf.get(kase.cur) === arm ? kase.cur : spy);
	useEffect(() => {
		const n = map?.nodes.find((m) => m.id === focus);
		const el = scroller.current;
		if (!n || !el) return;
		if (n.x < el.scrollLeft || n.x + n.w > el.scrollLeft + el.clientWidth)
			el.scrollTo({ left: Math.max(0, n.x - 60), behavior: "smooth" });
	}, [focus, map]);
	useEffect(() => {
		if (!flash) return;
		const t = setTimeout(() => setFlash(null), 1800);
		return () => clearTimeout(t);
	}, [flash]);

	if (!arm || !map) return null;

	const path = new Set(kase?.forks.map((f) => `${f.from}>${f.to}`));
	const reached = (id: string) =>
		status?.(id) === "done" || status?.(id) === "current";
	const onPath = (e: Edge) =>
		status?.(e.from) === "done" && (reached(e.to) || path.has(`${e.from}>${e.to}`));

	const tipAt = (target: Element, t: Omit<Tip, "x" | "y">) => {
		clearTimeout(hideTip.current);
		const hostEl = wrap.current;
		if (!hostEl) return;
		const box = target.getBoundingClientRect();
		const host = hostEl.getBoundingClientRect();
		// Below the map, never over its nodes.
		setTip({
			...t,
			x: Math.min(box.left - host.left - 40, host.width - 420),
			y: host.height + 4,
		});
	};
	const leave = () => {
		clearTimeout(hideTip.current);
		hideTip.current = setTimeout(() => setTip(null), 220);
	};
	const goExit = (x: (typeof map.exits)[number]) => {
		setTip(null);
		if (x.arm && x.step) {
			setTab(x.arm.key);
			setFlash(x.step);
		} else open(x.to.id);
	};

	const multi = arms.length > 1;
	// Off the chosen path: still drawn and clickable, faded.
	const off = (id: string) =>
		!!riskPath && !riskPath.steps.has(id) && map.nodes.some((n) => n.id === id && !n.decision);
	const offArm = (a?: Arm) => !!riskPath && !!a && !riskPath.arms.has(a.key);
	return (
		<section
			aria-label="Treatment map"
			ref={wrap}
			className="treatment-map relative mb-8 rounded-lg border border-line bg-surface"
		>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 pt-3 pb-2">
				<h3 className="text-[15px] font-semibold text-ink">Treatment map</h3>
				{printing && multi && (
					<span className="text-sm font-semibold">{arm.label}</span>
				)}
				<span className="no-print ml-auto flex items-center gap-3 text-xs text-muted">
					<span className="flex items-center gap-1">
						<svg width="22" height="6" aria-hidden>
							<line
								x1="0"
								y1="3"
								x2="22"
								y2="3"
								stroke="var(--muted)"
								strokeWidth="1.5"
								strokeDasharray="4 3"
							/>
						</svg>
						inferred from document order
					</span>
					<span className="flex items-center gap-1">
						<GitForkIcon size={12} className="text-flow" /> fork: hover for
						the deciding sentence
					</span>
				</span>
			</div>
			{multi && (
				<div
					role="tablist"
					aria-label="Arms"
					className="no-print flex flex-wrap gap-1 border-b border-line px-3 py-2"
				>
					{arms.map((a, i) => {
						const sel = a.key === arm.key;
						const other =
							!a.phase &&
							arms.some((b) => b.phase) &&
							(i === 0 || arms[i - 1].phase);
						const done = a.steps.some((s) => status?.(s.id));
						const faded = offArm(a) && !sel && !done;
						return (
							<span key={a.key || "_"} className="contents">
								{other && (
									<span className="ml-2 self-center text-xs text-faint">
										Other steps:
									</span>
								)}
								<button
									type="button"
									role="tab"
									aria-selected={sel}
									title={a.label}
									onClick={() => setTab(a.key)}
									className={`max-w-72 truncate rounded-full border px-3 py-1 text-[13px] transition-colors ${sel ? "border-accent bg-accent text-white" : done ? "border-accent/50 bg-accent-soft text-accent" : faded ? "border-dashed border-line bg-paper text-muted hover:border-accent hover:text-accent" : "border-line text-ink hover:border-accent hover:text-accent"}`}
								>
									{armName(a, paths)}
									<span
										className={`ml-1.5 text-xs tabular-nums ${sel ? "text-white/75" : "text-faint"}`}
									>
										{a.steps.length}
									</span>
								</button>
							</span>
						);
					})}
				</div>
			)}
			<div
				ref={scroller}
				className="overflow-x-auto overscroll-x-contain px-2 py-3 print:overflow-visible"
			>
				<svg
					width={map.width}
					height={map.height}
					viewBox={`0 0 ${map.width} ${map.height}`}
					className="mx-auto block print:h-auto print:max-w-full"
					role="img"
					aria-label={`Treatment map: ${arm.label}`}
				>
					<defs>
						{(["muted", "flow", "ink"] as const).map((c) => (
							<marker
								key={c}
								id={`tm-arrow-${c}`}
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerUnits="userSpaceOnUse"
								markerWidth="10"
								markerHeight="10"
								orient="auto-start-reverse"
							>
								<path
									d="M0,1 L9,5 L0,9 z"
									style={{ fill: `var(--${c})` }}
								/>
							</marker>
						))}
					</defs>
					{map.joins.map((d, i) => (
						<path
							key={i}
							d={d}
							fill="none"
							style={{ stroke: "var(--faint)" }}
							strokeOpacity={0.5}
							strokeWidth={1.5}
						/>
					))}
					{map.edges.map((m) => {
						const e = m.edge;
						const branch = e.kind !== "next";
						const bold = onPath(e);
						const dim =
							off(e.from) ||
							off(e.to) ||
							(m.key.endsWith(":exit") &&
								offArm(map.exits.find((x) => x.edge === e)?.arm));
						const c = bold ? "ink" : branch ? "flow" : "muted";
						const ev = e.evidence;
						const inferred = !ev;
						const title = !ev
							? "inferred from document order"
							: `${e.kind === "alternative" ? "Option" : e.kind === "restratify_to" ? "Re-stratification" : "Next"} (p. ${ev.page}): ${ev.text.replace(/\s+/g, " ")}`;
						return (
							<g key={m.key}>
								<path
									d={m.d}
									fill="none"
									opacity={dim ? 0.25 : 1}
									style={{ stroke: `var(--${c})` }}
									strokeWidth={bold ? 3.2 : branch ? 1.8 : 1.5}
									strokeDasharray={inferred ? "5 4" : undefined}
									markerEnd={`url(#tm-arrow-${c})`}
								/>
								{/* Wide invisible hit area for hover / click. */}
								<path
									d={m.d}
									fill="none"
									stroke="transparent"
									strokeWidth={14}
									className={
										e.evidence ? "cursor-pointer" : "cursor-help"
									}
									onMouseEnter={(ev) =>
										tipAt(ev.currentTarget, {
											title: inferred
												? "Inferred from document order"
												: e.kind === "alternative"
													? "Option at this fork"
													: e.kind === "restratify_to"
														? "Re-stratification"
														: "Next step",
											anchors: e.evidence ? [e.evidence] : [],
											nodeId: e.from,
											inferred,
										})
									}
									onMouseLeave={leave}
									onClick={() =>
										e.evidence && show(e.evidence, e.from)
									}
								>
									<title>{title}</title>
								</path>
							</g>
						);
					})}
					{map.nodes.map((n) => {
						const st = status?.(n.id);
						const here = n.id === spy;
						const fork = map.forks.get(n.id);
						const [num, full] = splitNumber(n.node.title);
						// "IR-High: Consolidation 1" under the IR-High tab reads "Consolidation 1".
						const text = (multi && stripArm(full, arm.short)) || full;
						const missing =
							n.node.notFound?.filter(
								(f) => f.kind === "start_requirements",
							) ?? [];
						const cls = n.decision
							? "border-flow/60 bg-flow-soft text-flow rounded-2xl"
							: off(n.id) && !st
								? "border-dashed border-line bg-paper text-muted hover:border-accent hover:bg-accent-soft hover:text-ink"
								: st === "current"
								? "border-accent bg-accent text-white shadow-md"
								: st === "done"
									? "border-line bg-paper text-muted"
									: "border-line bg-surface text-ink hover:border-accent hover:bg-accent-soft";
						return (
							<foreignObject
								key={n.id}
								x={n.x}
								y={n.y}
								width={n.w}
								height={n.h}
								overflow="visible"
							>
								<div className="relative size-full">
									<button
										type="button"
										data-map-node={n.id}
										onClick={() => open(n.id)}
										title={`${n.node.title} (p. ${n.node.pages.from})${missing.length ? `\nStart requirements not found in pp. ${missing[0].searched.from}-${missing[0].searched.to}` : ""}`}
										aria-current={here ? "step" : undefined}
										className={`flex size-full flex-col justify-center rounded-lg border px-2.5 py-1.5 text-left leading-tight transition-colors ${cls} ${here && st !== "current" ? "ring-2 ring-accent ring-offset-1" : ""} ${flash === n.id ? "ring-4 ring-flow/60" : ""} ${st === "current" ? "ring-4 ring-accent/25" : ""}`}
									>
										{num && (
											<span
												className={`text-[11px] tabular-nums ${st === "current" ? "text-white/80" : "text-faint"}`}
											>
												{num}
											</span>
										)}
										<span
											className={`${n.decision || num ? "line-clamp-2" : "line-clamp-3"} text-[13px] ${st === "current" || here ? "font-semibold" : "font-medium"}`}
										>
											{st === "done" && (
												<CheckIcon
													size={13}
													strokeWidth={3}
													aria-label="completed"
													className="mr-0.5 inline text-go"
												/>
											)}
											{text}
										</span>
									</button>
									{fork && (
										<span
											onMouseEnter={(ev) =>
												tipAt(ev.currentTarget, {
													title: `Fork: ${fork.length} options`,
													anchors: forkEvidence(fork),
													nodeId: n.id,
													inferred:
														!forkEvidence(fork).length,
												})
											}
											onMouseLeave={leave}
											onClick={() => {
												const a = forkEvidence(fork)[0];
												if (a) show(a, n.id);
											}}
											className="absolute top-1/2 -right-3 flex size-6 -translate-y-1/2 cursor-help items-center justify-center rounded-full border border-flow/50 bg-flow-soft text-flow shadow-sm"
										>
											<GitForkIcon size={13} aria-label="fork" />
										</span>
									)}
								</div>
							</foreignObject>
						);
					})}
					{map.exits.map((x) => (
						<foreignObject
							key={x.key}
							x={x.x}
							y={x.y}
							width={x.w}
							height={x.h}
							overflow="visible"
						>
							<button
								type="button"
								onClick={() => goExit(x)}
								onMouseEnter={(ev) =>
									tipAt(ev.currentTarget, {
										title: x.arm
											? `Leaves this arm → ${x.arm.label}`
											: `Continues in: ${x.to.title}`,
										anchors: x.edge.evidence
											? [x.edge.evidence]
											: [],
										nodeId: x.edge.from,
										inferred: !x.edge.evidence,
									})
								}
								onMouseLeave={leave}
								className={`flex size-full items-center gap-1 rounded-full border px-3 text-left text-[12.5px] leading-tight font-medium transition-colors hover:bg-flow hover:text-white ${offArm(x.arm) ? "border-line bg-paper text-muted" : "border-flow/60 bg-flow-soft text-flow"} ${x.edge.evidence ? "" : "border-dashed"}`}
							>
								<ArrowRightIcon
									size={13}
									className="shrink-0"
									aria-hidden
								/>
								<span className="line-clamp-2">
									{x.arm && x.label === x.arm.short
										? armName(x.arm, paths)
										: x.label}
								</span>
							</button>
						</foreignObject>
					))}
				</svg>
			</div>
			{tip && !printing && (
				<div
					onMouseEnter={() => clearTimeout(hideTip.current)}
					onMouseLeave={leave}
					style={{ left: Math.max(8, tip.x), top: tip.y }}
					className="no-print absolute z-20 w-[26rem] rounded-lg border border-line bg-surface p-3 text-sm shadow-lg"
				>
					<p className="mb-1 text-xs font-semibold tracking-wide text-flow uppercase">
						{tip.title}
					</p>
					{tip.anchors.length === 0 && (
						<p className="text-muted">
							{tip.inferred
								? "No sentence in the protocol was found for this link: inferred from document order."
								: "No evidence."}
						</p>
					)}
					{tip.anchors.map((a, i) => (
						<button
							key={i}
							type="button"
							onClick={() => {
								setTip(null);
								show(a, tip.nodeId);
							}}
							className="mt-1 block w-full rounded border border-line bg-paper px-2 py-1.5 text-left hover:border-flow/50 hover:bg-flow-soft"
						>
							<span className="verbatim line-clamp-6">{quoteLine(a.text)}</span>
							<span className="mt-0.5 block text-xs text-accent">
								p. {a.page} · open the page
							</span>
						</button>
					))}
				</div>
			)}
		</section>
	);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripArm = (title: string, arm: string) =>
	title.replace(new RegExp(`^${escape(arm)}\\s*[:–-]\\s*`, "i"), "");
