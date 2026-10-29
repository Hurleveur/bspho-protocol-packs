/** "6.0" -> "v6.0", "v2.2" -> "v2.2", "final 7.0 (05 Sep 2020)" and "30 Nov 2006" stay as printed. */
export function formatVersion(v?: string | null): string {
	if (!v) return "version not printed";
	const s = v.trim().replace(/^v(?=\d)/i, "");
	return /^\d/.test(s) && !/^\d{1,2}\s+[A-Za-z]{3}/.test(s) ? `v${s}` : s;
}

/** "2025-03-07" -> "7 Mar 2025"; anything else stays as printed. */
export function formatDate(d?: string | null): string | undefined {
	const m = d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim()) : null;
	if (!m) return d ?? undefined;
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
	return `${Number(m[3])} ${month} ${m[1]}`;
}

/** A quoted line for tooltips: no leading list glyph (PDF symbol fonts map bullets to private-use characters). */
export const quoteLine = (t: string) =>
	t
		.replace(/[-]/g, "")
		.replace(/^\s*(?:[•●▪◦■□♦◆►▸➢➤✓✔\-–]|o(?=\s))\s*/, "")
		.trim();
