/**
 * Body lines of a protocol's pages as the section pass sees them (boilerplate, page numbers and
 * top/bottom margins dropped): the input for the segmenter fixture.
 *
 *   bun scripts/eval/segment-lines.ts <protocolId> <fromPage> [toPage]    dump with x, bold, size
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Line, openPdf, type PdfPage, readPage } from "@bspho/protocol/pdf";
import { boilerplate, norm } from "@bspho/protocol/sections";

const STORE = join(import.meta.dir, "..", "..", "store");
const PAGE_NO = /^(?:page\s*)?\d+(?:\s*(?:of|\/|von)\s*\d+)?$/i;

export function shaOf(id: string): string {
	const p = JSON.parse(
		readFileSync(join(STORE, "registry.json"), "utf8"),
	).protocols.find((x: { id: string }) => x.id === id);
	if (!p?.published) throw new Error(`no published version of ${id}`);
	return p.published;
}

/** Every page of a PDF, read once. */
export function pagesOf(sha: string): PdfPage[] {
	const doc = openPdf(
		new Uint8Array(readFileSync(join(STORE, "pdfs", `${sha}.pdf`))),
	);
	return Array.from({ length: doc.countPages() }, (_, i) => readPage(doc, i + 1));
}

/** Body lines of pages from..to, filtered as sections.ts gathers a section's lines. */
export function bodyLines(pages: PdfPage[], from: number, to: number): Line[] {
	const boiler = boilerplate(pages);
	const out: Line[] = [];
	for (let pg = from; pg <= to; pg++) {
		const p = pages[pg - 1];
		for (const l of p.lines)
			if (
				!(
					boiler.has(norm(l.text)) ||
					PAGE_NO.test(l.text) ||
					l.bbox[3] < 0.05 * p.height ||
					l.bbox[1] > 0.95 * p.height
				)
			)
				out.push(l);
	}
	return out;
}

if (import.meta.main) {
	const [id, a, b] = process.argv.slice(2);
	const pages = pagesOf(shaOf(id));
	const lines = bodyLines(pages, Number(a), Number(b ?? a));
	const x0 = Math.min(...lines.map((l) => l.bbox[0]));
	lines.forEach((l, i) =>
		console.log(
			`${i}\tp${l.page}\tx=${Math.round(l.bbox[0] - x0)}\ty=${Math.round(l.bbox[1])}\t${l.bold ? "b" : ""}\ts=${Math.round(l.size)}${l.cells ? `\tc${l.cells}` : ""}\t| ${l.text}`,
		),
	);
}
