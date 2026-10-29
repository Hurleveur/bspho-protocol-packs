"use client";

import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useEffect, useRef } from "react";

export type Flash = { text: string; error: boolean } | null;

/** Confirmation that a change was saved, in view however far the page is scrolled. */
export function Toast({ flash, onDone }: { flash: Flash; onDone: () => void }) {
	const done = useRef(onDone);
	useEffect(() => {
		done.current = onDone;
	});
	useEffect(() => {
		if (!flash || flash.error) return;
		const t = setTimeout(() => done.current(), 3500);
		return () => clearTimeout(t);
	}, [flash]);
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
		>
			{flash && (
				<p
					className={`pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-lg ${
						flash.error
							? "border-warn/40 bg-warn-soft text-warn"
							: "border-go/30 bg-surface text-ink"
					}`}
				>
					{flash.error ? (
						<CircleAlertIcon className="size-4 shrink-0" />
					) : (
						<CircleCheckIcon className="size-4 shrink-0 text-go" />
					)}
					{flash.text}
					{flash.error && (
						<button
							type="button"
							onClick={onDone}
							className="ml-2 font-medium underline"
						>
							Close
						</button>
					)}
				</p>
			)}
		</div>
	);
}
