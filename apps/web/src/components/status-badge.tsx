const STYLES: Record<string, [string, string]> = {
	live: ["Live", "bg-go-soft text-go"],
	closed: ["Closed", "bg-line text-muted"],
	standard_of_care: ["Standard of care", "bg-accent-soft text-accent"],
};

/** Participation status at the current centre. Unset status shows nothing: a badge on every card is noise. */

export function StatusBadge({ status }: { status: string }) {
	const style = STYLES[status];
	if (!style) return null;
	const [label, cls] = style;
	return (
		<span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
			{label}
		</span>
	);
}
