/**
 * The protocol spec: what one protocol version looks like once built from its PDF.
 *
 * Thin by design. Structure (nodes, edges, kinds, order) is typed; clinical text is
 * never typed or paraphrased: it lives only in `Anchor.text`, copied by code from the
 * PDF text layer at a page + line boxes. The LLM only labels headings that code found
 * (kind, parent, edges) and never writes text a clinician reads.
 *
 * Every field's description starts with who fills it:
 *   [code]  deterministic pipeline code (PDF parsing, heading detection, hashing)
 *   [llm]   the labelling call; it may only choose from enums and existing ids
 *   [admin] a person in the admin UI (upload confirmation, hospitals, status)
 * Descriptions double as instructions for the labelling call.
 *
 * An instance is immutable: keyed by the PDF sha256 + pipeline version and rebuilt
 * from the PDF, never edited. Hospital data lives in the separate Overlay.
 */
import { z } from "zod";

export const SPEC_VERSION = 1;

const page = z
	.number()
	.int()
	.min(1)
	.describe("[code] 1-based PDF page index (not the printed page number).");

export const Box = z
	.tuple([z.number(), z.number(), z.number(), z.number()])
	.describe(
		"[code] Rectangle [x0, y0, x1, y1] in PDF points, origin top-left of the page.",
	);
export type Box = z.infer<typeof Box>;

export const Quad = z
	.tuple([
		z.number(),
		z.number(),
		z.number(),
		z.number(),
		z.number(),
		z.number(),
		z.number(),
		z.number(),
	])
	.describe(
		"[code] Quadrilateral [ulx, uly, urx, ury, llx, lly, lrx, lry] in PDF points, for rotated text.",
	);

export const DiagnosticStage = z
	.enum(["primary", "molecular", "extent", "baseline", "relapse", "follow_up"])
	.describe(
		[
			"[llm] For diagnostic work-up sections only, the stage of the work-up in clinical order:",
			"primary = establishing the primary tumour or disease: clinical exam, imaging of the primary site, biopsy, pathology/morphology, immunophenotyping, central review;",
			"molecular = genetic/molecular confirmation and biology: translocations, fusion genes, cytogenetics, MYCN, molecular markers;",
			"extent = extent of disease / staging ('bilan d'extension'): metastases, chest CT, PET-CT, scintigraphy, bone marrow involvement, CSF/CNS status;",
			"baseline = pre-treatment baseline investigations: organ function (cardiac echo/ECG, renal/GFR, liver, hearing, fertility), lab, history, consent; the starting point for monitoring toxicity later.",
			"relapse = work-up at suspected or confirmed relapse/recurrence/progression (not the initial diagnosis);",
			"follow_up = investigations during follow-up after end of treatment.",
		].join(" "),
	);
export type DiagnosticStage = z.infer<typeof DiagnosticStage>;

/** Protocol languages a summary can be shown in. "Original" is the verbatim text itself. */
export const Lang = z.enum(["en", "fr", "nl"]);
export type Lang = z.infer<typeof Lang>;
export const Summaries = z
	.object({
		en: z.string().optional(),
		fr: z.string().optional(),
		nl: z.string().optional(),
	})
	.describe(
		"[llm, code-checked] Short rewrite of the verbatim text per language, for reading at a glance. Every number, unit, threshold and drug name of the original appears unchanged (code rejects the summary otherwise); the verbatim `text` stays the source of truth and is one click away.",
	);
export type Summaries = z.infer<typeof Summaries>;

