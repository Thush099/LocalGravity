#!/usr/bin/env bash
set -euo pipefail

echo "=== LocalGravity Clean Uninstaller ==="

# 1. Stop running app
if pgrep -x "LocalGravity" >/dev/null 2>&1; then
  echo "Stopping LocalGravity.app..."
  pkill -x "LocalGravity" || true
  sleep 1
fi

# 2. Unload & remove managed LaunchAgents
for plist in "${HOME}"/Library/LaunchAgents/com.localgravity.*.plist; do
  [ -e "${plist}" ] || continue
  echo "Unloading scheduled agent: ${plist}"
  launchctl unload -w "${plist}" 2>/dev/null || true
  rm -f "${plist}"
done

# 3. Remove application bundle and runtime state
if [ -d "/Applications/LocalGravity.app" ]; then
  echo "Removing /Applications/LocalGravity.app..."
  rm -rf "/Applications/LocalGravity.app"
fi

if [ -d "${HOME}/.localgravity" ]; then
  echo "Removing ${HOME}/.localgravity..."
  rm -rf "${HOME}/.localgravity"
fi

# 4. Optional model & CLI removal
REMOVE_MODELS="${1:-}"
if [ "${REMOVE_MODELS}" = "--purge-models" ]; then
  DO_PURGE="y"
else
  read -r -p "Also remove Ollama models (qwen3.5:9b), Ollama, and ImageMagick to reclaim ~7-8 GB? [y/N]: " DO_PURGE || DO_PURGE="n"
fi

if [[ "${DO_PURGE}" =~ ^[Yy]$ ]]; then
  if command -v ollama >/dev/null 2>&1; then
    STARTED_TEMP_OLLAMA=0
    if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      ollama serve >/dev/null 2>&1 &
      TEMP_OLLAMA_PID=$!
      STARTED_TEMP_OLLAMA=1
      sleep 2
    fi
    ollama rm qwen3.5:9b 2>/dev/null || true
    if [ "${STARTED_TEMP_OLLAMA}" = "1" ] && [ -n "${TEMP_OLLAMA_PID:-}" ]; then
      kill "${TEMP_OLLAMA_PID}" 2>/dev/null || true
    fi
    brew uninstall ollama 2>/dev/null || true
  fi
  if command -v magick >/dev/null 2>&1; then
    brew uninstall imagemagick 2>/dev/null || true
  fi
fi

echo "LocalGravity cleanly removed."
