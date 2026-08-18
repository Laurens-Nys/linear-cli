# Development

Pinned toolchain: Bun 1.3.14. Install with `bun install --frozen-lockfile`.

```sh
bun test              # unit tests, no network
bunx tsc --noEmit     # types
bun run build         # dist/lin
bun run check:size    # compiled binary size budget
bun run check:startup # --version/--help smoke after warmup
bun run check:budgets # both budgets
```

`lin doctor` is the first-run check after a source or binary install. It prints a `checks` table and exits 1 if a required check failed. A missing `LINEAR_API_KEY` never prints the secret.

## Budgets

- Size: `scripts/check-binary-size.ts` fails if `dist/lin` exceeds 96 MiB. The current host binary is about 75 MiB.
- Startup: `scripts/check-startup.ts` warms once, then times three `--version` runs and one `--help`. Each timed run must finish within 5s. That is a hang/regression tripwire, not a micro-benchmark.

CI runs typecheck, tests, host build, and both budgets on `ubuntu-latest` and `macos-latest`. A separate Linux job validates `.goreleaser.yaml`, builds a snapshot with `--skip=publish`, and checks the four archives plus `checksums.txt` and a `lin` member in each archive. It lists archive members with `tar -tzf` and never executes foreign-arch binaries. GoReleaser is pinned to `~> v2.10` (homebrew_casks needs v2.10+).

## Live smoke

GitHub Action `live-smoke` is `workflow_dispatch` only. It builds the host binary and runs:

```
lin auth
lin doctor
lin cache warm
lin team list
lin ls -n 5
lin today -n 5
```

Each Linear command's stdout is redirected to `/dev/null`. The step prints only those static labels and the command's exit status still fails the job. It fails clearly when repository secret `LINEAR_API_KEY` is absent. The key stays in the environment and is never printed. Workspace email, teams, issues, customers, and cache paths must not appear in the log. The workflow never runs mutations (`start`, `done`, `issue update`, `comment add`, and the rest).

## Release safety

`workflow_dispatch` dry-runs (`check` or `snapshot`) have `contents: read` only and cannot publish.

A tag push with `LIN_RELEASE_PUBLISH` unset or not exactly `true` runs only the fail-closed `guard` job (`contents: read`) and exits 1.

The `publish` job runs only on a tag push when `vars.LIN_RELEASE_PUBLISH` is exactly `true`. It is the only job with `contents: write`, and it names the protected GitHub Environment `release`. That variable plus the environment is the approval boundary. Both stay unset/unprotected-for-workers now and must stay that way until a separate publish approval.

Homebrew cask `skip_upload` is `true` until a separate tap approval explicitly changes it. The tap token stays commented.

Manual dry-run: Actions → release → Run workflow → `check` or `snapshot`. `workflow_dispatch` never publishes.

### First release checklist (after separate approval)

1. Confirm the approval names a version and allows GitHub release publication.
2. Create or confirm the protected GitHub Environment named `release` (required reviewers).
3. Create the empty tap repository `Laurens-Nys/homebrew-tap` if it does not exist.
4. Decide whether this release may push the cask. If yes, after a separate tap approval: add secret `HOMEBREW_TAP_TOKEN` with tap write access, uncomment the token line in `.goreleaser.yaml`, and change `skip_upload` from `true` to `auto` or `false`. After the release, revert `skip_upload` to `true`, comment the token line again, and remove or rotate the secret. If this release must not push the cask, leave `skip_upload: true` and the token commented.
5. Decide notarization. The cask currently only strips `com.apple.quarantine`. The binary is not notarized.
6. Enable `LIN_RELEASE_PUBLISH=true` for the publish window only.
7. Push the approved tag (`vX.Y.Z`). Do not tag from a worker.
8. Unset `LIN_RELEASE_PUBLISH` after the release so a later accidental tag cannot publish.

Until those steps are approved, do not tag, do not create a GitHub release, and do not add a tap token.
