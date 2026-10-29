"use client";

import type { Anchor, Edge, Node } from "@bspho/protocol/spec";
import {
	Check,
	ChevronDown,
	ChevronRight,
	GitFork,
	Layers,
	Route,
	Shuffle,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { quoteLine } from "@/lib/format";
import { createPortal } from "react-dom";
import { type Arm, splitNumber } from "@/lib/flow";
import { armName, type RiskPath, type Segment, slotsOf } from "@/lib/path";

type Status = (id: string) => "done" | "current" | undefined;

interface Tip {
	x: number;
	y: number;
	title: string;
	anchors: Anchor[];
	/** Steps to list (a folded arm, a fork's options). */
	steps?: Node[];
	note?: string;
}

/**
 * The protocol's journey in one line, under the header: sections, then the treatment steps of the
 * chosen risk group's path (or of the arm being read). Follows the scroll, shows the case's done /
 * current steps, jumps on click. Forks and re-stratifications sit on the path; hover for the rule.
 */
export function SpineBar({
	sections,
	paths,
	path,
	setPath,
	arms,
	edges,
	spy,
	caseArm,
	status,
	go,
	goSection,
	show,
}: {
	/** Sheet sections in order; "treatment" is where the steps go. */
	sections: { id: string; label: string }[];
	paths: RiskPath[];
	path: RiskPath | null;
	setPath: (id: string | null) => void;
	arms: Arm[];
	edges: Edge[];
	spy: string;
	caseArm?: string;
	status?: Status;
	go: (nodeId: string) => void;
	goSection: (id: string) => void;
	show: (a: Anchor) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [tip, setTip] = useState<Tip | null>(null);
	const hideTip = useRef<ReturnType<typeof setTimeout>>(undefined);
	const [picker, setPicker] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);

	// Without a path: the arm being read (or the case's), one at a time like the map.
	const armOf = useMemo(() => {
		const m = new Map<string, Arm>();
		for (const a of arms) for (const s of a.steps) m.set(s.id, a);
		return m;
	}, [arms]);
	const [lastArm, setLastArm] = useState<string | undefined>(undefined);
	const spyArm = armOf.get(spy)?.key;
	if (spyArm !== undefined && spyArm !== lastArm) setLastArm(spyArm);
	const readArm =
		arms.find((a) => a.key === (spyArm ?? lastArm)) ??
		arms.find((a) => a.key === caseArm) ??
		arms[0];
	const segments: Segment[] = path
		? path.segments
		: readArm
			? [{ arm: readArm, steps: readArm.steps }]
			: [];

	const active = spy;
	useEffect(() => {
		const el = scroller.current;
		const on = el?.querySelector<HTMLElement>("[data-spine-on]");
		if (!el || !on) return;
		const left = on.offsetLeft - el.clientWidth / 2 + on.offsetWidth / 2;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		el.scrollTo({ left: Math.max(0, left), behavior: still ? "auto" : "smooth" });
	}, [active, path, readArm?.key]);

	useEffect(() => {
		if (!picker) return;
		const close = (e: MouseEvent) => {
			if (!pickerRef.current?.contains(e.target as globalThis.Node)) setPicker(false);
		};
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setPicker(false);
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", esc);
		};
	}, [picker]);

	const tipAt = (target: Element, t: Omit<Tip, "x" | "y">) => {
		clearTimeout(hideTip.current);
		const box = target.getBoundingClientRect();
		setTip({
			...t,
			x: Math.max(8, Math.min(box.left - 12, window.innerWidth - 440)),
			y: box.bottom + 6,
		});
	};
	const leave = () => {
		clearTimeout(hideTip.current);
		hideTip.current = setTimeout(() => setTip(null), 200);
	};

	const pill = (on: boolean, st?: "done" | "current") =>
		`flex h-7 max-w-52 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset ${
			st === "current"
				? "bg-accent font-semibold text-white"
				: on
					? "bg-accent-soft font-semibold text-accent ring-1 ring-inset ring-accent/40"
					: st === "done"
						? "text-muted hover:bg-paper hover:text-ink"
						: "text-ink/85 hover:bg-paper hover:text-ink"
		}`;
	const sep = (k: string) => (
		<ChevronRight
			key={k}
			size={13}
			aria-hidden
			className="shrink-0 text-faint/70"
		/>
	);
	const marker = (key: string, via: Edge[], title: string) => {
		const anchors = via.flatMap((e) => (e.evidence ? [e.evidence] : []));
		const restrat = via.some((e) => e.kind === "restratify_to");
		const Icon = restrat ? Shuffle : GitFork;
		return (
			<button
				key={key}
				type="button"
				aria-label={title}
				onMouseEnter={(ev) =>
					tipAt(ev.currentTarget, {
						title,
						anchors: dedupe(anchors),
						note: anchors.length
							? undefined
							: "No sentence in the protocol was found for this link.",
					})
				}
				onMouseLeave={leave}
				onFocus={(ev) =>
					tipAt(ev.currentTarget, { title, anchors: dedupe(anchors) })
				}
				onBlur={leave}
				onClick={() => anchors[0] && show(anchors[0])}
				className="flex size-6 shrink-0 cursor-help items-center justify-center rounded-full border border-flow/50 bg-flow-soft text-flow"
			>
				<Icon size={12} aria-hidden />
			</button>
		);
	};

	const stepButton = (s: Node, arm: Arm, compact = false) => {
		const st = status?.(s.id);
		const on = s.id === active;
		return (
			<button
				key={s.id}
				type="button"
				data-spine-on={on || st === "current" ? "" : undefined}
				onClick={() => go(s.id)}
				title={`${s.title} (p. ${s.pages.from})`}
				aria-current={on ? "step" : undefined}
				className={`${pill(on, st)} ${compact ? "max-w-40" : ""}`}
			>
				{st === "done" && (
					<Check
						size={12}
						strokeWidth={3}
						aria-label="completed"
						className="shrink-0 text-go"
					/>
				)}
				<span className="truncate">{stepLabel(s, arm)}</span>
			</button>
		);
	};

	const out: React.ReactNode[] = [];
	// One chevron between items, never two in a row (segment start + first slot).
	let lastSep = false;
	const push = (n: React.ReactNode, isSep = false) => {
		if (isSep && (lastSep || !out.length)) return;
		out.push(n);
		lastSep = isSep;
	};
	for (const sec of sections) {
		if (sec.id !== "treatment") {
			push(sep(`sep-${sec.id}`), true);
			const on = active === sec.id;
			push(
				<button
					key={sec.id}
					type="button"
					data-spine-on={on ? "" : undefined}
					onClick={() => goSection(sec.id)}
					className={pill(on)}
				>
					<span className="truncate">{sec.label}</span>
				</button>,
			);
			continue;
		}
		segments.forEach((seg, si) => {
			push(sep(`sep-t-${si}`), true);
			// Entry into a group's own arm: the re-stratification rule, quoted.
			if (seg.entry)
				push(
					marker(
						`entry-${si}`,
						[seg.entry],
						`Re-stratification into ${seg.arm.label}`,
					),
				);
			const armOn = si === 0 && active === "treatment";
			if (!path || seg.entry || si === 0 || path.own.has(seg.arm.key))
				push(
					<span
						key={`arm-${si}`}
						data-spine-on={armOn ? "" : undefined}
						title={seg.arm.label}
						className={`max-w-48 shrink-0 truncate px-1 text-[13px] font-semibold ${armOn ? "text-accent" : "text-muted"}`}
					>
						{/* One arm only: its parent title ("Therapy Elements") says less than the section. */}
						{arms.length === 1 ? "Treatment" : armName(seg.arm, paths)}
					</span>,
				);
			slotsOf(seg, edges).forEach((slot, k) => {
				const key = `${si}-${k}`;
				if (slot.folded) {
					const st = slot.steps.find((s) => status?.(s.id) === "current")
						? "current"
						: slot.steps.every((s) => status?.(s.id) === "done")
							? "done"
							: undefined;
					const on = slot.steps.some((s) => s.id === active);
					push(
						<button
							key={key}
							type="button"
							data-spine-on={on || st === "current" ? "" : undefined}
							onClick={() => go(slot.steps[0].id)}
							onMouseEnter={(ev) =>
								tipAt(ev.currentTarget, {
									title: `${seg.arm.label}: ${slot.steps.length} steps`,
									anchors: [],
									steps: slot.steps,
								})
							}
							onMouseLeave={leave}
							className={pill(on, st)}
						>
							<Layers size={12} aria-hidden className="shrink-0" />
							<span className="tabular-nums">
								{slot.steps.length} steps
							</span>
						</button>,
					);
					return;
				}
				push(sep(`sep-${key}`), true);
				if (slot.via.length)
					push(
						marker(
							`via-${key}`,
							slot.via,
							slot.steps.length > 1
								? `Fork: ${slot.steps.length} options`
								: slot.via.some((e) => e.kind === "restratify_to")
									? "Re-stratification"
									: "Option at a fork",
						),
					);
				if (slot.steps.length === 1) {
					push(stepButton(slot.steps[0], seg.arm));
					return;
				}
				// A fork's options side by side, in one bracket.
				push(
					<span
						key={`fork-${key}`}
						className="flex shrink-0 items-center gap-0.5 rounded-full border border-flow/30 px-0.5"
					>
						{slot.steps.map((s, i) => (
							<span key={s.id} className="flex items-center">
								{i > 0 && (
									<span aria-hidden className="px-0.5 text-xs text-faint">
										or
									</span>
								)}
								{stepButton(s, seg.arm, true)}
							</span>
						))}
					</span>,
				);
			});
		});
	}

	return (
		<div className="flex h-10 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur">
			{paths.length > 0 && (
				<div ref={pickerRef} className="relative shrink-0">
					<div
						className={`flex h-7 items-center rounded-md border text-[13px] ${path ? "border-accent bg-accent-soft text-accent" : "border-line text-ink hover:border-accent"}`}
					>
						<button
							type="button"
							aria-expanded={picker}
							aria-haspopup="listbox"
							onClick={() => setPicker((p) => !p)}
							title="Show the treatment path of one risk group"
							className="flex h-full items-center gap-1.5 pr-1.5 pl-2"
						>
							<Route size={14} aria-hidden />
							<span className="max-w-36 truncate font-medium">
								{path ? path.label : "All groups"}
							</span>
							<ChevronDown size={13} aria-hidden />
						</button>
						{path && (
							<button
								type="button"
								aria-label="Show all groups"
								title="All groups"
								onClick={() => setPath(null)}
								className="flex h-full items-center border-l border-accent/30 px-1.5 hover:bg-accent hover:text-white"
							>
								<X size={13} />
							</button>
						)}
					</div>
					{picker && (
						<div
							role="listbox"
							aria-label="Risk group path"
							className="absolute top-full left-0 z-40 mt-1.5 w-72 rounded-lg border border-line bg-surface p-1.5 text-sm shadow-lg"
						>
							<p className="px-2 pt-1 pb-1.5 text-xs text-muted">
								Show the treatment path of one group. Other arms stay on
								the sheet, folded.
							</p>
							{paths.map((p) => (
								<button
									key={p.id}
									type="button"
									role="option"
									aria-selected={path?.id === p.id}
									title={p.title}
									onClick={() => {
										setPath(p.id);
										setPicker(false);
									}}
									className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${path?.id === p.id ? "bg-accent-soft font-medium text-accent" : "hover:bg-paper"}`}
								>
									<span className="min-w-0 flex-1 truncate">{p.label}</span>
									<span className="text-xs text-faint tabular-nums">
										{p.steps.size} steps
									</span>
								</button>
							))}
							<button
								type="button"
								role="option"
								aria-selected={!path}
								onClick={() => {
									setPath(null);
									setPicker(false);
								}}
								className={`mt-1 flex w-full items-center gap-2 rounded border-t border-line px-2 py-1.5 text-left ${!path ? "font-medium text-accent" : "hover:bg-paper"}`}
							>
								All groups
							</button>
						</div>
					)}
				</div>
			)}
			<nav
				aria-label="Protocol journey"
				ref={scroller}
				className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-24px),transparent)] [&::-webkit-scrollbar]:hidden"
			>
				<span className="w-1 shrink-0" />
				{out}
				<span className="w-5 shrink-0" />
			</nav>
			{/* Portalled: the bar's backdrop blur would make it the box `fixed` is measured from. */}
			{tip &&
				createPortal(
				<div
					onMouseEnter={() => clearTimeout(hideTip.current)}
					onMouseLeave={leave}
					style={{ left: tip.x, top: tip.y }}
					className="fixed z-50 w-[26rem] rounded-lg border border-line bg-surface p-3 text-sm shadow-lg"
				>
					<p className="mb-1 text-xs font-semibold tracking-wide text-flow uppercase">
						{tip.title}
					</p>
					{tip.note && <p className="text-muted">{tip.note}</p>}
					{tip.anchors.map((a, i) => (
						<button
							key={i}
							type="button"
							onClick={() => {
								setTip(null);
								show(a);
							}}
							className="mt-1 block w-full rounded border border-line bg-paper px-2 py-1.5 text-left hover:border-flow/50 hover:bg-flow-soft"
						>
							<span className="verbatim line-clamp-6">{quoteLine(a.text)}</span>
							<span className="mt-0.5 block text-xs text-accent">
								p. {a.page} · open the page
							</span>
						</button>
					))}
					{tip.steps && (
						<ul className="mt-1 grid max-h-72 gap-0.5 overflow-y-auto">
							{tip.steps.map((s) => (
								<li key={s.id}>
									<button
										type="button"
										onClick={() => {
											setTip(null);
											go(s.id);
										}}
										className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-paper ${s.id === active ? "font-medium text-accent" : ""}`}
									>
										{status?.(s.id) === "done" && (
											<Check size={12} strokeWidth={3} className="text-go" />
										)}
										<span className="min-w-0 flex-1">{s.title}</span>
										<span className="text-xs text-faint tabular-nums">
											p. {s.pages.from}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>,
				document.body,
			)}
		</div>
	);
}

const dedupe = (as: Anchor[]) => {
	const seen = new Set<string>();
	return as.filter((a) => {
		const k = `${a.page}:${a.text}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "13.9.2 Standard Risk: Consolidation 1" in the Standard Risk arm → "Consolidation 1". */
function stepLabel(s: Node, arm: Arm): string {
	const full = splitNumber(s.title)[1];
	const t = full
		.replace(new RegExp(`^${escape(arm.short)}\\s*[:–-]?\\s*`, "i"), "")
		.replace(/^[^:]{2,32}:\s+/, "")
		.trim();
	return t || full;
}
