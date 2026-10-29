# BSPHO Protocol Packs

Paediatric haematology-oncology trial protocols, turned into fast, verified consult sheets.

Built by the Ingram team for the BSPHO use case (UC1) at Solve with Google 2026: 32 protocols, 4,142 PDF pages.

## The idea

Not a chatbot over PDFs. Each protocol version goes through a pipeline once; doctors then read the result.

1. **Extract**: text, tables, figures and their positions from the PDF text layer (MuPDF).
2. **Understand**: a model labels the headings code found (diagnosis, risk groups, treatment steps, requirements to start, supportive care) and the treatment flow between steps. It only points at ids; it never writes clinical text.
3. **Clean**: lists, headings, two-column layouts, tables and units are repaired by code.
4. **Structure**: one typed spec per protocol version (`packages/protocol/src/spec.ts`). Every clinical line is the protocol's own words, copied by code, with its page and position.
5. **Test**: every build is checked (see Evals below).

The consult sheet reads the spec: no model call per lookup. A verifier checks every quote and every number against its page before anything is shown.

## Layout

```
apps/web/            Next.js app: consult sheet, cross-protocol Ask, Ctrl+J assistant, admin (upload, diff, publish, local rules)
packages/protocol/   The pipeline and the spec
  src/pdf.ts         PDF text layer: lines, cells, fonts, positions
  src/sections.ts    Heading detection and sections
  src/build.ts       PDF to spec: labelling, blocks, tables, diagnostic staging, monitoring matrix, checks
  src/figures.ts     Vector tables, flowcharts and schedules, verified cell by cell
  src/verify.ts      Quote and number verification against the page
  src/spec.ts        The spec schema (zod)
  src/diff.ts        Version-to-version diff for review before publishing
  src/consistency.ts Gaps, broken references and contradictions
  src/ask.ts, agent.ts  Cross-protocol Ask and the per-protocol assistant
  src/store.ts       Spec and PDF store (local directory or Cloud Storage)
scripts/
  seed.ts            Build and publish specs for the catalogue
  catalog.json       The 32 protocols, their families and hospitals
  eval/              Extraction checks, vision judge, golden questions
docs/                Sources of the report pages and the slide deck
```

## Running it

Requires [Bun](https://bun.sh) and access to Gemini on Vertex AI (`gcloud auth application-default login`).

```sh
bun install
GOOGLE_CLOUD_PROJECT=<your project> bun scripts/seed.ts ml-ds-2018   # build one protocol
bun run dev                                                             # consult sheet on http://localhost:3000
```

The protocol PDFs are not in this repository. `scripts/seed.ts` reads them from `data/protocols/` using the file names in `scripts/catalog.json`. Specs and PDFs are stored under `store/` (or `STORE_DIR`), or in a Cloud Storage bucket when `STORE_BUCKET` is set.

Useful environment variables: `GOOGLE_CLOUD_PROJECT`, `PIPELINE_MODEL` (labelling model), `ASK_MODEL`, `AGENT_MODEL`, `STORE_DIR`, `STORE_BUCKET`.

## Evals

```sh
bun test                                  # verifier unit tests
bun scripts/eval/run.ts --no-judge        # deterministic extraction checks over every published spec
bun scripts/eval/run.ts                   # plus the vision judge (page image vs what the sheet shows)
bun scripts/eval/golden.ts                # organisers' clinical questions, scored fact by fact
```

Each finding names the protocol, page, section and text, and the report prints the change per failure class against the previous run. `scripts/seed.ts` keeps the previous spec when a rebuild loses treatment steps or diagnosis sections.

## Deployment

One Cloud Run service (`Dockerfile`): the Next.js app, which also runs the pipeline when an admin uploads a new protocol version.

## Docs

- `docs/pipeline-costs.html`: what the pipeline and the app cost to run.
- `docs/evals.html`: how the protocol packs are tested.
- `docs/slides/`: the presentation deck (one HTML section per slide; `deck.json` gives the order). Screenshots referenced as `/_blob/...` are not included.

## Privacy

No patient data is stored. The assistant receives the question and the place in the protocol the clinician is looking at, and keeps nothing.
