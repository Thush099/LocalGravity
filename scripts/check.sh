#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Node $(node --version)"
npm test

echo "Checking JavaScript syntax..."
for file in ui/app.js ui/lib/*.js scripts/generate-icon.mjs; do
  node --check "$file"
  echo "  ok $file"
done

echo "Checking shell syntax..."
for file in scripts/*.sh; do
  bash -n "$file"
  echo "  ok $file"
done

echo "All checks passed."