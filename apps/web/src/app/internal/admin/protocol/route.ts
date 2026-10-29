import { Family, store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
	protocolId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	short: z.string().trim().min(1).max(60),
	family: Family,
	/** Master protocol this one belongs to, or null for a protocol of its own. */
	parentId: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/)
		.nullable(),
});

/** Edit the catalogue details doctors see: short name, disease group, which master protocol it belongs to. */
export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json().catch(() => null)) as unknown);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const { protocolId, short, family, parentId } = parsed.data;
	const registry = await store.registry();
	const entry = registry.protocols.find((p) => p.id === protocolId);
	if (!entry) return Response.json({ error: "unknown protocol" }, { status: 404 });
	entry.short = short;
	entry.family = family;
	if (entry.kind !== "local") {
		if (parentId) {
			const parent = registry.protocols.find((p) => p.id === parentId);
			if (!parent || parent.id === protocolId || parent.kind !== "protocol")
				return Response.json(
					{ error: "it can only belong to a master protocol" },
					{ status: 400 },
				);
			if (
				registry.protocols.some(
					(p) => p.parentId === protocolId && p.kind === "subprotocol",
				)
			)
				return Response.json(
					{
						error: "this protocol has its own sub-protocols, so it cannot become one",
					},
					{ status: 400 },
				);
			entry.kind = "subprotocol";
			entry.parentId = parentId;
		} else {
			entry.kind = "protocol";
			delete entry.parentId;
		}
	}
	await store.saveRegistry(registry);
	return Response.json({ ok: true });
}