export const Anchor = z
	.object({
		page,
		text: z
			.string()
			.min(1)
			.describe(
				"[code] Verbatim text copied from the PDF text layer: the visual lines inside `bbox`, joined with \\n. Never written or edited by the LLM. The UI shows exactly this, next to the highlighted page.",
			),
		bbox: z
			.array(Box)
			.min(1)
			.describe(
				"[code] One box per visual line (or line piece) of `text`, in reading order. Used to highlight the page render.",
			),
		stage: DiagnosticStage.optional().describe(
			"[llm] Lines of the diagnostic work-up only: which work-up stage this line belongs to (the model points at line ids; the text stays code-copied).",
		),
		technique: z
			.boolean()
			.optional()
			.describe(
				"[llm] Lines of the diagnostic work-up only: true when the line is how-to/technique text (imaging protocol, MRI sequences, acquisition parameters), read but not ticked as an investigation.",
			),
		role: z
			.enum(["item", "rule", "heading", "prose"])
			.optional()
			.describe(
				"[llm] What the block is for the reader (the model groups line ids into blocks and names their role; the text stays code-copied): item = an investigation, action or criterion a clinician ticks; rule = a statement, decision or definition to read, not tick; heading = a run-in heading or list intro; prose = context. Absent on specs built before segmentation, or when the section fell back to the layout heuristics.",
			),
		depth: z
			.number()
			.int()
			.min(0)
			.max(5)
			.optional()
			.describe(
				"[llm] List nesting depth of the block (0 = top level), set with `role`.",
			),
		quads: z
			.array(Quad)
			.optional()
			.describe(
				"[code] Optional quads when the text is rotated or skewed (landscape tables).",
			),
		sum: Summaries.optional(),
	})
	.describe(
		"A pointer into the PDF: one contiguous span on one page. A span crossing a page break is two anchors. This is the only place clinical text exists in the spec.",
	);
export type Anchor = z.infer<typeof Anchor>;

export const Timepoint = z
	.enum([
		"at_diagnosis",
		"before_each_course",
		"during_treatment",
		"before_specific_course",
		"end_of_treatment",
		"follow_up",
		"on_toxicity",
	])
	.describe(
		"[llm] When something is checked or given, in clinical order: at_diagnosis = baseline before treatment starts; before_each_course = before every course/block/cycle; during_treatment = during therapy (daily, weekly, throughout); before_specific_course = before one named course or drug (e.g. before each anthracycline course); end_of_treatment = at the end of therapy; follow_up = after therapy; on_toxicity = event-driven, when a toxicity or condition occurs (e.g. grade 3 neuropathy, fever in neutropenia).",
	);
export type Timepoint = z.infer<typeof Timepoint>;

export const Monitoring = z
	.object({
		model: z.string().describe("[code] Model that arranged the matrix."),
		rows: z.array(
			z.object({
				id: z.string().describe("[code] Row id."),
				label: z
					.string()
					.describe(
						"[llm] Short name of what is checked or given (e.g. 'Echocardiography', 'PJP prophylaxis'). A label, never a clinical statement.",
					),
				group: z
					.enum(["monitoring", "prophylaxis", "dose_modification"])
					.describe(
						"[llm] monitoring = investigations; prophylaxis = prophylaxis and supportive care; dose_modification = dose modifications or holds for toxicity.",
					),
				cells: z.array(
					z.object({
						timepoint: Timepoint,
						detail: z
							.string()
							.optional()
							.describe(
								"[llm] Column qualifier of a few words: the course/drug for before_specific_course, the trigger for on_toxicity.",
							),
						lines: z
							.array(Anchor)
							.min(1)
							.describe(
								"[llm points, code copies] The protocol lines that state it; ids that do not resolve are dropped, and a cell with none is dropped.",
							),
					}),
				),
			}),
		),
	})
	.describe(
		"[llm points, code copies] Supportive care, toxicity and monitoring arranged by timepoint. The model only points at line ids and names rows; every statement shown is a code-copied Anchor.",
	);
export type Monitoring = z.infer<typeof Monitoring>;

export const PageRange = z
	.object({ from: page, to: page })
	.describe(
		"[code] Inclusive PDF page range, from the heading's page to the page before the next heading of the same or higher level.",
	);
export type PageRange = z.infer<typeof PageRange>;

