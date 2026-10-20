# Frozen-12 Alpac fork

Upstream: https://github.com/Kirill9732/alpac_source

`main` follows the author's source. `custom` contains this fork's changes. Keep
individual features in separate commits and merge them into `custom`.

## Filmix fix

The effective device token, including a personal Kit override, is checked for
PRO/PRO+ rights. A verified premium token takes precedence over the separate
api-fx account, including in `fx_mode = "primary"`. Available qualities are read
from the API and sorted in descending order. A local `pro = true` flag alone does
not grant high-quality streams to an unknown personal token.

The upstream fallback mode, token health monitoring, and cross-account 429
re-mint mechanism are retained. Re-mint can use rights confirmed by the existing
background profile probe. Expired subscriptions are not treated as premium.

If a stale personal Kit token overrides a valid global token, remove that
personal override or replace it through Kit with a valid token. This runtime
configuration change is separate from the source fix.

## Merge changes from the author

Initial clone:

```sh
git clone --branch custom https://github.com/Frozen-12/alpac_source.git
cd alpac_source
git remote add upstream https://github.com/Kirill9732/alpac_source.git
```

Before updating, commit your work and ensure `git status --short` is empty.
Use a new update branch name each time:

```sh
git switch custom
git fetch upstream
git switch -c update/upstream-YYYY-MM-DD
git merge upstream/main
```

Resolve any conflicts, run the checks, and inspect the diff. To cancel an
unfinished merge, run `git merge --abort`. For a particular upstream release,
merge its verified tag or commit instead of `upstream/main`.

```sh
go test ./internal/litesrc ./internal/httpapi -run 'Filmix|PremiumToken|TokenEntitlements' -count=1 -timeout 180s
go vet ./...
git switch custom
git merge --ff-only update/upstream-YYYY-MM-DD
git push origin custom
```

Do not reapply the original Filmix patch on top of `custom`: the fix is already
part of its history. Do not replace `custom` with upstream using a hard reset or
force push. Review an author's equivalent fix before retiring a local change.

## Checks and downloadable builds

The `Custom checks and Linux build` GitHub Actions workflow runs Filmix regression
tests, `go vet ./...`, and a Linux amd64 build on pushes and pull requests to
`custom`. It uploads a binary archive, matching `plugins` and `wwwroot` archives,
SHA256 sums, and the exact source commit. Artifacts are retained for 30 days.
For permanent storage, download the artifact or publish a reviewed release.

The full upstream test suite can be enabled for a manual workflow run. It is
not the default gate: the upstream suite includes platform/environment-sensitive
tests. Initial Windows validation passed Filmix tests and vet; the full suite
also encountered Windows file-permission, process-execution, and unrelated
fixture failures. No claim is made that all upstream tests pass on every host.

To use manual runs when `main` remains the default branch, open this workflow on
`custom`, or set `custom` as the repository default branch. The push trigger works
without changing the default branch.

## Deployment

The workflow does not automatically deploy to a server and needs no server
credentials. Review the build, make a runtime backup/snapshot, then install the
binary and any changed frontend assets from the same commit. Preserve local
configuration, databases, and keys. Use a health check and keep the previous
binary for rollback.

The built-in updater downloads complete releases from a compatible update
server; it does not merge Git changes. Installing an official release can replace
this fork's binary. Keep `[updater] auto_install = false` while deploying custom
builds manually. Any external cron/timer update script must be handled separately.
A GitHub repository URL is not a compatible updater `server_url` by itself.

## Runtime files

Never commit working configuration, tokens, keys, database contents, or backups.
The repository is for source only. In addition to upstream ignores, this fork
ignores `.kitkey`, backup directories, and local PID files.
