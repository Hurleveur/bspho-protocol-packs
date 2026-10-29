/**
 * Re-run the diagnostic work-up staging pass on published specs, without a full rebuild.
 *   bun scripts/restage.ts [--dry] protocolId ...
 * Clears every line's stage first, so lines of sections that stop being diagnostics lose theirs.
 * --dry prints what would change and saves nothing.
 */
import { stageWorkup } from "@bspho/protocol/build";
import { store } from "@bspho/protocol/store";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const registry = await store.registry();

for (const id of args.filter((a) => !a.startsWith("--"))) {
  const spec = await store.publishedSpec(id);
  if (!spec) throw new Error(`${id}: no published spec`);
  const family = registry.protocols.find((p) => p.id === id)?.family;
  const before = new Map(spec.nodes.flatMap((n) => n.blocks.map((a) => [a, a.stage] as const)));
  for (const n of spec.nodes) for (const a of n.blocks) delete a.stage;
  const { staged, moved } = await stageWorkup(spec.nodes, spec.doc.title, family);
  const changed = [...before].filter(([a, st]) => a.stage !== st).length;
  console.log(
    `${id}: ${staged} lines staged, ${changed} changed${moved.length ? `, now diagnostics: ${moved.join(", ")}` : ""}`,
  );
  if (!dry) await store.saveSpec(spec);
}
