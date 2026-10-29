import { publish } from "@bspho/protocol/ingest";
import { HospitalStatus } from "@bspho/protocol/spec";
import { Family, store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
	protocolId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	hospitals: z.array(z.string().regex(/^[A-Z0-9-]+$/)),
	status: HospitalStatus,
	/** Only for a new protocol: the name and family the admin confirmed. */
	identity: z
		.object({ short: z.string().trim().min(1).max(60), family: Family })
		.optional(),
});

/** Publish a draft version and set which hospitals use the protocol. */
export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json().catch(() => null)) as unknown);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const { protocolId, sha256, hospitals, status, identity } = parsed.data;

	const registry = await store.registry();
	const entry = registry.protocols.find((p) => p.id === protocolId);
	const version = entry?.versions.find((v) => v.sha256 === sha256);
	if (!entry || !version)
		return Response.json({ error: "unknown protocol version" }, { status: 404 });

	if (identity) {
		entry.short = identity.short;
		entry.family = identity.family;
		await store.saveRegistry(registry);
		const spec = await store.spec(protocolId, sha256);
		spec.doc.short = identity.short;
		await store.saveSpec(spec);
	}
	await publish(protocolId, sha256);

	const overlay = await store.overlay();
	const known = new Set(overlay.hospitals.map((h) => h.id));
	const ticked = new Set(hospitals.filter((h) => known.has(h)));
	const now = new Date().toISOString();
	for (const h of overlay.hospitals) {
		const p = overlay.participation.find(
			(x) => x.protocolId === protocolId && x.hospital === h.id,
		);
		const participating = ticked.has(h.id);
		if (p) {
			p.participating = participating;
			if (participating) p.status = status;
			p.updatedBy = "admin";
			p.updatedAt = now;
		} else if (participating) {
			overlay.participation.push({
				protocolId,
				hospital: h.id,
				participating,
				status,
				updatedBy: "admin",
				updatedAt: now,
			});
		}
	}
	await store.saveOverlay(overlay);

	return Response.json({
		ok: true,
		protocolId,
		version: version.version,
		hospitals: [...ticked],
	});
}
