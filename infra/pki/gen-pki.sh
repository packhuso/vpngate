#!/usr/bin/env bash
# VPN Hub — private CA + mTLS certs (design Section 6.1 layer 2 / 6.5).
# Control plane owns the CA. Outputs (gitignored):
#   ca.crt/ca.key                 private CA
#   gw-<id>.crt/.key              agent TLS server cert (deploy to gateway)
#   worker.crt/worker.key         control-plane client cert (mTLS)
# Usage: gen-pki.sh <gateway-id> <gateway-ip> [gateway-host]
set -euo pipefail
cd "$(dirname "$0")"

GW_ID="${1:?gateway id, e.g. gw1}"
GW_IP="${2:?gateway ip}"
GW_HOST="${3:-vpnhub-${GW_ID}}"
DAYS=3650
EC="-newkey ec -pkeyopt ec_paramgen_curve:prime256v1"

umask 077

# --- CA (reuse if exists) ---
if [[ ! -f ca.key ]]; then
  openssl req -x509 -nodes -days "$DAYS" $EC \
    -keyout ca.key -out ca.crt \
    -subj "/O=VPN Hub/CN=VPN Hub Private CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  echo "CA created"
fi

sign() { # name  subject  san  extku
  local name="$1" subj="$2" san="$3" eku="$4"
  openssl req -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$name.key" -out "$name.csr" -subj "$subj"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS" -out "$name.crt" \
    -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=%s\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n" "$san" "$eku")
  rm -f "$name.csr"
  chmod 600 "$name.key"; chmod 644 "$name.crt"
}

# --- gateway server cert (agent TLS listener) ---
sign "gw-${GW_ID}" "/O=VPN Hub/CN=${GW_HOST}" \
  "DNS:${GW_HOST},IP:${GW_IP}" "serverAuth"

# --- worker client cert (control plane → agent, mTLS) ---
sign "worker" "/O=VPN Hub/CN=vpnhub-worker" \
  "DNS:vpnhub-worker" "clientAuth"

chmod 644 ca.crt
echo "PKI ready:"
ls -1 ca.crt "gw-${GW_ID}.crt" "gw-${GW_ID}.key" worker.crt worker.key
echo "--- verify chain ---"
openssl verify -CAfile ca.crt "gw-${GW_ID}.crt" worker.crt
