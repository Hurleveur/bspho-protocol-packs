/**
 * Re-run one model pass on published specs, without a full rebuild.
 *   bun scripts/rerun.ts <stages|treatment> [--dry] protocolId ...
 * stages: the diagnostic work-up stages (every line's stage is cleared first, so lines of sections that
 * stop being diagnostics lose theirs). treatment: arms and risk-group paths.
 * --dry prints what would change and saves nothing.
 */
import { stageWorkup, treatmentModel } from "@bspho/protocol/build";
import { store } from "@bspho/protocol/store";

const [pass, ...args] = process.argv.slice(2);
if (pass !== "stages" && pass !== "treatment")
	throw new Error("usage: rerun.ts <stages|treatment> [--dry] id ...");
const dry = args.includes("--dry");
const registry = await store.registry();

await Promise.all(
	args
		.filter((a) => !a.startsWith("--"))
		.map(async (id) => {
			const spec = await store.publishedSpec(id);
			if (!spec) throw new Error(`${id}: no published spec`);
			if (pass === "stages") {
				const family = registry.protocols.find((p) => p.id === id)?.family;
				const before = new Map(
					spec.nodes.flatMap((n) =>
						n.blocks.map((a) => [a, a.stage] as const),
					),
				);
				for (const n of spec.nodes) for (const a of n.blocks) delete a.stage;
				const { staged, moved } = await stageWorkup(
					spec.nodes,
					spec.doc.title,
					family,
				);
				const changed = [...before].filter(([a, st]) => a.stage !== st).length;
				console.log(
					`${id}: ${staged} lines staged, ${changed} changed${moved.length ? `, now diagnostics: ${moved.join(", ")}` : ""}`,
				);
			} else {
				const t = await treatmentModel(spec.doc.title, spec.nodes, spec.edges);
				if (t) spec.treatment = t;
				else delete spec.treatment;
				const name = new Map(spec.nodes.map((n) => [n.id, n.title]));
				console.log(
					`${id}: ${t?.arms.length ?? 0} arms, ${t?.riskGroups.length ?? 0} risk groups\n` +
						(t?.arms
							.map(
								(a) =>
									`  arm ${a.label} (${a.title}): ${a.steps.map((s) => name.get(s)).join(" | ")}`,
							)
							.join("\n") ?? "") +
						"\n" +
						(t?.riskGroups
							.map(
								(g) =>
									`  group ${g.label}: ${g.arms.join(" > ")}[${g.steps.map((s) => name.get(s)?.slice(0, 14)).join(", ")}] rule=${g.rule}`,
							)
							.join("\n") ?? ""),
				);
			}
			if (!dry) await store.saveSpec(spec);
		}),
);