export const FigStatus = z
	.enum(["verified", "agreed", "disputed", "unverified"])
	.describe(
		"[code] verified = text copied from the text layer / connector drawn in the PDF / mark glyph at the cell; agreed = raster only, two independent model readings agree (not verified); disputed = the readings disagree; unverified = a claim with no PDF evidence.",
	);
export type FigStatus = z.infer<typeof FigStatus>;

export const FigureStructure = z
	.object({
		type: z
			.enum([
				"flowchart",
				"treatment_schema",
				"table",
				"schedule",
				"timeline",
				"other",
			])
			.describe("[code, llm for flowcharts] What the figure is."),
		source: z
			.enum(["vector", "raster"])
			.describe(
				"[code] vector = drawn with a text layer (verifiable); raster = image (never verified).",
			),
		nodes: z
			.array(
				z.object({
					id: z
						.string()
						.describe(
							"[code] b* = text inside a drawn box, l* = free text label; n* = raster reading.",
						),
					role: z.enum(["box", "label"]).describe("[code]"),
					text: z
						.string()
						.describe(
							"[code] Verbatim from the text layer (vector) or [llm] transcription (raster, status never 'verified').",
						),
					bbox: Box,
					status: FigStatus,
				}),
			)
			.optional()
			.describe("[code] Boxes and labels of a flowchart."),
		edges: z
			.array(
				z.object({
					from: z.string(),
					to: z.string(),
					label: z
						.string()
						.optional()
						.describe("[llm] Node id of the condition label on the arrow."),
					status: FigStatus,
					evidence: z
						.array(z.enum(["connector", "model", "model2"]))
						.describe(
							"[code] connector = drawn line in the PDF; model/model2 = vision readings.",
						),
				}),
			)
			.optional()
			.describe(
				"[code+llm] Arrows. Verified only when a drawn connector and the model agree.",
			),
		table: z
			.object({
				headerRows: z
					.number()
					.int()
					.min(0)
					.describe("[code] Leading rows that are headers."),
				rows: z
					.array(
						z.array(
							z.object({
								text: z
									.string()
									.describe(
										"[code] Verbatim cell text from the text layer; empty for covered cells.",
									),
								bbox: Box.optional().describe(
									"[code] Cell rectangle on the page (FigureRef.page).",
								),
								status: FigStatus,
								rowSpan: z
									.number()
									.int()
									.min(2)
									.optional()
									.describe(
										"[code] From the drawn rules: no rule below = merged cell.",
									),
								colSpan: z
									.number()
									.int()
									.min(2)
									.optional()
									.describe(
										"[code] From the drawn rules: no rule to the right = merged cell.",
									),
								covered: z
									.boolean()
									.optional()
									.describe(
										"[code] Part of a merged cell started above or to the left; not rendered.",
									),
							}),
						),
					)
					.describe(
						"[code] Rectangular grid; every row has the same number of cells.",
					),
			})
			.optional()
			.describe(
				"[code] Table or schedule grid cut from the text layer and the drawn rules.",
			),
		summary: z
			.record(FigStatus, z.number())
			.describe("[code] Element count per status."),
		allVerified: z
			.boolean()
			.describe(
				"[code] Every element verified: only then may the UI show the structure instead of the crop.",
			),
		model: z
			.string()
			.nullable()
			.describe("[code] Model used, null for code-only analysis."),
		notes: z
			.array(z.string())
			.describe("[code] What the analysis could not do cleanly."),
	})
	.describe(
		"A figure turned into a standard structure, each element carrying its verification status.",
	);
export type FigureStructure = z.infer<typeof FigureStructure>;

export const FigureRef = z
	.object({
		page,
		bbox: Box.optional().describe(
			"[code] Image or drawing region on the page; absent = show the whole page.",
		),
		raster: z
			.boolean()
			.describe(
				"[code] true when the region is an image with no text layer (flowcharts, scanned tables): it can only be shown, never searched or quoted.",
			),
		caption: Anchor.optional().describe(
			"[code] The caption line(s) under or above the figure, when present.",
		),
		structure: FigureStructure.optional().describe(
			"[code] Standardized structure (table/schedule grid today), attached only when every element is verified against the PDF.",
		),
	})
	.describe(
		"A figure or table shown as the original page render (cropped to `bbox`), never redrawn.",
	);
