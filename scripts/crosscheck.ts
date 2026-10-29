/**
 * Cross-protocol "Check these": discrepancies between protocols a patient can be under at the
 * same time. Pairs = each master protocol with each of its sub-protocols (registry parentId), plus
 * the overlay's `usedTogether` pairs. One Gemini Pro call per pair, sequential (the Pro per-minute
 * quota is small). Stored per pair, keyed by both PDF shas; a pair already checked at the same
 * versions is skipped unless --force.
 *   bun scripts/crosscheck.ts [protocolId ...] [--force]
 */
import { crossFindings } from "@bspho/protocol/consistency";
import { store } from "@bspho/protocol/store";

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));

const [registry, overlay] = await Promise.all([store.registry(), store.overlay()]);
const pairs: [string, string][] = [
	...registry.protocols.filter((p) => p.kind === "subprotocol" && p.parentId).map((p) => [p.parentId!, p.id] as [string, string]),
	...(overlay.usedTogether ?? []),
];
const seen = new Set<string>();
for (const [a, b] of pairs) {
	const key = [a, b].sort().join("|");
	if (seen.has(key) || a === b) continue;
	seen.add(key);
	if (only.length && !only.includes(a) && !only.includes(b)) continue;
	const ea = registry.protocols.find((p) => p.id === a);
	const eb = registry.protocols.find((p) => p.id === b);
	const [sa, sb] = await Promise.all([store.publishedSpec(a), store.publishedSpec(b)]);
	if (!ea || !eb || !sa || !sb) {
		console.log(`${a} × ${b}: skipped (not built)`);
		continue;
	}
	const prev = await store.crosscheck(a, b);
	if (!force && prev && prev.a.sha256 === sa.doc.sha256 && prev.b.sha256 === sb.doc.sha256) {
		console.log(`${a} × ${b}: up to date (${prev.findings.length} findings)`);
		continue;
	}
	const t = performance.now();
	let tokens = { in: 0, out: 0 };
	try {
		const r = await crossFindings({ spec: sa, name: ea.short }, { spec: sb, name: eb.short }, (u) => {
			tokens = { in: tokens.in + (u.inputTokens ?? 0), out: tokens.out + (u.outputTokens ?? 0) };
		});
		await store.saveCrosscheck({
			a: { id: a, short: ea.short, version: sa.doc.version, sha256: sa.doc.sha256 },
			b: { id: b, short: eb.short, version: sb.doc.version, sha256: sb.doc.sha256 },
			model: r.model,
			builtAt: new Date().toISOString(),
			findings: r.findings,
		});
		console.log(`${a} × ${b}: ${r.findings.length} findings, ${r.model}, ${tokens.in} in / ${tokens.out} out tokens, ${Math.round((performance.now() - t) / 1000)}s`);
	} catch (e) {
		console.log(`${a} × ${b}: FAILED ${(e as Error).message?.slice(0, 200)}`);
	}
}
