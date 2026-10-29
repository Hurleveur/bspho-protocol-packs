"use client";

import type { AskResult } from "@bspho/protocol/ask";
import { ArrowLeft, CornerDownLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/** Long-tail questions across the centre's protocols. Every point shows the protocol passage it rests on. */
export function AskView({
	hospital,
	protocolCount,
}: {
	hospital: string;
	protocolCount: number;
}) {
	const [q, setQ] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<AskResult | null>(null);
	const [error, setError] = useState("");

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (q.trim().length < 3) return;
		setBusy(true);
		setError("");
		setResult(null);
		const res = await fetch("/internal/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: q }),
		});
		const body = await res.json();
		setBusy(false);
		if (!res.ok) setError(body.error ?? "Something went wrong.");
		else setResult(body);
	}

	return (
		<div className="mx-auto max-w-4xl px-8 py-10">
			<Link
				href="/"
				className="flex items-center gap-1 text-sm text-muted hover:text-accent"
			>
				<ArrowLeft size={16} /> Protocols
			</Link>
			<h1 className="mt-4 text-3xl font-semibold tracking-tight">
				Ask the protocols
			</h1>
			<p className="mt-2 text-muted">
				Searches the {protocolCount} protocols {hospital} runs. Answers only
				from protocol text, with the passage and page under every point.
			</p>
			<form
				onSubmit={submit}
				className="mt-6 flex items-center gap-2 rounded-lg border border-line bg-surface p-2 focus-within:border-accent"
			>
				<input
					autoFocus
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="e.g. I have a patient with 150 000 WBC, what are the next steps?"
					className="flex-1 bg-transparent px-2 py-2 text-lg outline-none placeholder:text-faint"
				/>
				<button
					disabled={busy}
					className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-white disabled:opacity-50"
				>
					{busy ? (
						<LoaderCircle size={16} className="animate-spin" />
					) : (
						<CornerDownLeft size={16} />
					)}{" "}
					Ask
				</button>
			</form>

			{busy && (
				<p className="mt-6 text-muted">
					Searching protocol text and checking every passage…
				</p>
			)}
			{error && <p className="mt-6 text-warn">{error}</p>}

			{result && (
				<div className="mt-8">
					<p
						className={`text-lg ${result.mode === "refuse" ? "text-warn" : ""}`}
					>
						{result.summary}
					</p>
					{result.clarifyingQuestion && (
						<p className="mt-2 font-medium text-flow">
							{result.clarifyingQuestion}
						</p>
					)}
					<div className="mt-6 grid gap-5">
						{Object.entries(
							Object.groupBy(
								result.points,
								(p) => p.cites[0]?.protocol ?? p.protocol,
							),
						).map(([protocol, points]) => (
							<section key={protocol}>
								<h2 className="mb-2 font-semibold">{protocol}</h2>
								<div className="grid gap-3">
									{points?.map((p, i) => (
										<div
											key={i}
											className="rounded-lg border border-line bg-surface p-4"
										>
											<p>{p.text}</p>
											{p.cites.map((c) => (
												<Link
													key={c.id}
													href={`/p/${c.protocolId}?n=${c.nodeId}`}
													className="mt-2 block rounded-md bg-paper px-3 py-2 text-sm text-muted hover:text-ink"
												>
													<span className="verbatim">
														“{c.anchor.text}”
													</span>
													<span className="mt-1 block font-mono text-[11px] text-faint">
														{c.protocol} v{c.version} · p.{" "}
														{c.anchor.page} · {c.section}
													</span>
												</Link>
											))}
										</div>
									))}
								</div>
							</section>
						))}
					</div>
					{result.notCovered.length > 0 && (
						<p className="mt-6 text-sm text-muted">
							Not covered by the protocol text:{" "}
							{result.notCovered.join("; ")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
