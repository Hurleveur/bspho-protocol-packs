import { FAMILY_LABELS } from "@bspho/protocol/store";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AdminTabs } from "@/components/admin/admin-tabs";
import { buildNotes } from "@/components/admin/build-notes";
import { CoverageMatrix } from "@/components/admin/coverage-matrix";
import { LocalRulesAdmin } from "@/components/admin/local-rules-admin";
import { ProtocolTable } from "@/components/admin/protocol-table";
import { ReviewQueue } from "@/components/admin/review-queue";
import { concern } from "@/components/admin/rule-check";
import { UploadFlow } from "@/components/admin/upload-flow";
import { adminData } from "@/lib/admin";

export const metadata: Metadata = { title: "Protocol administration · BSPHO" };

export default async function Admin() {
	await connection();
	const data = await adminData();
	const { protocols, hospitals, participation, localRules, reports } = data;
	const byId = new Map(protocols.map((p) => [p.id, p]));

	const drafts = protocols.reduce(
		(n, p) => n + p.versions.filter((v) => v.state === "draft").length,
		0,
	);
	const usedBy: Record<string, number> = {};
	for (const x of participation)
		if (x.participating) usedBy[x.protocolId] = (usedBy[x.protocolId] ?? 0) + 1;
	const statusUnset = participation.filter(
		(x) => x.participating && x.status === "unknown",
	).length;
	const unused = protocols.filter((p) => p.kind !== "local" && !usedBy[p.id]).length;
	const rulesToCheck = localRules.filter((r) =>
		concern(r, byId.get(r.protocolId)),
	).length;
	const withNotes = protocols.filter((p) => {
		const r = p.published ? reports[p.published] : undefined;
		return r && buildNotes(r).length > 0;
	}).length;

	const attention = [
		{
			n: drafts,
			href: "#review",
			label:
				drafts === 1
					? "upload waiting to be published"
					: "uploads waiting to be published",
		},
		{
			n: statusUnset,
			href: "#hospitals",
			label: "hospital statuses still to fill in",
		},
		{
			n: unused,
			href: "#hospitals",
			label:
				unused === 1
					? "protocol no hospital uses"
					: "protocols no hospital uses",
		},
		{
			n: rulesToCheck,
			href: "#rules",
			label:
				rulesToCheck === 1
					? "local rule to re-check"
					: "local rules to re-check",
		},
		{ n: withNotes, href: "#protocols", label: "protocols with reading notes" },
	];

	return (
		<div className="mx-auto max-w-7xl px-8 py-10">
			<header className="mb-6">
				<Link
					href="/"
					className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent"
				>
					<ArrowLeftIcon className="size-3.5" /> Protocols
				</Link>
				<p className="text-sm font-medium tracking-wide text-accent uppercase">
					BSPHO protocol packs
				</p>
				<h1 className="mt-1 text-3xl font-semibold tracking-tight">
					Protocol administration
				</h1>
				<p className="mt-2 max-w-2xl text-muted">
					Upload new protocol versions, choose which hospitals use them, and
					keep statuses and local rules up to date.
				</p>
			</header>

			<ul className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
				{attention.map((a) => (
					<li key={a.label}>
						<a
							href={a.href}
							className={`block h-full rounded-lg border px-4 py-3 transition-colors hover:border-accent ${a.n ? "border-line bg-surface" : "border-line/60 bg-paper"}`}
						>
							<span
								className={`block text-2xl font-semibold tabular-nums ${a.n ? "text-ink" : "text-faint"}`}
							>
								{a.n}
							</span>
							<span className="text-sm text-muted">{a.label}</span>
						</a>
					</li>
				))}
			</ul>

			<AdminTabs
				tabs={[
					{
						id: "upload",
						label: "Upload",
						panel: (
							<UploadFlow
								hospitals={hospitals}
								participation={participation.map(
									({
										protocolId,
										hospital,
										participating,
										status,
									}) => ({
										protocolId,
										hospital,
										participating,
										status,
									}),
								)}
								familyLabels={FAMILY_LABELS}
							/>
						),
					},
					{
						id: "review",
						label: "Waiting for review",
						count: drafts,
						alert: drafts > 0,
						panel: <ReviewQueue protocols={protocols} reports={reports} />,
					},
					{
						id: "hospitals",
						label: "Hospitals",
						panel: (
							<CoverageMatrix
								protocols={protocols}
								hospitals={hospitals}
								participation={participation}
								familyLabels={FAMILY_LABELS}
							/>
						),
					},
					{
						id: "protocols",
						label: "Protocols and versions",
						count: protocols.length,
						panel: (
							<ProtocolTable
								protocols={protocols}
								reports={reports}
								usedBy={usedBy}
								familyLabels={FAMILY_LABELS}
							/>
						),
					},
					{
						id: "rules",
						label: "Local rules",
						count: localRules.length,
						alert: rulesToCheck > 0,
						panel: (
							<LocalRulesAdmin
								rules={localRules}
								protocols={protocols}
								hospitals={hospitals}
							/>
						),
					},
				]}
			/>
		</div>
	);
}
