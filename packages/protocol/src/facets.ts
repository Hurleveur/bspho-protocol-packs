/**
 * Facets: what a complete answer to a common clinical question type covers. Both Q&A paths
 * hand the matching checklist to the answer model, so it reads past the most obvious section
 * (the eligibility list it found first) to the other places a protocol states the rest (organ
 * function, risk-group consequences, drug holds, AE reporting, technique appendices).
 *
 * The checklists name kinds of content, never protocol facts: the model fills each facet from
 * the protocol text or says the protocol does not state it.
 */

export const QUESTION_TYPES = ["before_starting", "acute_management", "complication", "staging_workup", "other"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Per type: the checklist, and for each facet the section kinds that usually hold it (Ask boosts them when it searches that facet). */
export const FACETS: Record<Exclude<QuestionType, "other">, { label: string; facets: string[]; kinds: string[][] }> = {
	before_starting: {
		label: "conditions before starting a drug, course or phase",
		facets: [
			"Haematological: blood counts with thresholds and conditions (without transfusion / G-CSF for N hours, exceptions for marrow involvement); when a phase has both entry criteria and per-cycle criteria, give each with its own section, and say so explicitly when one of those lists has no blood-count threshold",
			"Organ function, per protocol and arm: renal, liver, cardiac, respiratory (oxygen saturation), blood pressure, coagulation (e.g. no uncontrolled coagulopathy), each with its threshold",
			"Other conditions, per protocol and arm: performance status, no active infection, prior toxicity grades, disease status, timing windows, premedication or drugs to avoid",
			"Every phase or arm where the drug is given (e.g. chemo-immunotherapy arm, maintenance with its companion drugs, trial entry vs before each cycle), named in the opening and each with its own criteria",
		],
		kinds: [["start_requirements", "eligibility"], ["start_requirements", "eligibility"], ["start_requirements", "eligibility", "drug_info"], ["start_requirements", "step", "phase"]],
	},
	acute_management: {
		label: "acute management of a presentation",
		facets: [
			"Immediate actions: supportive measures with their volumes or targets (hydration, transfusion), monitoring, what to avoid or postpone (procedures, transfusions), interventions the protocol does not recommend routinely and the reason it gives",
			"Risk-group consequence, per protocol: whether the presenting value is a stratification or high-risk criterion there (state the cut-off) and the group it assigns",
			"Next treatment step, per protocol: the induction or course the patient then starts, naming each of its drugs as the protocol lists them (not only '4-drug induction'), and any pre-phase or cytoreduction",
		],
		kinds: [["supportive_care"], ["risk_groups", "risk_group"], ["step", "phase", "risk_groups"]],
	},
	complication: {
		label: "a complication or adverse event during treatment",
		facets: [
			"Possible causes: every mechanism the protocol links to the presentation (toxicity of each protocol drug that can cause it, thrombosis or bleeding, involvement by the disease itself, infection), each from its own section with the mechanism the protocol gives (e.g. how the drug causes it) and the forms it names (e.g. which kinds of thrombosis); for disease involvement (e.g. CNS leukaemia) give the protocol's own definition of it (its clinical, CSF and imaging criteria)",
			"Work-up: investigations and their preconditions (e.g. what must be corrected before an invasive procedure such as a lumbar puncture, and what to do if that cannot be achieved safely), which imaging",
			"Drug handling: which protocol drugs to withhold while the event is diagnosed, suspected or being assessed (from the drug-toxicity paragraphs of the treatment phases, not only sub-protocols), and the conditions to continue or restart",
			"Treatment of the complication itself as the protocol or its sub-protocols describe it",
			"Reporting: whether it must be recorded or reported (toxicity form, AESI, SAE) and how; quote the full list of events the protocol's AESI or toxicity category names, not only the one asked about",
		],
		kinds: [["toxicity", "drug_info", "diagnostics"], ["diagnostics", "schedule"], ["toxicity", "drug_info"], ["supportive_care", "toxicity"], ["toxicity"]],
	},
	staging_workup: {
		label: "staging, diagnosis or work-up",
		facets: [
			"Each investigation the protocol requires, as its own point with what it is for: imaging of the primary (modality, contrast, and what it must assess, e.g. image-defined risk factors), metastatic imaging (scintigraphy, SPECT/CT, PET, chest CT), bone marrow (sites, aspirate vs trephine), CSF, lab, tumour markers; take each from the frontline (diagnosis) assessment schedule unless the question is about relapse, and leave out the relapse schedule's rows otherwise; quote the row's schedule footnote verbatim with the row it is attached to (when it is done, when it is repeated and on what condition) rather than paraphrasing it",
			"Technique details from the appendices: how each investigation is done or scored (e.g. scoring systems, acquisition, alternatives when the first test is negative)",
			"Pathology and biology: the classification system the pathologist must apply (name it), biopsy type (core or surgical vs fine-needle, and why), samples to send, molecular tests required for all patients",
			"Definitions and cut-offs that decide staging or risk group (e.g. what counts as metastatic, and what does not; for the patient the question describes, quote the protocol's risk-group or eligibility definition that applies to their age and biology, e.g. which stages qualify), with what the protocol says to do about borderline findings (e.g. whether to biopsy them), and conditional tests (state the condition)",
		],
		kinds: [["diagnostics", "schedule"], ["diagnostics"], ["diagnostics"], ["diagnostics", "risk_groups", "risk_group"]],
	},
};

/** Cheap question-type guess for the agent path (no extra model call). Ask uses its planner instead. */
export function classify(question: string): QuestionType {
	const q = question.toLowerCase();
	if (/\b(stag(e|ed|ing)|work-?up|investigations?|examinations?|baseline|imaging|diagnos(is|tic))\b/.test(q)) return "staging_workup";
	if (/\b(developed|complication|adverse|side[- ]effects?|toxicit(y|ies)|reaction|stroke|seizure|thrombos[ie]s|bleed(ing)?|pancreatitis|possible causes?)\b/.test(q)) return "complication";
	if (/\b(before (starting|start|giving|beginning)|prior to|conditions?|criteria|requirements?|eligib\w*|can i start)\b/.test(q)) return "before_starting";
	if (/\b(acute|emergenc\w*|next steps?|management|manage|presents? with)\b/.test(q)) return "acute_management";
	return "other";
}

/**
 * The direct answer comes first. A question that gives a patient value ("can I start if platelets
 * are 70?") opens with that value compared against the cited threshold, alternatives included; a
 * yes/no question about one course gets that course's criteria, not a tour of every phase.
 */
function lead(question: string): { text: string; narrow: boolean } {
	const value = /\d/.test(question);
	const narrow = value && /^(can|may|could|should|is|are|do|does)\b|\b(can|may|could) (i|we)\b/i.test(question.trim());
	const parts = ["Open with the direct answer to the question asked, in one or two sentences, before any label line or facet."];
	if (value) parts.push("The question gives a patient value: in those opening sentences compare it with the threshold that applies (quote the threshold with its citation, including any alternative criterion joined by OR or AND and what the outcome then depends on), and leave the decision to the clinician.");
	return { text: parts.join(" "), narrow };
}

/** The answer instructions for a question: the direct-answer lead, then the facet checklist ("" for 'other' questions without a value). */
export function checklist(type: QuestionType, question = ""): string {
	const l = lead(question);
	if (type === "other") return /\d/.test(question) ? l.text : "";
	if (l.narrow && type === "before_starting") return `${l.text}\nThen list the other starting criteria of that same course or step briefly, each with its threshold and citation. Do not cover other phases or arms unless the question leaves the course open.`;
	const f = FACETS[type];
	return `${l.text}\nThis is a question about ${f.label}. A complete answer then covers each of these facets that the protocol text addresses (give each its own label line and bullets; skip a facet only if the protocol says nothing about it):\n${f.facets.map((x) => `- ${x}`).join("\n")}`;
}

const LIST_HEAD = /criteria|requirements?|eligib|prior to|before (start|each|begin)|conditions? (to|for|prior)/i;
const NUMBERED_HEAD = /^\d+(\.\d+)+\s*[-–:]?\s*\S/;

/**
 * Criteria lists often sit one after another inside one extracted section ("4.1.4 Chemoimmunotherapy
 * criteria", then "4.1.5 Criteria to enter maintenance"), so a list item alone does not say which list
 * it belongs to. Walks a section's blocks and returns, per block, the criteria heading line it sits
 * under (or null), for the context to carry next to each item.
 */
export function listHeads(blocks: { text: string }[]): (string | null)[] {
	let under: string | null = null;
	return blocks.map((b) => {
		const t = b.text.replace(/\s+/g, " ").trim();
		// A heading is the whole short block, or the short first line of a longer one ("Dose Modifications for X\n...").
		const first = (b.text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
		const line = t.length < 160 ? t : first.length < 70 ? first : "";
		if (!line || /^(\d+\)|[o•·-]\s)/.test(line) || /[.,;]$/.test(line) || !/^[A-Z0-9]/.test(line)) return under;
		if (LIST_HEAD.test(line)) {
			under = line;
			return t === line ? null : under;
		}
		if (NUMBERED_HEAD.test(line) || (line !== t && !line.endsWith(":"))) under = null;
		return under;
	});
}

const BLOOD_COUNT = /\b(anc|neutrophil|granulocyte|platelet|plt|haemoglobin|hemoglobin|hb|wbc|leu[ck]ocyte|white (blood )?cell|blood counts?)\b/i;
const ITEM = /^(\d+\)|[o•·▪-]\s|[a-z]\)\s)/;
/** Items that set clinical start conditions (organ function, toxicity grades): the lists where a missing count matters. */
const CLINICAL = /\b(grade|uln|bilirubin|alt|ast|creatinine|gfr|toxicity)\b/i;
const noCounts = (items: string[]) => items.length >= 2 && !items.some((x) => BLOOD_COUNT.test(x)) && items.filter((x) => CLINICAL.test(x)).length >= 2;

