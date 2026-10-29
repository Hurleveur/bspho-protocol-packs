"use client";

import type { HospitalStatus } from "@bspho/protocol/spec";
import type { ProtocolEntry } from "@bspho/protocol/store";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { Toast } from "./toast";
import { errorText, send, when } from "./api";

type Use = "none" | HospitalStatus;
type Cell = { use: Use; updatedBy?: string; updatedAt?: string };
type Part = {
	protocolId: string;
	hospital: string;
	participating: boolean;
	status: HospitalStatus;
	updatedBy: string;
	updatedAt: string;
};

const OPTIONS: { value: Use; label: string; cls: string; hint: string }[] = [
	{
		value: "live",
		label: "Live",
		cls: "bg-go-soft text-go border-go/30",
		hint: "Recruiting patients",
	},
	{
		value: "standard_of_care",
		label: "Standard of care",
		cls: "bg-accent-soft text-accent border-accent/30",
		hint: "Trial closed, protocol still the standard",
	},
	{
		value: "closed",
		label: "Closed",
		cls: "bg-line/60 text-muted border-line",
		hint: "No longer used for new patients",
	},
	{
		value: "unknown",
		label: "To fill in",
		cls: "bg-mark/40 text-ink border-mark",
		hint: "Used here, status not chosen yet",
	},
	{
		value: "none",
		label: "Not used",
		cls: "bg-surface text-faint border-transparent",
		hint: "Hidden from this hospital's shelf",
	},
];
const OPT = Object.fromEntries(OPTIONS.map((o) => [o.value, o])) as Record<
	Use,
	(typeof OPTIONS)[number]
>;
const key = (protocolId: string, hospital: string) => `${protocolId}|${hospital}`;

