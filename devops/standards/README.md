# devops/standards: the family contract, checked

The design is `.planning/family-standards-2026-10.md`. This directory is its
implementation, and it is not a workspace package on purpose: a new
`packages/*` entry would change the lockfile of every pnpm repo that has
`inite-shared/packages/*` in its workspace.

| Path | What |
|---|---|
| `bin/inite-standards.mjs` | the CLI: `check`, `lint`, `sizes`, `protection`, `ci-verdict`, `drift`, `rules` |
| `lib/` | the rules (`checks.mjs`), the ratchets, the pin, secrets, workflow reading, GitHub reads, what a deploy may remove on the shared host (`host-safety.mjs`), the env contract (`env-rules.mjs`, with `lib/shared-env.json`: the names the shared packages read) |
| `family/family.sh` | the wrapper every repo carries as `scripts/family.sh`, byte for byte |
| `family/gate.sh` | the one list of checks: pre-commit (`GATE_SCOPE=commit`) and CI (full) |
| `family/release.sh` | CalVer GitHub release of main's head, the only thing that deploys |
| `family.json` | the family: repos, profiles, the Next and Node versions, script names |
| `templates/` | the thin `ci.yml`, the head of a deploy workflow, the hook, the config |
| `MANIFEST` | the files `family.sh` fetches; add a new file here |
| `test/` | `node --test devops/standards/test/*.test.mjs` |

The shared workflows are in `.github/workflows/`: `ci.yml` (called by each
repo's thin ci.yml), `release-gate.yml` and `verify-deploy.yml` (called by each
deploy workflow), `drift.yml` (weekly, here), and `standards-test.yml` (this
directory's tests). `.github/actions/family` points a runner at this directory.

## In a repo

```sh
sh scripts/family.sh standards check          # conformance; --against origin/main as CI does
sh scripts/family.sh lint                     # = pnpm lint
sh scripts/family.sh gate                     # what CI runs
sh scripts/family.sh release --dry            # what would go out
sh scripts/family.sh release --yes --watch    # release, then wait for the deploy and its verify
```

`.inite/standards.json` holds the profile (`next`, `node`, `python`), the gate
step overrides (`commands`), the deploy workflows (`deploy.workflows`) and the
debt: a rule the repo does not meet yet, with the reason. Debt only shrinks:
CI refuses a new entry, and a paid one fails until it is struck. The two
numeric records are `.inite/file-size-baseline.json` and
`.inite/lint-baseline.json`; `--update` lowers them, nothing raises them, and
`--seed` writes the first one only where none exists.

## The public mirror: inite-ai/family-ci

GitHub refuses a public repo's call to a private repo's reusable workflow, and
auth, billing and brain are public. They call `inite-ai/family-ci` instead: a
public, generated copy of the three reusable workflows, the `family` action
and this directory (decided by the owner on 29.10.2026). inite-shared stays
the source of truth; private repos keep calling inite-shared. After a change
here merges, run `sh devops/standards/sync-family-ci.sh` from a clean main
(`--dry` first). The checker accepts either path. Nothing secret lives in
what is mirrored.
