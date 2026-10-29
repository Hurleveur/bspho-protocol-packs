import { diffSpecs } from "@bspho/protocol/diff";
import { store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_CHANGES = 150;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const Query = z.object({
	protocolId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	from: sha,
	to: sha,
});

/** What changed between two versions of one protocol. */
export async function GET(req: Request) {
	const parsed = Query.safeParse(
		Object.fromEntries(new URL(req.url).searchParams) as unknown,
	);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const { protocolId, from, to } = parsed.data;
	const entry = (await store.registry()).protocols.find((p) => p.id === protocolId);
	if (
		!entry ||
		!entry.versions.some((v) => v.sha256 === from) ||
		!entry.versions.some((v) => v.sha256 === to)
	)
		return Response.json({ error: "unknown protocol version" }, { status: 404 });
	const diff = diffSpecs(
		await store.spec(protocolId, from),
		await store.spec(protocolId, to),
	);
	return Response.json({
		...diff,
		changes: diff.changes.slice(0, MAX_CHANGES),
		truncated: Math.max(0, diff.changes.length - MAX_CHANGES),
	});
}
