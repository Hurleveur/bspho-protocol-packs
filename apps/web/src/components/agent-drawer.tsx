"use client";

import type { Passage } from "@bspho/protocol/agent";
import type { Anchor, ProtocolSpec } from "@bspho/protocol/spec";
import {
	ArrowUp,
	ChevronRight,
	LoaderCircle,
	MessageSquareText,
	RotateCcw,
	Square,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Event the pack listens to: jump to a node (and a line of it). */
export const AGENT_GO = "agent:go";
/** Window event that opens the drawer (the header's Ask AI button). */
export const AGENT_OPEN = "agent:open";
export interface AgentGoDetail {
	nodeId: string;
	page: number;
	text: string;
}

interface Msg {
	role: "user" | "assistant";
	content: string;
	passages?: Passage[];
	error?: boolean;
	done?: boolean;
}

interface Props {
	/** Absent on the shelf: the agent only answers inside one protocol. */
	protocol?: { id: string; short: string; version: string; sha: string };
	spec?: ProtocolSpec;
}

const CITE = /\[((?:s\d+\.)?(?:n\d+\.[bf]\d+|e\d+))(?:\s+p\d+)?\]/g;

/** Where the reader is on the sheet, read from the DOM the pack already renders (no pack state needed). */
function readLocation(protocolId: string, sha: string, lastLine: string | undefined) {
	const below = (el: Element) => el.getBoundingClientRect().top < 170;
	let nodeId: string | undefined;
	for (const el of document.querySelectorAll<HTMLElement>("main [id^='n-']"))
		if (below(el) && el.getBoundingClientRect().bottom > 64)
			nodeId = el.id.slice(2);
	let stepId: string | undefined;
	for (const el of document.querySelectorAll<HTMLElement>("article[data-spy]"))
		if (below(el) && el.getBoundingClientRect().bottom > 64)
			stepId = el.dataset.spy;
	let ticked: string[] = [];
	try {
		ticked = JSON.parse(
			sessionStorage.getItem(`checks:${protocolId}:${sha}`) ?? "[]",
		) as string[];
	} catch {}
	return {
		nodeId: nodeId ? decodeURIComponent(nodeId) : undefined,
		stepId,
		line: lastLine,
		ticked: ticked.slice(0, 200),
	};
}

export function AgentDrawer({ protocol, spec }: Props) {
	const [open, setOpen] = useState(false);
	const [msgs, setMsgs] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [here, setHere] = useState<{
		title: string;
		kind: string;
		isStep: boolean;
	} | null>(null);
	const lastLine = useRef<string | undefined>(undefined);
	const abort = useRef<AbortController | null>(null);
	const box = useRef<HTMLTextAreaElement>(null);
	const scroller = useRef<HTMLDivElement>(null);

	// Ctrl/Cmd+J toggles, Esc closes. Capture phase so Esc doesn't also close the pack's source pane.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
				e.preventDefault();
				setOpen((o) => !o);
			} else if (e.key === "Escape" && open) {
				e.stopPropagation();
				setOpen(false);
			}
		};
		const onOpen = () => setOpen(true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener(AGENT_OPEN, onOpen);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener(AGENT_OPEN, onOpen);
		};
	}, [open]);

	// Remember the last line the reader clicked on the sheet (lines carry data-anchor = page:text-prefix).
	useEffect(() => {
		const onClick = (e: MouseEvent) => {
			const el = (e.target as HTMLElement)?.closest<HTMLElement>(
				"main [data-anchor]",
			);
			if (el?.dataset.anchor) lastLine.current = el.dataset.anchor;
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	// Focus on opening only: `protocol` is a fresh object on every sheet render, and refocusing
	// then stole the keys from the search palette opened over the drawer.
	useEffect(() => {
		if (open) requestAnimationFrame(() => box.current?.focus());
	}, [open]);
	useEffect(() => {
		if (!open) return;
		if (protocol && spec) {
			const loc = readLocation(protocol.id, protocol.sha, lastLine.current);
			const n = spec.nodes.find((x) => x.id === (loc.stepId ?? loc.nodeId));
			setHere(
				n ? { title: n.title, kind: n.kind, isStep: n.kind === "step" } : null,
			);
		}
	}, [open, protocol, spec]);

	useEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [msgs]);

	/** Resolve a citation from the spec already on the page, so chips work while the answer streams. */
	const resolve = useCallback(
		(id: string, m: Msg): Passage | undefined => {
			const known = m.passages?.find((p) => p.id === id);
			if (known || !spec || !protocol) return known;
			const mk = (
				nodeIdx: number,
				a: Anchor | undefined,
			): Passage | undefined => {
				const n = spec.nodes[nodeIdx];
				return n && a
					? {
							id,
							protocolId: protocol.id,
							protocol: protocol.short,
							version: protocol.version,
							nodeId: n.id,
							section: n.title,
							page: a.page,
							text: a.text,
						}
					: undefined;
			};
			let r = /^n(\d+)\.([bf])(\d+)$/.exec(id);
			if (r) {
				const n = spec.nodes[+r[1]];
				return mk(
					+r[1],
					r[2] === "b" ? n?.blocks[+r[3]] : n?.figures?.[+r[3]]?.caption,
				);
			}
			r = /^e(\d+)$/.exec(id);
			if (r) {
				const e = spec.edges[+r[1]];
				return e
					? mk(
							spec.nodes.findIndex((n) => n.id === e.from),
							e.evidence,
						)
					: undefined;
			}
			return undefined;
		},
		[spec, protocol],
	);

	const jump = (p: Passage) => {
		if (protocol && p.protocolId === protocol.id) {
			window.dispatchEvent(
				new CustomEvent<AgentGoDetail>(AGENT_GO, {
					detail: { nodeId: p.nodeId, page: p.page, text: p.text },
				}),
			);
		} else
			window.location.href = `/p/${p.protocolId}?n=${encodeURIComponent(p.nodeId)}`;
	};

	async function send(text: string) {
		const q = text.trim();
		if (!q || busy || !protocol) return;
		const history: Msg[] = [
			...msgs.filter((m) => !m.error),
			{ role: "user", content: q },
		];
		setMsgs([...history, { role: "assistant", content: "" }]);
		setInput("");
		setBusy(true);
		const ctrl = new AbortController();
		abort.current = ctrl;
		const update = (patch: Partial<Msg>) =>
			setMsgs((ms) => [...ms.slice(0, -1), { ...ms[ms.length - 1], ...patch }]);
		try {
			const res = await fetch("/internal/agent", {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: ctrl.signal,
				body: JSON.stringify({
					protocolId: protocol.id,
					messages: history.map((m) => ({
						role: m.role,
						content: m.content,
					})),
					location: readLocation(protocol.id, protocol.sha, lastLine.current),
				}),
			});
			if (!res.ok || !res.body) throw new Error();
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let raw = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				raw += dec.decode(value, { stream: true });
				update({ content: raw.split("\u001e")[0] });
			}
			const [body, trailer] = raw.split("\u001e");
			const meta = trailer
				? (JSON.parse(trailer) as { passages: Passage[]; error?: boolean })
				: { passages: [], error: true };
			update({
				content: body,
				passages: meta.passages,
				error: meta.error,
				done: true,
			});
		} catch {
			if (!ctrl.signal.aborted)
				update({
					content: "The assistant is busy. Try again in a moment.",
					error: true,
					done: true,
				});
			else update({ done: true });
		} finally {
			setBusy(false);
			abort.current = null;
		}
	}

	const steps = spec?.nodes.filter((n) => n.kind === "step") ?? [];
	const thirdStep =
		steps.find((n) => /\b(course|block|cycle)\s*3\b/i.test(n.title)) ?? steps[2];
	const starters = !protocol
		? []
		: here?.isStep
			? [
					"What do I need before this step?",
					"What comes next after this step?",
					"What are the toxicity rules for this step?",
				]
			: [
					thirdStep
						? `What do I need before starting ${thirdStep.title}?`
						: "What are the requirements to start each course?",
					"What does the protocol say about hyperleukocytosis?",
					"How is the risk group assigned?",
				];

	if (!open && protocol) return null;
	if (!open)
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="no-print fixed right-20 bottom-5 z-40 flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink shadow-md transition-colors hover:border-accent hover:text-accent"
			>
				<MessageSquareText size={16} /> Ask {protocol ? "this protocol" : ""}
				<kbd className="rounded border border-line bg-paper px-1.5 font-mono text-xs text-muted">
					Ctrl J
				</kbd>
			</button>
		);

	return (
		<aside
			aria-label="Protocol assistant"
			className="no-print fixed top-0 right-0 bottom-0 z-50 flex w-[30rem] max-w-full flex-col border-l border-line bg-surface shadow-2xl"
		>
			<header className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-4">
				<MessageSquareText size={18} className="text-accent" />
				<div className="min-w-0">
					<p className="font-semibold">
						Ask {protocol?.short ?? "a protocol"}
					</p>
					<p className="truncate text-xs text-muted">
						The assistant only quotes the protocol. It is not a medical
						device.
					</p>
				</div>
				<div className="ml-auto flex items-center gap-1">
					{msgs.length > 0 && (
						<button
							type="button"
							title="New conversation"
							onClick={() => (abort.current?.abort(), setMsgs([]))}
							className="rounded p-1.5 text-muted hover:bg-paper hover:text-ink"
						>
							<RotateCcw size={16} />
						</button>
					)}
					<button
						type="button"
						aria-label="Close assistant (Esc)"
						onClick={() => setOpen(false)}
						className="rounded p-1.5 text-muted hover:bg-paper hover:text-ink"
					>
						<X size={18} />
					</button>
				</div>
			</header>

			{!protocol ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
					<p className="text-lg text-ink">Open a protocol to ask about it.</p>
					<p className="text-sm">
						The assistant reads one protocol at a time, with the section you
						are looking at.
					</p>
				</div>
			) : (
				<>
					<div
						ref={scroller}
						className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
					>
						{msgs.length === 0 && (
							<div>
								<p className="text-sm text-muted">
									Answers come only from the text of {protocol.short}{" "}
									{protocol.version}, with a link to every line it
									rests on.
									{here ? (
										<>
											{" "}
											You are on{" "}
											<span className="font-medium text-ink">
												{here.title}
											</span>
											.
										</>
									) : null}
								</p>
								<div className="mt-4 grid gap-2">
									{starters.map((s) => (
										<button
											key={s}
											type="button"
											onClick={() => send(s)}
											className="rounded-md border border-line bg-paper px-3 py-2 text-left text-sm transition-colors hover:border-accent hover:text-accent"
										>
											{s}
										</button>
									))}
								</div>
							</div>
						)}
						<div className="grid gap-4">
							{msgs.map((m, i) =>
								m.role === "user" ? (
									<p
										key={i}
										className="ml-8 justify-self-end rounded-lg bg-accent-soft px-3 py-2 text-[15px] whitespace-pre-wrap"
									>
										{m.content}
									</p>
								) : (
									<Answer
										key={i}
										m={m}
										resolve={(id) => resolve(id, m)}
										jump={jump}
										home={protocol?.short}
									/>
								),
							)}
						</div>
					</div>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void send(input);
						}}
						className="shrink-0 border-t border-line p-3"
					>
						<div className="flex items-end gap-2 rounded-lg border border-line bg-paper p-2 focus-within:border-accent">
							<textarea
								ref={box}
								rows={2}
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										void send(input);
									}
								}}
								placeholder="Ask about this protocol…"
								className="flex-1 resize-none bg-transparent px-1 text-[15px] outline-none placeholder:text-faint"
							/>
							{busy ? (
								<button
									type="button"
									aria-label="Stop"
									onClick={() => abort.current?.abort()}
									className="rounded-md bg-ink p-2 text-white"
								>
									<Square size={14} />
								</button>
							) : (
								<button
									type="submit"
									aria-label="Send"
									disabled={!input.trim()}
									className="rounded-md bg-accent p-2 text-white disabled:opacity-40"
								>
									<ArrowUp size={16} />
								</button>
							)}
						</div>
						<p className="mt-1.5 text-[11px] text-faint">
							Do not enter patient names or identifiers. Nothing is
							stored.
						</p>
					</form>
				</>
			)}
		</aside>
	);
}