export type FigureRef = z.infer<typeof FigureRef>;

export const ProtocolDoc = z
	.object({
		id: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/)
			.describe(
				"[code, admin confirms] Protocol family slug, stable across versions (e.g. 'ml-ds-2018'). Recognised on upload by matching the title against known protocols.",
			),
		short: z
			.string()
			.describe(
				"[code, admin confirms] Short display name as printed on the cover (e.g. 'ML-DS 2018').",
			),
		title: z.string().describe("[code] Full title, verbatim from the cover page."),
		version: z
			.string()
			.describe(
				"[code, admin confirms] Version label as printed (e.g. '3.0'), from the cover or running header.",
			),
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.nullable()
			.describe(
				"[code, admin confirms] Version date as ISO yyyy-mm-dd, parsed from the cover or running header; null if not printed.",
			),
		versionEvidence: Anchor.optional().describe(
			"[code] Where the version label and date were read (cover page or running header).",
		),
		sha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.describe("[code] SHA-256 of the PDF bytes. Identity of this instance."),
		pageCount: z
			.number()
			.int()
			.min(1)
			.describe("[code] Number of pages in the PDF."),
		language: z
			.string()
			.optional()
			.describe(
				"[code] Main language (ISO 639-1) by stopword count, e.g. 'en', 'fr'.",
			),
		supersedes: z
			.object({
				version: z
					.string()
					.describe("[code] Version label of the previous instance."),
				sha256: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.describe("[code] SHA-256 of the previous PDF."),
			})
			.nullable()
			.describe(
				"[code, admin confirms] The published version this one replaces, or null for the first upload of this protocol.",
			),
	})
	.describe("Identity of one protocol version (one PDF).");
export type ProtocolDoc = z.infer<typeof ProtocolDoc>;

export const NodeKind = z
	.enum([
		"diagnostics",
		"eligibility",
		"risk_groups",
		"risk_group",
		"phase",
		"step",
		"start_requirements",
		"response_assessment",
		"restratification",
		"supportive_care",
		"toxicity",
		"drug_info",
		"schedule",
		"figure",
		"other",
	])
	.describe(
		[
			"[llm] What a clinician uses this section for. Choose exactly one:",
			"diagnostics = tests needed to confirm the diagnosis before treatment (work-up checklist);",
			"eligibility = inclusion/exclusion criteria for the protocol or a randomisation;",
			"risk_groups = section defining how patients are assigned to risk/treatment groups;",
			"risk_group = one group inside it (child of risk_groups);",
			"phase = a treatment phase or arm grouping several steps (induction, consolidation, an arm such as 'IR-Low');",
			"step = one treatment element a patient starts (a course, block, cycle);",
			"start_requirements = conditions to begin a step (count recovery, organ function, 'Requirements for beginning X', 'Starting Criteria', 'Minimum requirements'); child of its step;",
			"response_assessment = how and when response is evaluated (MRD timepoints, remission definitions, decision for local therapy);",
			"restratification = rules moving a patient to another group or arm after a response assessment;",
			"supportive_care = prophylaxis, emergencies, infections, transfusion guidance;",
			"toxicity = dose modifications or holds for toxicity;",
			"drug_info = description of drugs, side effects, administration, dose adaptation by age/weight;",
			"schedule = schedule of assessments or dosage overview tables;",
			"figure = a stand-alone flowchart or algorithm;",
			"other = anything else (administration, statistics, references). When unsure, use other.",
		].join(" "),
	);
export type NodeKind = z.infer<typeof NodeKind>;

