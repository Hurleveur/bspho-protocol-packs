"use client";

import type { ProtocolEntry, VersionEntry } from "@bspho/protocol/store";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BuildReport } from "@/lib/admin";
import { formatVersion } from "@/lib/format";
import { errorText, send, when } from "./api";
import { BuildReportView, NotesBadge } from "./build-notes";
import { Changes } from "./changes";
import { type Flash, Toast } from "./toast";
import type { UploadResult } from "./types";

type Diff = NonNullable<UploadResult["diff"]>;

const BADGE: Record<VersionEntry["state"], [string, string]> = {
	published: ["Doctors see this", "bg-go-soft text-go"],
	draft: ["Waiting for review", "bg-mark/60 text-ink"],
	superseded: ["Earlier version", "bg-paper text-faint"],
};

const field = "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink";

function Details({
	p,
	protocols,
	familyLabels,
	onFlash,
}: {
	p: ProtocolEntry;
	protocols: ProtocolEntry[];
	familyLabels: Record<string, string>;
	onFlash: (f: Flash) => void;
}) {
	const router = useRouter();
	const [short, setShort] = useState(p.short);
	const [family, setFamily] = useState(p.family);
	const [parentId, setParentId] = useState(
		p.kind === "subprotocol" ? (p.parentId ?? "") : "",
	);
	const [saving, setSaving] = useState(false);
	const dirty =
		short !== p.short ||
		family !== p.family ||
		parentId !== (p.kind === "subprotocol" ? (p.parentId ?? "") : "");
	const masters = protocols
		.filter((x) => x.kind === "protocol" && x.id !== p.id)
		.sort((a, b) => a.short.localeCompare(b.short));
	const hasSubs = protocols.some(
		(x) => x.kind === "subprotocol" && x.parentId === p.id,
	);

	async function save() {
		setSaving(true);
		try {
			await send("/internal/admin/protocol", "POST", {
				protocolId: p.id,
				short,
				family,
				parentId: parentId || null,
			});
			onFlash({ text: `Saved the details of ${short}.`, error: false });
			router.refresh();
		} catch (e) {
			onFlash({ text: `Not saved: ${errorText(e)}`, error: true });
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
			<label className="grid gap-1 text-sm">
				<span className="text-muted">Short name doctors see</span>
				<input
					value={short}
					maxLength={60}
					onChange={(e) => setShort(e.target.value)}
					className={field}
				/>
			</label>
			<label className="grid gap-1 text-sm">
				<span className="text-muted">Disease group</span>
				<select
					value={family}
					onChange={(e) =>
						setFamily(e.target.value as ProtocolEntry["family"])
					}
					className={field}
				>
					{Object.entries(familyLabels).map(([f, label]) => (
						<option key={f} value={f}>
							{label}
						</option>
					))}
				</select>
			</label>
			{p.kind === "local" ? (
				<p className="text-sm text-muted">Local document of {p.parentId}</p>
			) : (
				<label className="grid gap-1 text-sm">
					<span className="text-muted">Part of</span>
					<select
						value={parentId}
						disabled={hasSubs}
						onChange={(e) => setParentId(e.target.value)}
						className={field}
					>
						<option value="">Nothing: a protocol of its own</option>
						{masters.map((m) => (
							<option key={m.id} value={m.id}>
								Sub-protocol of {m.short}
							</option>
						))}
					</select>
				</label>
			)}
			<button
				type="button"
				disabled={!dirty || saving || !short.trim()}
				onClick={() => void save()}
				className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
			>
				{saving ? "Saving…" : "Save details"}
			</button>
		</div>
	);
}

function Versions({ p, onFlash }: { p: ProtocolEntry; onFlash: (f: Flash) => void }) {
	const router = useRouter();
	const current = p.versions.find((v) => v.sha256 === p.published);
	const [diff, setDiff] = useState<{ sha: string; data: Diff | null } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	async function compare(v: VersionEntry) {
		if (!current) return;
		if (diff?.sha === v.sha256) return setDiff(null);
		setDiff({ sha: v.sha256, data: null });
		try {
			const res = await fetch(
				`/internal/admin/diff?protocolId=${p.id}&from=${v.sha256}&to=${current.sha256}`,
			);
			const j = (await res.json()) as Diff & { error?: string };
			if (!res.ok) throw new Error(j.error ?? "Could not compare");
			setDiff({ sha: v.sha256, data: j });
		} catch (e) {
			setDiff(null);
			onFlash({ text: errorText(e), error: true });
		}
	}

	async function restore(v: VersionEntry) {
		const what =
			v.state === "draft"
				? `Publish ${formatVersion(v.version)}`
				: `Go back to ${formatVersion(v.version)}`;
		if (
			!confirm(
				`${what} of ${p.short}? Doctors will see it straight away. ${current ? `${formatVersion(current.version)} stays in the list and can be restored again.` : ""}`,
			)
		)
			return;
		setBusy(v.sha256);
		try {
			await send("/internal/admin/version", "POST", {
				protocolId: p.id,
				sha256: v.sha256,
				action: "publish",
			});
			onFlash({
				text: `Doctors now see ${p.short} ${formatVersion(v.version)}.`,
				error: false,
			});
			router.refresh();
		} catch (e) {
			onFlash({ text: `Not saved: ${errorText(e)}`, error: true });
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="grid gap-3">
			<ul className="divide-y divide-line rounded-md border border-line bg-surface">
				{[...p.versions].reverse().map((v) => {
					const [label, cls] = BADGE[v.state];
					return (
						<li
							key={v.sha256}
							className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
						>
							<span
								className={`w-36 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${cls}`}
							>
								{label}
							</span>
							<span className="w-40 shrink-0 font-mono text-xs">
								{formatVersion(v.version)}
							</span>
							<span
								className="min-w-0 flex-1 truncate text-xs text-faint"
								title={v.fileName}
							>
								{v.fileName} · uploaded {when(v.uploadedAt)}
							</span>
							{v.state !== "published" && current && (
								<button
									type="button"
									onClick={() => void compare(v)}
									className="text-xs font-medium text-accent hover:underline"
								>
									{diff?.sha === v.sha256
										? "Hide changes"
										: "Compare with the current version"}
								</button>
							)}
							{v.state !== "published" && (
								<button
									type="button"
									disabled={busy === v.sha256}
									onClick={() => void restore(v)}
									className="rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:border-accent disabled:opacity-60"
								>
									{busy === v.sha256
										? "Saving…"
										: v.state === "draft"
											? "Publish"
											: "Go back to this version"}
								</button>
							)}
						</li>
					);
				})}
			</ul>
			{diff &&
				(diff.data ? (
					<Changes diff={diff.data} />
				) : (
					<p className="text-sm text-muted">Comparing…</p>
				))}
		</div>
	);
}

function Row({
	p,
	protocols,
	reports,
	usedBy,
	familyLabels,
	sub,
	onFlash,
}: {
	p: ProtocolEntry;
	protocols: ProtocolEntry[];
	reports: Record<string, BuildReport>;
	usedBy: number;
	familyLabels: Record<string, string>;
	sub: boolean;
	onFlash: (f: Flash) => void;
}) {
	const [open, setOpen] = useState(false);
	const current = p.versions.find((v) => v.sha256 === p.published);
	const shown = current ?? p.versions.at(-1);
	const report = shown ? reports[shown.sha256] : undefined;
	const waiting = p.versions.filter((v) => v.state === "draft").length;
	return (
		<li className="border-t border-line first:border-t-0">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className={`grid w-full grid-cols-[1.25rem_minmax(0,2fr)_minmax(0,1.2fr)_8rem_9rem] items-center gap-3 py-3 pr-5 text-left hover:bg-paper/50 ${sub ? "pl-10" : "pl-4"} ${open ? "bg-paper/50" : ""}`}
			>
				{open ? (
					<ChevronDownIcon className="size-4 text-faint" />
				) : (
					<ChevronRightIcon className="size-4 text-faint" />
				)}
				<span className="min-w-0">
					<span className={sub ? "text-muted" : "font-semibold"}>
						{sub ? "↳ " : ""}
						{p.short}
					</span>
					<span className="ml-2 text-xs text-faint">
						{familyLabels[p.family]}
						{p.kind === "local" ? " · local document" : ""}
					</span>
					<span className="block truncate text-xs text-muted">{p.title}</span>
				</span>
				<span className="text-sm">
					{current ? (
						formatVersion(current.version)
					) : (
						<span className="text-warn">Not published yet</span>
					)}
					{waiting > 0 && (
						<span className="ml-2 rounded bg-mark/60 px-1.5 py-0.5 text-[11px]">
							{waiting} waiting
						</span>
					)}
				</span>
				<span className={`text-sm ${usedBy ? "text-muted" : "text-warn"}`}>
					{usedBy
						? `${usedBy} ${usedBy === 1 ? "hospital" : "hospitals"}`
						: "No hospital"}
				</span>
				<span className="justify-self-end">
					<NotesBadge report={report} />
				</span>
			</button>
			{open && (
				<div className="grid gap-5 border-t border-line bg-paper/50 py-4 pr-5 pl-12">
					<section>
						<h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
							Details
						</h4>
						<Details
							p={p}
							protocols={protocols}
							familyLabels={familyLabels}
							onFlash={onFlash}
						/>
					</section>
					<section>
						<h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
							Versions
						</h4>
						<Versions p={p} onFlash={onFlash} />
					</section>
					{report && shown && (
						<section>
							<h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
								How {formatVersion(shown.version)} was read
							</h4>
							<BuildReportView report={report} />
						</section>
					)}
					<Link
						href={`/p/${p.id}`}
						className="text-sm font-medium text-accent hover:underline"
					>
						Open {p.short} as doctors see it
					</Link>
				</div>
			)}
		</li>
	);
}

export function ProtocolTable({
	protocols,
	reports,
	usedBy,
	familyLabels,
}: {
	protocols: ProtocolEntry[];
	reports: Record<string, BuildReport>;
	usedBy: Record<string, number>;
	familyLabels: Record<string, string>;
}) {
	const [query, setQuery] = useState("");
	const [flash, setFlash] = useState<Flash>(null);
	if (!protocols.length)
		return (
			<p className="text-muted">
				No protocols yet. Upload the first one in the Upload tab.
			</p>
		);
	const byName = (a: ProtocolEntry, b: ProtocolEntry) =>
		a.short.localeCompare(b.short, "en", { sensitivity: "base" });
	const isTop = (p: ProtocolEntry) =>
		p.kind !== "subprotocol" || !protocols.some((m) => m.id === p.parentId);
	const q = query.trim().toLowerCase();
	const match = (p: ProtocolEntry) =>
		!q || p.short.toLowerCase().includes(q) || p.title.toLowerCase().includes(q);
	const rows = protocols
		.filter(isTop)
		.sort(byName)
		.flatMap((m) => [
			{ p: m, sub: false },
			...protocols
				.filter((s) => s.kind === "subprotocol" && s.parentId === m.id)
				.sort(byName)
				.map((s) => ({ p: s, sub: true })),
		])
		.filter((r) => match(r.p));

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-3xl text-sm text-muted">
					Every protocol, the version doctors see, and how well the PDF was
					read. Open a row to rename it, go back to an earlier version, or
					compare versions.
				</p>
				<label className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5">
					<SearchIcon className="size-4 text-faint" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Find a protocol"
						className="w-44 bg-transparent text-sm outline-none placeholder:text-faint"
					/>
				</label>
			</div>
			<div className="overflow-hidden rounded-lg border border-line bg-surface">
				<div className="grid grid-cols-[1.25rem_minmax(0,2fr)_minmax(0,1.2fr)_8rem_9rem] gap-3 border-b border-line bg-paper/70 py-2 pr-5 pl-4 text-xs font-medium text-muted">
					<span />
					<span>Protocol</span>
					<span>Version doctors see</span>
					<span>Used by</span>
					<span className="justify-self-end">Reading quality</span>
				</div>
				<ul>
					{rows.map(({ p, sub }) => (
						<Row
							key={p.id}
							p={p}
							sub={sub}
							protocols={protocols}
							reports={reports}
							usedBy={usedBy[p.id] ?? 0}
							familyLabels={familyLabels}
							onFlash={setFlash}
						/>
					))}
				</ul>
				{!rows.length && (
					<p className="px-5 py-6 text-sm text-muted">
						No protocol matches "{query}".
					</p>
				)}
			</div>
			<Toast flash={flash} onDone={() => setFlash(null)} />
		</div>
	);
}
