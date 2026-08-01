# Contributing to @alplus/sdk

This is the public source repo for the official Alplus instrumentation SDK.
Issues and pull requests are welcome.

## Dev setup

```sh
npm install
npm test
npm run build
```

`npm test` runs the Vitest suite; `npm run build` type-checks (`tsc --noEmit`)
and bundles all entry points with `tsup`. Both must pass before a PR is
reviewed.

## Rules for contributions

- **Zero runtime dependencies.** This package ships to serverless/edge
  runtimes (Cloudflare Workers, browsers, Node) where every extra dependency
  is bundle size and attack surface. New runtime `dependencies` are not
  accepted; `devDependencies` are fine.
- **Never throw.** Public functions (`heartbeat()` and anything added later)
  must never throw or reject the caller's promise, regardless of network
  failure or internal bugs. Failures are retried, then swallowed (optionally
  surfaced via a `debug` option). A PR that lets an SDK call crash a host
  app's cron job or request handler will not be merged.
- **Keep entry points in sync.** `.`, `./node`, `./cloudflare`, and `./core`
  must continue to export the same public surface; platform-specific code
  belongs behind runtime capability checks, not separate APIs.
- Add or update tests for any behavior change.
- Match the existing code style; no new linter/formatter config without
  discussion.

## Releases

Versions follow semver within the `0.x` line as described in the README.
Changes are published to npm and tagged as GitHub releases with changelog
notes.