export const Node = z
	.object({
		id: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/)
			.describe(
				"[code] Slug from kind + normalised heading text, unique in the instance. Rebuilt per version; local rules re-attach by id, then by quote match.",
			),
		kind: NodeKind,
		title: z
			.string()
			.describe(
				"[code] The heading text exactly as detected on the page (no section number if the PDF has none in its text layer).",
			),
		titles: Summaries.optional().describe(
			"[llm] The heading translated (en/fr/nl), section number kept; the UI falls back to `title`.",
		),
		headingPath: z
			.array(z.string())
			.describe(
				"[code] Titles of enclosing headings from the top level down, excluding this one. Breadcrumb and search context.",
			),
		pages: PageRange,
		parent: z
			.string()
			.nullable()
			.describe(
				"[code, llm may reassign] Parent node id: from heading levels; the LLM may move a node under another existing node (e.g. start_requirements under its step). null = top level.",
			),
		order: z
			.number()
			.int()
			.min(0)
			.describe(
				"[code] Position among siblings, in document order. The UI renders siblings and rails in this order.",
			),
		blocks: z
			.array(Anchor)
			.describe(
				"[code] Verbatim content, one anchor per paragraph or list item in reading order. List items render as checklist rows. Empty when the node only groups children.",
			),
		figures: z
			.array(FigureRef)
			.optional()
			.describe(
				"[code] Figures and tables in this node's pages that must be shown as page images.",
			),
		notFound: z
			.array(
				z.object({
					kind: NodeKind.describe(
						"[code] The kind of child that was expected but not found.",
					),
					searched: PageRange.describe(
						"[code] Pages searched. The UI says 'Not found in pp. X-Y', never 'not stated in protocol'.",
					),
				}),
			)
			.optional()
			.describe(
				"[code] Expected children not found inside this node's pages (e.g. a step with no start_requirements). Shown explicitly, together with see_also edges.",
			),
		stage: DiagnosticStage.optional(),
		status: z
			.array(Anchor)
			.optional()
			.describe(
				"[code finds, llm selects] The protocol's own sentences about recruitment status of this arm/step (e.g. 'Recruitment ... closed end of August 2024'). Quoted, not interpreted; hospital status lives in the Overlay.",
			),
	})
	.describe(
		"One section of the protocol that a clinician navigates to. Unknown shapes fall back to kind 'other' and still render (title + verbatim blocks + page link).",
	);
export type Node = z.infer<typeof Node>;

export const EdgeKind = z
	.enum(["next", "alternative", "restratify_to", "see_also"])
	.describe(
		[
			"[llm] next = the patient proceeds from step `from` to step `to`;",
			"alternative = `to` is one of mutually exclusive options after `from` (a fork: randomisation, MRD-based choice, Induction A-F); one edge per option;",
			"restratify_to = after a response assessment the patient moves from `from` to another group/arm/phase `to`;",
			"see_also = `from` refers the reader to `to` (cross-reference, response gate or supportive care located elsewhere).",
		].join(" "),
	);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const Edge = z
	.object({
		from: z.string().describe("[llm] Existing node id."),
		to: z.string().describe("[llm] Existing node id."),
		kind: EdgeKind,
		evidence: Anchor.optional().describe(
			"[llm points, code copies] The protocol sentence that establishes the edge (e.g. 'hAM therapy commences at least 28 days after start of course 2'). The LLM names the page and the sentence; code locates and copies it, and drops the edge's evidence if it does not resolve. Without evidence the UI draws the edge dashed, as 'inferred from document order'.",
		),
	})
	.describe(
		"A typed relation between two nodes: the treatment flow, forks, re-stratification arrows and cross-references.",
	);
export type Edge = z.infer<typeof Edge>;

export const Warning = z.object({
	code: z
		.string()
		.describe(
			"[code] Stable machine code, e.g. 'raster_page', 'table_flattened', 'dangling_xref', 'edge_evidence_unresolved'.",
		),
	message: z
		.string()
		.describe("[code] Plain-language explanation for the admin screen."),
	page: page.optional(),
	nodeId: z.string().optional().describe("[code] Node concerned, if any."),
});
export type Warning = z.infer<typeof Warning>;

