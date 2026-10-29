import "server-only";
import type { ProtocolSpec } from "@bspho/protocol/spec";
import { store } from "@bspho/protocol/store";

/** What the pipeline produced for one version, in numbers an admin can read. */
export interface BuildReport {
	pages: number;
	sections: number;
	steps: number;
	stepsMissingStart: number;
	links: number;
	linksInferred: number;
	imagePages: number[];
	versionFound: boolean;
	builtAt: string;
	model: string | null;
	seconds: number;
	otherWarnings: string[];
}

function report(spec: ProtocolSpec): BuildReport {
	const steps = spec.nodes.filter((n) => n.kind === "step");
	const ws = spec.build.warnings;
	return {
		pages: spec.doc.pageCount,
		sections: spec.nodes.length,
		steps: steps.length,
		stepsMissingStart: steps.filter((n) => n.notFound?.length).length,
		links: spec.edges.length,
		linksInferred: spec.edges.filter((e) => !e.evidence).length,
		imagePages: ws
			.filter((w) => w.code === "raster_page" && w.page)
			.map((w) => w.page as number),
		versionFound: !!spec.doc.versionEvidence,
		builtAt: spec.build.builtAt,
		model: spec.build.model,
		seconds:
			Math.round(
				Object.values(spec.build.timingsMs).reduce((a, b) => a + b, 0) / 100,
			) / 10,
		otherWarnings: ws
			.filter(
				(w) =>
					w.code !== "raster_page" && w.code !== "edge_evidence_unresolved",
			)
			.map((w) => w.message),
	};
}

// A version is immutable (keyed by its PDF hash), so its report never goes stale.
const reports = new Map<string, BuildReport>();

async function reportFor(protocolId: string, sha: string): Promise<BuildReport | null> {
	const hit = reports.get(sha);
	if (hit) return hit;
	try {
		const r = report(await store.spec(protocolId, sha));
		reports.set(sha, r);
		return r;
	} catch {
		return null;
	}
}

/** Everything the admin screen shows, in one read. */
export async function adminData() {
	const [registry, overlay] = await Promise.all([store.registry(), store.overlay()]);
	const reportPairs = await Promise.all(
		registry.protocols.flatMap((p) =>
			p.versions.map(
				async (v) => [v.sha256, await reportFor(p.id, v.sha256)] as const,
			),
		),
	);
	const byShaReport = Object.fromEntries(
		reportPairs.filter((x) => x[1]).map(([sha, r]) => [sha, r as BuildReport]),
	);

	// Section titles for local rules, from the version each rule is attached to.
	const ruleSpecs = new Map<string, ProtocolSpec | null>();
	for (const r of overlay.localRules) {
		const key = `${r.protocolId}/${r.attachedToSha256}`;
		if (!ruleSpecs.has(key))
			ruleSpecs.set(
				key,
				await store.spec(r.protocolId, r.attachedToSha256).catch(() => null),
			);
	}
	const localRules = overlay.localRules.map((r) => ({
		...r,
		nodeTitle:
			ruleSpecs
				.get(`${r.protocolId}/${r.attachedToSha256}`)
				?.nodes.find((n) => n.id === r.nodeId)?.title ?? null,
	}));

	return {
		protocols: registry.protocols,
		hospitals: overlay.hospitals,
		participation: overlay.participation.map(
			({
				protocolId,
				hospital,
				participating,
				status,
				updatedBy,
				updatedAt,
			}) => ({
				protocolId,
				hospital,
				participating,
				status,
				updatedBy,
				updatedAt,
			}),
		),
		localRules,
		reports: byShaReport,
	};
}
export type AdminData = Awaited<ReturnType<typeof adminData>>;
export type AdminRule = AdminData["localRules"][number];
