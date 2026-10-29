import {
	Activity,
	CalendarClock,
	Droplet,
	FlaskConical,
	HeartPulse,
	type LucideIcon,
	Microscope,
	OctagonAlert,
	Pill,
	ScanLine,
	Syringe,
	Thermometer,
} from "lucide-react";

export interface Topic {
	key: string;
	/** Chip / group label. Ours, not the protocol's: it names a category, never restates a requirement. */
	label: string;
	Icon: LucideIcon;
	alert?: boolean;
}

/**
 * Deterministic keyword classifier over a verbatim line: picks the icon and the diagnostics group.
 * First match wins, so the order is the priority (a "do not" line is an alert whatever it is about).
 */
const TOPICS: (Topic & { re: RegExp })[] = [
	{
		key: "stop",
		label: "Caution",
		Icon: OctagonAlert,
		alert: true,
		re: /\b(do not|don't|must not|should not|may not|never|avoid|not recommended|contra-?indicat|prohibited|omit)\b/i,
	},
	{
		key: "performance",
		label: "Performance",
		Icon: Activity,
		re: /karnofsky|lansky|performance status|\becog\b|general condition/i,
	},
	{
		key: "infection",
		label: "No infection",
		Icon: Thermometer,
		re: /infect|fever|febrile|sepsis|mucositis|pyrexi/i,
	},
	{
		key: "counts",
		label: "Counts",
		Icon: Droplet,
		re: /blood counts?|platelet|granulocyte|neutrophil|\banc\b|\bwbc\b|leukocyt|leucocyt|haemoglobin|hemoglobin|\bhb\b|thrombocyt|×10[⁹¹]|x\s?10\s?9|blood cell|full blood|\bfbc\b|\bcbc\b|blasts? in (the )?(peripheral )?blood/i,
	},
	{
		key: "csf",
		label: "CSF / LP",
		Icon: Syringe,
		re: /lumbar puncture|\blp\b|\bcsf\b|intrathecal|cerebrospinal|\bcns\b|cytospin/i,
	},
	{
		key: "marrow",
		label: "Bone marrow",
		Icon: Microscope,
		re: /bone[- ]?marrow|\bbm[ap]?\b|aspirat|biops|trephine|\bmrd\b|morpholog|immunophenotyp|cytogenet|\bfish\b|\bpcr\b|flow[- ]?cytometr|karyotyp|molecular|genetic/i,
	},
	{
		key: "heart",
		label: "Heart",
		Icon: HeartPulse,
		re: /echocardiog|\becho\b|\becg\b|\bekg\b|electrocardiog|cardiac|\blvef\b|shortening fraction|ejection fraction/i,
	},
	{
		key: "imaging",
		label: "Imaging",
		Icon: ScanLine,
		re: /\bmri\b|\bct\b|\bpet\b|ultraso|x-?ray|radiograph|imaging|\bscan|chest film|ophthalmolog|fundoscop/i,
	},
	{
		key: "organ",
		label: "Organ function",
		Icon: FlaskConical,
		re: /renal|kidney|creatinin|liver|hepatic|bilirubin|\balt\b|\bast\b|\bgfr\b|clearance|transaminase|urine|coagulat|chemistr|serolog|pregnan/i,
	},
	{
		key: "drug",
		label: "Drug / dose",
		Icon: Pill,
		re: /\bmg\b|\/m²|\/m2|\bdose|dosage|\bi\.?v\.?\b|infusion|\boral\b|\bp\.?o\.?\b|cytarabine|methotrexate|vincristine|asparaginase|anthracycl|daunorubicin|doxorubicin|steroid|dexamethason|prednison|mitoxantron/i,
	},
	{
		key: "timing",
		label: "Timing",
		Icon: CalendarClock,
		re: /\bday\s?\d|\bdays?\b|\bweeks?\b|\bhours?\b|\bmonths?\b|interval|after (the )?(start|end)/i,
	},
];

export function classify(text: string): Topic | null {
	for (const t of TOPICS) if (t.re.test(text)) return t;
	return null;
}

/** Diagnostics groups, in display order. */
export const DIAG_GROUPS: {
	key: string;
	label: string;
	Icon: LucideIcon;
	keys: string[];
}[] = [
	{
		key: "marrow",
		label: "Bone marrow & lab diagnosis",
		Icon: Microscope,
		keys: ["marrow"],
	},
	{
		key: "blood",
		label: "Blood & organ function",
		Icon: Droplet,
		keys: ["counts", "organ", "infection"],
	},
	{ key: "csf", label: "CSF & lumbar puncture", Icon: Syringe, keys: ["csf"] },
	{
		key: "imaging",
		label: "Imaging & heart",
		Icon: ScanLine,
		keys: ["imaging", "heart"],
	},
	{ key: "other", label: "Other", Icon: Activity, keys: [] },
];

export function TopicIcon({
	text,
	className = "",
}: {
	text: string;
	className?: string;
}) {
	const t = classify(text);
	if (!t)
		return (
			<span
				aria-hidden
				className={`inline-block size-[18px] shrink-0 ${className}`}
			/>
		);
	return (
		<t.Icon
			size={18}
			aria-label={t.label}
			className={`shrink-0 ${t.alert ? "text-warn" : "text-muted"} ${className}`}
		/>
	);
}
