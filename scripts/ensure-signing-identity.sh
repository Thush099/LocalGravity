#!/usr/bin/env bash
# Prints the SHA-1 of a stable self-signed code-signing certificate, creating it
# on first use. Signing with a fixed certificate keeps the app's designated
# requirement constant, so macOS remembers the folder access the user granted
# (Downloads, Desktop, Documents, Full Disk Access) instead of asking again after
# every rebuild. Ad-hoc signatures change on every build and reset those grants.
set -euo pipefail

IDENTITY_NAME="${LG_SIGN_IDENTITY:-LocalGravity Code Signing}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

cert_hash() {
  security find-certificate -c "${IDENTITY_NAME}" -Z "${KEYCHAIN}" 2>/dev/null \
    | awk '/SHA-1 hash:/ {print $3; exit}'
}

HASH="$(cert_hash || true)"
if [ -n "${HASH}" ]; then
  echo "${HASH}"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "${tmp}/key.pem" -out "${tmp}/cert.pem" \
  -subj "/CN=${IDENTITY_NAME}/O=LocalGravity/C=US" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

# Import the certificate and key as separate PEM items: a PKCS#12 bundle made by
# OpenSSL 3 uses PBES2, which the macOS security tool rejects. -A lets codesign
# use the key without an interactive keychain prompt.
security import "${tmp}/cert.pem" -k "${KEYCHAIN}" -T /usr/bin/codesign -A >/dev/null
security import "${tmp}/key.pem" -k "${KEYCHAIN}" -T /usr/bin/codesign -A >/dev/null

HASH="$(cert_hash || true)"
if [ -z "${HASH}" ]; then
  echo "could not create ${IDENTITY_NAME}" >&2
  exit 1
fi
echo "${HASH}"