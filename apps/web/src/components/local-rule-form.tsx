"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** "+ Local rule": a hospital adds its own rule under a protocol section. Shown separately, never merged. */
export function LocalRuleForm({
	protocolId,
	hospital,
	hospitalName,
	nodeId,
}: {
	protocolId: string;
	hospital: string;
	hospitalName: string;
	nodeId: string;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [author, setAuthor] = useState("");
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);

	if (!open)
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="no-print mt-3 flex items-center gap-1 text-sm text-local hover:underline"
			>
				<Plus size={14} /> Add a {hospitalName} local rule
			</button>
		);

	return (
		<form
			className="no-print mt-3 grid gap-2 rounded-lg border border-local/30 bg-local-soft p-3"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				const res = await fetch("/internal/local-rules", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						protocolId,
						hospital,
						nodeId,
						text,
						author,
						sourceTitle: source || undefined,
					}),
				});
				setBusy(false);
				if (res.ok) {
					setOpen(false);
					setText("");
					router.refresh();
				}
			}}
		>
			<p className="text-xs font-semibold tracking-wide text-local uppercase">
				{hospitalName} local rule
			</p>
			<textarea
				required
				autoFocus
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={2}
				placeholder="e.g. Platelets ≥ 50 ×10⁹/L before lumbar puncture"
				className="rounded-md border border-line bg-surface px-3 py-2"
			/>
			<div className="flex gap-2">
				<input
					required
					value={author}
					onChange={(e) => setAuthor(e.target.value)}
					placeholder="Your name"
					className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
				/>
				<input
					value={source}
					onChange={(e) => setSource(e.target.value)}
					placeholder="Source (local SOP, optional)"
					className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
				/>
				<button
					type="button"
					onClick={() => setOpen(false)}
					className="rounded-md px-3 text-sm text-muted"
				>
					Cancel
				</button>
				<button
					disabled={busy}
					className="rounded-md bg-local px-3 text-sm text-white disabled:opacity-50"
				>
					{busy ? "Saving…" : "Save rule"}
				</button>
			</div>
		</form>
	);
}
