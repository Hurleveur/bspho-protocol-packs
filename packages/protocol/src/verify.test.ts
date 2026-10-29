import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { openPdf, readPage } from "./pdf.ts";
import { locate, normalize } from "./verify.ts";

// ALLTogether1 p179: "WBC should be >1.5x109/L or • ANC ≥0.5x109/L (...) and • platelets >50x109/L and rising."
const PDF = resolve(import.meta.dir, "../../../data/protocols/ALLTogether1 Master Protocol v6.0 07Mar25_CLEAN3_signed.pdf");
let page = "";

beforeAll(async () => {
	page = readPage(openPdf(await Bun.file(PDF).bytes()), 179).text;
});

describe("locate", () => {
	test("rejects quotes whose numbers differ from the page", () => {
		for (const q of ["WBC should be >3.0x109/L", "platelets >75x109/L and rising", "platelets >30x109/L and rising"]) {
			expect(locate(q, page).verified).toBe(false);
		}
	});

	test("verifies real quotes", () => {
		for (const q of [
			"WBC should be >1.5x109/L or",
			"platelets >50x109/L and rising",
			"ANC ≥0.5x109/L (consider Duffy phenotype – see section 10.3.8) and",
			"The patient should be in good clinical condition and free of serious infection.",
		]) {
			expect(locate(q, page).verified).toBe(true);
		}
	});

	test("verifies a quote spanning bullets and line breaks", () => {
		const q =
			"WBC should be >1.5x109/L or ANC ≥0.5x109/L (consider Duffy phenotype – see section 10.3.8) and platelets >50x109/L and rising.";
		expect(locate(q, page).verified).toBe(true);
	});

	test("checks every segment of an elided quote", () => {
		expect(locate("Before the start of the phase: ... platelets >50x109/L and rising", page).verified).toBe(true);
		expect(locate("Before the start of the phase: ... platelets >80x109/L and rising", page).verified).toBe(false);
	});

	test("a section number is not a threshold", () => {
		expect(locate("ANC ≥0.3x109/L (consider Duffy phenotype – see section 10.3.8)", page).verified).toBe(false);
	});
});

test("count units normalize to one spelling", () => {
	expect(normalize("ANC ≥ 0.5 x 10\n9/l")).toBe("anc ≥ 0.5 x10^9/l");
	expect(normalize("ANC ≥ 0.5 ×10⁹/L")).toBe("anc ≥ 0.5 x10^9/l");
});
