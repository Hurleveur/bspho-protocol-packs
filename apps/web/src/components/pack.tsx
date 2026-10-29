"use client";

import type { Anchor, Edge, Finding, Node, NodeKind } from "@bspho/protocol/spec";
import {
	ArrowRight,
	Pill,
	ClipboardCheck,
	CalendarDays,
	Building2,
	Check,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	FileText,
	Flag,
	GitFork,
	Search,
	Shuffle,
	Sparkles,
	StickyNote,
	X,
} from "lucide-react";
import Link from "next/link";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import type { LineNote } from "@/lib/case";
import type { PackData } from "@/lib/data";
import { type Arm, armsOf, splitNumber } from "@/lib/flow";
import { formatDate, formatVersion } from "@/lib/format";
import { armName, type RiskPath, riskPaths } from "@/lib/path";
import { classify, DIAG_GROUPS, TopicIcon } from "./classify";
import {
	AGENT_GO,
	AGENT_OPEN,
	AgentDrawer,
	type AgentGoDetail,
} from "./agent-drawer";
import { CaseBar, CaseDialogs, CaseHeaderButtons } from "./case/case-bar";
import { CaseStepPanel } from "./case/step-panel";
import { type CaseApi, useCase } from "./case/use-case";
import { CheckThese, FindingFlag } from "./check-these";
import { Doses, doseGroups } from "./doses";
import { FigureTable } from "./figure-table";
import { ProtocolMenu } from "./protocol-menu";
import { PROTO_LANGS, type ProtoLang, summaryOf, titleOf, useProtoLang } from "./proto-lang";
import { MonitoringView } from "./monitoring";
import { LocalRuleForm } from "./local-rule-form";
import { SearchPalette } from "./search-palette";
import { SpineBar } from "./spine-bar";
import { StatusBadge } from "./status-badge";
import { TreatmentMap } from "./treatment-map";
import { BackPill, hasPlace, readRecents, useJumpHistory } from "./jump-history";

export interface Target {
	nodeId: string;
	anchor?: Anchor;
	/** Open the source pane on this page when there is no anchor (raster figures). */
	page?: number;
}

type Spec = PackData["spec"];
type Rule = PackData["localRules"][number];

interface Ctx {
	sha: string;
	kids: Map<string, Node[]>;
	elsewhere: Set<string>;
	byId: Map<string, Node>;
	rules: Map<string, Rule[]>;
	hospital: { id: string; name: string };
	protocolId: string;
	active?: Anchor;
	printing: boolean;
	checks: Set<string>;
	tick: (key: string) => void;
	untick: (keys: string[]) => void;
	show: (a: Anchor | undefined, page: number, nodeId: string) => void;
	go: (t: Target) => void;
	/** lineKey → findings ("Check these") that include the line. */
	flags: Map<string, Finding[]>;
	/** The followed case (stateless: lives in a code), if any. */
	kase: CaseApi;
	edges: Edge[];
	nodes: Node[];
	/** lineKey → the clinician's note on that line (case only, this tab only). */
	notes: Record<string, LineNote>;
	setNote: (a: Anchor, note: string) => void;
}

/* ------------------------------------------------------------------ sheet model */

function useSheet(spec: Spec) {
	return useMemo(() => {
		const byId = new Map(spec.nodes.map((n) => [n.id, n]));
		const kids = new Map<string, Node[]>();
		for (const n of spec.nodes)
			if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
		const order = new Map(spec.nodes.map((n, i) => [n.id, i]));
		// A node is placed on the sheet once, at its highest sheet-kind ancestor.
		const underSheet = (n: Node, kinds: Set<NodeKind>) => {
			for (
				let p = n.parent ? byId.get(n.parent) : undefined;
				p;
				p = p.parent ? byId.get(p.parent) : undefined
			)
				if (kinds.has(p.kind)) return true;
			return false;
		};
		const top = (kinds: NodeKind[]) => {
			const k = new Set(kinds);
			return spec.nodes.filter((n) => k.has(n.kind) && !underSheet(n, k));
		};
		const diagnostics = top(["diagnostics"]);
		const risk = top(["risk_groups", "risk_group"]);
		const steps = spec.nodes.filter((n) => n.kind === "step");
		const phases = spec.nodes.filter((n) => n.kind === "phase");
		// Response assessment / re-stratification sits just before the first step it links to.
		const decisions = top(["response_assessment", "restratification"]);
		const before = new Map<string, Node[]>();
		const looseDecisions: Node[] = [];
		const stepIds = new Set(steps.map((s) => s.id));
		for (const d of decisions) {
			const linked = spec.edges
				.filter(
					(e) =>
						(e.from === d.id && stepIds.has(e.to)) ||
						(e.to === d.id && stepIds.has(e.from)),
				)
				.map((e) => (e.from === d.id ? e.to : e.from))
				.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
			if (linked.length)
				before.set(linked[0], [...(before.get(linked[0]) ?? []), d]);
			else looseDecisions.push(d);
		}
		const care = top(["supportive_care", "toxicity"]);
		const more = top(["eligibility", "drug_info", "schedule"]);
		// Nodes with their own place on the sheet; bodies skip them so nothing renders twice.
		const elsewhere = new Set(
			[
				...diagnostics,
				...risk,
				...steps,
				...phases,
				...decisions,
				...care,
				...more,
			].map((n) => n.id),
		);
		return {
			byId,
			kids,
			diagnostics,
			risk,
			steps,
			phases,
			before,
			looseDecisions,
			care,
			more,
			elsewhere,
		};
	}, [spec]);
}

/* ------------------------------------------------------------------ page */

/** When the source pane last turned a page by wheel: one flick turns one page. */
let lastFlip = 0;

