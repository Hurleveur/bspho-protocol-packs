"use client";

import type { Anchor, Node } from "@bspho/protocol/spec";
import { ArrowLeft } from "lucide-react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";

/**
 * "Get me back to where I was": every deliberate jump on the sheet (search result, AI citation,
 * step or fork link, flowchart node, contents or journey-bar entry) pushes one real browser history
 * entry, so Back, Alt+Left and the mouse back button return to the line the reader had on screen.
 * Each entry remembers that line (topmost visible line or section + offset), kept fresh while
 * scrolling, so Forward and a reload land where the reader was too. Nothing else is recorded:
 * scrolling, the source pane, drawers, menus and ticks never touch history.
 */

/** Where the reader is: a line (data-anchor) or element id, inside a node, at an offset below the bars. */
export interface Place {
	/** Node whose element holds the place (`n-<id>`); its step is opened on restore. */
	node?: string;
	/** data-anchor of the line, looked up inside the node first. */
	line?: string;
	/** Element id when the place is not a line (a node, a section). */
	id?: string;
	/** Pixels between the element's top and the bottom of the sticky bars. */
	off: number;
	label: string;
	/** The off-sheet section shown on top of the sheet, if any. */
	pin?: string | null;
}

interface NavState {
	place?: Place;
	/** Name of the previous entry's place: what "Back" returns to. */
	from?: string;
	/** In-app entries before this one. */
	depth: number;
}

/** A jump target as the palette's "Recent places" shows and replays it. */
export interface Recent {
	nodeId: string;
	anchor?: Anchor;
	label: string;
	path?: string;
}

const recentKey = (protocolId: string) => `recent:${protocolId}`;

export function readRecents(protocolId: string): Recent[] {
	try {
		return JSON.parse(
			sessionStorage.getItem(recentKey(protocolId)) ?? "[]",
		) as Recent[];
	} catch {
		return [];
	}
}

const recentId = (r: Recent) =>
	r.anchor ? `${r.nodeId}@${r.anchor.page}:${r.anchor.text}` : r.nodeId;

function addRecent(protocolId: string, r: Recent) {
	try {
		const list = [
			r,
			...readRecents(protocolId).filter((x) => recentId(x) !== recentId(r)),
		];
		sessionStorage.setItem(
			recentKey(protocolId),
			JSON.stringify(list.slice(0, 10)),
		);
	} catch {}
}

const navState = (): NavState | undefined =>
	(window.history.state as { bspho?: NavState } | null)?.bspho;

/** Rewrite this entry's state in place: keeps Next's own fields, so the router is not re-run. */
function writeState(s: NavState) {
	window.history.replaceState({ ...window.history.state, bspho: s }, "");
}

const reduceMotion = () =>
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function flash(el: Element) {
	el.classList.remove("flash");
	void (el as HTMLElement).offsetWidth;
	el.classList.add("flash");
	setTimeout(() => el.classList.remove("flash"), reduceMotion() ? 1000 : 1400);
}

