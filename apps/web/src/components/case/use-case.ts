"use client";

import type { Node, ProtocolSpec, Treatment } from "@bspho/protocol/spec";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CaseState,
	decodeCase,
	encodeCase,
	lineKey,
	requirementLines,
} from "@/lib/case";

export type CaseUi = "start" | "paste" | "summary" | null;

export interface CaseApi {
	state: CaseState | null;
	code: string | null;
	/** Shareable link: the code rides in the URL fragment, which browsers never send to the server. */
	link: string | null;
	/** The case's version is not the one on screen. */
	stale: { sha8: string; version?: string } | null;
	dropped: number;
	ui: CaseUi;
	setUi: (u: CaseUi) => void;
	byId: Map<string, Node>;
	/** The spec's arms and risk groups: a case's arm id can name one of them. */
	treatment?: Treatment;
	status: (stepId: string) => "done" | "current" | undefined;
	reqKeys: string[];
	begin: (arm: string, why: number[], step: string | undefined) => void;
	end: () => void;
	restore: (raw: string) => string | null;
	update: (fn: (c: CaseState) => CaseState) => void;
	/** Move to another step: marks the current one done, clears ticks of the new step. */
	moveTo: (to: string | undefined, opts?: { fork?: boolean; arm?: string }) => void;
}

const SESSION = (p: string) => `case:${p}`;

export function useCase(opts: {
	spec: ProtocolSpec;
	protocolId: string;
	versions: { sha256: string; version: string }[];
	checks: Set<string>;
	setChecks: (s: Set<string>) => void;
}): CaseApi {
	const { spec, protocolId, checks, setChecks } = opts;
	const byId = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec]);
	const sha8 = spec.doc.sha256.slice(0, 8);
	const [state, setState] = useState<CaseState | null>(null);
	const [dropped, setDropped] = useState(0);
	const [ui, setUi] = useState<CaseUi>(null);

	const cur = state?.cur;
	const reqLines = useMemo(
		() => (cur ? requirementLines(cur, spec.nodes) : []),
		[cur, spec],
	);
	const reqKeys = useMemo(() => reqLines.map(lineKey), [reqLines]);

	// Requirement ticks are the sheet's own checkboxes: the case reads them for its current step.
	const full = useMemo<CaseState | null>(
		() =>
			state
				? {
						...state,
						req: reqKeys.flatMap((k, i) => (checks.has(k) ? [i] : [])),
					}
				: null,
		[state, reqKeys, checks],
	);
	const code = full ? encodeCase(full) : null;
	const link =
		code && typeof window !== "undefined"
			? `${window.location.origin}/p/${protocolId}#case=${code}`
			: null;

	const apply = useCallback(
		(raw: string): string | null => {
			const r = decodeCase(raw, spec.nodes, spec.treatment);
			if ("error" in r) return r.error;
			if (r.state.protocolId !== protocolId)
				return `This case code is for another protocol (${r.state.protocolId}). Open it from that protocol's page.`;
			setState(r.state);
			setDropped(r.dropped);
			// Put the code's requirement ticks back on the sheet.
			if (r.state.cur) {
				const keys = requirementLines(r.state.cur, spec.nodes).map(lineKey);
				const next = new Set([...checks].filter((k) => !keys.includes(k)));
				for (const i of r.state.req) if (keys[i]) next.add(keys[i]);
				setChecks(next);
			}
			return null;
		},
		[spec, protocolId, checks, setChecks],
	);

	// Restore once: #case=… (or ?case=…, moved into the fragment), else this tab's last case.
	const [booted, setBooted] = useState(false);
	const once = useRef(false);
	useEffect(() => {
		if (once.current) return;
		once.current = true;
		setBooted(true);
		const url = new URL(window.location.href);
		const fromHash = /case=([^&]+)/.exec(url.hash)?.[1];
		const fromQuery = url.searchParams.get("case");
		let raw = fromHash ?? fromQuery ?? null;
		if (fromQuery) {
			url.searchParams.delete("case");
			// Keep the entry's remembered place (jump-history.tsx).
			window.history.replaceState(
				{ bspho: window.history.state?.bspho },
				"",
				url,
			);
		}
		if (!raw)
			try {
				raw = sessionStorage.getItem(SESSION(protocolId));
			} catch {}
		if (raw) apply(decodeURIComponent(raw));
	}, [apply, protocolId]);

	// Keep the fragment and this tab's copy in step with the case.
	useEffect(() => {
		if (!booted) return;
		const url = new URL(window.location.href);
		const hash = url.hash.replace(/(^#|&)case=[^&]*/, "").replace(/^#?&?/, "");
		url.hash = code ? `case=${code}${hash ? `&${hash}` : ""}` : hash;
		// Keep the entry's remembered place (jump-history.tsx).
		window.history.replaceState({ bspho: window.history.state?.bspho }, "", url);
		try {
			if (code) sessionStorage.setItem(SESSION(protocolId), code);
			else sessionStorage.removeItem(SESSION(protocolId));
		} catch {}
	}, [code, booted, protocolId]);

	const stale =
		state && state.sha8 !== sha8
			? {
					sha8: state.sha8,
					version: opts.versions.find((v) => v.sha256.startsWith(state.sha8))
						?.version,
				}
			: null;

	const clearTicks = (stepId?: string) => {
		if (!stepId) return;
		const keys = requirementLines(stepId, spec.nodes).map(lineKey);
		setChecks(new Set([...checks].filter((k) => !keys.includes(k))));
	};

	return {
		state: full,
		code,
		link,
		stale,
		dropped,
		ui,
		setUi,
		byId,
		treatment: spec.treatment,
		reqKeys,
		status: (id) =>
			!full
				? undefined
				: full.cur === id
					? "current"
					: full.done.includes(id)
						? "done"
						: undefined,
		begin: (arm, why, step) => {
			clearTicks(step);
			setDropped(0);
			setState({
				protocolId,
				sha8,
				arm,
				why,
				done: [],
				cur: step,
				started: false,
				req: [],
				delays: [],
				forks: [],
				rulesAck: false,
			});
			setUi(null);
		},
		end: () => {
			setState(null);
			setUi(null);
		},
		restore: (raw) => {
			const err = apply(raw);
			if (!err) setUi(null);
			return err;
		},
		update: (fn) => setState((c) => (c ? fn(c) : c)),
		moveTo: (to, o) => {
			clearTicks(to);
			setState((c) =>
				c
					? {
							...c,
							done:
								c.cur && !c.done.includes(c.cur)
									? [...c.done, c.cur]
									: c.done,
							forks:
								o?.fork && c.cur && to
									? [...c.forks, { from: c.cur, to }]
									: c.forks,
							cur: to,
							started: false,
							rulesAck: false,
							...(o?.arm && o.arm !== c.arm
								? { arm: o.arm, why: [] }
								: {}),
						}
					: c,
			);
		},
	};
}
