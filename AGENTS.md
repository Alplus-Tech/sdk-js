# packages/sdk

`@alplus/sdk`, published to public npm and mirrored to a public GitHub repo. SDK contract
is normative in `docs/sdk/01-sdk-spec.md` — do not restate it here.

Root conventions apply first: `../../AGENTS.md`, **except** the internal-docs-linking rule
below, which is stricter for this package.

## Local conventions

- **Zero runtime dependencies.** Never add one without explicit founder approval — this is
  a distribution constraint, not just a style preference.
- **Never-throw guarantee**: every capture/transport path catches and swallows, it never
  lets an SDK call throw into host application code.
- **Public repo, closed platform.** Nothing shipped from this package — README, code
  comments in `files: ["dist", "README.md"]`, JSDoc that ends up in `.d.ts` — may reference
  `docs/**` or any other internal-repo path. The npm README must be fully self-contained
  and describe only what the published package actually exports (today: `heartbeat()`
  only, from `.`, `./node`, `./cloudflare`, `./core`). No aspirational API surface.
- Client-facing distribution rules in full: `docs/product/00-ratified-decisions.md`
  ("Distribution" section).