export function Pack({ data }: { data: PackData }) {
	const { spec, entry, localRules } = data;
	const sheet = useSheet(spec);
	const { byId, kids } = sheet;
	const sha = spec.doc.sha256;
	const { lang } = useProtoLang();

	// `sha`/`label` set when the pane shows another protocol's page (cross-protocol findings).
	const [pane, setPane] = useState<{
		page: number;
		anchor?: Anchor;
		sha?: string;
		label?: string;
	} | null>(null);
	// Source pane width in px, dragged from its left edge; null = the default (36vw, at most 680px).
	const [paneW, setPaneW] = useState<number | null>(null);
	useEffect(() => {
		try {
			const w = Number(localStorage.getItem("bspho:paneW"));
			if (w > 0) setPaneW(w);
		} catch {}
	}, []);
	const dragPane = (e: React.PointerEvent) => {
		e.preventDefault();
		const move = (ev: PointerEvent) =>
			setPaneW(Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, 360), window.innerWidth * 0.75)));
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			setPaneW((w) => {
				try {
					if (w) localStorage.setItem("bspho:paneW", String(w));
				} catch {}
				return w;
			});
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const findings = useMemo(
		() => [...(spec.findings ?? []), ...data.crossFindings],
		[spec, data.crossFindings],
	);
	const flags = useMemo(() => {
		const m = new Map<string, Finding[]>();
		for (const f of findings)
			for (const a of f.lines)
				m.set(lineKey(a), [...(m.get(lineKey(a)) ?? []), f]);
		return m;
	}, [findings]);
	const [pinned, setPinned] = useState<string | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [spy, setSpy] = useState<string>("");
	const [printing, setPrinting] = useState(false);
	const [openSteps, setOpenSteps] = useState<Set<string>>(
		() => new Set(sheet.steps[0] ? [sheet.steps[0].id] : []),
	);
	const toggleStep = (id: string) =>
		setOpenSteps((o) =>
			o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id]),
		);

	// Ticks: this tab only, keyed by protocol version. Never sent anywhere; no patient data.
	const storeKey = `checks:${entry.id}:${sha}`;
	const [checks, setChecks] = useState<Set<string>>(new Set());
	useEffect(() => {
		try {
			setChecks(
				new Set(
					JSON.parse(sessionStorage.getItem(storeKey) ?? "[]") as string[],
				),
			);
		} catch {}
	}, [storeKey]);
	const saveChecks = (next: Set<string>) => {
		setChecks(next);
		try {
			sessionStorage.setItem(storeKey, JSON.stringify([...next]));
		} catch {}
	};
	const tick = (key: string) =>
		saveChecks(
			checks.has(key)
				? new Set([...checks].filter((k) => k !== key))
				: new Set([...checks, key]),
		);
	const untick = (keys: string[]) =>
		saveChecks(new Set([...checks].filter((k) => !keys.includes(k))));

	// Notes on checklist lines while a case is followed: next to the ticks, this tab only. Free text
	// may hold patient data, so it never goes into the case code or any request; it leaves only in
	// the EHR text the clinician copies.
	const notesKey = `notes:${entry.id}:${sha}`;
	const [notes, setNotes] = useState<Record<string, LineNote>>({});
	useEffect(() => {
		try {
			setNotes(
				JSON.parse(sessionStorage.getItem(notesKey) ?? "{}") as Record<
					string,
					LineNote
				>,
			);
		} catch {}
	}, [notesKey]);
	const saveNotes = (next: Record<string, LineNote>) => {
		setNotes(next);
		try {
			if (Object.keys(next).length)
				sessionStorage.setItem(notesKey, JSON.stringify(next));
			else sessionStorage.removeItem(notesKey);
		} catch {}
	};
	const setNote = (a: Anchor, note: string) => {
		const { [lineKey(a)]: _, ...rest } = notes;
		const text = note.trim();
		saveNotes(
			text ? { ...rest, [lineKey(a)]: { line: a.text, page: a.page, note: text } } : rest,
		);
	};

	const rules = useMemo(() => {
		const m = new Map<string, Rule[]>();
		for (const r of localRules) m.set(r.nodeId, [...(m.get(r.nodeId) ?? []), r]);
		return m;
	}, [localRules]);

	const kase = useCase({
		spec,
		protocolId: entry.id,
		versions: entry.versions,
		checks,
		setChecks: saveChecks,
	});
	const caseCur = kase.state?.cur;
	// Ending a case drops its notes from this tab too.
	const hadCase = useRef(false);
	const hasCase = !!kase.state;
	useEffect(() => {
		if (hadCase.current && !hasCase) {
			setNotes({});
			try {
				sessionStorage.removeItem(notesKey);
			} catch {}
		}
		hadCase.current = hasCase;
	}, [hasCase, notesKey]);

	// Risk-group path (?g=): one group's steps on the bar and the map, other arms folded.
	const arms = useMemo(() => armsOf(sheet.steps, byId), [sheet.steps, byId]);
	const paths = useMemo(
		() => riskPaths(sheet.steps, byId, spec.edges),
		[sheet.steps, byId, spec.edges],
	);
	// undefined = not chosen (follow the case), null = "All groups".
	const [pick, setPick] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		const g = new URL(window.location.href).searchParams.get("g");
		if (g && paths.some((p) => p.id === g)) setPick(g);
	}, [paths]);
	const caseArm = caseCur
		? arms.find((a) => a.steps.some((s) => s.id === caseCur))?.key
		: kase.state?.arm;
	const path: RiskPath | null =
		(pick === undefined
			? paths.find((p) => caseArm && p.own.has(caseArm))
			: paths.find((p) => p.id === pick)) ?? null;
	const setPath = (id: string | null) => {
		setPick(id);
		const url = new URL(window.location.href);
		if (id) url.searchParams.set("g", id);
		else url.searchParams.delete("g");
		window.history.replaceState({ bspho: window.history.state?.bspho }, "", url);
	};
	// Folded: steps of other arms (phases) and of other groups in a shared arm. Plain step groupings
	// (indications, general therapy elements) can apply to any group and stay as they are.
	const armOfStep = useMemo(() => {
		const m = new Map<string, (typeof arms)[number]>();
		for (const a of arms) for (const s of a.steps) m.set(s.id, a);
		return m;
	}, [arms]);
	const onPath = (id: string) => {
		if (!path || path.steps.has(id)) return true;
		const a = armOfStep.get(id);
		return !a || (!a.phase && !path.arms.has(a.key));
	};

	// The sticky bars (journey + case) set how far below the top a jump lands.
	const stick = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = stick.current;
		if (!el) return;
		const set = () => setStick(el);
		set();
		const ro = new ResizeObserver(set);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const stepHasRules = (id: string) =>
		[
			id,
			...(kids.get(id) ?? [])
				.filter((c) => c.kind === "start_requirements")
				.map((c) => c.id),
		].some((x) => rules.has(x));
	// The case's current step opens on its own.
	useEffect(() => {
		if (!caseCur) return;
		setOpenSteps((o) => (o.has(caseCur) ? o : new Set([...o, caseCur])));
		const t = setTimeout(() => {
			const el = document.getElementById(`n-${caseCur}`);
			if (el) openDetails(el);
			el?.scrollIntoView({ block: "start" });
		}, 60);
		return () => clearTimeout(t);
	}, [caseCur]);

	// Opening the pane narrows the sheet; keep the line the reader clicked where their eyes are.
	const show = useCallback((anchor: Anchor | undefined, page: number) => {
		const el = anchor
			? document.querySelector<HTMLElement>(
					`[data-anchor="${anchor.page}:${cssKey(anchor.text)}"]`,
				)
			: null;
		const top = el?.getBoundingClientRect().top;
		setPane({ page: anchor?.page ?? page, anchor });
		if (el && top !== undefined)
			requestAnimationFrame(() =>
				window.scrollBy({ top: el.getBoundingClientRect().top - top }),
			);
	}, []);

	/** Open the treatment step that holds a node, synchronously, so its content exists. */
	const openStep = useCallback(
		(nodeId: string) => {
			for (
				let c: Node | undefined = byId.get(nodeId);
				c;
				c = c.parent ? byId.get(c.parent) : undefined
			)
				if (c.kind === "step") {
					const id = c.id;
					flushSync(() =>
						setOpenSteps((o) => (o.has(id) ? o : new Set([...o, id]))),
					);
					break;
				}
		},
		[byId],
	);
	// Back/Forward between deliberate jumps (see jump-history.tsx).
	const nav = useJumpHistory({
		byId,
		stick,
		protocolId: entry.id,
		sections: SECTION_NAMES,
		pinned,
		setPinned,
		openStep,
	});

	/** Land on a target without touching history (deep links). */
	const land = useCallback(
		(t: Target) => {
			const n = byId.get(t.nodeId);
			if (!n) return;
			if (t.anchor || t.page)
				setPane({
					page: t.anchor?.page ?? t.page ?? n.pages.from,
					anchor: t.anchor,
				});
			// Open the treatment step that holds the node, so its content exists before scrolling.
			for (
				let c: Node | undefined = n;
				c;
				c = c.parent ? byId.get(c.parent) : undefined
			)
				if (c.kind === "step") {
					const id = c.id;
					flushSync(() =>
						setOpenSteps((o) => (o.has(id) ? o : new Set([...o, id]))),
					);
					break;
				}
			// Scroll to the node, or the nearest ancestor that is on the sheet; off-sheet sections open at the top.
			let el: HTMLElement | null = null;
			for (
				let c: Node | undefined = n;
				c && !el;
				c = c.parent ? byId.get(c.parent) : undefined
			)
				el = document.getElementById(`n-${c.id}`);
			if (!el) {
				setPinned(n.id);
				requestAnimationFrame(() =>
					document
						.getElementById("pinned")
						?.scrollIntoView({ block: "start" }),
				);
				return;
			}
			openDetails(el);
			const target = t.anchor
				? (document.querySelector(
						`[data-anchor="${t.anchor.page}:${cssKey(t.anchor.text)}"]`,
					) as HTMLElement | null)
				: null;
			(target ?? el).scrollIntoView({ block: target ? "center" : "start" });
		},
		[byId],
	);
	/** A deliberate jump: one browser history entry, so Back returns to where the reader was. */
	const navPush = nav.push;
	// The Back pill hangs below the bars: jumps land below it while it shows.
	const navBack = nav.back;
	useLayoutEffect(() => {
		if (stick.current) setStick(stick.current);
	}, [navBack]);
	const go = useCallback(
		(t: Target) => {
			const n = byId.get(t.nodeId);
			if (!n) return;
			const url = new URL(window.location.href);
			url.searchParams.set("n", n.id);
			const pushed = navPush(
				url,
				{ node: n.id, line: t.anchor ? lineKey(t.anchor) : undefined },
				{
					nodeId: n.id,
					anchor: t.anchor,
					label: t.anchor ? t.anchor.text.replace(/\s+/g, " ").slice(0, 120) : n.title,
					path: [...n.headingPath.slice(0, -1), ...(t.anchor ? [n.title] : [])].join(" › "),
				},
			);
			if (!pushed)
				window.history.replaceState(
					{ bspho: window.history.state?.bspho },
					"",
					url,
				);
			land(t);
		},
		[byId, land, navPush],
	);
	/** A deliberate jump to a sheet section or other element id (journey bar, contents). */
	const goTo = useCallback(
		(id: string) => {
			const node = id.startsWith("n-") ? byId.get(id.slice(2)) : undefined;
			if (node) return go({ nodeId: node.id });
			const el = document.getElementById(id);
			if (!el) return;
			const url = new URL(window.location.href);
			url.searchParams.delete("n");
			navPush(url, { id });
			openDetails(el);
			el.scrollIntoView({ block: "start" });
		},
		[byId, go, navPush],
	);

	// Deep links: /p/x?n=node-id
	useEffect(() => {
		// A reload or traversal restores the remembered place instead (jump-history.tsx).
		if (hasPlace()) return;
		const n = new URL(window.location.href).searchParams.get("n");
		if (n && byId.has(n)) requestAnimationFrame(() => land({ nodeId: n }));
	}, [byId, land]);

	// The assistant drawer (Ctrl/Cmd+J, handled in AgentDrawer) asks to jump to a cited line.
	useEffect(() => {
		const onGo = (e: Event) => {
			const { nodeId, page, text } = (e as CustomEvent<AgentGoDetail>).detail;
			const n = byId.get(nodeId);
			const anchor = [
				...(n?.blocks ?? []),
				...(n?.figures ?? []).flatMap((f) => (f.caption ? [f.caption] : [])),
			].find((a) => a.page === page && a.text === text);
			go({ nodeId, anchor, page });
		};
		window.addEventListener(AGENT_GO, onGo);
		return () => window.removeEventListener(AGENT_GO, onGo);
	}, [byId, go]);

	// Ctrl/Cmd+F, Ctrl/Cmd+K and "/" open the protocol search (Ctrl+F twice falls back to the browser's).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const typing = (e.target as HTMLElement)?.closest(
				"input, textarea, select",
			);
			if (
				(e.metaKey || e.ctrlKey) &&
				(e.key === "k" || (e.key === "f" && !searchOpen))
			) {
				e.preventDefault();
				setSearchOpen(true);
			} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
				// The assistant takes over: search steps aside (the drawer handles the key itself).
				setSearchOpen(false);
			} else if (e.key === "/" && !typing) {
				e.preventDefault();
				setSearchOpen(true);
			} else if (e.key === "Escape" && !searchOpen) setPane(null);
		};
		const onAgent = () => setSearchOpen(false);
		window.addEventListener("keydown", onKey);
		window.addEventListener(AGENT_OPEN, onAgent);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener(AGENT_OPEN, onAgent);
		};
	}, [searchOpen]);

	// Contents links (#n-step) open the step they point at.
	useEffect(() => {
		const onHash = () => {
			if (hasPlace()) return;
			const id = decodeURIComponent(window.location.hash.replace(/^#n-/, ""));
			if (byId.get(id)?.kind === "step") {
				flushSync(() => setOpenSteps((o) => new Set([...o, id])));
				const el = document.getElementById(`n-${id}`);
				if (el) openDetails(el);
				el?.scrollIntoView({ block: "start" });
			}
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, [byId]);
	// In-sheet hash links (contents, "more items in ...") are jumps: one history entry each, via goTo.
	useEffect(() => {
		const onClick = (e: MouseEvent) => {
			if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
				return;
			const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
			const id = a ? decodeURIComponent(a.getAttribute("href")?.slice(1) ?? "") : "";
			if (!id || !document.getElementById(id)) return;
			e.preventDefault();
			goTo(id);
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [goTo]);

	// Scroll-spy for the table of contents.
	useEffect(() => {
		let raf = 0;
		const onScroll = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				let cur = "";
				// Below the bars, and below the Back pill while it shows (jumps land under it).
				const line =
					(document.querySelector("[data-back-pill] button")?.getBoundingClientRect()
						.bottom ??
						stick.current?.getBoundingClientRect().bottom ??
						104) + 40;
				for (const el of document.querySelectorAll<HTMLElement>("[data-spy]"))
					if (el.getBoundingClientRect().top < line && el.offsetParent)
						cur = el.dataset.spy ?? "";
				setSpy(cur);
			});
		};
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	useEffect(() => {
		document
			.querySelector(`[data-toc="${spy}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [spy]);

	// Print the whole sheet: open every collapsed section first.
	useEffect(() => {
		// Paper gets the sheet as it is on screen: what is open prints, what is folded stays folded.
		// Expanding everything turned a long protocol into a print job of hundreds of pages.
		const before = () => flushSync(() => setPrinting(true));
		const after = () => setPrinting(false);
		window.addEventListener("beforeprint", before);
		window.addEventListener("afterprint", after);
		return () => {
			window.removeEventListener("beforeprint", before);
			window.removeEventListener("afterprint", after);
		};
	}, []);

	const ctx: Ctx = {
		sha,
		kids,
		elsewhere: sheet.elsewhere,
		byId,
		rules,
		hospital: data.hospital,
		protocolId: entry.id,
		active: pane?.anchor,
		printing,
		checks,
		tick,
		untick,
		show,
		go,
		flags,
		kase,
		edges: spec.edges,
		nodes: spec.nodes,
		notes,
		setNote,
	};
	// "Check these" is folded at the end of the sheet; links to it open it.
	const openCheck = () => {
		const d = document.getElementById("check");
		if (d instanceof HTMLDetailsElement) d.open = true;
	};
	const placed = new Set<string>();
	const pinnedNode = pinned ? byId.get(pinned) : undefined;

	const doses = doseGroups(spec.nodes);
	const toc: { id: string; label: string; steps?: Node[]; count?: number }[] = [
		sheet.diagnostics.length
			? { id: "diagnostics", label: "Diagnosis work-up" }
			: null,
		sheet.risk.length ? { id: "risk", label: "Risk groups" } : null,
		sheet.steps.length
			? { id: "treatment", label: "Treatment", steps: sheet.steps }
			: null,
		sheet.looseDecisions.length
			? { id: "response", label: "Response & re-stratification" }
			: null,
		sheet.care.length || spec.monitoring
			? { id: "care", label: "Supportive care & toxicity" }
			: null,
		doses.length ? { id: "doses", label: "Doses" } : null,
		sheet.more.length
			? { id: "more", label: "Eligibility, drugs & schedules" }
			: null,
		findings.length
			? { id: "check", label: "Check these", count: findings.length }
			: null,
	].filter((x) => x !== null);

	return (
		<div
			className="pack-shell min-h-screen"
			style={{ "--pane": paneW ? `${paneW}px` : "min(36vw,680px)" } as React.CSSProperties}
		>
			<header className="no-print sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-line bg-surface px-5">
				<ProtocolMenu current={entry.id} protocols={data.protocols} />
				<div className="h-6 w-px bg-line" />
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h1 className="truncate text-xl font-semibold">
							{entry.short}
						</h1>
						<StatusBadge status={data.status} />
					</div>
					<p className="truncate text-[13px] text-muted">
						{[
							spec.doc.date
								? formatVersion(spec.doc.version).replace(/\s*\([^)]*\)$/, "")
								: formatVersion(spec.doc.version),
							formatDate(spec.doc.date),
							data.hospital.name,
						]
							.filter(Boolean)
							.join(" · ")}
						{lang !== "orig" && (
							<span title="Protocol text shown as short summaries; click a line for the original page. Change in the ⋯ menu.">
								{" · "}
								{PROTO_LANGS.find((l) => l.id === lang)?.short}
							</span>
						)}
					</p>
				</div>
				<button
					type="button"
					onClick={() => setSearchOpen(true)}
					className="ml-auto flex w-72 min-w-40 shrink items-center gap-2 rounded-md border border-line bg-paper px-3 py-2 text-left text-sm whitespace-nowrap text-muted transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
				>
					<Search size={16} className="shrink-0" />
					<span className="truncate">Search</span>
					<kbd className="ml-auto rounded border border-line bg-surface px-1.5 font-mono text-xs">
						Ctrl K
					</kbd>
				</button>
				<button
					type="button"
					onClick={() => window.dispatchEvent(new Event(AGENT_OPEN))}
					title="Ask the AI assistant about this protocol (Ctrl J)"
					className="flex shrink-0 items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm font-medium whitespace-nowrap text-accent transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
				>
					<Sparkles size={16} aria-hidden /> Ask AI
				</button>
				<CaseHeaderButtons kase={kase} onPrint={() => window.print()} />
			</header>

			<div className="flex">
				<nav
					aria-label="On this sheet"
					className="no-print sticky top-16 h-[calc(100vh-4rem)] w-72 shrink-0 overflow-y-auto overscroll-contain border-r border-line px-3 py-5 text-[15px]"
				>
					{toc.map((t) => (
						<div key={t.id} className="mb-3">
							<a
								href={`#${t.id}`}
								data-toc={t.id}
								onClick={t.count ? openCheck : undefined}
								className={`flex items-baseline gap-2 rounded px-2 py-1 transition-colors ${t.count ? "font-medium" : "font-semibold"} ${spy === t.id ? "bg-accent-soft text-accent" : t.count ? "text-muted hover:bg-surface hover:text-ink" : "text-ink hover:bg-surface"}`}
							>
								{t.label}
								{t.count ? (
									<span className="text-sm tabular-nums">
										{t.count}
									</span>
								) : null}
							</a>
							{t.steps && (
								<StepToc
									steps={t.steps}
									byId={byId}
									spy={caseCur ?? spy}
									status={kase.status}
									dim={(id) => !onPath(id)}
									arms={arms}
								/>
							)}
						</div>
					))}
					{data.subprotocols.length > 0 && (
						<div className="mt-6 border-t border-line pt-3">
							<p className="px-2 text-[13px] font-semibold text-muted">
								Sub-protocols
							</p>
							{data.subprotocols.map((p) => (
								<Link
									key={p.id}
									href={`/p/${p.id}`}
									className="block rounded px-2 py-0.5 text-sm text-accent hover:bg-surface"
								>
									{p.short}
								</Link>
							))}
						</div>
					)}
				</nav>

				<main
					className={`min-w-0 flex-1 pt-8 pb-24 ${pane ? "mr-(--pane) px-6" : "px-10"}`}
				>
					<div
						ref={stick}
						className={`no-print sticky top-16 z-20 -mt-8 mb-8 ${pane ? "-mx-6" : "-mx-10"}`}
					>
						<SpineBar
							sections={toc
								.filter((t) => t.id !== "check")
								.map((t) => ({ id: t.id, label: SPINE[t.id] ?? t.label }))}
							paths={paths}
							path={path}
							setPath={setPath}
							arms={arms}
							edges={spec.edges}
							spy={spy}
							caseArm={caseArm}
							status={kase.state ? kase.status : undefined}
							go={(id) => go({ nodeId: id })}
							goSection={goTo}
							show={(a) => show(a, a.page)}
						/>
						<CaseBar
							kase={kase}
							protocol={{
								short: entry.short,
								version: formatVersion(spec.doc.version),
							}}
							onJump={(id) => go({ nodeId: id })}
						/>
						<BackPill label={nav.back} />
					</div>
					<div data-reading className="mx-auto max-w-[50rem]">
						<div className="print-only mb-6 border-b border-ink pb-3">
							<p className="text-lg font-semibold">
								{entry.short} · {formatVersion(spec.doc.version)}
								{spec.doc.date ? ` · ${spec.doc.date}` : ""}
							</p>
							<p className="text-sm">
								{entry.title}. {data.hospital.name}.
							</p>
							<p className="mt-1 text-xs">
								Verbatim protocol text; each line carries its page in
								the protocol. Check the protocol before acting. Printed{" "}
								{new Date().toISOString().slice(0, 10)}. No patient
								data.
							</p>
						</div>

						{pinnedNode && (
							<section
								id="pinned"
								className="no-print mb-10 scroll-mt-(--stick) rounded-lg border border-line bg-surface p-5"
							>
								<div className="mb-2 flex items-start gap-3">
									<div className="min-w-0 flex-1">
										<p className="text-[13px] text-muted">
											From the full protocol:{" "}
											{pinnedNode.headingPath.join(" › ")}
										</p>
										<h2 className="text-2xl font-semibold text-balance">
											{pinnedNode.title}
										</h2>
									</div>
									<button
										type="button"
										aria-label="Close"
										onClick={() => setPinned(null)}
										className="rounded p-1 text-muted hover:bg-paper hover:text-ink"
									>
										<X size={18} />
									</button>
								</div>
								<NodeBody
									node={pinnedNode}
									ctx={ctx}
									depth={0}
									placed={new Set()}
								/>
							</section>
						)}

						{sheet.diagnostics.length > 0 && (
							<SheetSection id="diagnostics" title="Diagnosis work-up">
								<Diagnostics
									nodes={sheet.diagnostics}
									ctx={ctx}
									placed={placed}
									family={entry.family}
								/>
							</SheetSection>
						)}

						{sheet.risk.length > 0 && (
							<SheetSection id="risk" title="Risk groups">
								<PathChips paths={paths} path={path} setPath={setPath} />
								{sheet.risk.map((n) => (
									<Block
										key={n.id}
										node={n}
										ctx={ctx}
										placed={placed}
										heading={sheet.risk.length > 1}
									/>
								))}
							</SheetSection>
						)}

						{sheet.steps.length > 0 && (
							<SheetSection id="treatment" title="Treatment">
								{sheet.risk.length === 0 && (
									<PathChips paths={paths} path={path} setPath={setPath} />
								)}
								<TreatmentMap
									steps={sheet.steps}
									byId={byId}
									edges={spec.edges}
									paths={paths}
									spy={
										sheet.steps.some((s) => s.id === spy)
											? spy
											: undefined
									}
									status={kase.status}
									kase={kase.state}
									printing={printing}
									path={path}
									open={(id) => go({ nodeId: id })}
									show={(a) => show(a, a.page)}
								/>
								<PhaseOverviews
									phases={sheet.phases.filter(
										(p) =>
											!sheet.steps.some((s) => s.parent === p.id),
									)}
									ctx={ctx}
									placed={placed}
								/>
								<div className="no-print mb-3 flex gap-4 text-sm">
									<button
										type="button"
										className="text-accent hover:underline"
										onClick={() =>
											setOpenSteps(
												new Set(sheet.steps.map((s) => s.id)),
											)
										}
									>
										Expand all steps
									</button>
									<button
										type="button"
										className="text-accent hover:underline"
										onClick={() => setOpenSteps(new Set())}
									>
										Collapse all
									</button>
								</div>
								{runs(sheet.steps, onPath).map((run) => {
									const body = run.steps.map(({ s, i }) => {
										const phase = s.parent
											? byId.get(s.parent)
											: undefined;
										const newPhase =
											phase?.kind === "phase" &&
											(i === 0 ||
												sheet.steps[i - 1].parent !== phase.id);
										return (
											<div key={s.id}>
												{newPhase && (
													<PhaseHeading
														phase={phase}
														ctx={ctx}
														placed={placed}
													/>
												)}
												{(sheet.before.get(s.id) ?? []).map((d) => (
													<Decision
														key={d.id}
														node={d}
														ctx={ctx}
														placed={placed}
													/>
												))}
												<Step
													step={s}
													spec={spec}
													ctx={ctx}
													placed={placed}
													index={i}
													open={openSteps.has(s.id)}
													onToggle={() => toggleStep(s.id)}
												/>
											</div>
										);
									});
									if (run.on || !path)
										return <div key={run.key}>{body}</div>;
									const names = [
										...new Set(
											run.steps.map(
												({ s }) => {
													const a = arms.find((x) => x.steps.includes(s));
													return a ? armName(a, paths) : "";
												},
											),
										),
									].filter(Boolean);
									// Other groups' steps stay on the sheet, folded and faded.
									return (
										<details
											key={run.key}
											className="group/off mb-4 rounded-lg border border-dashed border-line"
										>
											<summary className="flex cursor-pointer list-none items-baseline gap-2 px-4 py-2.5 text-sm text-muted hover:text-ink">
												<ChevronRight
													size={14}
													aria-hidden
													className="shrink-0 self-center transition-transform group-open/off:rotate-90"
												/>
												<span className="shrink-0">
													Not on the {path.label} path:{" "}
													{run.steps.length}{" "}
													{run.steps.length === 1 ? "step" : "steps"}
												</span>
												<span className="truncate text-faint">
													{names.join(", ")}
												</span>
											</summary>
											<div className="px-3 pb-2">
												{body}
											</div>
										</details>
									);
								})}
							</SheetSection>
						)}

						{sheet.looseDecisions.length > 0 && (
							<SheetSection
								id="response"
								title="Response & re-stratification"
							>
								{sheet.looseDecisions.map((n) => (
									<Block
										key={n.id}
										node={n}
										ctx={ctx}
										placed={placed}
										heading
									/>
								))}
							</SheetSection>
						)}

						{(sheet.care.length > 0 || spec.monitoring) && (
							<SheetSection id="care" title="Supportive care & toxicity">
								<MonitoringView
									monitoring={spec.monitoring}
									nodes={spec.nodes}
									sha={ctx.sha}
									active={ctx.active}
									show={ctx.show}
								/>
								{sheet.care.length > 0 && (
									<h3 className="mb-1 text-lg font-semibold text-muted">
										Full text as written
									</h3>
								)}
								<Collapsed
									nodes={sheet.care}
									ctx={ctx}
									placed={placed}
								/>
							</SheetSection>
						)}

						{doses.length > 0 && (
							<SheetSection id="doses" title="Doses">
								<Doses
									groups={doses}
									sha={ctx.sha}
									active={ctx.active}
									show={ctx.show}
								/>
							</SheetSection>
						)}

						{sheet.more.length > 0 && (
							<SheetSection
								id="more"
								title="Eligibility, drugs & schedules"
							>
								<Collapsed
									nodes={sheet.more}
									ctx={ctx}
									placed={placed}
								/>
							</SheetSection>
						)}

						<OrphanRules
							rules={localRules}
							byId={byId}
							hospital={data.hospital.name}
						/>

						<CheckThese
							findings={findings}
							title={(id) => (id ? byId.get(id)?.title : undefined)}
							show={(a, nodeId) =>
								nodeId ? go({ nodeId, anchor: a }) : show(a, a.page)
							}
							showOther={(otherId, a) => {
								const other = data.crossFindings.find(
									(f) => f.otherProtocol?.id === otherId,
								)?.otherProtocol;
								setPane({
									page: a.page,
									anchor: a,
									sha: data.otherShas[otherId],
									label: other
										? `${other.short} ${formatVersion(other.version)}`
										: otherId,
								});
							}}
							protocol={{
								id: entry.id,
								short: entry.short,
								version: spec.doc.version,
							}}
							hospital={data.hospital}
						/>

						<Outline spec={spec} go={go} />
					</div>
				</main>
			</div>

			{pane && (
				<aside
					aria-label="Source page"
					className="no-print fixed top-16 right-0 bottom-0 z-20 flex w-(--pane) flex-col border-l border-line bg-line/60 shadow-[-8px_0_24px_-12px_rgb(0_0_0/0.15)]"
				>
					{/* Drag the left edge to widen the page (double-click resets). */}
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize the source page"
						title="Drag to resize"
						onPointerDown={dragPane}
						onDoubleClick={() => {
							setPaneW(null);
							try {
								localStorage.removeItem("bspho:paneW");
							} catch {}
						}}
						className="absolute top-0 bottom-0 -left-1.5 z-10 w-3 cursor-col-resize after:absolute after:inset-y-0 after:left-1.5 after:w-px after:bg-transparent hover:after:bg-accent"
					/>
					<div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm">
						<FileText size={16} className="text-muted" />
						<span className="font-medium">
							{pane.label ??
								`${entry.short} ${formatVersion(spec.doc.version)}`}
							, page {pane.page}
						</span>
						<div className="ml-auto flex items-center gap-1">
							<button
								type="button"
								aria-label="Previous page"
								disabled={pane.page <= 1}
								onClick={() =>
									setPane((p) => p && { ...p, page: p.page - 1 })
								}
								className="rounded p-1 hover:bg-paper disabled:opacity-30"
							>
								<ChevronRight size={18} className="rotate-180" />
							</button>
							<span className="w-16 text-center font-mono text-[13px] text-muted tabular-nums">
								{pane.page}
								{pane.sha ? "" : ` / ${spec.doc.pageCount}`}
							</span>
							<button
								type="button"
								aria-label="Next page"
								disabled={!pane.sha && pane.page >= spec.doc.pageCount}
								onClick={() =>
									setPane((p) => p && { ...p, page: p.page + 1 })
								}
								className="rounded p-1 hover:bg-paper disabled:opacity-30"
							>
								<ChevronRight size={18} />
							</button>
							<button
								type="button"
								aria-label="Close source page"
								onClick={() => setPane(null)}
								className="ml-1 rounded p-1 hover:bg-paper"
							>
								<X size={18} />
							</button>
						</div>
					</div>
					<div
						className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
						// Like a PDF viewer: scrolling past the end of a page turns to the next one, past the top to the previous.
						onWheel={(e) => {
							const el = e.currentTarget;
							const now = Date.now();
							if (now - lastFlip < 450 || Math.abs(e.deltaY) < 8) return;
							const last = pane.sha ? Number.POSITIVE_INFINITY : spec.doc.pageCount;
							if (e.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2 && pane.page < last) {
								lastFlip = now;
								setPane((p) => p && { ...p, page: p.page + 1 });
								requestAnimationFrame(() => el.scrollTo({ top: 0 }));
							} else if (e.deltaY < 0 && el.scrollTop <= 1 && pane.page > 1) {
								lastFlip = now;
								setPane((p) => p && { ...p, page: p.page - 1 });
								requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
							}
						}}
					>
						<PageImage
							sha={pane.sha ?? sha}
							page={pane.page}
							anchor={
								pane.anchor?.page === pane.page
									? pane.anchor
									: undefined
							}
						/>
					</div>
				</aside>
			)}

			<CaseDialogs
				kase={kase}
				nodes={spec.nodes}
				edges={spec.edges}
				steps={sheet.steps}
				protocol={{
					short: entry.short,
					version: formatVersion(spec.doc.version),
					sha,
				}}
				hospital={data.hospital.name}
				hasRules={stepHasRules}
				notes={Object.values(notes).sort((a, b) => a.page - b.page)}
			/>

			<AgentDrawer
				protocol={{
					id: entry.id,
					short: entry.short,
					version: spec.doc.version,
					sha,
				}}
				spec={spec}
			/>

			{searchOpen && (
				<SearchPalette
					spec={spec}
					recents={readRecents(entry.id)}
					onClose={() => setSearchOpen(false)}
					onPick={(t) => {
						setSearchOpen(false);
						go(t);
					}}
				/>
			)}
		</div>
	);
}

const cssKey = (s: string) => s.slice(0, 40).replace(/["\\\n]/g, " ");

/** Section headings, for "Back to <section>". */
const SECTION_NAMES: Record<string, string> = {
	diagnostics: "Diagnosis work-up",
	risk: "Risk groups",
	treatment: "Treatment",
	response: "Response & re-stratification",
	care: "Supportive care & toxicity",
	doses: "Doses",
	more: "Eligibility, drugs & schedules",
	check: "Check these",
	pinned: "the opened section",
};

/** Section names on the journey bar, shorter than the headings. */
const SPINE: Record<string, string> = {
	diagnostics: "Diagnosis",
	risk: "Risk groups",
	response: "Response",
	care: "Supportive care",
	doses: "Doses",
	more: "Drugs & schedules",
};

/** Where jumps land: below the sticky bars, and below the Back pill while it shows. */
function setStick(el: HTMLElement) {
	const pill = el.querySelector("[data-back-pill]") ? 40 : 0;
	document.documentElement.style.setProperty(
		"--stick",
		`${Math.round(el.getBoundingClientRect().height + 64 + 12 + pill)}px`,
	);
}

/** Open the folded sections around an element so a jump can land on it. */
function openDetails(el: HTMLElement) {
	for (
		let d = el.closest("details");
		d;
		d = d.parentElement?.closest("details") ?? null
	)
		d.open = true;
}

/* ------------------------------------------------------------------ sections */

function SheetSection({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section id={id} data-spy={id} className="mb-14 scroll-mt-(--stick)">
			<h2 className="mb-5 border-b-2 border-ink pb-2 text-[26px] font-semibold tracking-tight">
				{title}
			</h2>
			{children}
		</section>
	);
}

/** One sheet node, expanded: optional title, verbatim lines, tables, sub-sections, local rules. */
function Block({
	node,
	ctx,
	placed,
	heading,
}: {
	node: Node;
	ctx: Ctx;
	placed: Set<string>;
	heading?: boolean;
}) {
	placed.add(node.id);
	return (
		<div id={`n-${node.id}`} className="mb-8 scroll-mt-(--stick)">
			{heading && (
				<h3 className="mb-2 text-xl font-semibold text-balance">
					<Title node={node} />
				</h3>
			)}
			<Rules rules={ctx.rules.get(node.id)} hospital={ctx.hospital.name} />
			<NodeBody node={node} ctx={ctx} depth={0} placed={placed} />
		</div>
	);
}

/** Sub-sections whose heading says they list things to do or check become checklists. */
const CHECKLIST_TITLE =
	/investigation|examination|work-?up|assessment|required|requirement|before (the )?start|prior to|checklist|diagnos/i;

const textOf = (n: Node, kids: Map<string, Node[]>): number =>
	n.blocks.reduce((s, b) => s + b.text.length, 0) +
	(kids.get(n.id) ?? []).reduce((s, c) => s + textOf(c, kids), 0);
const hasFigures = (n: Node, kids: Map<string, Node[]>): boolean =>
	!!n.figures?.length || (kids.get(n.id) ?? []).some((c) => hasFigures(c, kids));

function NodeBody({
	node,
	ctx,
	depth,
	placed,
	checklist,
}: {
	node: Node;
	ctx: Ctx;
	depth: number;
	placed: Set<string>;
	checklist?: boolean;
}) {
	const children = (ctx.kids.get(node.id) ?? []).filter(
		(c) => !ctx.elsewhere.has(c.id) && c.kind !== "start_requirements",
	);
	const asList = checklist || CHECKLIST_TITLE.test(node.title);
	return (
		<>
			{asList && node.blocks.length > 1 ? (
				<Checklist
					items={node.blocks.map((a) => ({ a, nodeId: node.id }))}
					ctx={ctx}
				/>
			) : (
				<Preview
					long={
						depth === 0 &&
						node.blocks.reduce((s, b) => s + b.text.length, 0) > 700
					}
					ctx={ctx}
				>
					<Lines node={node} ctx={ctx} />
				</Preview>
			)}
			<Tables node={node} ctx={ctx} />
			{children.map((c) => {
				placed.add(c.id);
				const empty =
					!c.blocks.length &&
					!(ctx.kids.get(c.id) ?? []).length &&
					!c.figures?.length;
				if (empty) return null;
				const childList = asList || CHECKLIST_TITLE.test(c.title);
				return (
					<div key={c.id} id={`n-${c.id}`} className="mt-5 scroll-mt-(--stick)">
						<h4
							className={`mb-1 px-3 font-semibold text-balance ${depth === 0 ? "text-lg" : "text-base"}`}
						>
							<Title node={c} />
						</h4>
						<Rules
							rules={ctx.rules.get(c.id)}
							hospital={ctx.hospital.name}
						/>
						<Preview
							long={
								!childList &&
								depth === 0 &&
								textOf(c, ctx.kids) > 700 &&
								!hasFigures(c, ctx.kids)
							}
							ctx={ctx}
						>
							{depth < 6 ? (
								<NodeBody
									node={c}
									ctx={ctx}
									depth={depth + 1}
									placed={placed}
									checklist={childList}
								/>
							) : (
								<Lines node={c} ctx={ctx} />
							)}
						</Preview>
					</div>
				);
			})}
		</>
	);
}

/** Long prose shows its first few lines; "Show all" opens the rest. Print always shows everything. */
function Preview({
	long,
	ctx,
	children,
}: {
	long: boolean;
	ctx: Ctx;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (!long || open) return <>{children}</>;
	return (
		<div>
			<div className="max-h-[8.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
				{children}
			</div>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="no-print mt-1 ml-3 flex items-center gap-1 text-[15px] font-medium text-accent hover:underline"
			>
				<ChevronDown size={16} aria-hidden /> Show all
			</button>
		</div>
	);
}

/** What a phase heading would show under its title (overview text, figures, local rules). */
function phaseHasContent(phase: Node, ctx: Ctx): boolean {
	const body = (ctx.kids.get(phase.id) ?? []).filter(
		(c) => !ctx.elsewhere.has(c.id) && c.kind !== "start_requirements",
	);
	return (
		phase.blocks.length > 0 ||
		body.length > 0 ||
		!!phase.figures?.length ||
		!!ctx.rules.get(phase.id)?.length
	);
}

/**
 * Phases with no steps of their own (overview chapters, umbrella headings): one quiet disclosure
 * under the map instead of a run of headings. Empty ones keep only their anchor.
 */
function PhaseOverviews({
	phases,
	ctx,
	placed,
}: {
	phases: Node[];
	ctx: Ctx;
	placed: Set<string>;
}) {
	const full = phases.filter((p) => phaseHasContent(p, ctx));
	for (const p of phases) placed.add(p.id);
	const empty = phases.filter((p) => !full.includes(p));
	return (
		<>
			{empty.map((p) => (
				<span key={p.id} id={`n-${p.id}`} className="block scroll-mt-(--stick)" />
			))}
			{full.length > 0 && (
				<details className="group/ov mb-8 rounded-lg border border-line bg-surface">
					<summary className="flex cursor-pointer list-none items-baseline gap-2 px-4 py-2.5 text-sm text-ink hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
						<ChevronRight
							size={14}
							aria-hidden
							className="shrink-0 self-center transition-transform group-open/ov:rotate-90 motion-reduce:transition-none"
						/>
						<span className="shrink-0 font-medium whitespace-nowrap">Phase overviews</span>
						<span className="shrink-0 text-muted tabular-nums">{full.length}</span>
						<span className="min-w-0 truncate text-muted">
							{full.map((p) => splitNumber(p.title)[1]).join(", ")}
						</span>
					</summary>
					<div className="border-t border-line px-4 pb-4 [&>div]:mt-5 [&>div]:mb-0">
						{full.map((p) => (
							<PhaseHeading key={p.id} phase={p} ctx={ctx} placed={placed} />
						))}
					</div>
				</details>
			)}
		</>
	);
}

function PhaseHeading({
	phase,
	ctx,
	placed,
}: {
	phase: Node;
	ctx: Ctx;
	placed: Set<string>;
}) {
	placed.add(phase.id);
	const body = (ctx.kids.get(phase.id) ?? []).filter(
		(c) => !ctx.elsewhere.has(c.id) && c.kind !== "start_requirements",
	);
	const hasText = phase.blocks.length > 0 || body.length > 0;
	// Algorithms and schemas are the point of a phase overview: open it when it holds one.
	const hasFigure =
		!!phase.figures?.length ||
		body.some((c) => c.kind === "figure" || c.figures?.length);
	return (
		<div id={`n-${phase.id}`} className="mt-10 mb-4 scroll-mt-(--stick)">
			<h3 className="text-xl font-semibold text-ink"><Title node={phase} /></h3>
			<Rules rules={ctx.rules.get(phase.id)} hospital={ctx.hospital.name} />
			{hasText && (
				<details className="group mt-1" open={hasFigure}>
					<summary className="cursor-pointer list-none text-sm text-accent hover:underline">
						<ChevronRight
							size={14}
							className="mr-1 inline transition-transform group-open:rotate-90"
						/>
						Phase overview, as written in the protocol
					</summary>
					<div className="mt-2">
						<NodeBody node={phase} ctx={ctx} depth={0} placed={placed} />
					</div>
				</details>
			)}
		</div>
	);
}

function Decision({
	node,
	ctx,
	placed,
}: {
	node: Node;
	ctx: Ctx;
	placed: Set<string>;
}) {
	placed.add(node.id);
	return (
		<div
			id={`n-${node.id}`}
			className="mb-6 ml-10 scroll-mt-(--stick) rounded-lg border border-flow/30 bg-flow-soft/60 p-4"
		>
			<h3 className="mb-1 flex items-center gap-2 text-lg font-semibold text-flow">
				<GitFork size={18} aria-hidden /> <Title node={node} />
			</h3>
			<Rules rules={ctx.rules.get(node.id)} hospital={ctx.hospital.name} />
			<Preview
				long={textOf(node, ctx.kids) > 700 && !hasFigures(node, ctx.kids)}
				ctx={ctx}
			>
				<NodeBody node={node} ctx={ctx} depth={1} placed={placed} />
			</Preview>
		</div>
	);
}

/* ------------------------------------------------------------------ diagnostics */

interface Item {
	a: Anchor;
	nodeId: string;
	section?: string;
	/** What a chip points at when it is not the line itself (a requirement table). */
	target?: Anchor;
	/** A sentence split out of a paragraph that carries no threshold: read, not ticked. */
	prose?: boolean;
}

function diagItems(nodes: Node[], ctx: Ctx, placed: Set<string>): Item[] {
	const out: Item[] = [];
	const walk = (n: Node, section: string) => {
		placed.add(n.id);
		for (const a of n.blocks) out.push({ a, nodeId: n.id, section });
		for (const c of ctx.kids.get(n.id) ?? [])
			if (!ctx.elsewhere.has(c.id) && c.kind !== "start_requirements")
				walk(c, c.title);
	};
	for (const n of nodes) walk(n, n.title);
	return out;
}

const SPECIFIC_SECTION =
	/baseline|organ function|prior (?:to )?start|before treatment|staging|metasta|extension|imaging|scintigraph|tomograph|PET|MRI|\bCT\b|biops|patholog|histolog|molecular|genetic|cytogenetic|immunohisto/i;

/** The work-up in the order a clinician does it. The protocol's own lines, sorted by the pipeline. */
const STAGES = [
	{
		key: "primary",
		label: "Primary tumour diagnosis",
		hint: "Imaging of the primary, biopsy, pathology",
	},
	{
		key: "molecular",
		label: "Molecular and genetic confirmation",
		hint: "Translocations, fusion genes, cytogenetics",
	},
	{
		key: "extent",
		label: "Extent of disease",
		hint: "Staging: metastases, chest CT, PET-CT, bone marrow",
	},
	{
		key: "baseline",
		label: "Baseline before treatment",
		hint: "Organ function and fitness: the starting point for monitoring side effects",
	},
	{
		key: "relapse",
		label: "At relapse",
		hint: "Work-up at suspected or confirmed recurrence, not part of the initial diagnosis",
	},
	{
		key: "follow_up",
		label: "Follow-up",
		hint: "Investigations after the end of treatment",
	},
] as const;
type StageWording = Partial<
	Record<(typeof STAGES)[number]["key"], { label: string; hint: string }>
>;
const LEUKAEMIA_STAGES: StageWording = {
	primary: {
		label: "Confirming the diagnosis",
		hint: "Bone marrow morphology, immunophenotyping, cytochemistry",
	},
	molecular: {
		label: "Genetics",
		hint: "Cytogenetics, molecular genetics, MRD markers",
	},
	extent: {
		label: "Extent of disease",
		hint: "CNS/CSF status, extramedullary disease, organomegaly",
	},
};
/** Stage wording per disease family; solid tumours keep the default. */
const STAGE_WORDING: Record<string, StageWording> = {
	leukaemia: LEUKAEMIA_STAGES,
	marrow_failure_histiocytosis: LEUKAEMIA_STAGES,
	lymphoma: {
		primary: {
			label: "Confirming the diagnosis",
			hint: "Biopsy, histology, immunohistochemistry",
		},
		molecular: { label: "Molecular", hint: "Molecular and genetic markers" },
		extent: { label: "Staging", hint: "PET-CT, bone marrow, CSF" },
	},
};
const stagesFor = (family: string | undefined) =>
	STAGES.map((st) => ({ ...st, ...STAGE_WORDING[family ?? ""]?.[st.key] }));
/** Relapse and follow-up work-ups come after the four initial steps, unnumbered. */
const LATER = new Set<string>(["relapse", "follow_up"]);
const stepName = (key: string | undefined) => {
	const i = STAGES.findIndex((s) => s.key === key);
	return i < 0 ? "Other text" : LATER.has(key!) ? STAGES[i].label : `step ${i + 1}`;
};

/** A list = an intro line ending ":" and the item lines after it, inside one section. */
function workupLists(all: Item[]): { intro: Item; items: Item[] }[] {
	const out: { intro: Item; items: Item[] }[] = [];
	let cur: { intro: Item; items: Item[] } | null = null;
	// A numbered run with no intro line ("1. History…", "2. Haemoglobin…") is a list too; its intro is
	// an empty stand-in that never renders, so the "more items in step X" note still has a key.
	let run: { intro: Item; items: Item[] } | null = null;
	for (const it of all) {
		const tx = it.a.text.trim();
		if (cur && cur.intro.nodeId !== it.nodeId) cur = null;
		if (run && run.intro.nodeId !== it.nodeId) run = null;
		if (cur && (LIST_MARK.test(tx) || (cur.items.length && /^[a-z]/.test(tx))))
			cur.items.push(it);
		else if (/:\s*$/.test(tx) && tx.length < 240) {
			out.push((cur = { intro: it, items: [] }));
			run = null;
		} else if (NUMBERED.test(tx)) {
			cur = null;
			if (!run) out.push((run = { intro: { ...it, a: { ...it.a, text: "" } }, items: [] }));
			run.items.push(it);
		} else cur = run = null;
	}
	return out.filter((l) => l.items.length);
}
const NUMBERED = /^\d{1,2}[.)]\s+\S/;
const LIST_MARK = /^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–\uf0b7\uf0a7]|o\s|\(?[a-z0-9]{1,2}[.)]\s)/i;

/** "3 more items of this list in step 3": shown under a list whose items were sorted into several steps. */
interface ListNote {
	intro: Item;
	elsewhere: { key: string | undefined; n: number }[];
}

/** Diagnosis work-up in four stages (1 to 4), each grouped by the protocol section it comes from; or as written. */
function Diagnostics({
	nodes,
	ctx,
	placed,
	family,
}: {
	nodes: Node[];
	ctx: Ctx;
	placed: Set<string>;
	family?: string;
}) {
	const [view, setView] = useState<"stages" | "written">("stages");
	const all = diagItems(nodes, ctx, placed);
	const items = all.filter((i) => !isHeading(i.a.text) && i.a.text.trim().length > 2);
	// A section whose own title names its stage ("Baseline investigations", "Staging", "Biopsies") wins over
	// the per-line sorting; broad sections ("Diagnostics", "Frontline assessments") defer to the lines.
	// Relapse and follow-up lines always leave the initial work-up.
	const stageOf = (i: Item) => {
		const n = ctx.byId.get(i.nodeId);
		if (i.a.stage && LATER.has(i.a.stage)) return i.a.stage;
		if (n?.stage && SPECIFIC_SECTION.test(n.title)) return n.stage;
		return i.a.stage ?? n?.stage;
	};
	const lists = workupLists(all);
	const listOf = new Map<Item, { intro: Item; items: Item[] }>();
	for (const l of lists) for (const it of l.items) listOf.set(it, l);
	/** A step's lines, in document order, with the intro of every list that has items here. */
	const stepItems = (key: string | undefined) => {
		const mine = new Set(items.filter((it) => stageOf(it) === key));
		const notes = new Map<string, ListNote[]>();
		for (const l of lists) {
			const here = l.items.filter((it) => mine.has(it));
			if (!here.length) continue;
			mine.add(l.intro);
			const counts = new Map<string | undefined, number>();
			for (const it of l.items)
				if (!mine.has(it) && it.a.text.trim().length > 2)
					counts.set(stageOf(it), (counts.get(stageOf(it)) ?? 0) + 1);
			if (counts.size) {
				const sec = l.intro.section ?? "";
				notes.set(sec, [
					...(notes.get(sec) ?? []),
					{
						intro: l.intro,
						elsewhere: [...counts].map(([k, n]) => ({ key: k, n })),
					},
				]);
			}
		}
		return { list: all.filter((it) => mine.has(it)), notes };
	};
	const sorted = items.some((i) => stageOf(i));
	const figs = (n: Node): Node[] => [
		n,
		...(ctx.kids.get(n.id) ?? [])
			.filter((c) => !ctx.elsewhere.has(c.id))
			.flatMap(figs),
	];
	const withFigures = nodes.flatMap(figs).filter((n) => n.figures?.length);
	const showStages = view === "stages" && sorted;

	return (
		<div>
			{sorted && (
				<div
					role="tablist"
					aria-label="Diagnosis view"
					className="no-print mb-4 inline-flex rounded-md border border-line bg-surface p-0.5 text-sm"
				>
					{(
						[
							["stages", "Step by step"],
							["written", "As written in the protocol"],
						] as const
					).map(([k, label]) => (
						<button
							key={k}
							type="button"
							role="tab"
							aria-selected={view === k}
							onClick={() => setView(k)}
							className={`rounded px-3 py-1.5 transition-colors ${view === k ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
						>
							{label}
						</button>
					))}
				</div>
			)}
			{nodes.map((n) => (
				<div key={n.id} id={`n-${n.id}`} className="scroll-mt-(--stick)">
					<Rules rules={ctx.rules.get(n.id)} hospital={ctx.hospital.name} />
				</div>
			))}
			{showStages ? (
				<ol className="grid gap-5">
					{stagesFor(family).map((st, i) => {
						const { list: mine, notes } = stepItems(st.key);
						const tables = withFigures.filter((n) => n.stage === st.key);
						const later = LATER.has(st.key);
						if (later && !mine.length && !tables.length) return null;
						return (
							<li
								key={st.key}
								id={`stage-${st.key}`}
								className={`scroll-mt-(--stick) rounded-lg border p-4 ${later ? "border-line bg-paper" : "border-line bg-surface"}`}
							>
								<div className="mb-2 flex items-baseline gap-3">
									{later ? (
										<span
											aria-hidden
											className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-base font-semibold text-muted"
										>
											↻
										</span>
									) : (
										<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-base font-semibold text-white tabular-nums">
											{i + 1}
										</span>
									)}
									<div className="min-w-0">
										<h3 className="text-xl font-semibold">
											{st.label}
										</h3>
										<p className="text-sm text-muted">{st.hint}</p>
									</div>
								</div>
								{mine.length || tables.length ? (
									<div className="grid gap-3 pl-11">
										{bySection(mine).map(([section, group]) => (
											<SectionGroup
												key={section}
												section={section}
												items={group}
												ctx={ctx}
												notes={notes.get(section)}
											/>
										))}
										{tables.map((n) => (
											<Tables key={n.id} node={n} ctx={ctx} />
										))}
									</div>
								) : (
									<p className="pl-11 text-sm text-muted">
										Nothing in this protocol's work-up for this
										step.
									</p>
								)}
							</li>
						);
					})}
					{(() => {
						const { list: rest, notes } = stepItems(undefined);
						const tables = withFigures.filter((n) => !n.stage);
						if (!rest.length && !tables.length) return null;
						return (
							<li
								id="stage-undefined"
								className="scroll-mt-(--stick) rounded-lg border border-dashed border-line p-4"
							>
								<details>
									<summary className="cursor-pointer text-base font-semibold text-muted">
										Other text in the work-up sections (
										{rest.length})
									</summary>
									<div className="mt-3 grid gap-3">
										{bySection(rest).map(([section, group]) => (
											<SectionGroup
												key={section}
												section={section}
												items={group}
												ctx={ctx}
												notes={notes.get(section)}
											/>
										))}
										{tables.map((n) => (
											<Tables key={n.id} node={n} ctx={ctx} />
										))}
									</div>
								</details>
							</li>
						);
					})()}
				</ol>
			) : (
				nodes.map((n) => (
					<div key={n.id} className="mb-6">
						{nodes.length > 1 && (
							<h3 className="mb-2 text-xl font-semibold"><Title node={n} /></h3>
						)}
						<NodeBody
							node={n}
							ctx={ctx}
							depth={0}
							placed={placed}
							checklist
						/>
					</div>
				))
			)}
		</div>
	);
}

/** Lines grouped by their protocol section, in document order of first appearance. */
function bySection(items: Item[]): [string, Item[]][] {
	const m = new Map<string, Item[]>();
	for (const i of items) {
		const k = i.section ?? "";
		m.set(k, [...(m.get(k) ?? []), i]);
	}
	return [...m.entries()];
}

/**
 * One protocol section inside a work-up step. Long technical lists start folded; technique lines
 * (imaging protocols, sequences, acquisition) are read, not ticked, and sit folded under the section.
 */
function SectionGroup({
	section,
	items: lines,
	ctx,
	notes,
}: {
	section: string;
	items: Item[];
	ctx: Ctx;
	notes?: ListNote[];
}) {
	const say = useSay();
	const { lang } = useProtoLang();
	const secNode = lines[0] && ctx.byId.get(lines[0].nodeId);
	const heading = secNode?.title === section ? titleOf(secNode, lang) : section;
	const items = lines.filter((i) => !i.a.technique);
	const technique = lines.filter((i) => i.a.technique);
	const page = lines[0]?.a.page;
	// Work-up lists stay open: a step's items are re-sorted from several lists, folding by length hid real
	// investigations. Technique text is folded by its own flag (`technique`) below.
	const technical = false;
	const body = (
		<>
			{items.length > 0 && <Checklist items={items} ctx={ctx} compact />}
			{notes?.map((nt) => (
				<p
					key={lineKey(nt.intro.a)}
					className="no-print px-3 py-0.5 text-sm text-muted"
				>
					{nt.elsewhere.map((e, k) => (
						<span key={String(e.key)}>
							{k > 0 && " · "}
							<a
								href={`#stage-${e.key}`}
								className="text-accent hover:underline"
							>
								{e.n} more item{e.n === 1 ? "" : "s"} of this list in{" "}
								{stepName(e.key)}
							</a>
						</span>
					))}
				</p>
			))}
			{technique.length > 0 && (
				<details className="mt-1 px-2">
					<summary className="cursor-pointer text-sm text-muted hover:text-ink">
						How it is done: technique ({technique.length} line
						{technique.length === 1 ? "" : "s"})
					</summary>
					<ul className="mt-1 grid gap-0.5 border-l border-line pl-2">
						{technique.map((i, k) => (
							<li
								key={`${lineKey(i.a)}-${k}`}
								data-anchor={lineKey(i.a)}
								className="group/row flex items-start gap-2 rounded-md px-2 py-1 text-[15px] leading-relaxed text-ink/85"
							>
								<button
									type="button"
									onClick={() => ctx.show(i.a, i.a.page, i.nodeId)}
									className="verbatim min-w-0 flex-1 text-left text-pretty"
									title={say(i.a).orig ?? `Show on page ${i.a.page}`}
								>
									{say(i.a).text}
								</button>
								<span className="page-ref mt-1 shrink-0 font-mono text-[13px] text-accent opacity-0 transition-opacity group-hover/row:opacity-100">
									p. {i.a.page}
								</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</>
	);
	return (
		<div>
			{technical ? (
				<details>
					<summary className="cursor-pointer text-[15px] font-semibold text-ink/80">
						{heading}{" "}
						<span className="font-normal text-muted">
							· {items.length} lines
						</span>
					</summary>
					<div className="mt-1">{body}</div>
				</details>
			) : (
				<>
					<p className="group/sec mb-0.5 px-2 text-[15px] font-semibold text-ink/80">
						{heading}{" "}
						<span className="page-ref font-mono text-[13px] font-normal text-accent opacity-0 transition-opacity group-hover/sec:opacity-100">
							p. {page}
						</span>
					</p>
					{body}
				</>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ treatment steps */

function Step({
	step,
	spec,
	ctx,
	placed,
	index,
	open,
	onToggle,
}: {
	step: Node;
	spec: Spec;
	ctx: Ctx;
	placed: Set<string>;
	index: number;
	open: boolean;
	onToggle: () => void;
}) {
	placed.add(step.id);
	const reqs = (ctx.kids.get(step.id) ?? []).filter(
		(c) => c.kind === "start_requirements",
	);
	for (const r of reqs) placed.add(r.id);
	const items: Item[] = reqs.flatMap((r) =>
		r.blocks.map((a) => ({ a, nodeId: r.id })),
	);
	const { lang } = useProtoLang();
	const checkable = checklistRows(items, lang).filter(tickable);
	const done = checkable.filter((i) => ctx.checks.has(lineKey(i.a))).length;
	const edges = spec.edges.filter((e) => e.from === step.id && e.kind !== "see_also");
	const stepRules = [step, ...reqs].flatMap((n) => ctx.rules.get(n.id) ?? []);
	const hasText =
		step.blocks.length > 0 ||
		step.figures?.length ||
		(ctx.kids.get(step.id) ?? []).some(
			(c) => !ctx.elsewhere.has(c.id) && c.kind !== "start_requirements",
		);
	const range =
		step.pages.to !== step.pages.from
			? `pp. ${step.pages.from}-${step.pages.to}`
			: `p. ${step.pages.from}`;
	const all = checkable.length > 0 && done === checkable.length;
	const caseStatus = ctx.kase.status(step.id);
	// Chips also read requirement tables (their text layer, line by line), pointing at the table.
	const chipItems: Item[] = [
		...checkable,
		...reqs.flatMap((r) =>
			(r.figures ?? []).flatMap((f) =>
				f.caption
					? f.caption.text.split("\n").map((line) => ({
							a: { ...f.caption!, text: line },
							nodeId: r.id,
							target: f.caption,
						}))
					: [],
			),
		),
	];

	return (
		<article
			id={`n-${step.id}`}
			data-spy={step.id}
			className="group/step relative mb-4 scroll-mt-(--stick) pl-10"
		>
			<span
				aria-hidden
				className={`absolute top-3 left-0 flex size-7 items-center justify-center rounded-full border-2 text-[13px] font-semibold tabular-nums ${caseStatus === "done" ? "border-go bg-go text-white" : caseStatus === "current" ? "border-accent bg-accent text-white ring-4 ring-accent/25" : all ? "border-go bg-go text-white" : open ? "border-accent bg-accent text-white" : "border-line bg-surface text-muted"}`}
			>
				{caseStatus === "done" || (all && !caseStatus) ? (
					<Check size={15} strokeWidth={3} />
				) : (
					index + 1
				)}
			</span>
			<div
				className={`rounded-lg border transition-colors ${open ? "border-accent/40 bg-surface shadow-sm" : "border-line bg-surface/70 hover:border-accent/50"}`}
			>
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="flex w-full items-start gap-3 px-4 py-3 text-left"
				>
					<span className="min-w-0 flex-1">
						<span
							className={`block leading-tight font-semibold text-balance ${open ? "text-[22px]" : "text-lg"}`}
						>
							<Title node={step} />
						</span>
						{!open && (
							<span className="mt-1.5 flex flex-wrap items-center gap-1.5">
								<Chips items={chipItems} ctx={ctx} passive />
								{checkable.length ? (
									<span
										className={`text-sm tabular-nums ${all ? "font-medium text-go" : "text-muted"}`}
									>
										{done} of {checkable.length} requirements ticked
									</span>
								) : null}
							</span>
						)}
					</span>
					<ChevronDown
						size={20}
						aria-hidden
						className={`mt-1 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
					/>
				</button>

				{open && (
					<div className="px-4 pb-4">
						<CaseStepPanel
							kase={ctx.kase}
							step={step}
							nodes={ctx.nodes}
							edges={ctx.edges}
							hasRules={stepRules.length > 0}
							hospital={ctx.hospital.name}
						/>
						{reqs.length ? (
							<div className="rounded-lg border border-go/40 bg-go-soft p-4">
								<p className="mb-2 flex items-center gap-2 text-base font-semibold text-go">
									<CircleCheck size={18} aria-hidden /> Requirements
									to start
								</p>
								<div className="no-print mb-2">
									<Chips items={chipItems} ctx={ctx} />
								</div>
								<Checklist items={items} ctx={ctx} tone="go" />
								{reqs.map((r) => (
									<div
										key={r.id}
										id={`n-${r.id}`}
										className="scroll-mt-(--stick)"
									>
										<Tables node={r} ctx={ctx} />
									</div>
								))}
							</div>
						) : (
							<p className="text-[15px] text-muted">
								Conditions to start this step: see the protocol,{" "}
								<button
									type="button"
									className="text-accent hover:underline"
									onClick={() =>
										ctx.show(undefined, step.pages.from, step.id)
									}
								>
									{range}
								</button>
								.
							</p>
						)}

						<Rules rules={stepRules} hospital={ctx.hospital.name} />
						<div className="opacity-0 transition-opacity group-hover/step:opacity-100 focus-within:opacity-100">
							<LocalRuleForm
								protocolId={ctx.protocolId}
								hospital={ctx.hospital.id}
								hospitalName={ctx.hospital.name}
								nodeId={reqs[0]?.id ?? step.id}
							/>
						</div>

						{edges.length > 0 && (
							<ul className="mt-3 grid gap-1.5">
								{edges.map((e, i) => (
									<EdgeLine key={`${e.to}-${i}`} edge={e} ctx={ctx} />
								))}
							</ul>
						)}

						{hasText && (
							<details
								className="group mt-3"
								
							>
								<summary className="cursor-pointer list-none text-[15px] text-accent hover:underline">
									<ChevronRight
										size={15}
										className="mr-1 inline transition-transform group-open:rotate-90"
									/>
									Full text of this step ({range})
								</summary>
								<div className="mt-2">
									<NodeBody
										node={step}
										ctx={ctx}
										depth={0}
										placed={placed}
									/>
								</div>
							</details>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

/** One chip per kind of requirement, from the verbatim lines; clicking one points at its line. */
function Chips({
	items,
	ctx,
	passive,
}: {
	items: Item[];
	ctx: Ctx;
	passive?: boolean;
}) {
	const seen = new Map<
		string,
		{ t: NonNullable<ReturnType<typeof classify>>; a: Anchor }
	>();
	for (const i of items) {
		const t = classify(i.a.text);
		if (t && !seen.has(t.key)) seen.set(t.key, { t, a: i.target ?? i.a });
	}
	if (!seen.size) return null;
	return (
		<span className="inline-flex flex-wrap gap-1.5">
			{[...seen.values()].map(({ t, a }) => {
				const cls = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px] font-medium ${t.alert ? "border-warn/40 bg-warn-soft text-warn" : "border-line bg-surface text-ink/80"}`;
				const body = (
					<>
						<t.Icon size={14} aria-hidden /> {t.label}
					</>
				);
				return passive ? (
					<span key={t.key} className={cls}>
						{body}
					</span>
				) : (
					<button
						key={t.key}
						type="button"
						onClick={() => flash(a)}
						className={`${cls} transition-colors hover:border-accent`}
					>
						{body}
					</button>
				);
			})}
		</span>
	);
}

function flash(a: Anchor) {
	const el = document.querySelector<HTMLElement>(
		`[data-anchor="${a.page}:${cssKey(a.text)}"]`,
	);
	if (!el) return;
	el.scrollIntoView({ block: "center", behavior: "smooth" });
	el.classList.remove("flash");
	void el.offsetWidth;
	el.classList.add("flash");
}

const EDGE_LABEL: Record<Edge["kind"], string> = {
	next: "Next",
	alternative: "Or",
	restratify_to: "Re-stratified to",
	see_also: "See also",
};

function EdgeLine({ edge, ctx }: { edge: Edge; ctx: Ctx }) {
	const other = ctx.byId.get(edge.to);
	if (!other) return null;
	const decision = edge.kind === "alternative" || edge.kind === "restratify_to";
	const Icon =
		edge.kind === "alternative"
			? GitFork
			: edge.kind === "restratify_to"
				? Shuffle
				: ArrowRight;
	return (
		<li className="group/edge flex flex-wrap items-baseline gap-x-2 text-[15px] leading-snug">
			<span
				className={`inline-flex items-center gap-1.5 self-center font-semibold ${decision ? "text-flow" : "text-muted"}`}
			>
				<Icon size={16} aria-hidden /> {EDGE_LABEL[edge.kind]}
			</span>
			<button
				type="button"
				onClick={() => ctx.go({ nodeId: other.id })}
				className="font-medium text-accent hover:underline"
			>
				<Title node={other} />
			</button>
			{edge.evidence ? (
				<button
					type="button"
					onClick={() =>
						ctx.show(edge.evidence, edge.evidence!.page, edge.from)
					}
					title={`“${restoreUnits(edge.evidence.text.replace(/\s+/g, " "))}”\nShow on page ${edge.evidence.page}`}
					className="page-ref font-mono text-[13px] whitespace-nowrap text-accent opacity-0 transition-opacity group-hover/edge:opacity-100 focus-visible:opacity-100"
				>
					p. {edge.evidence.page}
				</button>
			) : (
				<span className="text-sm text-muted italic">
					not stated in the text, inferred from document order
				</span>
			)}
		</li>
	);
}

/** PDF headings in capitals ("8 ELIGIBILITY", "DACARBAZINE") in sentence case; roman numerals and codes stay. */
function tidyTitle(t: string): string {
	if (/[a-z]/.test(t) || !/[A-Z]{4}/.test(t)) return t;
	const s = t
		.split(/(\s+|\/)/)
		.map((w) => (/^[IVXL]+$|\d/.test(w) ? w : w.toLowerCase()))
		.join("");
	return s.replace(/[a-z]/, (c) => c.toUpperCase());
}

const MORE_GROUPS: { kind: Node["kind"]; label: string; icon: React.ReactNode }[] = [
	{ kind: "eligibility", label: "Eligibility", icon: <ClipboardCheck size={17} aria-hidden /> },
	{ kind: "drug_info", label: "Drugs", icon: <Pill size={17} aria-hidden /> },
	{ kind: "schedule", label: "Schedules", icon: <CalendarDays size={17} aria-hidden /> },
];

/** Eligibility, drug descriptions and schedules: grouped by kind, drugs A to Z, each folded until opened. */
function Collapsed({
	nodes,
	ctx,
	placed,
}: {
	nodes: Node[];
	ctx: Ctx;
	placed: Set<string>;
}) {
	const ids = new Set(nodes.map((n) => n.id));
	// A bare container heading ("Appendix IX drug descriptions") whose sections are listed anyway adds nothing.
	const rows = nodes.filter(
		(n) => n.blocks.length || n.figures?.length || !nodes.some((m) => m.parent === n.id),
	);
	for (const n of nodes) if (!rows.includes(n) && ids.has(n.id)) placed.add(n.id);
	return (
		<div className="grid gap-6">
			{MORE_GROUPS.map((g) => {
				const mine = rows.filter((n) => n.kind === g.kind);
				if (g.kind === "drug_info")
					// Drugs A to Z; an appendix's own intro ("Appendix IX drug descriptions") after them.
					mine.sort(
						(a, b) =>
							Number(/^appendix/i.test(a.title)) - Number(/^appendix/i.test(b.title)) ||
							tidyTitle(a.title).localeCompare(tidyTitle(b.title)),
					);
				if (!mine.length) return null;
				return (
					<div key={g.kind}>
						<h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-muted">
							{g.icon} {g.label}
						</h3>
						<div className="grid border-t border-line">
							{mine.map((n) => {
								placed.add(n.id);
								return (
									<details
										key={n.id}
										id={`n-${n.id}`}
										className="group scroll-mt-(--stick) border-b border-line"
									>
										<summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-[17px] font-medium hover:text-accent">
											<ChevronRight
												size={17}
												className="shrink-0 text-muted transition-transform group-open:rotate-90"
											/>
											<Title node={n} tidy />
										</summary>
										<div className="pb-4">
											<Rules
												rules={ctx.rules.get(n.id)}
												hospital={ctx.hospital.name}
											/>
											<NodeBody node={n} ctx={ctx} depth={0} placed={placed} />
										</div>
									</details>
								);
							})}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/* ------------------------------------------------------------------ lines, checklists */

const BULLET = /^(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–]\s*|o\s+)/;

/**
 * Restores superscripts that PDF text extraction flattens ("x109/L" is printed as ×10⁹/L, "mg/m2" as mg/m²).
 * Typography only: the words and numbers are the protocol's own.
 */
function restoreUnits(text: string): string {
	return text
		.replace(
			/\s?[x×*]\s?10\s?\^?\s?(9|12)\s?\/\s?l\b/gi,
			(_, e: string) => ` ×10${e === "9" ? "⁹" : "¹²"}/L`,
		)
		.replace(/\b((?:m|µ|u)?g|IU|U|mL|ml)\/m2\b/g, "$1/m²");
}

/**
 * Checklists re-sort a protocol's numbered list across steps, so its numbers ("4.", "7)") read as gaps:
 * drop a single-level list marker before a word. Never a decimal: "1.8 Gy" and "2.5 MBq" are doses.
 */
const unnumber = (t: string) =>
	t.replace(/^\d{1,2}[.)]\s+(?=[A-Z][a-z])/, "");

/** Reflow the PDF's hard line wraps for reading; keep breaks before list markers. Words are untouched. */
const display = (t: string) =>
	restoreUnits(
		t
			.replace(/^[\uf000-\uf0ff]\s*/, "")
			.replace(BULLET, "")
			.replace(/\n(?![•●▪◦■□♦◆►▸➢➤✓✔\-–]\s|o\s|\(?[a-z0-9]{1,2}[.)]\s)/gi, " "),
	);
/**
 * Something you can tick: a list item, or a short criterion/investigation. Explanatory prose
 * ("The follow-up checks can be performed according to national guidelines...") is read, not ticked.
 */
const isItem = (t: string) => {
	const x = t.trim();
	if (/^(?:[•●▪◦■□♦◆►▸➢➤✓✔*\-–\uf0b7\uf0a7]|o\s|\(?[a-z0-9]{1,2}[.)]\s)/i.test(x))
		return true;
	return x.length <= 140 && (x.match(/[.!?](\s|$)/g)?.length ?? 0) <= 1;
};

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9≥≤<>]+/g, "");
/**
 * An ALL-CAPS line that repeats text already on another line (a table's text layer echoing the
 * paragraph above it) is noise in a checklist: the reader would tick the same rule twice.
 */
const isEcho = (t: string, items: Item[], k: number) => {
	const letters = t.replace(/[^a-z]/gi, "");
	if (
		letters.length < 12 ||
		letters.replace(/[^A-Z]/g, "").length / letters.length < 0.8
	)
		return false;
	const own = squash(t).slice(4, 60);
	return (
		own.length > 20 &&
		items.some(
			(o, j) =>
				j !== k &&
				!/^[^a-z]*$/.test(o.a.text) &&
				squash(o.a.text).includes(own),
		)
	);
};

const THRESHOLD = /[≥≤]|>=|<=|\b(?:ANC|WBC|platelets?)\b[^.]{0,40}[<>]/i;
/** A tickable criterion: a list item or short line, or one sentence that carries a threshold. */
const isCriterion = (t: string) =>
	!isHeading(t) &&
	(isItem(t) ||
		(THRESHOLD.test(t) &&
			t.trim().length <= 320 &&
			(t.match(/[.!?](\s|$)/g)?.length ?? 0) <= 1));
/** Tickable: the pipeline's block role when the section was segmented by the model, else the text heuristics. */
const tickable = (i: Item) =>
	i.a.role ? i.a.role === "item" : !i.prose && isCriterion(i.a.text);
/** A sub-heading row: role heading, else a short line ending ":". */
const headingRow = (a: Anchor) => (a.role ? a.role === "heading" : isHeading(a.text));

/**
 * Checklist rows: drop ALL-CAPS echoes, and split a paragraph that carries thresholds into its
 * sentences (verbatim, in order) so each threshold can be ticked on its own and the rest is read.
 */
function checklistRows(items: Item[], lang: ProtoLang = "orig"): Item[] {
	// A block that still holds several bullet items (a wrap the pipeline did not split) ticks one by one.
	// A summarised line is read as one row: its summary covers the whole block.
	const split = items.flatMap((i) => {
		if (summaryOf(i.a, lang)) return [i];
		const parts = i.a.text.split(/\n(?=[•●▪◦■□♦◆►▸➢➤✓✔]\s)/);
		return parts.length < 2
			? [i]
			: parts.map((text) => ({ ...i, a: { ...i.a, text }, target: i.target ?? i.a }));
	});
	return split.flatMap((i, k, items) => {
		const t = i.a.text;
		if (!t.trim() || isEcho(t, items, k)) return [];
		if (i.a.role || isHeading(t) || isItem(t) || !THRESHOLD.test(t) || summaryOf(i.a, lang)) return [i];
		const parts = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
		if (parts.length < 2) return [i];
		return parts.map((text) => ({
			...i,
			a: { ...i.a, text },
			target: i.target ?? i.a,
			prose: !THRESHOLD.test(text),
		}));
	});
}

/** "...is started when:" introduces a list; a line carrying a threshold (≥, <, a count unit) is a criterion, never a heading. */
const isHeading = (t: string) =>
	t.trim().length < 90 &&
	/:\s*$/.test(t.trim()) &&
	!/[≥≤<>]|x\s*10|×10|\/mm|\/µl/i.test(t);
const lineKey = (a: Anchor) => `${a.page}:${cssKey(a.text)}`;

/**
 * A line as the reader chose to read it: its summary in the protocol language when there is one,
 * else the verbatim text (`fmt` formats it). `orig` is the verbatim text, set only when summarised:
 * shown on hover, while the click still opens the source page. Keys stay on the verbatim text.
 */
function useSay() {
	const { lang } = useProtoLang();
	return (a: Anchor, fmt: (t: string) => string = display) => {
		const s = summaryOf(a, lang);
		return s
			? { text: restoreUnits(s), orig: `${display(a.text)}\n\nOriginal, page ${a.page}` }
			: { text: fmt(a.text), orig: undefined };
	};
}

/** A section heading in the protocol language; the original heading on hover when translated. */
function Title({ node, tidy }: { node: Node; tidy?: boolean }) {
	const { lang } = useProtoLang();
	const t = titleOf(node, lang);
	const shown = tidy ? tidyTitle(t) : t;
	return t === node.title ? shown : <span title={node.title}>{shown}</span>;
}

const sameTitle = (text: string, title: string) => {
	const n = (t: string) =>
		t
			.replace(/^[\d.\s]+/, "")
			.replace(/\W+/g, " ")
			.trim()
			.toLowerCase();
	return n(text) === n(title);
};

/**
 * List depth of each line from where it starts on the page: the distinct left edges of list items,
 * left to right, are levels 0, 1, 2 (a sub-item sits further right than its parent). Prose stays at 0.
 */
function depths(anchors: Anchor[]): number[] {
	if (anchors.some((a) => a.role)) return anchors.map((a) => a.depth ?? 0);
	const x = (a: Anchor) => a.bbox?.[0]?.[0];
	const item = (a: Anchor) => BULLET.test(a.text) || isItem(a.text);
	const edges: number[] = [];
	for (const a of anchors) {
		const v = x(a);
		if (v !== undefined && item(a) && !edges.some((e) => Math.abs(e - v) < 6)) edges.push(v);
	}
	edges.sort((a, b) => a - b);
	return anchors.map((a) => {
		const v = x(a);
		if (v === undefined || !item(a)) return 0;
		return Math.min(5, edges.findIndex((e) => Math.abs(e - v) < 6));
	});
}

function Lines({ node, ctx }: { node: Node; ctx: Ctx }) {
	const blocks = node.blocks.filter(
		(a, i) => !(i === 0 && sameTitle(a.text, node.title)),
	);
	const say = useSay();
	if (!blocks.length) return null;
	const depth = depths(blocks);
	return (
		<div className="grid gap-0.5">
			{blocks.map((a, i) => {
				const bullet = BULLET.test(a.text);
				const on = ctx.active === a;
				return (
					<button
						key={`${a.page}-${i}`}
						type="button"
						data-anchor={lineKey(a)}
						onClick={() => ctx.show(a, a.page, node.id)}
						title={say(a).orig ?? `Show on page ${a.page}`}
						style={depth[i] ? { paddingLeft: `${0.75 + depth[i] * 1.5}rem` } : undefined}
						className={`group/row flex w-full items-start gap-3 rounded-md px-3 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${on ? "bg-mark/70" : "hover:bg-surface"}`}
					>
						{bullet ? (
							<span
								className={`mt-2.5 size-1.5 shrink-0 rounded-full ${depth[i] ? "border border-muted" : "bg-muted"}`}
							/>
						) : null}
						<span className="verbatim min-w-0 flex-1 text-[17px] leading-relaxed text-pretty">
							{say(a).text}
						</span>
						<FindingFlag findings={ctx.flags.get(lineKey(a))} />
						<span
							className={`page-ref mt-1 shrink-0 font-mono text-[13px] tabular-nums transition-opacity ${on ? "text-ink opacity-100" : "text-accent opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100"}`}
						>
							p. {a.page}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/**
 * Verbatim lines as a tickable checklist. Ticks live in this browser tab only (sessionStorage),
 * are never sent anywhere and carry no patient data; print shows them as boxes.
 */
function Checklist({
	items,
	ctx,
	compact,
	tone,
}: {
	items: Item[];
	ctx: Ctx;
	compact?: boolean;
	tone?: "go";
}) {
	const { lang } = useProtoLang();
	const say = useSay();
	const rows = checklistRows(items, lang);
	const depth = depths(rows.map((i) => i.a));
	const checkable = rows.filter(tickable);
	const done = checkable.filter((i) => ctx.checks.has(lineKey(i.a))).length;
	const [editing, setEditing] = useState<string | null>(null);
	const noting = !!ctx.kase.state && !ctx.printing;
	if (!rows.length) return null;
	return (
		<div>
			{checkable.length > 1 && (
				<p
					className={`mb-1 flex items-center gap-3 px-3 text-sm tabular-nums ${tone === "go" ? "text-go" : "text-muted"}`}
				>
					<span className={done === checkable.length ? "font-semibold" : ""}>
						{done} of {checkable.length} done
					</span>
					{done > 0 && (
						<button
							type="button"
							onClick={() =>
								ctx.untick(checkable.map((i) => lineKey(i.a)))
							}
							className="no-print text-accent hover:underline"
						>
							Reset
						</button>
					)}
				</p>
			)}
			<ul className="grid gap-0.5">
				{rows.map((i, k) => {
					const key = lineKey(i.a);
					const on =
						ctx.active === i.a || (!!i.target && ctx.active === i.target);
					if (!headingRow(i.a) && !tickable(i))
						return (
							<li
								key={`${key}-${k}`}
								data-anchor={key}
								style={depth[k] ? { paddingLeft: `${0.75 + depth[k] * 1.75}rem` } : undefined}
								className={`group/row flex items-start gap-2 rounded-md px-3 py-1 text-[16px] leading-relaxed text-ink/90 transition-colors ${on ? "bg-mark/70" : "hover:bg-paper/70"}`}
							>
								<button
									type="button"
									onClick={() => ctx.show(i.a, i.a.page, i.nodeId)}
									className="verbatim min-w-0 flex-1 rounded-sm text-left text-pretty focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									title={say(i.a).orig ?? `Show on page ${i.a.page}`}
								>
									{say(i.a, (t) => unnumber(display(t))).text}
								</button>
								<FindingFlag findings={ctx.flags.get(key)} />
								<span
									className={`page-ref mt-1 shrink-0 font-mono text-[13px] transition-opacity ${on ? "text-ink opacity-100" : "text-accent opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"}`}
								>
									p. {i.a.page}
								</span>
							</li>
						);
					if (headingRow(i.a))
						return (
							<li
								key={`${key}-${k}`}
								className="px-3 pt-2 text-[15px] font-semibold text-ink/80"
								title={say(i.a).orig}
							>
								{say(i.a).text}
							</li>
						);
					const ticked = ctx.checks.has(key);
					const note = noting ? ctx.notes[key]?.note : undefined;
					const edit = noting && editing === key;
					return (
						<li
							key={`${key}-${k}`}
							data-anchor={key}
							style={depth[k] ? { paddingLeft: `${0.5 + depth[k] * 1.75}rem` } : undefined}
							className={`group/row flex flex-wrap items-start gap-x-2.5 gap-y-0.5 rounded-md px-2 py-1 transition-colors ${on ? "bg-mark/70" : "hover:bg-paper/70"}`}
						>
							<button
								type="button"
								role="checkbox"
								aria-checked={ticked}
								aria-label={ticked ? "Untick" : "Tick"}
								onClick={() => ctx.tick(key)}
								className={`mt-1 flex size-[22px] shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${ticked ? "border-go bg-go text-white" : "border-muted bg-white hover:border-accent"}`}
							>
								{ticked && <Check size={15} strokeWidth={3} />}
							</button>
							<TopicIcon text={i.a.text} className="mt-1.5" />
							<LineText
								item={i}
								ctx={ctx}
								ticked={ticked}
								compact={compact}
							/>
							<FindingFlag findings={ctx.flags.get(key)} />
							{noting && (
								<button
									type="button"
									onClick={() => setEditing(key)}
									aria-label={note ? "Edit the note" : "Add a note"}
									title={
										note
											? "Edit the note (kept in this tab, copied into the EHR text)"
											: "Add a short note (kept in this tab, copied into the EHR text)"
									}
									className={`no-print mt-1 shrink-0 rounded p-0.5 transition-opacity hover:bg-surface hover:text-accent focus-visible:opacity-100 ${note ? "text-accent" : "text-muted opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"}`}
								>
									<StickyNote size={15} aria-hidden />
								</button>
							)}
							<span
								className={`page-ref mt-1.5 shrink-0 font-mono text-[13px] tabular-nums transition-opacity ${on ? "text-ink opacity-100" : "text-accent opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"}`}
							>
								p. {i.a.page}
							</span>
							{edit ? (
								<NoteInput
									value={note ?? ""}
									onSave={(v) => {
										ctx.setNote(i.a, v);
										setEditing(null);
									}}
									onCancel={() => setEditing(null)}
								/>
							) : (
								note && (
									<div className="basis-full pl-[calc(3.75rem-0.375rem)]">
										<button
											type="button"
											onClick={() => setEditing(key)}
											title="Edit the note (yours, not the protocol's)"
											className="flex max-w-xl items-start gap-1.5 rounded px-1.5 py-0.5 text-left text-sm text-ink/85 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
										>
											<StickyNote
												size={13}
												aria-hidden
												className="mt-[3px] shrink-0 text-accent"
											/>
											<span className="min-w-0 italic">{note}</span>
										</button>
									</div>
								)
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function LineText({
	item,
	ctx,
	ticked,
	compact,
}: {
	item: Item;
	ctx: Ctx;
	ticked: boolean;
	compact?: boolean;
}) {
	const [all, setAll] = useState(false);
	const said = useSay()(item.a, (t) => unnumber(display(t)));
	const text = said.text;
	const long = compact && text.length > 260 && !ctx.printing;
	return (
		<span className="min-w-0 flex-1">
			<button
				type="button"
				onClick={() => ctx.show(item.a, item.a.page, item.nodeId)}
				title={
					said.orig ??
					(item.section
						? `${item.section}, page ${item.a.page}`
						: `Show on page ${item.a.page}`)
				}
				className={`verbatim block w-full text-left leading-relaxed text-pretty transition-colors ${compact ? "text-base" : "text-[17px]"} ${ticked ? "text-muted line-through decoration-muted/60" : "hover:text-accent"} ${long && !all ? "line-clamp-3" : ""}`}
			>
				{text}
			</button>
			{long && (
				<button
					type="button"
					onClick={() => setAll((v) => !v)}
					className="no-print text-sm text-accent hover:underline"
				>
					{all ? "Show less" : "Show all"}
				</button>
			)}
		</span>
	);
}

/** Tables, figures and algorithms: shown as the printed page region, never re-typeset or redrawn. */
function Tables({ node, ctx }: { node: Node; ctx: Ctx }) {
	const figs = node.figures ?? [];
	if (!figs.length) return null;
	return (
		<div className="mt-3 grid gap-5 px-3">
			{figs.map((f, i) => {
				const crop = f.bbox ? f.bbox.map((v) => Math.round(v)).join(",") : "";
				const on = !!f.caption && ctx.active === f.caption;
				if (!f.raster && f.bbox && f.structure?.table)
					return (
						<figure
							key={`${f.page}-${crop}-${i}`}
							data-anchor={f.caption ? lineKey(f.caption) : undefined}
							className="m-0 min-w-0"
						>
							<FigureTable
								figure={f}
								cropSrc={`/internal/page/${ctx.sha}/${f.page}?crop=${crop}`}
								active={ctx.active}
								onCell={(a) => ctx.show(a, f.page, node.id)}
							/>
						</figure>
					);
				return (
					<figure
						key={`${f.page}-${crop}-${i}`}
						data-anchor={f.caption ? lineKey(f.caption) : undefined}
						className="m-0 rounded-md"
					>
						<button
							type="button"
							onClick={() => ctx.show(f.caption, f.page, node.id)}
							title={`Show page ${f.page}`}
							className={`block w-full overflow-hidden rounded-md border bg-white p-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${on ? "border-ink" : "border-line hover:border-accent"}`}
						>
							{/* biome-ignore lint: rendered page region */}
							<img
								src={`/internal/page/${ctx.sha}/${f.page}${crop ? `?crop=${crop}` : ""}`}
								alt={
									f.caption?.text.slice(0, 120) ??
									`As printed on page ${f.page}`
								}
								loading="lazy"
								className="mx-auto block w-full"
							/>
						</button>
						<figcaption className="mt-1 font-mono text-[13px] text-muted">
							As printed on p. {f.page}
						</figcaption>
					</figure>
				);
			})}
		</div>
	);
}

function Rules({ rules, hospital }: { rules?: Rule[]; hospital: string }) {
	if (!rules?.length) return null;
	return (
		<div className="my-3 grid gap-2">
			{rules.map((r) => (
				<div
					key={r.id}
					className="rounded-lg border-2 border-local/40 bg-local-soft px-4 py-3"
				>
					<p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-local">
						<Building2 size={15} aria-hidden /> {hospital} local rule, not
						protocol text
						{r.state !== "active" ? (
							<span className="rounded bg-warn-soft px-1.5 text-warn">
								{r.state === "reconfirm"
									? "Re-confirm: protocol text changed"
									: "Orphaned"}
							</span>
						) : null}
					</p>
					<p className="mt-1 text-[17px]">{r.text}</p>
					<p className="mt-1 text-[13px] text-local/80">
						{r.author}, {r.createdAt.slice(0, 10)}
						{r.source ? `, ${r.source.title}` : ""}
					</p>
				</div>
			))}
		</div>
	);
}

function OrphanRules({
	rules,
	byId,
	hospital,
}: {
	rules: Rule[];
	byId: Map<string, Node>;
	hospital: string;
}) {
	const orphans = rules.filter((r) => !byId.has(r.nodeId));
	if (!orphans.length) return null;
	return (
		<section className="mb-14">
			<h2 className="mb-3 text-lg font-semibold text-local">
				{hospital} rules whose protocol section moved
			</h2>
			<Rules rules={orphans} hospital={hospital} />
		</section>
	);
}

function Outline({ spec, go }: { spec: Spec; go: (t: Target) => void }) {
	const [open, setOpen] = useState(false);
	return (
		<section className="no-print border-t border-line pt-4">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1 text-sm text-muted hover:text-accent"
			>
				<ChevronRight
					size={14}
					className={`transition-transform ${open ? "rotate-90" : ""}`}
				/>{" "}
				Full protocol outline ({spec.nodes.length} sections)
			</button>
			{open && (
				<div className="mt-2 columns-2 gap-6">
					{spec.nodes.map((n) => (
						<button
							key={n.id}
							type="button"
							onClick={() => go({ nodeId: n.id })}
							title={n.title}
							style={{
								paddingLeft: Math.min(n.headingPath.length, 5) * 10,
							}}
							className="block w-full truncate py-0.5 text-left text-[13px] text-muted hover:text-ink"
						>
							{n.title}
						</button>
					))}
				</div>
			)}
		</section>
	);
}

function PageImage({
	sha,
	page,
	anchor,
}: {
	sha: string;
	page: number;
	anchor?: Anchor;
}) {
	const b = anchor
		? anchor.bbox.map((x) => x.map((v) => Math.round(v)).join(",")).join(";")
		: "";
	const src = `/internal/page/${sha}/${page}${b ? `?b=${b}` : ""}`;
	const [loaded, setLoaded] = useState<string | null>(null);
	return (
		<div className="relative mx-auto max-w-[820px]">
			{/* biome-ignore lint: rendered page */}
			<img
				key={src}
				src={src}
				alt={`Protocol page ${page}`}
				onLoad={() => setLoaded(src)}
				className={`w-full rounded bg-white shadow-sm transition-opacity ${loaded === src ? "opacity-100" : "opacity-40"}`}
			/>
		</div>
	);
}

/**
 * Treatment steps in the contents list, grouped by the arm or phase they belong to. Big multi-arm
 * protocols (ALLTogether1: 60+ steps) only open the group the reader is in.
 */
function StepToc({
	steps,
	byId,
	spy,
	status,
	dim,
	arms,
}: {
	steps: Node[];
	byId: Map<string, Node>;
	/** Arm names (the induction trunk under a generic parent reads "Induction"). */
	arms?: Arm[];
	spy: string | null;
	status?: (id: string) => "done" | "current" | undefined;
	/** Steps off the chosen risk-group path. */
	dim?: (id: string) => boolean;
}) {
	const groups: { key: string; label: string; steps: Node[] }[] = [];
	for (const s of steps) {
		const key = s.parent ?? "";
		const last = groups.at(-1);
		if (last && last.key === key) last.steps.push(s);
		else
			groups.push({
				key,
				label:
					arms?.find((a) => a.key === key)?.label ?? byId.get(key)?.title ?? "",
				steps: [s],
			});
	}
	const [open, setOpen] = useState<Set<string>>(new Set());
	const link = (s: Node) => (
		<li key={s.id}>
			<a
				href={`#n-${s.id}`}
				data-toc={s.id}
				title={s.title}
				className={`line-clamp-2 rounded px-2 py-0.5 text-sm leading-snug transition-colors ${status?.(s.id) === "current" ? "bg-accent font-medium text-white" : spy === s.id ? "bg-accent-soft font-medium text-accent" : status?.(s.id) === "done" ? "text-go hover:bg-surface" : dim?.(s.id) ? "text-muted hover:bg-surface hover:text-ink" : "text-ink/80 hover:bg-surface hover:text-ink"}`}
			>
				{status?.(s.id) === "done" && (
					<Check
						size={13}
						strokeWidth={3}
						aria-label="completed"
						className="mr-1 inline"
					/>
				)}
				{s.title}
			</a>
		</li>
	);
	if (groups.length < 3)
		return (
			<ol className="mt-0.5 ml-2 border-l border-line pl-1">{steps.map(link)}</ol>
		);
	return (
		<div className="mt-0.5 ml-2 grid gap-0.5">
			{groups.map((g) => {
				const here = g.steps.some((s) => s.id === spy);
				const expanded = here || open.has(g.key);
				return (
					<div key={g.key + g.steps[0].id}>
						<button
							type="button"
							onClick={() =>
								setOpen(
									(o) =>
										new Set(
											o.has(g.key)
												? [...o].filter((k) => k !== g.key)
												: [...o, g.key],
										),
								)
							}
							className={`flex w-full items-start gap-1 rounded px-2 py-0.5 text-left text-sm leading-snug ${here ? "font-medium text-accent" : "text-ink hover:bg-surface"}`}
						>
							<span className="mt-0.5 text-xs text-muted">
								{expanded ? "▾" : "▸"}
							</span>
							<span className="line-clamp-2">
								{g.label.replace(/^[\d.]+\s*/, "") || "Treatment"}
							</span>
							<span className="ml-auto text-xs text-muted">
								{g.steps.length}
							</span>
						</button>
						{expanded && (
							<ol className="ml-3 border-l border-line pl-1">
								{g.steps.map(link)}
							</ol>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Consecutive steps on / off the chosen path. */
function runs(steps: Node[], onPath: (id: string) => boolean) {
	const out: { key: string; on: boolean; steps: { s: Node; i: number }[] }[] = [];
	steps.forEach((s, i) => {
		const on = onPath(s.id);
		const last = out.at(-1);
		if (last && last.on === on) last.steps.push({ s, i });
		else out.push({ key: s.id, on, steps: [{ s, i }] });
	});
	return out;
}

/** Risk-group chips: pick one group's treatment path, or all groups. */
function PathChips({
	paths,
	path,
	setPath,
}: {
	paths: RiskPath[];
	path: RiskPath | null;
	setPath: (id: string | null) => void;
}) {
	if (!paths.length) return null;
	const chip = (on: boolean) =>
		`rounded-full border px-3 py-1 text-[13px] transition-colors ${on ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink/85 hover:border-accent hover:text-accent"}`;
	return (
		<div className="no-print mb-6 rounded-lg border border-line bg-surface px-4 py-3">
			<p className="mb-2 text-sm font-medium">Treatment path for</p>
			<div className="flex flex-wrap items-center gap-1.5">
				{paths.map((p) => {
					const rule = p.segments.find((g) => g.entry)?.entry?.evidence;
					return (
						<button
							key={p.id}
							type="button"
							aria-pressed={path?.id === p.id}
							onClick={() => setPath(path?.id === p.id ? null : p.id)}
							title={`${p.title}${rule ? `\n\n"${rule.text.replace(/\s+/g, " ").trim()}" (p. ${rule.page})` : ""}`}
							className={chip(path?.id === p.id)}
						>
							{p.label}
						</button>
					);
				})}
				<button
					type="button"
					aria-pressed={!path}
					onClick={() => setPath(null)}
					className={`ml-1 ${chip(!path)}`}
				>
					All groups
				</button>
			</div>
		</div>
	);
}

/** One-line note under a checklist item: Enter (or leaving the field) saves, Esc cancels. */
function NoteInput({
	value,
	onSave,
	onCancel,
}: {
	value: string;
	onSave: (v: string) => void;
	onCancel: () => void;
}) {
	const cancelled = useRef(false);
	return (
		<div className="basis-full pl-[3.75rem]">
			<input
				autoFocus
				defaultValue={value}
				maxLength={140}
				placeholder="Short note, e.g. done 12/10, normal. Enter saves, Esc cancels"
				aria-label="Note on this line"
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						cancelled.current = true;
						onSave(e.currentTarget.value);
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						cancelled.current = true;
						onCancel();
					}
				}}
				onBlur={(e) => {
					if (!cancelled.current) onSave(e.currentTarget.value);
				}}
				className="w-full max-w-xl rounded border border-line bg-surface px-2 py-1 text-sm text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent"
			/>
		</div>
	);
}
