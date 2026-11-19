# CLAUDE.md

BSPHO protocol packs: paediatric oncology trial protocols turned into verified consult
sheets. One Bun workspace; `README.md` has the pipeline, layout and how to run it.

- `apps/web`: the Next.js app (consult sheet, Ask, assistant, admin). Its own notes
  are in `apps/web/CLAUDE.md` and `apps/web/PRODUCT.md`.
- `packages/protocol`: the PDF to spec pipeline and the spec schema.
- `scripts/`: seeding, evals and one-off pipeline runs.

`bun run ci` is the gate: lint, format, knip, type-check of every workspace, tests.
Lint, format and knip are configured once at the root (`.oxlintrc.json`, `knip.json`);
every workspace type-checks against the nk-dev presets via `tsconfig.app.json` (the
Next app) or `tsconfig.package.json` (everything else).

@./node_modules/@ingram-tech/nk-dev/guide.md
