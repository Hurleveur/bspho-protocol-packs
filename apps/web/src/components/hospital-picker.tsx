"use client";

import { useRouter } from "next/navigation";

export function HospitalPicker({
	hospitals,
	current,
}: {
	hospitals: { id: string; name: string }[];
	current: string;
}) {
	const router = useRouter();
	return (
		<label className="flex items-center gap-2 text-sm text-muted">
			Centre
			<select
				className="rounded-md border border-line bg-surface px-2 py-2 text-ink"
				value={current}
				onChange={(e) => {
					document.cookie = `hospital=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
					router.refresh();
				}}
			>
				{hospitals.map((h) => (
					<option key={h.id} value={h.id}>
						{h.name}
					</option>
				))}
			</select>
		</label>
	);
}
