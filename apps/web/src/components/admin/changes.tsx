import type { BlockChange, NodeChange, Segment } from "@bspho/protocol/diff";
import type { UploadResult } from "./types";

const CONTEXT = 8;
const NUM = /(\d+(?:[.,]\d+)?)/;

/** PDF text layers flatten ×10⁹/L to "x109/L". */
const pretty = (s: string) => s.replace(/\bx\s?10\s?\^?9\s?\/\s?l\b/gi, "×10⁹/L");

/** Emphasise numbers inside an edited run. */
function Nums({ text }: { text: string }) {
	return (
		<>
			{pretty(text)
				.split(NUM)
				.map((part, i) =>
					i % 2 ? (
						<strong key={i} className="font-semibold">
							{part}
						</strong>
					) : (
						part
					),
				)}
		</>
	);
}

function elide(text: string, where: "start" | "end" | "middle") {
	const w = text.split(" ");
	if (w.length <= 2 * CONTEXT) return text;
	if (where === "start") return `… ${w.slice(-CONTEXT).join(" ")}`;
	if (where === "end") return `${w.slice(0, CONTEXT).join(" ")} …`;
	return `${w.slice(0, CONTEXT).join(" ")} … ${w.slice(-CONTEXT).join(" ")}`;
}

function Segments({ segments }: { segments: Segment[] }) {
	return (
		<p className="text-sm leading-relaxed">
			{segments.map((s, i) => {
				if (s.op === "same") {
					const where =
						i === 0
							? "start"
							: i === segments.length - 1
								? "end"
								: "middle";
					return (
						<span key={i} className="text-muted">
							{pretty(elide(s.text, where))}{" "}
						</span>
					);
				}
				return s.op === "del" ? (
					<del
						key={i}
						className="mr-1 rounded bg-warn-soft px-0.5 text-warn decoration-warn/60"
					>
						<Nums text={s.text} />
					</del>
				) : (
					<ins
						key={i}
						className="mr-1 rounded bg-go-soft px-0.5 text-go no-underline"
					>
						<Nums text={s.text} />
					</ins>
				);
			})}
		</p>
	);
}

function pageRef(b: BlockChange) {
	const { old, new: nw } = b.page;
	if (old && nw) return old === nw ? `p. ${nw}` : `p. ${old} → ${nw}`;
	return nw ? `new, p. ${nw}` : `was p. ${old}`;
}

function Change({ c }: { c: NodeChange }) {
	const pages = c.pages.new ?? c.pages.old;
	const pageText =
		c.pages.old && c.pages.new && c.pages.old.from !== c.pages.new.from
			? `pp. ${c.pages.old.from} → ${c.pages.new.from}`
			: `p. ${pages?.from ?? "?"}`;
	const numbers = c.blocks.flatMap((b) => b.numbers);
	return (
		<li className="border-t border-line px-5 py-4 first:border-t-0">
			<div className="flex items-baseline justify-between gap-4">
				<div className="min-w-0">
					{c.headingPath.length > 0 && (
						<p className="truncate text-xs text-faint">
							{c.headingPath.join(" › ")}
						</p>
					)}
					<p className="font-medium">
						{c.status === "added" && (
							<span className="mr-2 rounded bg-go-soft px-1.5 py-0.5 text-[11px] font-medium text-go">
								New section
							</span>
						)}
						{c.status === "removed" && (
							<span className="mr-2 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">
								Removed
							</span>
						)}
						<span
							className={
								c.status === "removed" ? "text-muted line-through" : ""
							}
						>
							{c.title}
						</span>
					</p>
				</div>
				<span className="shrink-0 font-mono text-xs text-faint">
					{pageText}
				</span>
			</div>
			{numbers.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-2">
					{numbers.map((n, i) => (
						<span
							key={i}
							className="rounded-md bg-mark/60 px-2 py-1 font-mono text-sm"
						>
							{n.before && (
								<span className="text-muted">{pretty(n.before)} </span>
							)}
							<span className="text-warn line-through decoration-warn/60">
								{n.old || "∅"}
							</span>
							<span className="mx-1.5 text-muted">→</span>
							<strong className="text-ink">{n.new || "∅"}</strong>
							{n.after && (
								<span className="text-muted"> {pretty(n.after)}</span>
							)}
						</span>
					))}
				</div>
			)}
			{c.blocks.length > 0 && (
				<div className="mt-3 grid gap-2">
					{c.blocks.slice(0, 4).map((b, i) => (
						<div key={i} className="flex gap-3">
							<span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-faint">
								{pageRef(b)}
							</span>
							<Segments segments={b.segments} />
						</div>
					))}
					{c.blocks.length > 4 && (
						<p className="pl-23 text-xs text-faint">
							and {c.blocks.length - 4} more paragraphs
						</p>
					)}
				</div>
			)}
		</li>
	);
}

const GROUPS: { id: NodeChange["category"]; label: string; hint: string }[] = [
	{
		id: "numeric",
		label: "Numbers changed",
		hint: "Doses, counts, thresholds, days",
	},
	{ id: "textual", label: "Wording changed", hint: "Same section, different text" },
	{ id: "structural", label: "Sections added or removed", hint: "" },
];

export function Changes({ diff }: { diff: NonNullable<UploadResult["diff"]> }) {
	const { counts } = diff;
	const total = counts.added + counts.removed + counts.changed;
	return (
		<section className="rounded-lg border border-line bg-surface">
			<header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
				<div>
					<h3 className="font-semibold">What changed</h3>
					<p className="text-sm text-muted">
						Version {diff.from.version || "?"} → {diff.to.version || "?"},
						compared section by section
					</p>
				</div>
				<p className="text-sm text-muted">
					{total === 0 ? (
						"No text changes found"
					) : (
						<>
							<strong className="text-ink">{counts.changed}</strong>{" "}
							sections changed
							{counts.numeric ? (
								<>, {counts.numeric} with numbers</>
							) : null}
							{counts.added ? <> · {counts.added} new</> : null}
							{counts.removed ? <> · {counts.removed} removed</> : null}
							<span className="text-faint">
								{" "}
								· {counts.unchanged} unchanged
							</span>
						</>
					)}
				</p>
			</header>
			{GROUPS.map((g) => {
				const items = diff.changes.filter((c) => c.category === g.id);
				if (!items.length) return null;
				return (
					<div key={g.id}>
						<h4 className="flex items-baseline gap-2 bg-paper/60 px-5 py-2 text-xs font-semibold tracking-wide text-muted uppercase">
							{g.label}{" "}
							<span className="font-normal tracking-normal normal-case">
								{items.length}
							</span>
							{g.hint && (
								<span className="font-normal tracking-normal text-faint normal-case">
									· {g.hint}
								</span>
							)}
						</h4>
						<ul>
							{items.map((c) => (
								<Change key={`${c.status}-${c.nodeId}`} c={c} />
							))}
						</ul>
					</div>
				);
			})}
			{diff.truncated > 0 && (
				<p className="border-t border-line px-5 py-3 text-sm text-faint">
					and {diff.truncated} more changes not shown
				</p>
			)}
		</section>
	);
}
