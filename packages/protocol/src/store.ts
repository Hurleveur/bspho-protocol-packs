/**
 * Storage for protocol versions, the registry and the hospital overlay.
 *
 * Layout (a local directory in dev, mirrored to a GCS bucket in production):
 *   registry.json                     protocols, their versions and which one is published
 *   overlay.json                      hospitals, participation/status, local rules
 *   pdfs/<sha256>.pdf                 every uploaded PDF, by content hash
 *   specs/<protocolId>/<sha256>.json  one immutable spec per protocol version
 *   crosschecks/<idA>__<idB>.json     discrepancies between two protocols used together, keyed by both shas
 *
 * A new PDF is a new version: built into a draft, compared with the published version,
 * then published. Older versions stay readable.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { Finding, Overlay, ProtocolSpec, SPEC_VERSION } from "./spec.ts";

export const Family = z.enum([
	"leukaemia",
	"lymphoma",
	"bone_tumours",
	"soft_tissue_sarcoma",
	"neuroblastoma",
	"cns_tumours",
	"renal_tumours",
	"liver_tumours",
	"germ_cell_tumours",
	"marrow_failure_histiocytosis",
	"other",
]);
export type Family = z.infer<typeof Family>;

export const FAMILY_LABELS: Record<Family, string> = {
	leukaemia: "Leukaemia & MDS",
	lymphoma: "Lymphoma",
	bone_tumours: "Bone tumours",
	soft_tissue_sarcoma: "Soft tissue sarcoma",
	neuroblastoma: "Neuroblastoma",
	cns_tumours: "Brain & CNS tumours",
	renal_tumours: "Kidney tumours",
	liver_tumours: "Liver tumours",
	germ_cell_tumours: "Germ cell tumours",
	marrow_failure_histiocytosis: "Marrow failure & histiocytosis",
	other: "Other",
};

export const VersionEntry = z.object({
	sha256: z.string(),
	version: z.string(),
	date: z.string().nullable(),
	fileName: z.string(),
	uploadedAt: z.string(),
	uploadedBy: z.string(),
	state: z.enum(["draft", "published", "superseded"]),
});
export type VersionEntry = z.infer<typeof VersionEntry>;

export const ProtocolEntry = z.object({
	id: z.string(),
	short: z.string(),
	title: z.string(),
	family: Family,
	kind: z.enum(["protocol", "subprotocol", "local"]),
	/** For sub-protocols: the master protocol id. For local documents: the owning hospital. */
	parentId: z.string().optional(),
	published: z.string().nullable(),
	versions: z.array(VersionEntry),
});
export type ProtocolEntry = z.infer<typeof ProtocolEntry>;

const Side = z.object({ id: z.string(), short: z.string(), version: z.string(), sha256: z.string() });
/** Findings between protocol A and B, from A's side: `lines` are in A, `otherLines` in B. */
export const Crosscheck = z.object({ a: Side, b: Side, model: z.string(), builtAt: z.string(), findings: z.array(Finding) });
export type Crosscheck = z.infer<typeof Crosscheck>;

export const Registry = z.object({ protocols: z.array(ProtocolEntry) });
export type Registry = z.infer<typeof Registry>;

/** STORE_DIR, else `store/` at the workspace root (found from the cwd: works under bun scripts and Next). */
function defaultRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 5; i++) {
		if (existsSync(join(dir, "packages", "protocol"))) return join(dir, "store");
		dir = dirname(dir);
	}
	return join(process.cwd(), "store");
}

const ROOT = resolve(process.env.STORE_DIR ?? defaultRoot());

// Production: Cloud Run disks are ephemeral, so the store mirrors a GCS bucket.
// Everything is pulled once on first access; every write is pushed.
const BUCKET = process.env.STORE_BUCKET ?? "";
let synced: Promise<void> | null = null;

async function bucket() {
	const { Storage } = await import("@google-cloud/storage");
	return new Storage().bucket(BUCKET);
}

function ready(): Promise<void> {
	if (!BUCKET) return Promise.resolve();
	synced ??= (async () => {
		const [files] = await (await bucket()).getFiles();
		await Promise.all(
			files.map(async (f) => {
				const dest = join(ROOT, f.name);
				if (existsSync(dest)) return;
				await mkdir(dirname(dest), { recursive: true });
				await f.download({ destination: dest });
			}),
		);
	})();
	return synced;
}

async function push(rel: string) {
	if (BUCKET) await (await bucket()).upload(join(ROOT, rel), { destination: rel });
}

async function readJson<T>(rel: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
	await ready();
	try {
		return schema.parse(JSON.parse(await readFile(join(ROOT, rel), "utf8")));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw e;
	}
}

async function writeJson(rel: string, value: unknown) {
	const path = join(ROOT, rel);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 1));
	await push(rel);
}

export const store = {
	root: ROOT,

	registry: () => readJson("registry.json", Registry, { protocols: [] }),
	saveRegistry: (r: Registry) => writeJson("registry.json", r),

	overlay: () => readJson("overlay.json", Overlay, { specVersion: SPEC_VERSION, hospitals: [], participation: [], localRules: [] }),
	saveOverlay: (o: Overlay) => writeJson("overlay.json", Overlay.parse(o)),

	ready,

	async spec(protocolId: string, sha: string): Promise<ProtocolSpec> {
		await ready();
		return ProtocolSpec.parse(JSON.parse(await readFile(join(ROOT, "specs", protocolId, `${sha}.json`), "utf8")));
	},
	saveSpec: (spec: ProtocolSpec) => writeJson(join("specs", spec.doc.id, `${spec.doc.sha256}.json`), spec),

	pdfPath: (sha: string) => join(ROOT, "pdfs", `${sha}.pdf`),
	async savePdf(sha: string, bytes: Uint8Array) {
		await mkdir(join(ROOT, "pdfs"), { recursive: true });
		await writeFile(join(ROOT, "pdfs", `${sha}.pdf`), bytes);
		await push(join("pdfs", `${sha}.pdf`));
	},

	crosscheck: (idA: string, idB: string) => readJson<Crosscheck | null>(join("crosschecks", `${idA}__${idB}.json`), Crosscheck.nullable(), null),
	saveCrosscheck: (c: Crosscheck) => writeJson(join("crosschecks", `${c.a.id}__${c.b.id}.json`), Crosscheck.parse(c)),
	/** Every crosscheck involving a protocol (either side). */
	async crosschecks(protocolId: string): Promise<Crosscheck[]> {
		await ready();
		const names = await readdir(join(ROOT, "crosschecks")).catch(() => [] as string[]);
		const mine = names.filter((n) => n.endsWith(".json") && n.slice(0, -5).split("__").includes(protocolId));
		return (await Promise.all(mine.map((n) => readJson<Crosscheck | null>(join("crosschecks", n), Crosscheck.nullable(), null)))).filter((c): c is Crosscheck => !!c);
	},

	/** The published spec of a protocol (or its newest draft when nothing is published yet). */
	async publishedSpec(protocolId: string): Promise<ProtocolSpec | null> {
		const p = (await this.registry()).protocols.find((x) => x.id === protocolId);
		const sha = p?.published ?? p?.versions.at(-1)?.sha256;
		return p && sha ? this.spec(p.id, sha) : null;
	},
};
