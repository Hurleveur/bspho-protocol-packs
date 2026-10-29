import { type Box, openPdf, renderPage, renderRegion } from "@bspho/protocol/pdf";
import { store } from "@bspho/protocol/store";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// PDFs are immutable by hash: keep the parsed documents warm.
const docs = new Map<string, ReturnType<typeof openPdf>>();

async function doc(sha: string) {
	let d = docs.get(sha);
	if (!d) {
		await store.ready();
		d = openPdf(new Uint8Array(await readFile(store.pdfPath(sha))));
		docs.set(sha, d);
	}
	return d;
}

const Params = z.object({
	sha: z.string().regex(/^[0-9a-f]{64}$/),
	page: z.coerce.number().int().min(1),
});

/** PNG of one protocol page; `b` = highlight boxes "x0,y0,x1,y1;..." in PDF points; `crop` = one region only. */
export async function GET(
	req: Request,
	ctx: RouteContext<"/internal/page/[sha]/[page]">,
) {
	const parsed = Params.safeParse(await ctx.params);
	if (!parsed.success) return new Response("bad request", { status: 400 });
	const { sha, page } = parsed.data;
	const boxes: Box[] = (new URL(req.url).searchParams.get("b") ?? "")
		.split(";")
		.map((s) => s.split(",").map(Number))
		.filter((b): b is Box => b.length === 4 && b.every(Number.isFinite));
	try {
		const d = await doc(sha);
		if (page > d.countPages()) return new Response("no such page", { status: 404 });
		const crop = (new URL(req.url).searchParams.get("crop") ?? "")
			.split(",")
			.map(Number);
		const png =
			crop.length === 4 && crop.every(Number.isFinite)
				? renderRegion(d, page, crop as Box)
				: renderPage(d, page, boxes, 2);
		return new Response(new Uint8Array(png), {
			headers: {
				"content-type": "image/png",
				"cache-control": "public, max-age=31536000, immutable",
			},
		});
	} catch {
		return new Response("not found", { status: 404 });
	}
}
