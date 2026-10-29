import { HospitalStatus } from "@bspho/protocol/spec";
import { store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
	protocolId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	hospital: z.string().regex(/^[A-Z0-9-]+$/),
	/** "none" = the hospital does not use this protocol. */
	use: z.union([z.literal("none"), HospitalStatus]),
});

/** Set whether one hospital uses one protocol, and its status there. */
export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json().catch(() => null)) as unknown);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const { protocolId, hospital, use } = parsed.data;
	const [registry, overlay] = await Promise.all([store.registry(), store.overlay()]);
	if (!registry.protocols.some((p) => p.id === protocolId))
		return Response.json({ error: "unknown protocol" }, { status: 404 });
	if (!overlay.hospitals.some((h) => h.id === hospital))
		return Response.json({ error: "unknown hospital" }, { status: 404 });

	const now = new Date().toISOString();
	const p = overlay.participation.find(
		(x) => x.protocolId === protocolId && x.hospital === hospital,
	);
	if (p) {
		p.participating = use !== "none";
		if (use !== "none") p.status = use;
		p.updatedBy = "admin";
		p.updatedAt = now;
	} else if (use !== "none") {
		overlay.participation.push({
			protocolId,
			hospital,
			participating: true,
			status: use,
			updatedBy: "admin",
			updatedAt: now,
		});
	}
	await store.saveOverlay(overlay);
	return Response.json({ ok: true, updatedAt: now });
}