function Answer({
	m,
	resolve,
	jump,
	home,
}: {
	m: Msg;
	resolve: (id: string) => Passage | undefined;
	jump: (p: Passage) => void;
	/** The protocol the drawer is open on: its name is left off its own citations. */
	home?: string;
}) {
	const ids: string[] = [];
	const line = (text: string, key: number) => {
		const parts: React.ReactNode[] = [];
		// One chip per page and protocol within a line: "p. 48" once, not after every quote.
		const shown = new Set<string>();
		let at = 0;
		for (const hit of text.matchAll(CITE)) {
			if (hit.index > at)
				parts.push(text.slice(at, hit.index).replace(/\s+$/, " "));
			const p = resolve(hit[1]);
			if (p) {
				if (!ids.includes(hit[1])) ids.push(hit[1]);
				const k = `${p.protocol}:${p.page}`;
				if (!shown.has(k)) {
					shown.add(k);
					parts.push(
						<Chip
							key={`${key}-${hit.index}`}
							p={p}
							home={home}
							jump={jump}
						/>,
					);
				}
			}
			at = hit.index + hit[0].length;
		}
		parts.push(text.slice(at));
		return parts;
	};
	const lines = m.content.split("\n");
	const passages = (
		m.passages?.length
			? m.passages
			: ids.map(resolve).filter((p): p is Passage => !!p)
	).filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i);

	return (
		<div className="text-[15px] leading-relaxed">
			{!m.content && !m.done && (
				<p className="flex items-center gap-2 text-sm text-muted">
					<LoaderCircle size={14} className="animate-spin" /> Reading the
					protocol…
				</p>
			)}
			<div className={m.error ? "text-warn" : ""}>
				{lines.map((l, i) => {
					const bullet = /^\s*[-*•]\s+/.exec(l);
					if (!l.trim()) return <div key={i} className="h-2" />;
					return bullet ? (
						<div key={i} className="flex gap-2 pl-1">
							<span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-muted" />
							<p className="min-w-0">
								{line(
									l.slice(bullet[0].length).replace(/\*\*/g, ""),
									i,
								)}
							</p>
						</div>
					) : (
						<p key={i}>{line(l.replace(/\*\*/g, ""), i)}</p>
					);
				})}
			</div>
			{m.done && passages.length > 0 && (
				<details className="group mt-3 rounded-md border border-line bg-paper">
					<summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-sm text-muted hover:text-ink">
						<ChevronRight
							size={14}
							className="transition-transform group-open:rotate-90"
						/>
						{passages.length} cited protocol passage
						{passages.length > 1 ? "s" : ""}
					</summary>
					<div className="grid gap-2 px-3 pb-3">
						{passages.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => jump(p)}
								className="rounded-md bg-surface px-3 py-2 text-left text-sm text-muted transition-colors hover:text-ink"
							>
								<span className="verbatim">“{p.text}”</span>
								<span className="mt-1 block font-mono text-[11px] text-faint">
									{p.protocol} v{p.version} · p. {p.page} ·{" "}
									{p.section}
								</span>
							</button>
						))}
					</div>
				</details>
			)}
		</div>
	);
}

/** A quiet page reference after the claim; the section and the quoted line are on hover. */
function Chip({
	p,
	home,
	jump,
}: {
	p: Passage;
	home?: string;
	jump: (p: Passage) => void;
}) {
	const other = p.protocol !== home;
	return (
		<button
			type="button"
			onClick={() => jump(p)}
			title={`${p.protocol} p. ${p.page} · ${p.section}\n\n“${p.text}”`}
			className="ml-1 inline-flex items-baseline gap-1 rounded px-1 align-baseline font-mono text-[12px] whitespace-nowrap text-accent tabular-nums transition-colors hover:bg-accent-soft"
		>
			{other && <span className="font-sans font-medium">{p.protocol}</span>}
			p.&nbsp;{p.page}
		</button>
	);
}
