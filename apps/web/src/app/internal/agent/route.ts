import { answer, corpus } from "@bspho/protocol/agent";
import { store } from "@bspho/protocol/store";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
	protocolId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	messages: z
		.array(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string().trim().min(1).max(8000),
			}),
		)
		.min(1)
		.max(30)
		.refine((m) => m.at(-1)?.role === "user", "last message must be the user's"),
	location: z
		.object({
			nodeId: z.string().max(200).optional(),
			stepId: z.string().max(200).optional(),
			line: z.string().max(200).optional(),
			ticked: z.array(z.string().max(200)).max(200).optional(),
		})
		.optional(),
});

/** Chat over one protocol (whole text in context). Streams plain text, then \u001e + JSON with the cited passages. Nothing is stored. */
export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json()) as unknown);
	if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
	const { protocolId, messages, location } = parsed.data;
	const registry = await store.registry();
	const entry = registry.protocols.find((p) => p.id === protocolId);
	const spec = entry ? await store.publishedSpec(entry.id) : null;
	if (!entry || !spec)
		return Response.json({ error: "unknown protocol" }, { status: 404 });
	const subs = await Promise.all(
		registry.protocols
			.filter((p) => p.parentId === protocolId && p.kind === "subprotocol")
			.map(async (p) => ({
				spec: await store.publishedSpec(p.id),
				name: p.short,
			})),
	);
	const c = corpus(
		{ spec, name: entry.short },
		subs.filter(
			(s): s is { spec: NonNullable<typeof s.spec>; name: string } => !!s.spec,
		),
	);
	return new Response(answer(c, messages, location, req.signal), {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"x-accel-buffering": "no",
		},
	});
}
