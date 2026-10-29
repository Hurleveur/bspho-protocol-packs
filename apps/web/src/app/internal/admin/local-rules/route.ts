import { store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";

const Patch = z.object({
	id: z.string().min(1),
	text: z.string().trim().min(3).max(2000).optional(),
	/** Re-confirm a rule against the version doctors see now. */
	confirm: z.boolean().optional(),
});

/** Edit a local rule's text, or confirm it still holds for the published version. */
export async function PATCH(req: Request) {
	const parsed = Patch.safeParse((await req.json().catch(() => null)) as unknown);
	if (!parsed.success)
		return Response.json(
			{ error: "invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const { id, text, confirm } = parsed.data;
	const overlay = await store.overlay();
	const rule = overlay.localRules.find((r) => r.id === id);
	if (!rule) return Response.json({ error: "unknown rule" }, { status: 404 });
	if (text) rule.text = text;
	if (confirm) {
		const spec = await store.publishedSpec(rule.protocolId);
		if (!spec?.nodes.some((n) => n.id === rule.nodeId))
			return Response.json(
				{
					error: "this section no longer exists in the version doctors use; remove the rule and add it again",
				},
				{ status: 409 },
			);
		rule.attachedToSha256 = spec.doc.sha256;
		rule.state = "active";
	}
	await store.saveOverlay(overlay);
	return Response.json(rule);
}

const Delete = z.object({ id: z.string().min(1) });

export async function DELETE(req: Request) {
	const parsed = Delete.safeParse((await req.json().catch(() => null)) as unknown);
	if (!parsed.success)
		return Response.json({ error: "invalid request" }, { status: 400 });
	const overlay = await store.overlay();
	overlay.localRules = overlay.localRules.filter((r) => r.id !== parsed.data.id);
	await store.saveOverlay(overlay);
	return Response.json({ ok: true });
}
