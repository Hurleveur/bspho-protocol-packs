import { ask } from "@bspho/protocol/ask";
import { store } from "@bspho/protocol/store";
import { z } from "zod";
import { currentHospital } from "@/lib/data";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
	question: z.string().trim().min(3).max(1000),
	protocolId: z.string().optional(),
});

/** Answer from the published protocols of the user's hospital (or one protocol), citing verbatim passages. */
export async function POST(req: Request) {
	const parsed = Body.safeParse((await req.json()) as unknown);
	if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
	const hospital = await currentHospital();
	const [registry, overlay] = await Promise.all([store.registry(), store.overlay()]);
	const runs = new Set(
		overlay.participation
			.filter((p) => p.hospital === hospital && p.participating)
			.map((p) => p.protocolId),
	);
	const entries = registry.protocols.filter(
		(p) =>
			p.published &&
			(parsed.data.protocolId
				? p.id === parsed.data.protocolId ||
					p.parentId === parsed.data.protocolId
				: runs.has(p.id)),
	);
	const specs = await Promise.all(entries.map((p) => store.spec(p.id, p.published!)));
	const names = Object.fromEntries(entries.map((p) => [p.id, p.short]));
	try {
		return Response.json(await ask(parsed.data.question, specs, names));
	} catch {
		return Response.json(
			{ error: "The search service is busy. Try again in a moment." },
			{ status: 503 },
		);
	}
}
