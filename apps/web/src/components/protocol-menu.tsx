"use client";

import { ArrowLeft, Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface Item {
	id: string;
	short: string;
	family: string;
}

/** The header's protocol switcher: back to the shelf, or straight to another protocol at this centre. */
export function ProtocolMenu({ current, protocols }: { current: string; protocols: Item[] }) {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent | KeyboardEvent) => {
			if (
				e instanceof KeyboardEvent
					? e.key === "Escape"
					: !box.current?.contains(e.target as Node)
			)
				setOpen(false);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", close);
		};
	}, [open]);
	const families = [...new Set(protocols.map((p) => p.family))];
	return (
		<div ref={box} className="relative shrink-0">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="menu"
				aria-expanded={open}
				className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-sm whitespace-nowrap transition-colors hover:text-accent ${open ? "text-accent" : "text-muted"}`}
			>
				Protocols <ChevronDown size={15} aria-hidden />
			</button>
			{open && (
				<div
					role="menu"
					className="absolute top-full left-0 z-50 mt-1.5 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-lg"
				>
					<Link
						href="/"
						role="menuitem"
						className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent-soft"
					>
						<ArrowLeft size={15} aria-hidden /> All protocols
					</Link>
					{families.map((f) => (
						<div key={f} className="mt-1 border-t border-line pt-1">
							<p className="px-3 pt-1.5 pb-1 text-[13px] font-semibold text-muted">
								{f}
							</p>
							{protocols
								.filter((p) => p.family === f)
								.map((p) => (
									<Link
										key={p.id}
										href={`/p/${p.id}`}
										role="menuitem"
										aria-current={p.id === current ? "page" : undefined}
										className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm hover:bg-accent-soft ${p.id === current ? "font-semibold text-accent" : ""}`}
									>
										{p.short}
										{p.id === current && <Check size={15} aria-hidden />}
									</Link>
								))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
