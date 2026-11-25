#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Node $(node --version)"
npm test

echo "Checking JavaScript syntax..."
while IFS= read -r file; do
  node --check "$file"
  echo "  ok $file"
done < <(find backend ui scripts -type f \( -name "*.mjs" -o -name "*.js" \) | sort)

echo "Checking shell syntax..."
for file in scripts/*.sh; do
  bash -n "$file"
  echo "  ok $file"
done

echo "All checks passed."
