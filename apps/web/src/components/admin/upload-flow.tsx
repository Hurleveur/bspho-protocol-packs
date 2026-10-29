"use client";

import type { HospitalStatus, Warning } from "@bspho/protocol/spec";
import type { Family } from "@bspho/protocol/store";
import {
	ArrowRightIcon,
	CircleCheckIcon,
	FileTextIcon,
	FileUpIcon,
	RotateCcwIcon,
	TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Changes } from "./changes";
import { Pipeline } from "./pipeline";
import type { ParticipationLite, StageEvent, StageName, UploadResult } from "./types";

type Phase =
	| { name: "idle" }
	| { name: "running"; file: File }
	| { name: "failed"; file: File; message: string }
	| { name: "ready"; file: File; result: UploadResult }
	| { name: "published"; file: File; result: UploadResult; version: string };

const STATUS_LABELS: Record<HospitalStatus, string> = {
	live: "Live: recruiting patients",
	closed: "Closed: no longer used",
	standard_of_care: "Standard of care: trial closed, protocol still the standard",
	unknown: "Not set",
};

const v = (s: string) =>
	s ? `version ${s.replace(/^v/i, "")}` : "an unnumbered version";

/** Read a text/event-stream response, calling `on` per event. */
async function readEvents(res: Response, on: (event: string, data: unknown) => void) {
	if (!res.body) return;
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += value;
		let i: number;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const chunk = buf.slice(0, i);
			buf = buf.slice(i + 2);
			let event = "message";
			let data = "";
			for (const line of chunk.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data) on(event, JSON.parse(data));
		}
	}
}

/** Plain-language warnings, grouped by kind. */
function plainWarnings(result: UploadResult): string[] {
	const by = new Map<string, Warning[]>();
	for (const w of result.warnings) by.set(w.code, [...(by.get(w.code) ?? []), w]);
	const out: string[] = [];
	const missing = result.counts.steps - result.counts.stepsWithStart;
	if (missing > 0)
		out.push(
			`${missing} of ${result.counts.steps} treatment steps have no "requirements to start" section. Doctors will see "not found in these pages" for them, with the pages to check.`,
		);
	for (const [code, ws] of by) {
		const pages = ws.map((w) => w.page).filter((p): p is number => p !== undefined);
		const list =
			pages.length > 6
				? `${pages.slice(0, 6).join(", ")} and ${pages.length - 6} more`
				: pages.join(", ");
		if (code === "raster_page")
			out.push(
				`${ws.length === 1 ? "1 page is" : `${ws.length} pages are`} pictures (flowcharts or scanned tables), p. ${list}. They are shown as the original page but can't be searched.`,
			);
		else if (code === "edge_evidence_unresolved")
			out.push(
				`${ws.length} links between sections could not be backed by a sentence in the PDF. They are shown as dashed, "inferred from the order of the document".`,
			);
		else out.push(...ws.map((w) => w.message));
	}
	return out;
}