export const Build = z
	.object({
		pipelineVersion: z
			.string()
			.describe(
				"[code] Version of the build pipeline; part of the instance key with doc.sha256.",
			),
		model: z
			.string()
			.nullable()
			.describe(
				"[code] Model used for the labelling call; null when built without one (hand-built or heading-only).",
			),
		builtAt: z.string().datetime().describe("[code] ISO timestamp of the build."),
		timingsMs: z
			.record(z.string(), z.number())
			.describe(
				"[code] Duration per pipeline stage in ms (parse, headings, label, anchors...).",
			),
		counts: z
			.record(z.string(), z.number())
			.describe(
				"[code] Counters (pages, headings, nodes, edges, rasterPages, unresolvedAnchors...).",
			),
		warnings: z
			.array(Warning)
			.describe(
				"[code] Everything the pipeline could not do cleanly. Shown to the admin, never hidden.",
			),
	})
	.describe("How this instance was built.");
export type Build = z.infer<typeof Build>;

export const FindingKind = z
	.enum([
		"delegation",
		"dangling_ref",
		"missing_start",
		"contradiction",
		"gap",
		"ambiguity",
	])
	.describe(
		[
			"delegation = [code] a line leaving the decision to local/national/institutional guidelines or someone's discretion;",
			"dangling_ref = [code] a cross-reference ('see section 8.1.5', 'Table 16') whose target number does not exist in the document;",
			"missing_start = [code] a treatment step with no start requirements found in its pages;",
			"contradiction = [llm points, code copies] the same criterion, threshold, dose or timepoint stated differently in two places (or in two protocols used together);",
			"gap = [llm points, code copies] something a clinician needs that the text leaves undefined (no threshold, no timing, a handover not described);",
			"ambiguity = [llm points, code copies] a line that can reasonably be read two ways.",
		].join(" "),
	);
export type FindingKind = z.infer<typeof FindingKind>;

export const Finding = z
	.object({
		id: z
			.string()
			.describe("[code] Finding id, unique in the spec (or crosscheck)."),
		kind: FindingKind,
		source: z
			.enum(["code", "llm"])
			.describe(
				"[code] code = deterministic text pattern or structural check; llm = flagged by the consistency call (shown as 'AI-flagged, please verify').",
			),
		severity: z
			.enum(["high", "medium", "low"])
			.describe(
				"[code] for code findings (fixed per kind); [llm] for model findings.",
			),
		note: z
			.string()
			.optional()
			.describe(
				"[llm] At most 25 plain words in the model's own words, saying what to check. Never clinical text: always shown labelled 'AI-flagged, please verify', next to the verbatim lines.",
			),
		nodeId: z
			.string()
			.optional()
			.describe(
				"[code] Node of the first line, for '+ local rule' and navigation.",
			),
		lines: z
			.array(Anchor)
			.describe(
				"[llm points, code copies] The protocol lines concerned, verbatim with their page. The model only names line ids; ids that do not resolve are dropped, and a model finding left without lines is dropped.",
			),
		otherProtocol: z
			.object({ id: z.string(), short: z.string(), version: z.string() })
			.optional()
			.describe(
				"[code] For cross-protocol findings: the other protocol of the pair (a sub-protocol or one used together).",
			),
		otherLines: z
			.array(Anchor)
			.optional()
			.describe(
				"[llm points, code copies] Cross-protocol findings: the lines in the other protocol, verbatim with their page in that PDF.",
			),
	})
	.describe(
		"Something a clinician should check: a contradiction, gap or ambiguity in the protocol, a decision left to local guidelines, a broken reference. Points at verbatim lines; never rewrites them.",
	);
export type Finding = z.infer<typeof Finding>;

