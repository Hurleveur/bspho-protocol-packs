import {
	ActivityIcon,
	CalendarClockIcon,
	DropletIcon,
	FlaskConicalIcon,
	HeartPulseIcon,
	type LucideIcon,
	MicroscopeIcon,
	OctagonAlertIcon,
	PillIcon,
	ScanLineIcon,
	SyringeIcon,
	ThermometerIcon,
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
		Icon: OctagonAlertIcon,
		alert: true,
		re: /\b(do not|don't|must not|should not|may not|never|avoid|not recommended|contra-?indicat|prohibited|omit)\b/i,
	},
	{
		key: "performance",
		label: "Performance",
		Icon: ActivityIcon,
		re: /karnofsky|lansky|performance status|\becog\b|general condition/i,
	},
	{
		key: "infection",
		label: "No infection",
		Icon: ThermometerIcon,
		re: /infect|fever|febrile|sepsis|mucositis|pyrexi/i,
	},
	{
		key: "counts",
		label: "Counts",
		Icon: DropletIcon,
		re: /blood counts?|platelet|granulocyte|neutrophil|\banc\b|\bwbc\b|leukocyt|leucocyt|haemoglobin|hemoglobin|\bhb\b|thrombocyt|×10[⁹¹]|x\s?10\s?9|blood cell|full blood|\bfbc\b|\bcbc\b|blasts? in (the )?(peripheral )?blood/i,
	},
	{
		key: "csf",
		label: "CSF / LP",
		Icon: SyringeIcon,
		re: /lumbar puncture|\blp\b|\bcsf\b|intrathecal|cerebrospinal|\bcns\b|cytospin/i,
	},
	{
		key: "marrow",
		label: "Bone marrow",
		Icon: MicroscopeIcon,
		re: /bone[- ]?marrow|\bbm[ap]?\b|aspirat|biops|trephine|\bmrd\b|morpholog|immunophenotyp|cytogenet|\bfish\b|\bpcr\b|flow[- ]?cytometr|karyotyp|molecular|genetic/i,
	},
	{
		key: "heart",
		label: "Heart",
		Icon: HeartPulseIcon,
		re: /echocardiog|\becho\b|\becg\b|\bekg\b|electrocardiog|cardiac|\blvef\b|shortening fraction|ejection fraction/i,
	},
	{
		key: "imaging",
		label: "Imaging",
		Icon: ScanLineIcon,
		re: /\bmri\b|\bct\b|\bpet\b|ultraso|x-?ray|radiograph|imaging|\bscan|chest film|ophthalmolog|fundoscop/i,
	},
	{
		key: "organ",
		label: "Organ function",
		Icon: FlaskConicalIcon,
		re: /renal|kidney|creatinin|liver|hepatic|bilirubin|\balt\b|\bast\b|\bgfr\b|clearance|transaminase|urine|coagulat|chemistr|serolog|pregnan/i,
	},
	{
		key: "drug",
		label: "Drug / dose",
		Icon: PillIcon,
		re: /\bmg\b|\/m²|\/m2|\bdose|dosage|\bi\.?v\.?\b|infusion|\boral\b|\bp\.?o\.?\b|cytarabine|methotrexate|vincristine|asparaginase|anthracycl|daunorubicin|doxorubicin|steroid|dexamethason|prednison|mitoxantron/i,
	},
	{
		key: "timing",
		label: "Timing",
		Icon: CalendarClockIcon,
		re: /\bday\s?\d|\bdays?\b|\bweeks?\b|\bhours?\b|\bmonths?\b|interval|after (the )?(start|end)/i,
	},
];

export function classify(text: string): Topic | null {
	for (const t of TOPICS) if (t.re.test(text)) return t;
	return null;
}

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