export function UploadFlow({
	hospitals,
	participation,
	familyLabels,
}: {
	hospitals: { id: string; name: string }[];
	participation: ParticipationLite[];
	familyLabels: Record<Family, string>;
}) {
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const [phase, setPhase] = useState<Phase>({ name: "idle" });
	const [events, setEvents] = useState<Partial<Record<StageName, StageEvent>>>({});
	const [activeSince, setActiveSince] = useState(0);
	const [dragging, setDragging] = useState(false);
	// The first stages finish within a second: reveal events one at a time so each step reads.
	const reveal = useRef<Promise<void>>(Promise.resolve());
	const later = (fn: () => void) => {
		reveal.current = reveal.current.then(() => {
			fn();
			return new Promise((r) => setTimeout(r, 450));
		});
	};

	// Publish form
	const [ticked, setTicked] = useState<Set<string>>(new Set());
	const [status, setStatus] = useState<HospitalStatus>("live");
	const [short, setShort] = useState("");
	const [family, setFamily] = useState<Family>("other");
	const [publishing, setPublishing] = useState(false);
	const [publishError, setPublishError] = useState<string | null>(null);

	async function start(file: File) {
		if (
			!file.name.toLowerCase().endsWith(".pdf") &&
			file.type !== "application/pdf"
		) {
			setPhase({
				name: "failed",
				file,
				message: "This is not a PDF. Please choose the protocol PDF.",
			});
			return;
		}
		reveal.current = Promise.resolve();
		setEvents({});
		setActiveSince(Date.now());
		setPublishError(null);
		setPhase({ name: "running", file });
		const body = new FormData();
		body.append("file", file);
		try {
			const res = await fetch("/internal/upload", { method: "POST", body });
			if (!res.ok || !res.body) {
				const j = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(j.error ?? `Upload failed (${res.status})`);
			}
			let finished = false;
			await readEvents(res, (event, data) => {
				if (event === "stage") {
					const e = data as StageEvent;
					if (e.stage === "done") return;
					later(() => {
						setEvents((prev) => ({ ...prev, [e.stage]: e }));
						setActiveSince(Date.now());
					});
				} else if (event === "result") {
					finished = true;
					const r = data as UploadResult;
					const current = participation.filter(
						(p) => p.protocolId === r.protocolId && p.participating,
					);
					later(() => {
						setTicked(new Set(current.map((p) => p.hospital)));
						setStatus(
							current[0]?.status && current[0].status !== "unknown"
								? current[0].status
								: "live",
						);
						setShort(r.short);
						setFamily(r.family);
						setPhase({ name: "ready", file, result: r });
						router.refresh();
					});
				} else if (event === "error") {
					finished = true;
					const message = (data as { message: string }).message;
					later(() => setPhase({ name: "failed", file, message }));
				}
			});
			if (!finished)
				throw new Error("The connection closed before the protocol was ready.");
		} catch (e) {
			setPhase({
				name: "failed",
				file,
				message: e instanceof Error ? e.message : String(e),
			});
		}
	}

	async function doPublish(result: UploadResult, file: File) {
		setPublishing(true);
		setPublishError(null);
		try {
			const res = await fetch("/internal/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					protocolId: result.protocolId,
					sha256: result.sha256,
					hospitals: [...ticked],
					status,
					...(result.isNew
						? { identity: { short: short.trim() || result.short, family } }
						: {}),
				}),
			});
			const j = (await res.json()) as { error?: string; version?: string };
			if (!res.ok) throw new Error(j.error ?? `Publish failed (${res.status})`);
			setPhase({
				name: "published",
				file,
				result,
				version: j.version ?? result.version,
			});
			router.refresh();
		} catch (e) {
			setPublishError(e instanceof Error ? e.message : String(e));
		} finally {
			setPublishing(false);
		}
	}

	const reset = () => {
		setPhase({ name: "idle" });
		setEvents({});
	};

	if (phase.name === "idle")
		return (
			<div
				role="button"
				tabIndex={0}
				onClick={() => input.current?.click()}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						input.current?.click();
					}
				}}
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragging(false);
					const f = e.dataTransfer.files[0];
					if (f) void start(f);
				}}
				className={`flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-8 py-16 text-center transition-colors ${
					dragging
						? "border-accent bg-accent-soft"
						: "border-line bg-surface hover:border-accent/60"
				}`}
			>
				<FileUpIcon
					className={`size-10 ${dragging ? "text-accent" : "text-faint"}`}
					strokeWidth={1.5}
				/>
				<span className="text-xl font-semibold">
					Drop the new protocol PDF here
				</span>
				<span className="text-muted">
					or click to choose a file. We recognise the protocol and its version
					for you.
				</span>
				<input
					ref={input}
					type="file"
					accept="application/pdf,.pdf"
					className="hidden"
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => {
						const f = e.target.files?.[0];
						e.target.value = "";
						if (f) void start(f);
					}}
				/>
			</div>
		);

	const { file } = phase;
	const result =
		phase.name === "ready" || phase.name === "published" ? phase.result : null;

	return (
		<div className="grid gap-6">
			<div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface px-5 py-3">
				<div className="flex min-w-0 items-center gap-3">
					<FileTextIcon className="size-5 shrink-0 text-accent" />
					<span className="truncate font-medium">{file.name}</span>
					<span className="shrink-0 font-mono text-xs text-faint">
						{(file.size / 1024 / 1024).toFixed(1)} MB
					</span>
				</div>
				{phase.name !== "running" && (
					<button
						type="button"
						onClick={reset}
						className="flex shrink-0 items-center gap-1.5 text-sm text-muted hover:text-accent"
					>
						<RotateCcwIcon className="size-3.5" /> Upload another
					</button>
				)}
			</div>

			<div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
				<section className="self-start rounded-lg border border-line bg-surface p-5">
					<h2 className="mb-4 text-sm font-semibold tracking-wide text-muted uppercase">
						Turning the PDF into a protocol pack
					</h2>
					<Pipeline
						events={events}
						failed={phase.name === "failed"}
						activeSince={activeSince}
					/>
					{phase.name === "failed" && (
						<div className="mt-5 rounded-md bg-warn-soft p-3 text-sm text-warn">
							<p className="font-medium">
								This PDF could not be processed.
							</p>
							<p className="mt-1 break-words">{phase.message}</p>
							<button
								type="button"
								onClick={() => void start(file)}
								className="mt-2 font-medium underline"
							>
								Try again
							</button>
						</div>
					)}
				</section>

				<div className="grid min-w-0 content-start gap-6">
					{!result && phase.name === "running" && (
						<div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-muted">
							The protocol summary appears here when the steps on the left
							are done.
						</div>
					)}
					{result && (
						<>
							<section className="rounded-lg border border-line bg-surface p-5">
								{result.isNew ? (
									<>
										<p className="text-sm font-medium tracking-wide text-accent uppercase">
											New protocol
										</p>
										<h2 className="mt-1 text-2xl font-semibold tracking-tight">
											{result.title}
										</h2>
										<p className="mt-1 text-muted">
											{v(result.version)}
											{result.date
												? `, dated ${result.date}`
												: ""}{" "}
											· {result.pageCount} pages
										</p>
										{phase.name === "ready" && (
											<div className="mt-4 grid gap-3 rounded-md bg-paper p-4 sm:grid-cols-2">
												<label className="grid gap-1 text-sm">
													<span className="text-muted">
														Short name doctors will see
													</span>
													<input
														value={short}
														onChange={(e) =>
															setShort(e.target.value)
														}
														className="rounded-md border border-line bg-surface px-3 py-2 text-ink"
													/>
												</label>
												<label className="grid gap-1 text-sm">
													<span className="text-muted">
														Disease group
													</span>
													<select
														value={family}
														onChange={(e) =>
															setFamily(
																e.target
																	.value as Family,
															)
														}
														className="rounded-md border border-line bg-surface px-3 py-2 text-ink"
													>
														{(
															Object.keys(
																familyLabels,
															) as Family[]
														).map((f) => (
															<option key={f} value={f}>
																{familyLabels[f]}
															</option>
														))}
													</select>
												</label>
											</div>
										)}
									</>
								) : (
									<>
										<p className="text-sm font-medium tracking-wide text-go uppercase">
											Recognised
										</p>
										<h2 className="mt-1 text-2xl font-semibold tracking-tight">
											{result.short},{" "}
											{result.alreadyPublished
												? v(result.version)
												: `new ${v(result.version)}`}
											{result.supersedes ? (
												<span className="text-muted">
													{" "}
													replaces {result.supersedes.version}
												</span>
											) : null}
										</h2>
										<p className="mt-1 text-muted">
											{result.date
												? `Dated ${result.date} · `
												: ""}
											{result.pageCount} pages
										</p>
										{result.alreadyPublished && (
											<p className="mt-3 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
												This exact PDF is already the published
												version. Nothing changes for doctors.
											</p>
										)}
									</>
								)}

								<dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
									{[
										["Sections", result.counts.sections],
										["Treatment steps", result.counts.steps],
										[
											"Steps with start requirements",
											result.counts.stepsWithStart,
										],
										["Links between sections", result.counts.links],
									].map(([label, n]) => (
										<div
											key={label}
											className="rounded-md border border-line px-3 py-2.5"
										>
											<dt className="text-xs text-muted">
												{label}
											</dt>
											<dd className="mt-0.5 text-2xl font-semibold tabular-nums">
												{n}
											</dd>
										</div>
									))}
								</dl>

								{plainWarnings(result).length > 0 && (
									<div className="mt-5">
										<h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-warn">
											<TriangleAlertIcon className="size-4" />{" "}
											Worth knowing
										</h3>
										<ul className="grid gap-1.5 text-sm text-muted">
											{plainWarnings(result).map((w, i) => (
												<li
													key={i}
													className="border-l-2 border-warn/40 pl-3"
												>
													{w}
												</li>
											))}
										</ul>
									</div>
								)}
							</section>

							{result.diff && <Changes diff={result.diff} />}

							{phase.name === "published" ? (
								<section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-go/40 bg-go-soft p-5">
									<p className="flex items-center gap-2 text-lg font-semibold text-go">
										<CircleCheckIcon className="size-6" />{" "}
										Published, doctors now see {v(phase.version)}
									</p>
									<Link
										href={`/p/${result.protocolId}`}
										className="flex items-center gap-1.5 rounded-md bg-go px-4 py-2 font-medium text-white hover:opacity-90"
									>
										Open {short || result.short}{" "}
										<ArrowRightIcon className="size-4" />
									</Link>
								</section>
							) : (
								<section className="rounded-lg border border-line bg-surface p-5">
									<h3 className="font-semibold">
										Who uses this protocol
									</h3>
									<p className="text-sm text-muted">
										Ticked hospitals see it on their shelf. Already
										ticked: the hospitals using it today.
									</p>
									<div className="mt-4 grid gap-2 sm:grid-cols-2">
										{hospitals.map((h) => (
											<label
												key={h.id}
												className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors ${
													ticked.has(h.id)
														? "border-accent bg-accent-soft"
														: "border-line hover:border-accent/50"
												}`}
											>
												<input
													type="checkbox"
													className="size-4 accent-[var(--accent)]"
													checked={ticked.has(h.id)}
													onChange={(e) => {
														const next = new Set(ticked);
														if (e.target.checked)
															next.add(h.id);
														else next.delete(h.id);
														setTicked(next);
													}}
												/>
												<span className="font-medium">
													{h.name}
												</span>
												<span className="ml-auto font-mono text-xs text-faint">
													{h.id}
												</span>
											</label>
										))}
									</div>
									<label className="mt-4 grid gap-1 text-sm sm:max-w-md">
										<span className="text-muted">
											Status at these hospitals
										</span>
										<select
											value={status}
											onChange={(e) =>
												setStatus(
													e.target.value as HospitalStatus,
												)
											}
											className="rounded-md border border-line bg-surface px-3 py-2 text-ink"
										>
											{(
												Object.keys(
													STATUS_LABELS,
												) as HospitalStatus[]
											).map((s) => (
												<option key={s} value={s}>
													{STATUS_LABELS[s]}
												</option>
											))}
										</select>
									</label>
									<div className="mt-5 flex flex-wrap items-center gap-4">
										<button
											type="button"
											disabled={publishing}
											onClick={() => void doPublish(result, file)}
											className="rounded-md bg-accent px-5 py-2.5 font-medium text-white transition hover:opacity-90 disabled:opacity-60"
										>
											{publishing
												? "Saving…"
												: result.alreadyPublished
													? "Save hospitals"
													: `Publish ${v(result.version)}`}
										</button>
										<span className="text-sm text-muted">
											{result.supersedes
												? `Version ${result.supersedes.version} stays readable in the history.`
												: "Doctors see it as soon as it is published."}
										</span>
									</div>
									{publishError && (
										<p className="mt-3 text-sm text-warn">
											{publishError}
										</p>
									)}
								</section>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
