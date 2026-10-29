/**
 * Upload workflow shared by the admin screen and the seed script:
 * PDF → spec (draft version) → compare with the published version → publish.
 */
import { type BuildInput, buildSpec, type StageEvent } from "./build.ts";
import { sha256 } from "./pdf.ts";
import type { ProtocolSpec } from "./spec.ts";
import { type Family, type ProtocolEntry, store } from "./store.ts";

export interface IngestInput {
	pdf: Uint8Array;
	fileName: string;
	uploadedBy: string;
	onStage?: (e: StageEvent) => void;
	/** Catalogue data an admin already knows (seed, or confirmed on the upload screen). */
	identity?: {
		id: string;
		short: string;
		title?: string;
		version?: string;
		family: Family;
		kind: ProtocolEntry["kind"];
		parentId?: string;
	};
	offline?: BuildInput["offline"];
}

export async function ingestPdf(input: IngestInput): Promise<{
	spec: ProtocolSpec;
	entry: ProtocolEntry;
	previous: ProtocolSpec | null;
}> {
	const registry = await store.registry();
	const known = registry.protocols
		.filter((p) => p.published)
		.map((p) => {
			const v = p.versions.find((x) => x.sha256 === p.published)!;
			return {
				id: p.id,
				short: p.short,
				title: p.title,
				version: v.version,
				sha256: v.sha256,
			};
		});
	const spec = await buildSpec({
		pdf: input.pdf,
		known,
		onStage: input.onStage,
		offline: input.offline,
		family: input.identity?.family,
	});
	if (input.identity) {
		spec.doc.id = input.identity.id;
		spec.doc.short = input.identity.short;
		if (input.identity.title) spec.doc.title = input.identity.title;
		// A version the catalogue (or the admin) already knows beats the one guessed from the PDF text.
		if (input.identity.version) spec.doc.version = input.identity.version;
	}
	let entry = registry.protocols.find((p) => p.id === spec.doc.id);
	if (!entry) {
		entry = {
			id: spec.doc.id,
			short: spec.doc.short,
			title: spec.doc.title,
			family: input.identity?.family ?? "other",
			kind: input.identity?.kind ?? "protocol",
			...(input.identity?.parentId ? { parentId: input.identity.parentId } : {}),
			published: null,
			versions: [],
		};
		registry.protocols.push(entry);
	}
	const previousSha = entry.published;
	if (previousSha && previousSha !== spec.doc.sha256) {
		const prev = entry.versions.find((v) => v.sha256 === previousSha)!;
		spec.doc.supersedes = { version: prev.version, sha256: prev.sha256 };
	}
	if (!entry.versions.some((v) => v.sha256 === spec.doc.sha256)) {
		entry.versions.push({
			sha256: spec.doc.sha256,
			version: spec.doc.version,
			date: spec.doc.date,
			fileName: input.fileName,
			uploadedAt: new Date().toISOString(),
			uploadedBy: input.uploadedBy,
			state: "draft",
		});
	}
	await store.savePdf(spec.doc.sha256, input.pdf);
	await store.saveSpec(spec);
	await store.saveRegistry(registry);
	const previous =
		previousSha && previousSha !== spec.doc.sha256
			? await store.spec(entry.id, previousSha)
			: null;
	return { spec, entry, previous };
}

export async function publish(protocolId: string, sha: string): Promise<void> {
	const registry = await store.registry();
	const entry = registry.protocols.find((p) => p.id === protocolId);
	if (!entry) throw new Error(`unknown protocol ${protocolId}`);
	for (const v of entry.versions) {
		if (v.sha256 === sha) v.state = "published";
		else if (v.state === "published") v.state = "superseded";
	}
	entry.published = sha;
	await store.saveRegistry(registry);
}

export { sha256 };