export const Treatment = z
	.object({
		model: z.string().describe("[code] Model that grouped the treatment."),
		arms: z
			.array(
				z.object({
					id: z
						.string()
						.describe("[code] Slug of the label, unique within the spec."),
					label: z
						.string()
						.describe(
							"[llm, code checks every word appears in the protocol's titles or flow evidence] Short name for tabs and chips, 1-4 words ('Induction', 'IR-Low', 'HR T-cell').",
						),
					title: z
						.string()
						.describe(
							"[code] Full name: the title of `node`, else the label.",
						),
					node: z
						.string()
						.nullable()
						.describe(
							"[llm, checked] The phase or section node that holds the arm, if one does.",
						),
					steps: z
						.array(z.string())
						.describe(
							"[llm, checked] Step node ids, in the order a patient gets them.",
						),
				}),
			)
			.describe(
				"Treatment arms: the step groups a clinician switches between (induction, each post-induction arm, an experimental arm).",
			),
		riskGroups: z
			.array(
				z.object({
					id: z
						.string()
						.describe("[code] Slug of the label (the ?g= URL value)."),
					label: z
						.string()
						.describe(
							"[llm, checked like arm labels] Chip label, 1-4 words.",
						),
					title: z
						.string()
						.describe(
							"[code] Full name: the arm title that names the group, else the label.",
						),
					arms: z
						.array(z.string())
						.describe(
							"[llm, checked] Arm ids the group goes through, in order.",
						),
					steps: z
						.array(z.string())
						.describe(
							"[llm, checked] Every step on the path, in order: the whole of each arm, except where the protocol says the group takes only some of an arm's steps.",
						),
					rule: z
						.string()
						.nullable()
						.describe(
							"[llm, checked] The risk_groups/risk_group node that defines who is in the group.",
						),
				}),
			)
			.describe(
				"Risk groups as paths through the arms. Empty when the protocol does not split patients into treatment paths.",
			),
	})
	.describe(
		"[llm points at node ids, code checks them] Arms and risk-group paths, from one model call over the steps, phases, risk-group sections and flow edges.",
	);
export type Treatment = z.infer<typeof Treatment>;

export const ProtocolSpec = z
	.object({
		specVersion: z.literal(SPEC_VERSION).describe("[code] Version of this schema."),
		doc: ProtocolDoc,
		nodes: z
			.array(Node)
			.describe(
				"[code+llm] All navigable sections, flat; the tree comes from `parent` + `order`.",
			),
		edges: z
			.array(Edge)
			.describe(
				"[llm, evidence by code] Flow, forks, re-stratification and cross-references.",
			),
		monitoring: Monitoring.optional(),
		treatment: Treatment.optional(),
		findings: z
			.array(Finding)
			.optional()
			.describe(
				"[code] + [llm points, code copies] 'Check these': delegations, broken references and steps without start requirements found by code, then contradictions, gaps and ambiguities flagged by one model call over the whole protocol (model names line ids and writes a short note; code copies the lines).",
			),
		build: Build,
	})
	.superRefine((spec, ctx) => {
		const ids = new Set<string>();
		for (const n of spec.nodes) {
			if (ids.has(n.id))
				ctx.addIssue({ code: "custom", message: `duplicate node id ${n.id}` });
			ids.add(n.id);
		}
		for (const n of spec.nodes) {
			if (n.parent !== null && !ids.has(n.parent))
				ctx.addIssue({
					code: "custom",
					message: `node ${n.id}: unknown parent ${n.parent}`,
				});
			if (n.pages.from > n.pages.to || n.pages.to > spec.doc.pageCount)
				ctx.addIssue({
					code: "custom",
					message: `node ${n.id}: bad page range`,
				});
		}
		for (const e of spec.edges)
			for (const end of [e.from, e.to])
				if (!ids.has(end))
					ctx.addIssue({
						code: "custom",
						message: `edge ${e.from}->${e.to}: unknown node ${end}`,
					});
	})
	.describe(
		"One protocol version, built from its PDF. Immutable; rebuilt, never edited.",
	);
export type ProtocolSpec = z.infer<typeof ProtocolSpec>;

// ---------------------------------------------------------------------------
// Overlay: hospital layer, separate from the protocol instance.
// ---------------------------------------------------------------------------

