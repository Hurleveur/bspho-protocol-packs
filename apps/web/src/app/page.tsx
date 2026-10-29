import { FAMILY_LABELS, type Family } from "@bspho/protocol/store";
import Link from "next/link";
import { AgentDrawer } from "@/components/agent-drawer";
import { HospitalPicker } from "@/components/hospital-picker";
import { StatusBadge } from "@/components/status-badge";
import { currentHospital, shelf } from "@/lib/data";
import { formatVersion } from "@/lib/format";

export default async function Shelf() {
	const hospital = await currentHospital();
	const { hospitals, protocols } = await shelf(hospital);
	const families = Object.keys(FAMILY_LABELS) as Family[];
	const masters = protocols.filter((p) => p.kind !== "subprotocol");

	return (
		<div className="mx-auto max-w-6xl px-8 py-10">
			<header className="mb-10 flex items-end justify-between gap-6">
				<div>
					<p className="text-sm font-semibold text-accent">
						BSPHO Protocol Packs
					</p>
					<h1 className="mt-1 text-3xl font-semibold tracking-tight">
						Protocols at your centre
					</h1>
				</div>
				<div className="flex items-center gap-3">
					<HospitalPicker hospitals={hospitals} current={hospital} />
					<Link
						href="/admin"
						className="rounded-md border border-line bg-surface px-3 py-2 text-sm hover:border-accent"
					>
						Upload a protocol
					</Link>
				</div>
			</header>

			<div className="grid gap-8">
				{families.map((f) => {
					const items = masters.filter((p) => p.family === f);
					if (!items.length) return null;
					return (
						<section key={f}>
							<h2 className="mb-3 text-base font-semibold text-ink">
								{FAMILY_LABELS[f]}{" "}
								<span className="font-normal text-muted">
									{items.length}
								</span>
							</h2>
							<div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
								{items.map((p) => {
									const v = p.versions.find(
										(x) => x.sha256 === p.published,
									);
									const subs = protocols.filter(
										(s) => s.parentId === p.id,
									);
									return (
										<Link
											key={p.id}
											href={`/p/${p.id}`}
											className="group flex flex-col rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
										>
											<div className="flex items-start justify-between gap-2">
												<span className="text-lg leading-snug font-semibold group-hover:text-accent">
													{p.short}
												</span>
												<StatusBadge status={p.status} />
											</div>
											<p className="mt-1 line-clamp-2 text-sm text-ink/75">
												{p.title}
											</p>
											<p className="mt-auto pt-3 font-mono text-[13px] text-muted">
												{formatVersion(v?.version)}
												{v?.date ? ` · ${v.date}` : ""}
												{subs.length
													? ` · +${subs.length} sub-protocols`
													: ""}
												{p.kind === "local"
													? " · local document"
													: ""}
											</p>
										</Link>
									);
								})}
							</div>
						</section>
					);
				})}
			</div>
			<AgentDrawer />
		</div>
	);
}
