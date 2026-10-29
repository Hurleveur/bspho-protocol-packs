import { expect, test } from "bun:test";
import type { Line } from "./pdf.ts";
import { anchorsFrom, chunk } from "./segment.ts";

const line = (page: number, y: number, text: string): Line => ({
	page,
	text,
	size: 10,
	bold: false,
	cells: 0,
	bbox: [72, y, 500, y + 10],
});
const lines = [
	line(80, 100, "PET at LRA will be performed in the last COPDAC-"),
	line(80, 112, "28) or DECOPDAC-21 cycle."),
	line(80, 130, "No IR criterion fulfilled"),
	line(81, 50, "Patients with AR do not"),
];
const ids = ["L0", "L1", "L2", "L3"];

test("blocks run from each start to the next; text is the lines verbatim", () => {
	const a = anchorsFrom(lines.slice(0, 3), ids.slice(0, 3), [
		{ start: "L0", role: "rule", depth: 0 },
		{ start: "L2", role: "item", depth: 1 },
	])!;
	expect(a.map((x) => x.text)).toEqual([
		"PET at LRA will be performed in the last COPDAC-\n28) or DECOPDAC-21 cycle.",
		"No IR criterion fulfilled",
	]);
	expect(a.map((x) => x.role)).toEqual(["rule", "item"]);
	expect(a[1].depth).toBe(1);
	expect(a.every((x) => x.bbox.length === x.text.split("\n").length)).toBe(true);
});

test("a block crossing a page break is one anchor per page, same role", () => {
	const a = anchorsFrom(lines, ids, [
		{ start: "L0", role: "rule", depth: 0 },
		{ start: "L2", role: "prose", depth: 0 },
	])!;
	expect(a.map((x) => [x.page, x.role])).toEqual([
		[80, "rule"],
		[80, "prose"],
		[81, "prose"],
	]);
});

test("invalid answers are rejected (fallback to heuristics)", () => {
	expect(
		anchorsFrom(lines, ids, [{ start: "L1", role: "rule", depth: 0 }]),
	).toBeNull(); // does not cover the first line
	expect(
		anchorsFrom(lines, ids, [
			{ start: "L0", role: "rule", depth: 0 },
			{ start: "L9", role: "item", depth: 0 },
		]),
	).toBeNull(); // unknown id
	expect(
		anchorsFrom(lines, ids, [
			{ start: "L0", role: "rule", depth: 0 },
			{ start: "L2", role: "item", depth: 0 },
			{ start: "L1", role: "item", depth: 0 },
		]),
	).toBeNull(); // out of order
	expect(anchorsFrom(lines, ids, [])).toBeNull();
});

test("sections are batched without splitting one", () => {
	const s = (n: number) => ({
		key: `k${n}`,
		title: "t",
		lines: Array.from({ length: n }, (_, i) => line(1, i * 12, "x")),
	});
	const groups = chunk([s(150), s(100), s(0), s(300)], 220);
	expect(groups.map((g) => g.map((x) => x.lines.length))).toEqual([
		[150],
		[100],
		[300],
	]);
});
