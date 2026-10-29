"use client";

import type { Edge, Node } from "@bspho/protocol/spec";
import {
	ArrowRight,
	CircleCheck,
	Clock,
	GitFork,
	Play,
	Route,
	Shuffle,
} from "lucide-react";
import { useState } from "react";
import { DELAY_REASONS, quote, stepExits } from "@/lib/case";
import type { CaseApi } from "./use-case";

/**
 * The transition controls on the case's current step card: start, postpone, complete and follow the
 * protocol's own edge (with its evidence quote). The clinician decides; nothing is computed from values.
 */
export function CaseStepPanel({
	kase,
	step,
	nodes,
	edges,
	hasRules,
	hospital,
}: {
	kase: CaseApi;
	step: Node;
	nodes: Node[];
	edges: Edge[];
	hasRules: boolean;
	hospital: string;
}) {
	const c = kase.state;
	const [postpone, setPostpone] = useState(false);
	const [reason, setReason] = useState(0);
	const [day, setDay] = useState("");
	if (!c) return null;
	const status = kase.status(step.id);
	if (status === "done")
		return (
			<p className="mb-3 flex items-center gap-1.5 rounded-md bg-go-soft px-3 py-2 text-sm font-medium text-go">
				<CircleCheck size={16} aria-hidden /> Completed in this case
			</p>
		);
	if (status !== "current") return null;

	const { flow, restrat } = stepExits(step.id, nodes, edges);
	const title = (id: string) => kase.byId.get(id)?.title ?? id;
	const armOf = (id: string) => kase.byId.get(id)?.parent ?? undefined;
	const ticked = c.req.length;
	const total = kase.reqKeys.length;
	const delays = c.delays.filter((d) => d.step === step.id);

	const option = (e: Edge, kind: "flow" | "arm") => (
		<li
			key={`${e.kind}-${e.to}`}
			className="rounded-md border border-line bg-surface p-2.5"
		>
			<button
				type="button"
				onClick={() =>
					kase.moveTo(e.to, {
						fork:
							kind === "arm" ||
							flow.length > 1 ||
							e.kind === "alternative",
						arm: kind === "arm" ? armOf(e.to) : undefined,
					})
				}
				className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[15px] font-medium text-white ${kind === "arm" ? "bg-flow hover:bg-flow/90" : "bg-accent hover:bg-accent/90"}`}
			>
				{kind === "arm" ? (
					<Shuffle size={15} aria-hidden />
				) : (
					<ArrowRight size={15} aria-hidden />
				)}
				{kind === "arm" ? "Move to" : "Go to"} {title(e.to)}
			</button>
			{e.evidence ? (
				<p className="mt-1.5 text-sm leading-snug text-muted">
					<span className="font-semibold text-flow">Protocol says: </span>“
					{quote(e.evidence)}”{" "}
					<span className="font-mono text-xs whitespace-nowrap">
						p. {e.evidence.page}
					</span>
				</p>
			) : (
				<p className="mt-1.5 text-sm text-muted italic">
					not stated in the text, inferred from document order
				</p>
			)}
		</li>
	);

	return (
		<div className="mb-4 rounded-lg border-2 border-accent/50 bg-accent-soft/60 p-4">
			<p className="mb-2 flex items-center gap-2 text-base font-semibold text-accent">
				<Route size={18} aria-hidden /> You are here
				<span className="font-normal text-muted">
					· {c.started ? "started" : "not started"}
					{total ? ` · ${ticked} of ${total} requirements ticked by you` : ""}
				</span>
			</p>

			{delays.map((d, i) => (
				<p key={i} className="mb-1 flex items-center gap-1.5 text-sm text-warn">
					<Clock size={14} aria-hidden /> Postponed at protocol day {d.day}:{" "}
					{DELAY_REASONS[d.reason]}
				</p>
			))}

			{hasRules && (
				<label className="mb-2 flex items-center gap-2 text-sm text-local">
					<input
						type="checkbox"
						checked={c.rulesAck}
						onChange={() =>
							kase.update((s) => ({ ...s, rulesAck: !s.rulesAck }))
						}
						className="size-4 accent-[var(--local)]"
					/>
					{hospital} local rules for this step read
				</label>
			)}

			{!c.started ? (
				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						onClick={() => kase.update((s) => ({ ...s, started: true }))}
						className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[15px] font-medium text-white hover:bg-accent/90"
					>
						<Play size={15} aria-hidden /> Start this step
					</button>
					<button
						type="button"
						onClick={() => setPostpone((v) => !v)}
						className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-[15px] hover:border-accent"
					>
						<Clock size={15} aria-hidden /> Postpone
					</button>
				</div>
			) : (
				<div>
					<p className="mb-1.5 text-sm font-semibold text-ink/80">
						{flow.length > 1 ? (
							<span className="inline-flex items-center gap-1.5 text-flow">
								<GitFork size={15} aria-hidden /> Step completed: the
								protocol forks here. Pick the branch.
							</span>
						) : flow.length === 1 ? (
							"Step completed → next"
						) : restrat.length ? (
							"Step completed: move to the arm the response assessment gives"
						) : (
							"Last step of this flow in the protocol"
						)}
					</p>
					<ul className="grid gap-2">
						{flow.map((e) => option(e, "flow"))}
						{!flow.length && !restrat.length && (
							<li>
								<button
									type="button"
									onClick={() => kase.moveTo(undefined)}
									className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[15px] font-medium text-white hover:bg-accent/90"
								>
									<CircleCheck size={15} aria-hidden /> Step completed
								</button>
							</li>
						)}
					</ul>
					<button
						type="button"
						onClick={() => kase.update((s) => ({ ...s, started: false }))}
						className="mt-2 text-sm text-accent hover:underline"
					>
						Undo start
					</button>
				</div>
			)}

			{restrat.length > 0 && (
				<details className="mt-3" open={c.started && !flow.length}>
					<summary className="cursor-pointer text-sm font-semibold text-flow">
						<Shuffle size={14} aria-hidden className="mr-1 inline" /> Move
						to another arm ({restrat.length})
					</summary>
					<ul className="mt-2 grid gap-2">
						{restrat.map((e) => option(e, "arm"))}
					</ul>
				</details>
			)}

			{postpone && !c.started && (
				<form
					className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-warn/40 bg-warn-soft p-3"
					onSubmit={(e) => {
						e.preventDefault();
						const d = Number.parseInt(day, 10);
						if (!Number.isInteger(d)) return;
						kase.update((s) => ({
							...s,
							delays: [...s.delays, { step: step.id, reason, day: d }],
						}));
						setPostpone(false);
						setDay("");
					}}
				>
					<label className="text-sm">
						<span className="mb-0.5 block font-semibold text-warn">
							Reason
						</span>
						<select
							value={reason}
							onChange={(e) => setReason(Number(e.target.value))}
							className="rounded-md border border-line bg-surface px-2 py-1"
						>
							{DELAY_REASONS.map((r, i) => (
								<option key={r} value={i}>
									{r}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<span className="mb-0.5 block font-semibold text-warn">
							Protocol day
						</span>
						<input
							type="number"
							min={1}
							max={2000}
							required
							value={day}
							onChange={(e) => setDay(e.target.value)}
							placeholder="e.g. 29"
							className="w-24 rounded-md border border-line bg-surface px-2 py-1 tabular-nums"
						/>
					</label>
					<button
						type="submit"
						className="rounded-md bg-warn px-3 py-1.5 text-sm font-medium text-white"
					>
						Record delay
					</button>
					<span className="basis-full text-xs text-warn/80">
						Protocol coordinates only: no calendar date.
					</span>
				</form>
			)}
		</div>
	);
}
