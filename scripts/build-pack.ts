/** Build a protocol spec from a PDF: bun scripts/build-pack.ts <pdf> [out.json] [--offline] */
import { buildSpec } from "@bspho/protocol/build";

const [pdfPath, out = "/dev/stdout"] = process.argv
	.slice(2)
	.filter((a) => !a.startsWith("--"));
const spec = await buildSpec({
	pdf: await Bun.file(pdfPath).bytes(),
	offline: process.argv.includes("--offline"),
	onStage: (e) =>
		console.error(
			`[${e.stage}] ${e.message}${e.ms !== undefined ? ` (${e.ms} ms)` : ""}`,
		),
});
await Bun.write(out, JSON.stringify(spec, null, 1));
