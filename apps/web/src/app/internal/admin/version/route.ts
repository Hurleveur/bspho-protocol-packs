import { publish } from "@bspho/protocol/ingest";
import { store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
	protocolId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	/** publish: make this version the one doctors see (also how an older version is restored). discard: drop a draft. */
	action: z.enum(["publish", "discard"]),
});

export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json().catch(() => null)) as unknown);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const { protocolId, sha256, action } = parsed.data;
	const registry = await store.registry();
	const entry = registry.protocols.find((p) => p.id === protocolId);
	const version = entry?.versions.find((v) => v.sha256 === sha256);
	if (!entry || !version)
		return Response.json({ error: "unknown protocol version" }, { status: 404 });

	if (action === "publish") {
		await publish(protocolId, sha256);
		return Response.json({ ok: true, version: version.version });
	}

	if (version.state !== "draft")
		return Response.json(
			{ error: "only a version waiting for review can be discarded" },
			{ status: 409 },
		);
	entry.versions = entry.versions.filter((v) => v.sha256 !== sha256);
	// A brand-new protocol whose only upload is discarded disappears, unless a hospital already set it up.
	if (!entry.versions.length) {
		const overlay = await store.overlay();
		if (
			!overlay.participation.some((p) => p.protocolId === protocolId) &&
			!overlay.localRules.some((r) => r.protocolId === protocolId)
		)
			registry.protocols = registry.protocols.filter((p) => p.id !== protocolId);
	}
	await store.saveRegistry(registry);
	return Response.json({ ok: true });
}
