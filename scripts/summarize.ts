/**
 * Fill short EN/FR/NL summaries of every line and translated node titles in published specs.
 *   bun scripts/summarize.ts [--force] [--all] [protocolId ...]
 * Idempotent: lines that already have all three summaries are skipped unless --force.
 * Re-loads the published spec right before each save and merges by page + text, so a
 * concurrent rebuild is never clobbered. SUMMARY_CONCURRENCY (default 6) model calls in flight.
 */
import { resolve } from "node:path";
import { store } from "@bspho/protocol/store";
import { mergeSummaries, summarizeSpec } from "@bspho/protocol/summarize";
import type { ProtocolSpec } from "@bspho/protocol/spec";

const args = process.argv.slice(2);
const force = args.includes("--force");
let ids = args.filter((a) => !a.startsWith("--"));
if (args.includes("--all") || !ids.length) {
	const catalog: { id: string }[] = await Bun.file(resolve(import.meta.dir, "catalog.json")).json();
	ids = [...ids, ...catalog.map((c) => c.id).filter((id) => !ids.includes(id))];
}

const CONC = Number(process.env.SUMMARY_CONCURRENCY ?? 6);
let active = 0;
const queue: (() => void)[] = [];
async function limit<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= CONC) await new Promise<void>((r) => queue.push(r));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		queue.shift()?.();
	}
}

async function save(id: string, done: ProtocolSpec) {
	const fresh = await store.publishedSpec(id);
	if (!fresh) return 0;
	const n = mergeSummaries(fresh, done);
	await store.saveSpec(fresh);
	return n;
}

async function run(id: string) {
	const t0 = Date.now();
	const spec = await store.publishedSpec(id);
	if (!spec) return console.log(`${id}: no spec, skipped`);
	const { stats } = await summarizeSpec(spec, {
		force,
		limit,
		onProgress: (d, t) => {
			if (d % 10 === 0 || d === t) console.log(`  ${id}: ${d}/${t} calls`);
		},
		onCheckpoint: async (s) => {
			await save(id, s);
		},
	});
	const merged = await save(id, spec);
	const c = spec.build.counts;
	console.log(
		`DONE ${id}: lines ${stats.lines} titles ${stats.titles} | this run ok ${stats.ok} rejected ${stats.rejected} (retried ${stats.retried} lines, failed calls ${stats.failedCalls}) | spec sumOk ${c.sumOk} sumRejected ${c.sumRejected} | saved ${merged} lines | ${stats.calls} calls ${JSON.stringify(stats.models)} | tok ${stats.tokensIn}/${stats.tokensOut} | ${((Date.now() - t0) / 1000).toFixed(0)}s`,
	);
}

// Two protocols at a time share the call limit; order is kept for starting.
const PAR = Number(process.env.SUMMARY_PROTOCOLS ?? 2);
let next = 0;
await Promise.all(
	Array.from({ length: PAR }, async () => {
		while (next < ids.length) {
			const id = ids[next++];
			try {
				await run(id);
			} catch (e) {
				console.log(`FAIL ${id}: ${(e as Error).message}`);
			}
		}
	}),
);
