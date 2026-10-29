import { store } from "@bspho/protocol/store";
import { z } from "zod";

const Body = z.object({
	protocolId: z.string().min(1),
	hospital: z.string().min(1),
	nodeId: z.string().min(1),
	text: z.string().trim().min(3).max(2000),
	author: z.string().trim().min(1).max(120),
	sourceTitle: z.string().trim().max(200).optional(),
});

/** Attach a hospital's local rule to a protocol section. */
export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json()) as unknown);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid", details: parsed.error.issues },
			{ status: 400 },
		);
	const b = parsed.data;
	const spec = await store.publishedSpec(b.protocolId);
	const node = spec?.nodes.find((n) => n.id === b.nodeId);
	if (!spec || !node)
		return Response.json({ error: "unknown section" }, { status: 404 });
	const overlay = await store.overlay();
	const rule = {
		id: crypto.randomUUID(),
		protocolId: b.protocolId,
		hospital: b.hospital,
		nodeId: b.nodeId,
		nodeQuote: node.blocks[0]?.text.slice(0, 300),
		text: b.text,
		...(b.sourceTitle ? { source: { title: b.sourceTitle } } : {}),
		author: b.author,
		createdAt: new Date().toISOString(),
		attachedToSha256: spec.doc.sha256,
		state: "active" as const,
	};
	overlay.localRules.push(rule);
	await store.saveOverlay(overlay);
	return Response.json(rule);
}

const Delete = z.object({ id: z.string().min(1) });

export async function DELETE(req: Request) {
	const parsed = Delete.safeParse((await req.json()) as unknown);
	if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
	const overlay = await store.overlay();
	overlay.localRules = overlay.localRules.filter((r) => r.id !== parsed.data.id);
	await store.saveOverlay(overlay);
	return Response.json({ ok: true });
}
