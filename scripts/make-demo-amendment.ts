/**
 * Make the clearly-labelled DEMO amendment of ML-DS 2018 used on stage (we have no real
 * version pair): version 3.0 → "3.1-DEMO", and one start requirement changed.
 *   bun scripts/make-demo-amendment.ts [out.pdf]
 * Edits are real PDF edits: the old text is redacted and the new text baked into the page.
 */
import { resolve } from "node:path";
import * as mupdf from "mupdf";

const SRC = resolve(
	import.meta.dir,
	"../data/protocols/01_Protocol_ML_DS_2018_v3_0_clean.pdf",
);
const OUT =
	process.argv[2] ?? resolve(import.meta.dir, "../demo/ML-DS-2018_v3.1-DEMO.pdf");

const doc = mupdf.Document.openDocument(
	await Bun.file(SRC).bytes(),
	"application/pdf",
) as mupdf.PDFDocument;

/** Replace the first occurrence of `find` on a page with `replace`, same position and size. */
function replaceOnPage(
	pageIndex: number,
	find: string,
	replace: string,
	size: number,
): boolean {
	const page = doc.loadPage(pageIndex) as mupdf.PDFPage;
	const hits = page.search(find);
	if (!hits.length) return false;
	const quad = hits[0][0];
	const rect: mupdf.Rect = [
		Math.min(quad[0], quad[4]),
		Math.min(quad[1], quad[3]),
		Math.max(quad[2], quad[6]),
		Math.max(quad[5], quad[7]),
	];
	const redact = page.createAnnotation("Redact");
	redact.setRect(rect);
	page.applyRedactions(false, 0, 0, 0);
	const text = page.createAnnotation("FreeText");
	text.setRect([rect[0], rect[1], rect[0] + (rect[2] - rect[0]) * 1.25, rect[3] + 2]);
	text.setDefaultAppearance("Helv", size, [0, 0, 0]);
	text.setContents(replace);
	text.setBorderWidth(0);
	text.update();
	return true;
}

let footers = 0;
for (let i = 0; i < doc.countPages(); i++)
	if (replaceOnPage(i, "Version 3.0 ML-DS 2018", "Version 3.1-DEMO ML-DS 2018", 9))
		footers++;
// Course 3 (hAM), p48: platelet requirement 80 → 75 ×10⁹/L (same width, so the layout holds).
const changed = replaceOnPage(47, ">80 x10", ">75 x10", 11);
doc.bake(true, true);
await Bun.write(OUT, doc.saveToBuffer("garbage,compress").asUint8Array());
console.log(
	`footers changed on ${footers} pages; hAM threshold changed: ${changed}; wrote ${OUT}`,
);
