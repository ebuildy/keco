#!/usr/bin/env bash
# `mise run infra:reset` used to mean "wipe the read model; rebuild offline in minutes with
# zero GitHub calls". That is no longer the whole truth: the same Meilisearch volume now holds
# discovery's write model, which is NOT rebuildable offline — only by re-sweeping GitHub
# Search, which is hours of paced requests.
#
# So the command says what it is about to destroy before destroying it. The counts come from
# `kecoctl discovery count`, not from a second query written here, so the two can never
# disagree about what is on disk.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--yes" ]]; then
  echo "this destroys discovery write-model data that is NOT rebuildable offline:"
  echo
  # A dead or empty Meilisearch is not a reason to refuse to reset it — that is very often
  # exactly why someone is resetting.
  pnpm -s -F @keco/workers kecoctl discovery count 2>/dev/null || echo "  (could not read discovery data)"
  echo
  read -r -p "continue? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "cancelled"; exit 1; }
fi

docker compose -f infra/compose.yml down -v
