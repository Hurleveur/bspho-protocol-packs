/**
 * PDF reading on top of MuPDF (WASM): visual lines with font and position, page
 * renders, and quote search for highlights. Everything a doctor reads is copied
 * out of these lines by code.
 */
import { createHash } from "node:crypto";
import * as mupdf from "mupdf";

export type Box = [x0: number, y0: number, x1: number, y1: number];

export interface Line {
	page: number; // 1-based
	text: string;
	size: number; // dominant font size (pt)
	bold: boolean;
	/** >0 when the line is several table cells side by side. */
	cells: number;
	bbox: Box;
}

export interface PdfPage {
	page: number;
	width: number;
	height: number;
	lines: Line[];
	text: string;
	/** Share of the page area covered by images: high on scanned tables and flowcharts. */
	imageCover: number;
	/** Embedded images large enough to be figures (PDF points). */
	images: Box[];
}

export function openPdf(bytes: Uint8Array): mupdf.PDFDocument {
	return mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
}

interface RawLine {
	text: string;
	size: number;
	weight: string;
	font: string;
	bbox: { x: number; y: number; w: number; h: number };
}

const BOLD_FONT = /bold|black|heavy|semibold|demi/i;

/** MuPDF splits a visual line into pieces ("8 " and "Therapy Elements "): regroup them by baseline. */
function visualLines(raw: RawLine[], page: number): Line[] {
	const pieces = raw
		.filter((r) => r.text.trim())
		.map((r) => ({ ...r, base: r.bbox.y + r.bbox.h }))
		.sort((a, b) => Math.round(a.base) - Math.round(b.base) || a.bbox.x - b.bbox.x);
	const rows: (typeof pieces)[] = [];
	for (const p of pieces) {
		const row = rows.at(-1);
		if (row && Math.abs(row[0].base - p.base) < 2.5) row.push(p);
		else rows.push([p]);
	}
	return rows.map((row) => {
		row.sort((a, b) => a.bbox.x - b.bbox.x);
		let text = "";
		let prevX1: number | null = null;
		let cells = 0;
		for (const p of row) {
			if (prevX1 !== null) {
				const gap = p.bbox.x - prevX1;
				// A wide gap is a column boundary, unless what precedes it is a section number or a list marker ("-<tab>item").
				// (a lone section number "5.1" or "A." before its title, or a list marker); numeric table cells do count.
				// List markers ("o", "•", "4) ◆", "a)", "(ii)") before a tab stop are not a table column either.
				const sectionNumber = /^\s*(?:\d{1,2}(?:\.\d{1,2}){0,4}\.?|\(?[A-Za-z][.)]|\(?\d{1,2}\)|\(?[ivxIVX]{1,4}[.)]|[^\p{L}\p{N}\s]{1,2}|o)(?:\s+[^\p{L}\p{N}\s]{1,2})?\s*$/u.test(text);
				if (gap > 12 && !sectionNumber && text.trim().length > 1) cells++;
				// A word space is ~0.25 em; loose letter-spacing (rotated HLH tables) stays below it.
				if (gap > Math.max(1.5, 0.22 * p.size) && !text.endsWith(" ")) text += " ";
			}
			text += p.text;
			prevX1 = p.bbox.x + p.bbox.w;
		}
		const chars = row.reduce((n, p) => n + p.text.trim().length, 0) || 1;
		const boldChars = row
			.filter((p) => p.weight === "bold" || BOLD_FONT.test(p.font))
			.reduce((n, p) => n + p.text.trim().length, 0);
		return {
			page,
			text: text.replace(/\s+/g, " ").trim(),
			size: row.reduce((s, p) => s + p.size * p.text.trim().length, 0) / chars,
			bold: boldChars / chars >= 0.8,
			cells,
			bbox: [
				Math.min(...row.map((p) => p.bbox.x)),
				Math.min(...row.map((p) => p.bbox.y)),
				Math.max(...row.map((p) => p.bbox.x + p.bbox.w)),
				Math.max(...row.map((p) => p.bbox.y + p.bbox.h)),
			],
		};
	});
}

export function readPage(doc: mupdf.Document, page: number): PdfPage {
	const p = doc.loadPage(page - 1);
	const [x0, y0, x1, y1] = p.getBounds();
	const width = x1 - x0;
	const height = y1 - y0;
	const st = p.toStructuredText("preserve-whitespace,preserve-images");
	const json = JSON.parse(st.asJSON()) as {
		blocks: {
			type: string;
			bbox: { x: number; y: number; w: number; h: number };
			lines?: { text: string; bbox: RawLine["bbox"]; font?: { name: string; size: number; weight: string }; wmode?: number }[];
		}[];
	};
	const raw: RawLine[] = [];
	let imageArea = 0;
	const images: Box[] = [];
	for (const b of json.blocks) {
		if (b.type === "image") {
			imageArea += b.bbox.w * b.bbox.h;
			if (b.bbox.w > 120 && b.bbox.h > 80) images.push([b.bbox.x, b.bbox.y, b.bbox.x + b.bbox.w, b.bbox.y + b.bbox.h]);
			continue;
		}
		for (const l of b.lines ?? []) {
			if (l.wmode) continue; // vertical text: margins, rotated table labels
			raw.push({
				text: l.text,
				size: l.font?.size ?? 0,
				weight: l.font?.weight ?? "normal",
				font: l.font?.name ?? "",
				bbox: l.bbox,
			});
		}
	}
	const lines = visualLines(raw, page);
	return {
		page,
		width,
		height,
		lines,
		text: lines.map((l) => l.text).join("\n"),
		imageCover: Math.min(1, imageArea / (width * height)),
		images,
	};
}

export function readPages(doc: mupdf.Document): PdfPage[] {
	return Array.from({ length: doc.countPages() }, (_, i) => readPage(doc, i + 1));
}

/** PNG of one page, optionally with highlight boxes (PDF points) painted in. */
export function renderPage(doc: mupdf.Document, page: number, highlights: Box[] = [], zoom = 1.6): Uint8Array {
	const p = doc.loadPage(page - 1);
	const pix = p.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
	if (highlights.length) {
		// Multiply a warm yellow over each box so the text stays readable.
		const w = pix.getWidth();
		const h = pix.getHeight();
		const n = pix.getNumberOfComponents();
		const px = pix.getPixels();
		for (const [bx0, by0, bx1, by1] of highlights) {
			const xa = Math.max(0, Math.floor((bx0 - 1) * zoom));
			const xb = Math.min(w, Math.ceil((bx1 + 1) * zoom));
			const ya = Math.max(0, Math.floor((by0 - 1) * zoom));
			const yb = Math.min(h, Math.ceil((by1 + 1) * zoom));
			for (let y = ya; y < yb; y++) {
				for (let x = xa; x < xb; x++) {
					const i = (y * w + x) * n;
					px[i + 2] = Math.round(px[i + 2] * 0.55); // less blue = yellow tint
				}
			}
		}
	}
	return pix.asPNG();
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** PNG of a region of a page (PDF points), e.g. a table shown exactly as printed. */
export function renderRegion(doc: mupdf.Document, page: number, [x0, y0, x1, y1]: Box, zoom = 2, pad = 6): Uint8Array {
	const p = doc.loadPage(page - 1);
	const bbox: mupdf.Rect = [(x0 - pad) * zoom, (y0 - pad) * zoom, (x1 + pad) * zoom, (y1 + pad) * zoom].map(Math.round) as mupdf.Rect;
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
	pix.clear(255);
	const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(zoom, zoom), pix);
	p.run(dev, mupdf.Matrix.identity);
	dev.close();
	return pix.asPNG();
}