/**
 * Per block, a note when the block heads a criteria list that sets no blood-count threshold
 * (e.g. "Criteria prior to each cycle": organ and toxicity items only). A reader of one list
 * otherwise easily carries the neighbouring list's counts over to it. Covers lists split into
 * blocks (heading block, then item blocks) and lists inside one block or table caption.
 */
export function countNotes(blocks: { text: string }[]): (string | null)[] {
	const heads = listHeads(blocks);
	return blocks.map((b, j) => {
		const t = b.text.replace(/\s+/g, " ").trim();
		const notes: string[] = [];
		// heading block followed by its item blocks
		if (heads[j] === null && heads[j + 1] === t) {
			const items = blocks.slice(j + 1).filter((_, k) => heads[j + 1 + k] === t);
			if (noCounts(items.map((x) => x.text))) notes.push(t);
		}
		// a list inside this block: a heading line, then item lines
		const ls = b.text.split("\n").map((l) => l.trim());
		for (const [i, l] of ls.entries()) {
			if (l.length > 120 || ITEM.test(l) || /\.{4,}/.test(l) || !LIST_HEAD.test(l)) continue;
			const items: string[] = [];
			for (const x of ls.slice(i + 1)) {
				if (ITEM.test(x)) items.push(x);
				else break;
			}
			if (noCounts(items)) notes.push(l);
		}
		return notes.length ? notes.map((n) => `the list "${n}" sets no blood-count threshold`).join("; ") : null;
	});
}
