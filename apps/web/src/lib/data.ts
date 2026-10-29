import "server-only";
import { flipFinding } from "@bspho/protocol/consistency";
import type { Finding } from "@bspho/protocol/spec";
import { FAMILY_LABELS, store } from "@bspho/protocol/store";
import { cookies } from "next/headers";

export const HOSPITAL_COOKIE = "hospital";

export async function currentHospital(): Promise<string> {
	return (await cookies()).get(HOSPITAL_COOKIE)?.value ?? "UZG";
}

export async function shelf(hospital: string) {
	const [registry, overlay] = await Promise.all([store.registry(), store.overlay()]);
	const part = new Map(
		overlay.participation
			.filter((p) => p.hospital === hospital)
			.map((p) => [p.protocolId, p]),
	);
	const local = registry.protocols.filter(
		(p) => p.kind === "local" && p.parentId === hospital,
	);
	return {
		hospitals: overlay.hospitals,
		protocols: [
			...registry.protocols.filter(
				(p) => p.kind !== "local" && part.get(p.id)?.participating,
			),
			...local,
		].map((p) => ({ ...p, status: part.get(p.id)?.status ?? "unknown" })),
	};
}

export async function pack(protocolId: string, hospital: string) {
	const [registry, overlay] = await Promise.all([store.registry(), store.overlay()]);
	const entry = registry.protocols.find((p) => p.id === protocolId);
	if (!entry) return null;
	const spec = await store.publishedSpec(protocolId);
	if (!spec) return null;
	// Cross-protocol findings, only while both sides are still the versions that were checked.
	const published = new Map(
		registry.protocols.map((p) => [p.id, p.published ?? p.versions.at(-1)?.sha256]),
	);
	const crossFindings: Finding[] = [];
	const otherShas: Record<string, string> = {};
	for (const c of await store.crosschecks(protocolId)) {
		if (
			published.get(c.a.id) !== c.a.sha256 ||
			published.get(c.b.id) !== c.b.sha256
		)
			continue;
		const mine = c.a.id === protocolId;
		const other = mine ? c.b : c.a;
		otherShas[other.id] = other.sha256;
		for (const f of c.findings)
			crossFindings.push(
				mine
					? f
					: flipFinding(f, {
							id: c.a.id,
							short: c.a.short,
							version: c.a.version,
						}),
			);
	}
	// The other protocols at this centre, for the header's protocol menu.
	const protocols = (await shelf(hospital)).protocols
		.filter((p) => p.kind === "protocol")
		.map((p) => ({
			id: p.id,
			short: p.short,
			family: FAMILY_LABELS[p.family as keyof typeof FAMILY_LABELS] ?? "Other",
		}));
	return {
		protocols,
		crossFindings,
		otherShas,
		entry,
		spec,
		status:
			overlay.participation.find(
				(p) => p.protocolId === protocolId && p.hospital === hospital,
			)?.status ?? "unknown",
		hospital: overlay.hospitals.find((h) => h.id === hospital) ?? {
			id: hospital,
			name: hospital,
		},
		localRules: overlay.localRules.filter(
			(r) => r.protocolId === protocolId && r.hospital === hospital,
		),
		subprotocols: registry.protocols
			.filter((p) => p.parentId === protocolId)
			.map((p) => ({ id: p.id, short: p.short })),
	};
}
export type PackData = NonNullable<Awaited<ReturnType<typeof pack>>>;
