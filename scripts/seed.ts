/**
 * Seed the store from the hackathon corpus: every PDF in data/ becomes a published
 * version 1, and the organisers' hospital mapping becomes the overlay.
 *   bun scripts/seed.ts [protocolId ...]
 */
import { resolve } from "node:path";
import { ingestPdf, publish } from "@bspho/protocol/ingest";
import { type Family, type ProtocolEntry, store } from "@bspho/protocol/store";

interface CatalogEntry {
	id: string;
	short: string;
	title: string;
	version: string;
	file: string;
	kind: ProtocolEntry["kind"];
	family: Family;
	parentId?: string;
	hospitals: string[];
}

const DATA = resolve(import.meta.dir, "../data");
const catalog: CatalogEntry[] = await Bun.file(resolve(import.meta.dir, "catalog.json")).json();
const only = process.argv.slice(2);

const overlay = await store.overlay();
overlay.hospitals = [
	{ id: "UZG", name: "UZ Gent" },
	{ id: "UZA", name: "UZ Antwerpen" },
	{ id: "UZL", name: "UZ Leuven" },
	{ id: "UCL", name: "Cliniques universitaires Saint-Luc" },
	{ id: "CHU", name: "CHU Liège" },
	{ id: "HUDERF", name: "HUDERF Brussels" },
];
const now = new Date().toISOString();
// Keep what admins already set (status per hospital); only add missing pairs from the catalogue.
const existing = new Map(overlay.participation.map((p) => [`${p.protocolId}|${p.hospital}`, p]));
overlay.participation = catalog.flatMap((c) =>
	c.hospitals.map(
		(h) =>
			existing.get(`${c.id}|${h}`) ?? { protocolId: c.id, hospital: h, participating: true, status: "unknown" as const, updatedBy: "seed", updatedAt: now },
	),
);
await store.saveOverlay(overlay);

for (const c of catalog) {
	if (only.length && !only.includes(c.id)) continue;
	const t = performance.now();
	try {
		// Model labelling is not fully deterministic: never let a rebuild replace a good spec with a structurally
		// worse one (e.g. a protocol suddenly without treatment steps). Retry once, else keep the previous spec.
		const previous = await store.publishedSpec(c.id).catch(() => null);
		const shape = (sp: NonNullable<typeof previous>) => ({
			steps: sp.nodes.filter((n) => n.kind === "step").length,
			diagnostics: sp.nodes.filter((n) => n.kind === "diagnostics").length,
		});
		const worse = (sp: NonNullable<typeof previous>) => {
			if (!previous) return false;
			const [a, b] = [shape(previous), shape(sp)];
			return (a.steps > 0 && b.steps < a.steps / 2) || (a.diagnostics > 0 && b.diagnostics === 0);
		};
		let { spec } = await ingestPdf({
			pdf: await Bun.file(resolve(DATA, c.file)).bytes(),
			fileName: c.file.split("/").pop()!,
			uploadedBy: "seed",
			identity: { id: c.id, short: c.short, title: c.title, version: c.version, family: c.family, kind: c.kind, parentId: c.parentId },
		});
		if (worse(spec)) {
			console.log(`${c.id}: rebuild is structurally worse (${JSON.stringify(shape(spec))} vs ${JSON.stringify(shape(previous!))}), retrying once`);
			({ spec } = await ingestPdf({
				pdf: await Bun.file(resolve(DATA, c.file)).bytes(),
				fileName: c.file.split("/").pop()!,
				uploadedBy: "seed",
				identity: { id: c.id, short: c.short, title: c.title, version: c.version, family: c.family, kind: c.kind, parentId: c.parentId },
			}));
			if (worse(spec) && previous) {
				console.log(`${c.id}: still worse, keeping the previous spec`);
				await store.saveSpec(previous);
				spec = previous;
			}
		}
		await publish(c.id, spec.doc.sha256);
		const steps = spec.nodes.filter((n) => n.kind === "step").length;
		const withReq = spec.nodes.filter((n) => n.kind === "step" && !n.notFound).length;
		console.log(
			`${c.id.padEnd(32)} ${String(spec.doc.pageCount).padStart(3)}p ${String(spec.nodes.length).padStart(4)} nodes ${String(steps).padStart(3)} steps (${withReq} w/ start req) ${String(spec.edges.length).padStart(3)} edges ${spec.build.warnings.length} warnings ${Math.round(performance.now() - t)}ms`,
		);
	} catch (e) {
		console.log(`${c.id.padEnd(32)} FAILED: ${(e as Error).message.slice(0, 200)}`);
	}
}
