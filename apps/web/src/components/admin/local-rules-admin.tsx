"use client";

import type { ProtocolEntry } from "@bspho/protocol/store";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AdminRule } from "@/lib/admin";
import { errorText, send, when } from "./api";
import { concern } from "./rule-check";
import { type Flash, Toast } from "./toast";

function Rule({
	r,
	p,
	hospital,
	onFlash,
}: {
	r: AdminRule;
	p: ProtocolEntry | undefined;
	hospital: string;
	onFlash: (f: Flash) => void;
}) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(r.text);
	const [busy, setBusy] = useState(false);
	const why = concern(r, p);

	async function run(label: string, fn: () => Promise<unknown>) {
		setBusy(true);
		try {
			await fn();
			onFlash({ text: label, error: false });
			setEditing(false);
			router.refresh();
		} catch (e) {
			onFlash({ text: `Not saved: ${errorText(e)}`, error: true });
		} finally {
			setBusy(false);
		}
	}

	return (
		<li
			className={`rounded-lg border bg-surface p-4 ${why ? "border-warn/40" : "border-line"}`}
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<p className="text-sm">
					<Link
						href={`/p/${r.protocolId}`}
						className="font-semibold hover:text-accent"
					>
						{p?.short ?? r.protocolId}
					</Link>
					<span className="text-muted"> › {r.nodeTitle ?? "a section"}</span>
				</p>
				<p className="text-xs text-faint">
					{r.author} · {when(r.createdAt)}
					{r.source ? ` · from ${r.source.title}` : ""}
				</p>
			</div>
			{why && (
				<p className="mt-2 rounded-md bg-warn-soft px-3 py-1.5 text-sm text-warn">
					{why}
				</p>
			)}
			{editing ? (
				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={4}
					className="mt-3 w-full rounded-md border border-local/40 bg-local-soft/40 px-3 py-2 text-sm"
				/>
			) : (
				<p className="mt-3 border-l-2 border-local/60 bg-local-soft/50 py-1.5 pl-3 text-sm whitespace-pre-line">
					{r.text}
				</p>
			)}
			<div className="mt-3 flex flex-wrap gap-2 text-sm">
				{editing ? (
					<>
						<button
							type="button"
							disabled={busy || text.trim().length < 3}
							onClick={() =>
								void run("Rule saved.", () =>
									send("/internal/admin/local-rules", "PATCH", {
										id: r.id,
										text,
									}),
								)
							}
							className="rounded-md bg-local px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => (setEditing(false), setText(r.text))}
							className="px-3 py-1.5 text-muted hover:text-ink"
						>
							Cancel
						</button>
					</>
				) : (
					<>
						{why && r.state !== "orphaned" && (
							<button
								type="button"
								disabled={busy}
								onClick={() =>
									void run("Marked as still correct.", () =>
										send("/internal/admin/local-rules", "PATCH", {
											id: r.id,
											confirm: true,
										}),
									)
								}
								className="rounded-md bg-local px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
							>
								Still correct
							</button>
						)}
						<button
							type="button"
							onClick={() => setEditing(true)}
							className="rounded-md border border-line px-3 py-1.5 hover:border-local"
						>
							Edit text
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (
									confirm(
										`Remove this ${hospital} rule from ${p?.short ?? r.protocolId}? Doctors stop seeing it.`,
									)
								)
									void run("Rule removed.", () =>
										send("/internal/admin/local-rules", "DELETE", {
											id: r.id,
										}),
									);
							}}
							className="px-3 py-1.5 text-muted hover:text-warn"
						>
							Remove
						</button>
					</>
				)}
			</div>
		</li>
	);
}

export function LocalRulesAdmin({
	rules,
	protocols,
	hospitals,
}: {
	rules: AdminRule[];
	protocols: ProtocolEntry[];
	hospitals: { id: string; name: string }[];
}) {
	const [hospital, setHospital] = useState("all");
	const [flash, setFlash] = useState<Flash>(null);
	const byId = new Map(protocols.map((p) => [p.id, p]));
	const shown = rules
		.filter((r) => hospital === "all" || r.hospital === hospital)
		.sort(
			(a, b) =>
				Number(!!concern(b, byId.get(b.protocolId))) -
					Number(!!concern(a, byId.get(a.protocolId))) ||
				b.createdAt.localeCompare(a.createdAt),
		);

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-3xl text-sm text-muted">
					Hospital-specific instructions shown under a protocol section, in
					purple, only to that hospital. To add one, open the protocol and use
					"+ local rule" on the section.
				</p>
				<label className="flex items-center gap-2 text-sm text-muted">
					Hospital
					<select
						value={hospital}
						onChange={(e) => setHospital(e.target.value)}
						className="rounded-md border border-line bg-surface px-2 py-1.5 text-ink"
					>
						<option value="all">All hospitals ({rules.length})</option>
						{hospitals.map((h) => (
							<option key={h.id} value={h.id}>
								{h.name} (
								{rules.filter((r) => r.hospital === h.id).length})
							</option>
						))}
					</select>
				</label>
			</div>
			{shown.length ? (
				hospitals
					.filter((h) => shown.some((r) => r.hospital === h.id))
					.map((h) => (
						<section key={h.id}>
							<h3 className="mb-2 text-sm font-semibold">{h.name}</h3>
							<ul className="grid gap-3">
								{shown
									.filter((r) => r.hospital === h.id)
									.map((r) => (
										<Rule
											key={r.id}
											r={r}
											p={byId.get(r.protocolId)}
											hospital={h.name}
											onFlash={setFlash}
										/>
									))}
							</ul>
						</section>
					))
			) : (
				<div className="rounded-lg border border-dashed border-line px-6 py-12 text-center text-sm text-muted">
					No local rules {hospital === "all" ? "yet" : "for this hospital"}.
					They are added from a protocol page, on the section they apply to.
				</div>
			)}
			<Toast flash={flash} onDone={() => setFlash(null)} />
		</div>
	);
}