export function CoverageMatrix({
	protocols,
	hospitals,
	participation,
	familyLabels,
}: {
	protocols: ProtocolEntry[];
	hospitals: { id: string; name: string }[];
	participation: Part[];
	familyLabels: Record<string, string>;
}) {
	const [cells, setCells] = useState<Map<string, Cell>>(
		() =>
			new Map(
				participation.map((p) => [
					key(p.protocolId, p.hospital),
					{
						use: p.participating ? p.status : "none",
						updatedBy: p.updatedBy,
						updatedAt: p.updatedAt,
					},
				]),
			),
	);
	const [saving, setSaving] = useState<Set<string>>(new Set());
	const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
	const [query, setQuery] = useState("");
	const [onlyUnset, setOnlyUnset] = useState(false);

	const get = (p: string, h: string): Cell => cells.get(key(p, h)) ?? { use: "none" };

	// Families in catalogue order, masters alphabetically, each followed by its sub-protocols.
	const groups = useMemo(() => {
		const shown = protocols.filter((p) => p.kind !== "local");
		const subsOf = (id: string) =>
			shown
				.filter((s) => s.kind === "subprotocol" && s.parentId === id)
				.sort((a, b) => a.short.localeCompare(b.short));
		const masters = shown.filter(
			(p) => p.kind !== "subprotocol" || !shown.some((m) => m.id === p.parentId),
		);
		return Object.keys(familyLabels)
			.map((f) => ({
				family: f,
				rows: masters
					.filter((m) => m.family === f)
					.sort((a, b) =>
						a.short.localeCompare(b.short, "en", { sensitivity: "base" }),
					)
					.flatMap((m) => [
						{ p: m, sub: false },
						...subsOf(m.id).map((s) => ({ p: s, sub: true })),
					]),
			}))
			.filter((g) => g.rows.length);
	}, [protocols, familyLabels]);

	const q = query.trim().toLowerCase();
	const visible = (p: ProtocolEntry) =>
		(!q ||
			p.short.toLowerCase().includes(q) ||
			p.title.toLowerCase().includes(q)) &&
		(!onlyUnset || hospitals.some((h) => get(p.id, h.id).use === "unknown"));
	const unsetCount = [...cells.values()].filter((c) => c.use === "unknown").length;

	async function change(p: ProtocolEntry, h: { id: string; name: string }, use: Use) {
		const k = key(p.id, h.id);
		const before = get(p.id, h.id);
		setCells((m) =>
			new Map(m).set(k, {
				use,
				updatedBy: "admin",
				updatedAt: new Date().toISOString(),
			}),
		);
		setSaving((s) => new Set(s).add(k));
		try {
			await send("/internal/admin/participation", "POST", {
				protocolId: p.id,
				hospital: h.id,
				use,
			});
			setFlash({
				text: `Saved: ${p.short} at ${h.name} is now "${OPT[use].label}".`,
				error: false,
			});
		} catch (e) {
			setCells((m) => new Map(m).set(k, before));
			setFlash({ text: `Not saved: ${errorText(e)}`, error: true });
		} finally {
			setSaving((s) => {
				const n = new Set(s);
				n.delete(k);
				return n;
			});
		}
	}

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-3xl text-sm text-muted">
					Which protocols each hospital uses, and their status there. Change a
					cell and it is saved at once: doctors at that hospital see the
					change on their shelf straight away.
				</p>
				<div className="flex items-center gap-3">
					<label className="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							className="size-4 accent-[var(--accent)]"
							checked={onlyUnset}
							onChange={(e) => setOnlyUnset(e.target.checked)}
						/>
						Only rows with a status to fill in ({unsetCount})
					</label>
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
			</div>

			<ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
				{OPTIONS.map((o) => (
					<li key={o.value} className="flex items-center gap-1.5">
						<span
							className={`inline-block size-3 rounded-sm border ${o.cls}`}
						/>
						<strong className="font-medium text-ink">{o.label}</strong>{" "}
						{o.hint}
					</li>
				))}
			</ul>

			<div className="overflow-x-auto rounded-lg border border-line bg-surface">
				<table className="w-full border-collapse text-sm">
					<thead className="sticky top-0 z-10 bg-surface">
						<tr className="border-b border-line">
							<th className="px-4 py-2.5 text-left font-medium text-muted">
								Protocol
							</th>
							{hospitals.map((h) => (
								<th
									key={h.id}
									className="px-1.5 py-2.5 text-center font-medium"
									title={h.name}
								>
									<span className="block">{h.id}</span>
									<span className="block text-[11px] font-normal text-faint">
										{h.name}
									</span>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{groups.map((g) => {
							const rows = g.rows.filter((r) => visible(r.p));
							if (!rows.length) return null;
							return (
								<Fragment key={g.family}>
									<tr className="bg-paper/70">
										<th
											colSpan={hospitals.length + 1}
											className="px-4 py-1.5 text-left text-xs font-semibold tracking-wide text-muted uppercase"
										>
											{familyLabels[g.family]}
										</th>
									</tr>
									{rows.map(({ p, sub }) => (
										<tr
											key={p.id}
											className="border-t border-line/70 hover:bg-paper/40"
										>
											<th
												scope="row"
												className={`max-w-72 py-1.5 pr-3 text-left font-normal ${sub ? "pl-9" : "pl-4"}`}
											>
												<Link
													href={`/p/${p.id}`}
													className={`hover:text-accent ${sub ? "text-muted" : "font-medium"}`}
												>
													{sub ? "↳ " : ""}
													{p.short}
												</Link>
												{!p.published && (
													<span className="ml-2 text-[11px] text-warn">
														not published
													</span>
												)}
											</th>
											{hospitals.map((h) => {
												const c = get(p.id, h.id);
												const k = key(p.id, h.id);
												return (
													<td
														key={h.id}
														className="px-1.5 py-1"
													>
														<select
															aria-label={`${p.short} at ${h.name}`}
															title={
																c.updatedAt
																	? `Last changed ${when(c.updatedAt)} by ${c.updatedBy}`
																	: "Never set"
															}
															value={c.use}
															disabled={saving.has(k)}
															onChange={(e) =>
																void change(
																	p,
																	h,
																	e.target
																		.value as Use,
																)
															}
															className={`w-full min-w-28 cursor-pointer rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60 ${OPT[c.use].cls}`}
														>
															{OPTIONS.map((o) => (
																<option
																	key={o.value}
																	value={o.value}
																>
																	{o.label}
																</option>
															))}
														</select>
													</td>
												);
											})}
										</tr>
									))}
								</Fragment>
							);
						})}
					</tbody>
					<tfoot>
						<tr className="border-t border-line bg-paper/70 text-xs text-muted">
							<th className="px-4 py-2 text-left font-medium">
								Protocols in use
							</th>
							{hospitals.map((h) => (
								<td
									key={h.id}
									className="px-1.5 py-2 text-center tabular-nums"
								>
									{
										protocols.filter(
											(p) => get(p.id, h.id).use !== "none",
										).length
									}
								</td>
							))}
						</tr>
					</tfoot>
				</table>
			</div>
			<Toast flash={flash} onDone={() => setFlash(null)} />
		</div>
	);
}
