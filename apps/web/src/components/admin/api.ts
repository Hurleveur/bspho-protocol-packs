/** JSON call to an /internal/admin route; throws the server's plain-language error. */
export async function send<T = unknown>(
	url: string,
	method: "POST" | "PATCH" | "DELETE",
	body: unknown,
): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const j = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) throw new Error(j.error ?? `Could not save (${res.status})`);
	return j as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const when = (iso: string) =>
	new Date(iso).toLocaleString("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
