"use client";

import type { Edge, Node } from "@bspho/protocol/spec";
import {
	Check,
	ClipboardCopy,
	ClipboardPaste,
	Ellipsis,
	FileText,
	History,
	Printer,
	Route,
	Settings,
	X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type ArmOption,
	armOptions,
	armSource,
	ehrSummary,
	type LineNote,
	quote,
	requirementLines,
} from "@/lib/case";
import { isGenericArm } from "@/lib/flow";
import { PROTO_LANGS, useProtoLang } from "../proto-lang";
import type { CaseApi } from "./use-case";

/** Arm names as the protocol titles them; a generic parent reads as plain "Treatment". */
const armText = (s: string) => (isGenericArm(s) ? "Treatment" : s);

/* ------------------------------------------------------------------ header buttons */

/** The header's secondary actions in one menu: follow or reopen a case, print the sheet. */
export function CaseHeaderButtons({
	kase,
	onPrint,
}: {
	kase: CaseApi;
	onPrint: () => void;
}) {
	const [open, setOpen] = useState(false);
	const { lang, setLang } = useProtoLang();
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent | KeyboardEvent) => {
			if (
				e instanceof KeyboardEvent
					? e.key === "Escape"
					: !box.current?.contains(e.target as globalThis.Node)
			)
				setOpen(false);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", close);
		};
	}, [open]);
	const item = (
		icon: React.ReactNode,
		label: string,
		hint: string,
		run: () => void,
	) => (
		<button
			type="button"
			role="menuitem"
			onClick={() => {
				setOpen(false);
				run();
			}}
			className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
		>
			<span className="mt-0.5 text-accent">{icon}</span>
			<span>
				<span className="block text-sm font-medium">{label}</span>
				<span className="block text-[13px] text-muted">{hint}</span>
			</span>
		</button>
	);
	return (
		<div ref={box} className="relative shrink-0">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="More actions"
				className={`flex items-center rounded-md border px-2.5 py-2 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent ${open ? "border-accent text-accent" : "border-line"}`}
			>
				<Ellipsis size={18} />
			</button>
			{open && (
				<div
					role="menu"
					className="absolute top-full right-0 z-50 mt-1.5 w-72 rounded-lg border border-line bg-surface p-1.5 shadow-lg"
				>
					{!kase.state &&
						item(
							<Route size={16} />,
							"Follow a case",
							"Track one patient's position. Nothing is stored.",
							() => kase.setUi("start"),
						)}
					{item(
						<ClipboardPaste size={16} />,
						"Paste case code",
						"Reopen a case from the EHR note",
						() => kase.setUi("paste"),
					)}
					{item(
						<Printer size={16} />,
						"Print",
						"The sheet as shown, with page references",
						onPrint,
					)}
					<div className="my-1 border-t border-line" />
					<div role="group" aria-label="Protocol language">
						<p className="px-3 pt-1.5 pb-1 text-[13px] text-muted">
							Protocol language
						</p>
						{PROTO_LANGS.map((l) => (
							<button
								key={l.id}
								type="button"
								role="menuitemradio"
								aria-checked={lang === l.id}
								onClick={() => {
									setOpen(false);
									setLang(l.id);
								}}
								className={`flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-sm hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none ${lang === l.id ? "font-medium" : ""}`}
							>
								<span className="w-4 text-accent">
									{lang === l.id && <Check size={16} />}
								</span>
								{l.label}
							</button>
						))}
					</div>
					<div className="my-1 border-t border-line" />
					<Link
						href="/admin"
						role="menuitem"
						className="flex items-start gap-2.5 rounded-md px-3 py-2 hover:bg-accent-soft"
					>
						<span className="mt-0.5 text-accent">
							<Settings size={16} />
						</span>
						<span>
							<span className="block text-sm font-medium">Admin</span>
							<span className="block text-[13px] text-muted">
								New versions, hospitals, local rules
							</span>
						</span>
					</Link>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ case bar */

export function CaseBar({
	kase,
	protocol,
	onJump,
}: {
	kase: CaseApi;
	protocol: { short: string; version: string };
	onJump: (stepId: string) => void;
}) {
	const c = kase.state;
	if (!c) return null;
	const t = (id?: string) =>
		id
			? armSource(id, kase.byId, kase.treatment).title.replace(/^[\d.]+\s*/, "")
			: undefined;
	return (
		<div className="no-print border-b border-accent/30 bg-accent-soft/95 px-4 py-2 backdrop-blur">
			<div className="flex items-center gap-3 text-sm">
				<span className="flex shrink-0 items-center gap-1.5 font-semibold text-accent">
					<Route size={16} aria-hidden /> Case
				</span>
				<span
					className="max-w-[16rem] min-w-0 shrink-0 truncate"
					title={t(c.arm)}
				>
					<span className="text-muted">Arm </span>
					<span className="font-medium">
						{c.arm ? armText(t(c.arm) ?? "") : "not chosen"}
					</span>
				</span>
				<span className="text-faint">·</span>
				{c.cur ? (
					<button
						type="button"
						onClick={() => c.cur && onJump(c.cur)}
						className="min-w-0 truncate text-left font-medium text-accent hover:underline"
						title="Go to the current step"
					>
						<span className="font-normal text-muted">Now </span>
						{t(c.cur)}
						{c.started ? " (started)" : ""}
					</button>
				) : (
					<span className="text-muted">End of flow</span>
				)}
				<code
					className="ml-auto w-36 shrink-0 truncate rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs text-muted"
					title={`${kase.code}\nOnly protocol positions: no name, date or value. ${protocol.short} ${protocol.version}`}
				>
					{kase.code}
				</code>
				<button
					type="button"
					onClick={() => kase.setUi("summary")}
					className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent/90"
				>
					<ClipboardCopy size={15} aria-hidden /> Copy for EHR
				</button>
				<button
					type="button"
					onClick={() => {
						if (
							window.confirm(
								"End this case on screen? Copy the EHR text first: nothing is kept here.",
							)
						)
							kase.end();
					}}
					className="shrink-0 rounded-md px-2 py-1 text-muted hover:bg-surface hover:text-ink"
				>
					End case
				</button>
			</div>
			{kase.stale && (
				<div className="mt-2 flex items-center gap-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
					<History size={16} aria-hidden className="shrink-0" />
					<span className="min-w-0 flex-1">
						This case started on{" "}
						{kase.stale.version
							? `v${kase.stale.version.replace(/^v/i, "")}`
							: `PDF ${kase.stale.sha8}`}
						; v{protocol.version.replace(/^v/i, "")} is now published.
						Review changes before continuing.
						{kase.dropped > 0 &&
							` ${kase.dropped} position(s) in the code no longer exist in this version.`}
					</span>
					<Link href="/admin" className="shrink-0 font-medium underline">
						Compare versions
					</Link>
					<button
						type="button"
						disabled
						className="shrink-0 cursor-not-allowed rounded border border-warn/40 px-2 py-0.5 opacity-60"
						title="Concept: the switch is the clinician's decision and goes into the EHR text"
					>
						Switch to v{protocol.version.replace(/^v/i, "")} (concept)
					</button>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ dialogs */

function Modal({
	title,
	onClose,
	children,
	wide,
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
	wide?: boolean;
}) {
	useEffect(() => {
		const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", k);
		return () => window.removeEventListener("keydown", k);
	}, [onClose]);
	return (
		<div
			className="no-print fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-8 pt-[8vh]"
			onMouseDown={(e) => e.target === e.currentTarget && onClose()}
		>
			<div
				role="dialog"
				aria-label={title}
				className={`flex max-h-[84vh] w-full flex-col rounded-xl border border-line bg-surface shadow-xl ${wide ? "max-w-3xl" : "max-w-2xl"}`}
			>
				<div className="flex items-center gap-2 border-b border-line px-5 py-3">
					<h2 className="text-lg font-semibold">{title}</h2>
					<button
						type="button"
						aria-label="Close"
						onClick={onClose}
						className="ml-auto rounded p-1 text-muted hover:bg-paper hover:text-ink"
					>
						<X size={18} />
					</button>
				</div>
				<div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
			</div>
		</div>
	);
}

const NOTHING_STORED =
	"Nothing about the patient is stored: the case is the code you paste into the EHR note.";

export function CaseDialogs({
	kase,
	nodes,
	edges,
	steps,
	protocol,
	hospital,
	hasRules,
	notes,
}: {
	kase: CaseApi;
	nodes: Node[];
	edges: Edge[];
	steps: Node[];
	protocol: { short: string; version: string; sha: string };
	hospital: string;
	hasRules: (stepId: string) => boolean;
	/** Notes on checklist lines (this tab only), for the EHR text. */
	notes?: LineNote[];
}) {
	const close = () => kase.setUi(null);
	if (kase.ui === "start")
		return (
			<StartDialog
				kase={kase}
				nodes={nodes}
				edges={edges}
				steps={steps}
				onClose={close}
			/>
		);
	if (kase.ui === "paste") return <PasteDialog kase={kase} onClose={close} />;
	if (kase.ui === "summary" && kase.state)
		return (
			<SummaryDialog
				onClose={close}
				text={ehrSummary({
					state: kase.state,
					code: kase.code ?? "",
					link: kase.link ?? "",
					protocol,
					byId: kase.byId,
					treatment: kase.treatment,
					edges,
					reqLines: kase.state.cur
						? requirementLines(kase.state.cur, nodes)
						: [],
					hospital,
					hasRules: !!kase.state.cur && hasRules(kase.state.cur),
					publishedNote: kase.stale
						? `Note: case started on PDF ${kase.stale.sha8}${kase.stale.version ? ` (v${kase.stale.version})` : ""}; shown against the published version.`
						: undefined,
					notes,
				})}
			/>
		);
	return null;
}

function StartDialog({
	kase,
	nodes,
	edges,
	steps,
	onClose,
}: {
	kase: CaseApi;
	nodes: Node[];
	edges: Edge[];
	steps: Node[];
	onClose: () => void;
}) {
	const options = useMemo(
		() => armOptions(nodes, edges, kase.treatment),
		[nodes, edges, kase.treatment],
	);
	const [pick, setPick] = useState<ArmOption | null>(null);
	const [why, setWhy] = useState<number[]>([]);
	const [step, setStep] = useState<string>();
	const choose = (o: ArmOption) => {
		setPick(o);
		setWhy([]);
		setStep(o.firstStep);
	};
	const groups: [string, ArmOption[]][] = [
		[
			"Risk groups, as defined in the protocol",
			options.filter((o) => o.source === "risk_group"),
		],
		["Treatment arms and phases", options.filter((o) => o.source === "arm")],
	];
	return (
		<Modal title="Follow a case" onClose={onClose} wide>
			<p className="mb-4 text-sm text-muted">
				Pick the arm or risk group, tick why (the protocol's own criteria), and
				start. {NOTHING_STORED}
			</p>
			{!options.length && (
				<p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
					No treatment steps or risk groups were found in this protocol
					version, so there is nothing to follow yet.
				</p>
			)}
			<div
				className={`grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)] gap-5 ${options.length ? "" : "hidden"}`}
			>
				<div className="grid content-start gap-3">
					{groups.map(([label, opts]) =>
						opts.length ? (
							<div key={label}>
								<p className="mb-1 text-[13px] font-semibold text-muted">
									{label}
								</p>
								<div className="grid gap-1">
									{opts.map((o) => (
										<button
											key={o.id}
											type="button"
											onClick={() => choose(o)}
											className={`rounded-md border px-2.5 py-1.5 text-left text-sm leading-snug transition-colors ${pick?.id === o.id ? "border-accent bg-accent text-white" : "border-line hover:border-accent hover:bg-accent-soft"}`}
										>
											{armText(o.label.replace(/^[\d.]+\s*/, ""))}
										</button>
									))}
								</div>
							</div>
						) : null,
					)}
				</div>
				<div className="min-w-0">
					{pick ? (
						<>
							<p className="mb-1 text-[13px] font-semibold text-muted">
								Why: tick the criteria met, as written
							</p>
							{pick.criteria.length ? (
								<ul className="mb-4 grid gap-1">
									{pick.criteria.map((a, i) => {
										const on = why.includes(i);
										return (
											<li key={`${a.page}-${i}`}>
												<label
													className={`flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1 ${on ? "bg-go-soft" : "hover:bg-paper"}`}
												>
													<input
														type="checkbox"
														checked={on}
														onChange={() =>
															setWhy((w) =>
																on
																	? w.filter(
																			(x) =>
																				x !== i,
																		)
																	: [...w, i],
															)
														}
														className="mt-1 size-4 accent-[var(--go)]"
													/>
													<span className="min-w-0 flex-1 text-[15px] leading-snug">
														{quote(a)}
													</span>
													<span className="shrink-0 font-mono text-xs text-faint">
														p. {a.page}
													</span>
												</label>
											</li>
										);
									})}
								</ul>
							) : (
								<p className="mb-4 text-sm text-muted">
									No criteria lines in this section of the protocol.
								</p>
							)}
							<label className="mb-4 block text-sm">
								<span className="mb-1 block text-[13px] font-semibold text-muted">
									Current step
								</span>
								<select
									value={step ?? ""}
									onChange={(e) =>
										setStep(e.target.value || undefined)
									}
									className="w-full rounded-md border border-line bg-paper px-2 py-1.5"
								>
									{steps.map((s) => (
										<option key={s.id} value={s.id}>
											{s.title}
										</option>
									))}
								</select>
							</label>
							<button
								type="button"
								onClick={() => kase.begin(pick.id, why, step)}
								className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent/90"
							>
								Start following
							</button>
						</>
					) : (
						<p className="pt-6 text-sm text-muted">
							Choose an arm or risk group on the left.
						</p>
					)}
				</div>
			</div>
		</Modal>
	);
}

function PasteDialog({ kase, onClose }: { kase: CaseApi; onClose: () => void }) {
	const [raw, setRaw] = useState("");
	const [err, setErr] = useState<string | null>(null);
	return (
		<Modal title="Paste case code" onClose={onClose}>
			<p className="mb-3 text-sm text-muted">
				Paste the code (or the whole EHR block) to reopen the case where it was.{" "}
				{NOTHING_STORED}
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					setErr(kase.restore(raw));
				}}
			>
				<textarea
					autoFocus
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
					rows={3}
					placeholder="ml-ds-2018.fd1661b2.eyJh…"
					className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-accent"
				/>
				{err && <p className="mt-1 text-sm text-warn">{err}</p>}
				<button
					type="submit"
					className="mt-3 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent/90"
				>
					Open case
				</button>
			</form>
		</Modal>
	);
}

function SummaryDialog({ text, onClose }: { text: string; onClose: () => void }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			ref.current?.select();
			document.execCommand("copy");
		}
		ref.current?.select();
		setCopied(true);
	};
	return (
		<Modal title="Handover / EHR summary" onClose={onClose} wide>
			<p className="mb-2 flex items-center gap-1.5 text-sm text-muted">
				<FileText size={15} aria-hidden /> Paste this into the EHR note. The
				last line reopens the case. {NOTHING_STORED}
			</p>
			<textarea
				ref={ref}
				readOnly
				value={text}
				rows={Math.min(22, text.split("\n").length + 1)}
				onFocus={(e) => e.currentTarget.select()}
				className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] leading-relaxed"
			/>
			<button
				type="button"
				onClick={() => void copy()}
				className="mt-3 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent/90"
			>
				<ClipboardCopy size={16} aria-hidden /> {copied ? "Copied" : "Copy"}
			</button>
		</Modal>
	);
}
