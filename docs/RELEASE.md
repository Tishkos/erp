# Cutting a release

REQ-IMPROVE-001 OP-11. A release is a version in `package.json`, a line in
`CHANGELOG.md`, a tag, and a deploy of that tag from `main`.

1. **Scope is merged.** Every stage branch for the release is merged to
   `main` through its pull request, CI green.
2. **Version.** On a branch `release/<version>`: set `"version"` in
   `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version`),
   move the `## Unreleased` entries in `CHANGELOG.md` under
   `## <version> — <date>`, listing under **Migrations** every migration the
   release carries and whether it changes data, and under **Rollback** what
   rolling this release back needs. Open the pull request; merge it.
3. **Tag.** `git tag -a v<version> -m "QS ERP <version>" && git push origin v<version>`
   on the merge commit.
4. **Deploy.** `scripts/ops/deploy.sh` from `main` at the tag. The footer
   shows the version; `/healthz` shows the build id; `var/deploys.log` on the
   server records the revision.
5. **Evidence.** The pull request's CI run is the test evidence; the
   integration suite ran again inside `deploy.sh`. Note anything skipped
   (`SKIP_INTEGRATION`, `DEPLOY_ANY_BRANCH`) in the CHANGELOG entry — the
   server keeps the same note in `var/deploy-skips.log`.

Versioning: the first number for a change the accounting manager has to be
told about before it lands (a changed posting rule, a screen moved); the
second for a stage of a requirement; the third for fixes.
