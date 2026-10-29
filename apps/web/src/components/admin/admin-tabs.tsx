"use client";

import { type ReactNode, useEffect, useState } from "react";

export type Tab = {
	id: string;
	label: string;
	count?: number;
	alert?: boolean;
	panel: ReactNode;
};

/** Tabs kept mounted (an upload in progress survives a tab switch), selected tab in the URL hash. */
export function AdminTabs({ tabs }: { tabs: Tab[] }) {
	const [active, setActive] = useState(tabs[0]?.id ?? "");
	useEffect(() => {
		const sync = () => {
			const id = window.location.hash.slice(1);
			if (tabs.some((t) => t.id === id)) setActive(id);
		};
		sync();
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, [tabs]);
	return (
		<div>
			<div
				role="tablist"
				className="mb-8 flex flex-wrap gap-1 border-b border-line"
			>
				{tabs.map((t) => (
					<button
						type="button"
						key={t.id}
						role="tab"
						aria-selected={active === t.id}
						onClick={() => {
							setActive(t.id);
							window.history.replaceState(null, "", `#${t.id}`);
						}}
						className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
							active === t.id
								? "border-accent text-accent"
								: "border-transparent text-muted hover:text-ink"
						}`}
					>
						{t.label}
						{t.count !== undefined && (
							<span
								className={`rounded-full px-1.5 py-px text-[11px] tabular-nums ${t.alert ? "bg-warn-soft text-warn" : "bg-line/70 text-muted"}`}
							>
								{t.count}
							</span>
						)}
					</button>
				))}
			</div>
			{tabs.map((t) => (
				<div key={t.id} role="tabpanel" hidden={active !== t.id}>
					{t.panel}
				</div>
			))}
		</div>
	);
}
