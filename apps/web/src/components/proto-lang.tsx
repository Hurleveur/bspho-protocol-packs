"use client";

import type { Anchor, Lang, Node } from "@bspho/protocol/spec";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

/** How the sheet shows protocol text: a short summary in one language, or the verbatim original. */
export type ProtoLang = Lang | "orig";

export const PROTO_LANGS: { id: ProtoLang; label: string; short?: string }[] = [
	{ id: "en", label: "Summary · English", short: "Summary · EN" },
	{ id: "fr", label: "Résumé · Français", short: "Résumé · FR" },
	{ id: "nl", label: "Samenvatting · Nederlands", short: "Samenvatting · NL" },
	{ id: "orig", label: "Original text" },
];

const KEY = "bspho.protoLang";
const DEFAULT: ProtoLang = "en";

interface LangApi {
	lang: ProtoLang;
	setLang: (l: ProtoLang) => void;
}

const LangContext = createContext<LangApi>({ lang: DEFAULT, setLang: () => {} });

/** Per-browser setting (localStorage); renders the default until mounted so SSR and hydration agree. */
export function ProtoLangProvider({ children }: { children: React.ReactNode }) {
	const [lang, set] = useState<ProtoLang>(DEFAULT);
	useEffect(() => {
		try {
			const v = localStorage.getItem(KEY);
			if (v && PROTO_LANGS.some((l) => l.id === v)) set(v as ProtoLang);
		} catch {}
	}, []);
	const setLang = useCallback((l: ProtoLang) => {
		set(l);
		try {
			localStorage.setItem(KEY, l);
		} catch {}
	}, []);
	return <LangContext value={{ lang, setLang }}>{children}</LangContext>;
}

export const useProtoLang = () => useContext(LangContext);

/** The summary of a line in the chosen language, if it has one; undefined means show the original. */
export const summaryOf = (a: Anchor, lang: ProtoLang): string | undefined =>
	lang === "orig" ? undefined : a.sum?.[lang]?.trim() || undefined;

/** A section heading in the chosen language, falling back to the protocol's own. */
export const titleOf = (n: Pick<Node, "title" | "titles">, lang: ProtoLang): string =>
	(lang !== "orig" && n.titles?.[lang]?.trim()) || n.title;
