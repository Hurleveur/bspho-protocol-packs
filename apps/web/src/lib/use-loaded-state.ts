"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** False on the server and during hydration, true from the first client render after it. */
function useHydrated(): boolean {
	return useSyncExternalStore(
		noSubscribe,
		() => true,
		() => false,
	);
}

/**
 * State whose value is read back from the browser (Web Storage, the URL) once per `key`.
 * The server and hydration render `initial`, so markup matches; the load runs on the first
 * client render after that, and again whenever `key` changes. `load` returning undefined
 * keeps the current value (nothing stored, or unreadable storage).
 */
export function useLoadedState<T>(
	key: string,
	load: () => T | undefined,
	initial: T | (() => T),
) {
	const hydrated = useHydrated();
	const [value, setValue] = useState(initial);
	const [loadedKey, setLoadedKey] = useState<string | null>(null);
	if (hydrated && loadedKey !== key) {
		setLoadedKey(key);
		const v = load();
		if (v !== undefined) setValue(v);
	}
	return [value, setValue] as const;
}