export function useJumpHistory({
	byId,
	stick,
	protocolId,
	sections,
	pinned,
	setPinned,
	openStep,
}: {
	byId: Map<string, Node>;
	/** The sticky bars: jumps land just below them. */
	stick: RefObject<HTMLDivElement | null>;
	protocolId: string;
	/** Section id → its name. */
	sections: Record<string, string>;
	pinned: string | null;
	setPinned: (id: string | null) => void;
	/** Open the treatment step holding a node (synchronously), so its content exists. */
	openStep: (nodeId: string) => void;
}) {
	const [back, setBack] = useState<string | null>(null);
	// This entry's state as we last wrote or read it: rewrites start from it, so an outside
	// replaceState that dropped our field (the router, the case code) is healed on the next write.
	const entry = useRef<NavState>({ depth: 0 });
	// Callers hold `push` across renders: read the changing inputs through a ref.
	const live = useRef({ byId, sections, pinned, setPinned, openStep });
	useLayoutEffect(() => {
		live.current = { byId, sections, pinned, setPinned, openStep };
	});

	// Below the sticky bars, and below the Back pill while it shows.
	const barBottom = useCallback(() => {
		const pill = document.querySelector("[data-back-pill] button");
		if (pill) return pill.getBoundingClientRect().bottom + 8;
		return stick.current?.getBoundingClientRect().bottom ?? 104;
	}, [stick]);

	const labelOf = useCallback((nodeId: string | undefined, sectionId?: string) => {
		const { byId, sections } = live.current;
		for (
			let c = nodeId ? byId.get(nodeId) : undefined;
			c;
			c = c.parent ? byId.get(c.parent) : undefined
		)
			if (c.kind === "step") return c.title;
		const n = nodeId ? byId.get(nodeId) : undefined;
		return (
			n?.title ??
			(sectionId ? sections[sectionId] : undefined) ??
			"previous place"
		);
	}, []);

	/** The topmost line or section the reader has on screen, just below the sticky bars. */
	const capture = useCallback((): Place | undefined => {
		const main = document.querySelector("main");
		if (!main) return undefined;
		const top = barBottom();
		const r = main.getBoundingClientRect();
		const col = main
			.querySelector<HTMLElement>("[data-reading]")
			?.getBoundingClientRect();
		const xs = col
			? [col.left + 24, col.left + col.width / 2]
			: [r.left + r.width / 2];
		// The first line or node a little below the bars; a bare section only if nothing finer is there.
		let fallback: Place | undefined;
		for (const dy of [12, 32, 64, 120, 200])
			for (const x of xs)
				for (const el of document.elementsFromPoint(x, top + dy)) {
					if (
						!main.contains(el) ||
						stick.current?.contains(el) ||
						el.closest("[data-back-pill]")
					)
						continue;
					const line = el.closest<HTMLElement>("[data-anchor]");
					const node = el.closest<HTMLElement>('[id^="n-"]');
					const sec = el.closest<HTMLElement>("section[id]");
					const at = line ?? node ?? sec;
					if (!at || !main.contains(at)) continue;
					const nodeId =
						node?.id.slice(2) ??
						(sec?.id === "pinned"
							? (live.current.pinned ?? undefined)
							: undefined);
					const place: Place = {
						node: nodeId,
						line: line?.dataset.anchor,
						id: line ? undefined : at.id,
						off: Math.round(at.getBoundingClientRect().top - top),
						// Diagnosis stages are cards, not nodes: name them by their heading.
						label: nodeId
							? labelOf(nodeId)
							: (el
									.closest('[id^="stage-"]')
									?.querySelector("h3, h4")
									?.textContent?.trim() ??
								labelOf(undefined, sec?.id)),
						pin: live.current.pinned,
					};
					if (line || node) return place;
					fallback ??= place;
					break;
				}
		return fallback;
	}, [barBottom, labelOf, stick]);

	// Keep the current entry's place fresh while reading, for Forward and reload.
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		const onScroll = () => {
			clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				const place = capture();
				if (!place) return;
				entry.current = { ...entry.current, ...navState(), place };
				writeState(entry.current);
			}, 250);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			window.removeEventListener("scroll", onScroll);
			clearTimeout(timer.current);
		};
	}, [capture]);

	/** Bring a remembered place back: open its step, wait for it to render, scroll, highlight. */
	const restore = useCallback(
		(p: Place) => {
			const { setPinned, openStep, pinned } = live.current;
			if (p.pin !== undefined && p.pin !== pinned)
				flushSync(() => setPinned(p.pin ?? null));
			if (p.node) openStep(p.node);
			const find = () => {
				const box = p.node ? document.getElementById(`n-${p.node}`) : null;
				if (p.line) {
					const sel = `[data-anchor="${CSS.escape(p.line)}"]`;
					const el =
						box?.querySelector<HTMLElement>(sel) ??
						document.querySelector<HTMLElement>(`main ${sel}`);
					if (el) return { el, line: true };
				}
				const el = (p.id ? document.getElementById(p.id) : null) ?? box;
				return el ? { el, line: false } : null;
			};
			let tries = 0;
			const land = () => {
				const hit = find();
				if (!hit && ++tries < 90) return void requestAnimationFrame(land);
				if (!hit) return;
				for (
					let d = hit.el.closest("details");
					d;
					d = d.parentElement?.closest("details") ?? null
				)
					d.open = true;
				// A line whose exact text moved: fall back to the node's own top.
				const off = hit.line || p.id ? p.off : 0;
				const align = () => {
					window.scrollTo({
						top:
							hit.el.getBoundingClientRect().top +
							window.scrollY -
							barBottom() -
							off,
					});
					return window.scrollY;
				};
				// Figures and lazy sections above may still be growing: re-align while the reader has not scrolled.
				let y = align();
				for (const ms of [200, 600, 1200])
					setTimeout(() => {
						if (Math.abs(window.scrollY - y) < 2) y = align();
					}, ms);
				if (hit.line) flash(hit.el);
				else if (off > -40)
					flash(hit.el.querySelector("h2, h3, h4, p") ?? hit.el);
			};
			land();
		},
		[barBottom],
	);

	/**
	 * Record a deliberate jump before it lands: this entry is rewritten with where the reader is,
	 * then one new entry is pushed for the target. No push when the target is the current place.
	 */
	const push = useCallback(
		(
			url: URL,
			to: { node?: string; line?: string; id?: string },
			recent?: Recent,
		) => {
			if (recent) addRecent(protocolId, recent);
			clearTimeout(timer.current);
			const here = capture();
			const cur: NavState = { ...entry.current, ...navState() };
			const same = to.line
				? here?.line === to.line
				: to.node
					? here?.node === to.node && !here.line
					: !!to.id && here?.id === to.id;
			if (same) return false;
			writeState({ ...cur, place: here ?? cur.place });
			const next: NavState = {
				depth: cur.depth + 1,
				from: here?.label ?? cur.place?.label ?? "previous place",
			};
			// Through Next's patched pushState, so its router keeps the URL and the entry.
			entry.current = next;
			window.history.pushState({ bspho: next }, "", url);
			// Render the pill now: the jump that follows lands below it.
			flushSync(() => setBack(next.from ?? null));
			return true;
		},
		[capture, protocolId],
	);

	// Back / Forward (and Alt+arrows, mouse buttons): restore the entry's place.
	useEffect(() => {
		window.history.scrollRestoration = "manual";
		const onPop = (e: PopStateEvent) => {
			clearTimeout(timer.current);
			const s = (e.state as { bspho?: NavState } | null)?.bspho;
			entry.current = s ?? { depth: 0 };
			setBack(s?.depth && s.from ? s.from : null);
			// After the pill has rendered or gone, so the landing line is measured against it.
			const p = s?.place;
			if (p) requestAnimationFrame(() => restore(p));
		};
		window.addEventListener("popstate", onPop);
		// A reload mid-history: this entry still knows where the reader was.
		const s = navState();
		if (s) {
			entry.current = s;
			requestAnimationFrame(() => {
				flushSync(() => setBack(s.depth && s.from ? s.from : null));
				if (s.place) restore(s.place);
			});
		}
		return () => window.removeEventListener("popstate", onPop);
	}, [restore]);

	return { push, back };
}

/** True when this entry has a remembered place (a reload or traversal), not a fresh link. */
export const hasPlace = () => !!navState()?.place;

/** "Back to <place>": the same as the browser's Back, shown after a jump. */
export function BackPill({ label }: { label: string | null }) {
	if (!label) return null;
	return (
		<div
			data-back-pill
			className="no-print pointer-events-none absolute top-full right-0 left-0 mt-2 flex justify-end px-4"
		>
			<button
				type="button"
				onClick={() => window.history.back()}
				title="Back (Alt+Left)"
				className="pointer-events-auto flex max-w-[22rem] items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-3 py-1 text-sm font-medium text-accent shadow-sm transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
			>
				<ArrowLeft size={14} aria-hidden className="shrink-0" />
				<span className="truncate">Back to {label}</span>
			</button>
		</div>
	);
}
