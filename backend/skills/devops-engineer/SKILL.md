---
name: devops-engineer
description: Write safe shell automation, macOS launchd jobs, backups, CI workflows, health checks, and rollback plans.
triggers: ["devops", "deploy", "ci", "github actions", "shell script", "backup", "cron", "launchd", "server", "release", "rollback"]
---

# DevOps Engineer

Use this skill for automation scripts, scheduled jobs, CI pipelines, backups, and release work.

## Non-negotiables

- Never deploy, push, force-push, rotate credentials, or delete production data without explicit user authorization.
- Never put secrets in a repository, shell history, CI logs, or chat. Use the keychain, env files excluded from git, or the CI secret store.
- Make every mutating script idempotent and dry-runnable.
- Back up before migrating; verify the backup restores.

## Shell script baseline

```zsh
#!/bin/zsh
set -euo pipefail
IFS=$'\n\t'

DRY_RUN="${DRY_RUN:-1}"
log() { print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY: $*"
  else
    log "RUN: $*"
    "$@"
  fi
}
```

- Quote every variable: `"$path"`, not `$path`.
- Use `mktemp -d` for scratch space and a `trap` to clean it up.
- Check prerequisites with `command -v`.
- Exit non-zero on failure so launchd and CI can detect it.
- Log to stderr, results to stdout.

## Backup recipe

```zsh
src="$HOME/Documents/project"
dest="$HOME/Backups/project-$(date +%Y-%m-%d-%H%M%S).tar.gz"
mkdir -p "$(dirname "$dest")"
tar -czf "$dest" -C "$(dirname "$src")" "$(basename "$src")"
shasum -a 256 "$dest"
# Verify by listing before trusting it
tar -tzf "$dest" >/dev/null && echo "backup ok"
```

Keep a retention policy (for example the last 14 daily and 8 weekly) and test one restore.

## launchd job checklist

- Absolute paths for program, arguments, logs, and working directory.
- `StartCalendarInterval` for a specific time, `StartInterval` for a fixed cadence (minimum 300 s).
- `RunAtLoad` only when the job is truly safe to repeat at login.
- Log stdout and stderr to files under `~/Library/Logs/`.
- Add a `ProcessType` of `Background` for non-interactive work.
- Provide load, inspect, and unload commands in the handoff.

## GitHub Actions baseline

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
```

Pin third-party actions to a major version at minimum and avoid `pull_request_target` with checkout of untrusted code.

## Release and rollback

1. Confirm a clean working tree and passing tests.
2. Tag the release and record the commit SHA.
3. Deploy to a staging target first when one exists.
4. Run a smoke check against the real URL, not just a local port.
5. Keep the previous artifact available and write the exact rollback command.
6. Announce what changed and what to watch.

## Health checks

Prefer a cheap endpoint that touches dependencies (database, queue) and returns a non-200 on failure. Log one line per request with latency and status. Alert on symptoms users feel, not on every restart.

## Guardrails

- No `curl | bash` in scripts you author.
- No `sudo` unless the user explicitly approved that exact command.
- Do not disable TLS verification, firewalls, or code signing to make a step pass.
- Report what you could not verify (production access, secrets, DNS) instead of implying success.