export const HospitalStatus = z
	.enum(["live", "closed", "standard_of_care", "unknown"])
	.describe(
		"[admin] live = recruiting at this hospital; closed = no longer used; standard_of_care = trial closed but this protocol (or its best arm) is the treatment standard; unknown = not set.",
	);
export type HospitalStatus = z.infer<typeof HospitalStatus>;

export const Hospital = z.object({
	id: z
		.string()
		.regex(/^[A-Z0-9-]+$/)
		.describe("[admin] Short code, e.g. 'UZG', 'HUDERF'."),
	name: z.string().describe("[admin] Full hospital name."),
});
export type Hospital = z.infer<typeof Hospital>;

export const Participation = z
	.object({
		protocolId: z
			.string()
			.describe(
				"[admin] ProtocolDoc.id. Applies to whichever version is published.",
			),
		hospital: z.string().describe("[admin] Hospital.id."),
		participating: z
			.boolean()
			.describe("[admin] The hospital treats patients on this protocol."),
		status: HospitalStatus,
		arms: z
			.array(
				z.object({
					nodeId: z.string().describe("[admin] Node id of a phase/arm/step."),
					status: HospitalStatus,
				}),
			)
			.optional()
			.describe(
				"[admin] Per-arm status where it differs from the protocol status (e.g. an experimental arm closed).",
			),
		updatedBy: z.string().describe("[admin] Who set this."),
		updatedAt: z.string().datetime().describe("[admin] When."),
	})
	.describe("Whether and how one hospital uses one protocol.");
export type Participation = z.infer<typeof Participation>;

export const LocalRule = z
	.object({
		id: z.string().describe("[code] Rule id."),
		protocolId: z.string().describe("[admin] ProtocolDoc.id."),
		hospital: z
			.string()
			.describe(
				"[admin] Hospital.id owning the rule; only shown to that hospital's users unless shared.",
			),
		nodeId: z
			.string()
			.describe(
				"[admin] Node the rule is attached to (picked by clicking '+ local rule' on a card).",
			),
		nodeQuote: z
			.string()
			.optional()
			.describe(
				"[code] First block text of the node at attach time; used to re-attach the rule on a new version when the id changed.",
			),
		text: z
			.string()
			.min(1)
			.describe(
				"[admin] The local rule, written by a clinician of that hospital. Rendered in a distinct style, never mixed with protocol text.",
			),
		source: z
			.object({
				title: z.string().describe("[admin] Local SOP or document name."),
				sha256: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.optional()
					.describe("[code] Hash of the uploaded local document, if any."),
				page: page.optional(),
			})
			.optional()
			.describe("[admin] Where the rule comes from."),
		author: z.string().describe("[admin] Clinician who wrote the rule."),
		createdAt: z.string().datetime().describe("[code] When it was written."),
		attachedToSha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.describe(
				"[code] Protocol version (PDF sha256) the rule was last confirmed against.",
			),
		state: z
			.enum(["active", "reconfirm", "orphaned"])
			.describe(
				"[code] active = node unchanged since confirmation; reconfirm = the node's text changed in a new version; orphaned = the node no longer exists. Never silently carried.",
			),
	})
	.describe("A hospital-specific rule shown under a protocol node.");
export type LocalRule = z.infer<typeof LocalRule>;

export const Overlay = z
	.object({
		specVersion: z.literal(SPEC_VERSION),
		hospitals: z.array(Hospital).describe("[admin] Treating hospitals."),
		participation: z.array(Participation),
		localRules: z.array(LocalRule),
		usedTogether: z
			.array(z.tuple([z.string(), z.string()]))
			.optional()
			.describe(
				"[admin] Pairs of ProtocolDoc.id a patient can be treated under at the same time (beyond master/sub-protocol): cross-checked for discrepancies by scripts/crosscheck.ts.",
			),
	})
	.describe(
		"The hospital layer: participation, status and local rules. Separate from protocol instances so a new protocol version never overwrites it.",
	);
export type Overlay = z.infer<typeof Overlay>;
