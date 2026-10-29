import { diffSpecs } from "@bspho/protocol/diff";
import { ingestPdf } from "@bspho/protocol/ingest";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Diffs of a heavily rewritten protocol can touch hundreds of sections: send the first ones. */
const MAX_CHANGES = 150;

const Upload = z.object({
	file: z
		.instanceof(File)
		.refine((f) => f.size > 0, "empty file")
		.refine(
			(f) =>
				f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
			"not a PDF",
		),
});

/** PDF upload → Server-Sent Events: one event per build stage, then `result` (or `error`). */
export async function POST(req: Request) {
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return Response.json(
			{ error: "expected multipart/form-data" },
			{ status: 400 },
		);
	}
	const parsed = Upload.safeParse({ file: form.get("file") as unknown });
	if (!parsed.success)
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? "bad request" },
			{ status: 400 },
		);
	const { file } = parsed.data;

	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(
						enc.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				} catch {
					// Client went away; keep building so the draft is still saved.
				}
			};
			try {
				const pdf = new Uint8Array(await file.arrayBuffer());
				const { spec, entry, previous } = await ingestPdf({
					pdf,
					fileName: file.name,
					uploadedBy: "admin",
					onStage: (e) => send("stage", e),
				});
				const diff = previous ? diffSpecs(previous, spec) : null;
				const steps = spec.nodes.filter((n) => n.kind === "step");
				send("result", {
					protocolId: entry.id,
					short: entry.short,
					title: entry.title,
					family: entry.family,
					isNew: !entry.published,
					alreadyPublished: entry.published === spec.doc.sha256,
					sha256: spec.doc.sha256,
					version: spec.doc.version,
					date: spec.doc.date,
					pageCount: spec.doc.pageCount,
					supersedes: spec.doc.supersedes,
					counts: {
						sections: spec.nodes.length,
						steps: steps.length,
						stepsWithStart: steps.filter((n) => !n.notFound?.length).length,
						links: spec.edges.length,
						verifiedLinks: spec.edges.filter((e) => e.evidence).length,
					},
					warnings: spec.build.warnings,
					diff: diff && {
						...diff,
						changes: diff.changes.slice(0, MAX_CHANGES),
						truncated: Math.max(0, diff.changes.length - MAX_CHANGES),
					},
				});
			} catch (e) {
				console.error("upload failed", e);
				send("error", { message: e instanceof Error ? e.message : String(e) });
			} finally {
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
		},
	});
}
