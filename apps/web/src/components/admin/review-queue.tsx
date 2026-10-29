"use client";

import type { ProtocolEntry, VersionEntry } from "@bspho/protocol/store";
import { CircleCheckIcon, InboxIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BuildReport } from "@/lib/admin";
import { formatVersion } from "@/lib/format";
import { errorText, send, when } from "./api";
import { BuildReportView, NotesBadge } from "./build-notes";
import { Changes } from "./changes";
import type { UploadResult } from "./types";

type Diff = NonNullable<UploadResult["diff"]>;

function Draft({
	p,
	v,
	report,
}: {
	p: ProtocolEntry;
	v: VersionEntry;
	report: BuildReport | undefined;
}) {
	const router = useRouter();
	const sha = v.sha256;
	const current = p.versions.find((x) => x.sha256 === p.published);
	const [open, setOpen] = useState(false);
	const [diff, setDiff] = useState<Diff | "loading" | null>(null);
	const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function toggle() {
		setOpen(!open);
		if (open || diff || !current) return;
		setDiff("loading");
		try {
			const res = await fetch(
				`/internal/admin/diff?protocolId=${p.id}&from=${current.sha256}&to=${sha}`,
			);
			const j = (await res.json()) as Diff & { error?: string };
			if (!res.ok) throw new Error(j.error ?? "Could not compare");
			setDiff(j);
		} catch (e) {
			setDiff(null);
			setError(errorText(e));
		}
	}

	async function act(action: "publish" | "discard") {
		if (
			action === "discard" &&
			!confirm(
				`Discard this upload of ${p.short}? Doctors keep seeing ${current ? formatVersion(current.version) : "nothing"}.`,
			)
		)
			return;
		setBusy(action);
		setError(null);
		try {
			await send("/internal/admin/version", "POST", {
				protocolId: p.id,
				sha256: sha,
				action,
			});
			router.refresh();
		} catch (e) {
			setError(errorText(e));
			setBusy(null);
		}
	}

	return (
		<li className="rounded-lg border border-line bg-surface">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
				<div className="min-w-0 flex-1">
					<p className="font-semibold">
						{p.short}{" "}
						<span className="font-normal text-muted">
							{formatVersion(v.version)}
						</span>
						{!current && (
							<span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
								New protocol
							</span>
						)}
					</p>
					<p className="truncate text-sm text-muted">
						{v.fileName} · uploaded {when(v.uploadedAt)}
						{current
							? ` · doctors see ${formatVersion(current.version)} today`
							: " · not yet visible to doctors"}
					</p>
				</div>
				<NotesBadge report={report} />
				<button
					type="button"
					onClick={() => void toggle()}
					className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent"
				>
					{open ? "Hide details" : current ? "Review changes" : "Review"}
				</button>
				<button
					type="button"
					disabled={!!busy}
					onClick={() => void act("publish")}
					className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
				>
					{busy === "publish" ? "Publishing…" : "Publish"}
				</button>
				<button
					type="button"
					disabled={!!busy}
					onClick={() => void act("discard")}
					className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-warn disabled:opacity-60"
				>
					{busy === "discard" ? "Discarding…" : "Discard"}
				</button>
			</div>
			{error && <p className="px-5 pb-3 text-sm text-warn">{error}</p>}
			{open && (
				<div className="grid gap-4 border-t border-line bg-paper/50 px-5 py-4">
					{report && <BuildReportView report={report} />}
					{!current && (
						<p className="text-sm text-muted">
							There is no earlier version to compare with. After
							publishing, choose which hospitals use it in the Hospitals
							tab.
						</p>
					)}
					{diff === "loading" && (
						<p className="text-sm text-muted">
							Comparing with {formatVersion(current?.version)}…
						</p>
					)}
					{diff && diff !== "loading" && <Changes diff={diff} />}
				</div>
			)}
		</li>
	);
}

export function ReviewQueue({
	protocols,
	reports,
}: {
	protocols: ProtocolEntry[];
	reports: Record<string, BuildReport>;
}) {
	const drafts = protocols
		.flatMap((p) =>
			p.versions.filter((v) => v.state === "draft").map((v) => ({ p, v })),
		)
		.sort((a, b) => b.v.uploadedAt.localeCompare(a.v.uploadedAt));
	if (!drafts.length)
		return (
			<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-14 text-center text-muted">
				<CircleCheckIcon className="size-8 text-go" strokeWidth={1.5} />
				<p className="font-medium text-ink">Nothing waiting</p>
				<p className="max-w-md text-sm">
					Uploads that were not published yet show up here, so you can review
					and publish them later.
				</p>
			</div>
		);
	return (
		<div className="grid gap-3">
			<p className="flex items-center gap-2 text-sm text-muted">
				<InboxIcon className="size-4" /> Uploaded but not published. Doctors
				keep seeing the current version until you publish.
			</p>
			<ul className="grid gap-3">
				{drafts.map(({ p, v }) => (
					<Draft key={v.sha256} p={p} v={v} report={reports[v.sha256]} />
				))}
			</ul>
		</div>
	);
}
