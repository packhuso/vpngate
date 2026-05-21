//go:build linux

// OpenVPN client-cert issuance, in-process (no easy-rsa subprocess at runtime).
// The node CA (cert + key) lives in the PKI dir the agent can read
// (AGENT_OVPN_PKI_DIR, default /etc/openvpn/pki). We load it once per request,
// generate a fresh client keypair, and sign a clientAuth cert whose CN matches
// the CCD filename so `ccd-exclusive` pins the client to its tunnel.
//
// Issued certs are cached on disk under <pki>/clients/<cn>.{crt,key} so a repeat
// download returns the same identity instead of churning new certs.
package wg

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

const clientCertValidity = 2 * 365 * 24 * time.Hour

// issueClientCert returns the material for an inline .ovpn profile. cn must be
// pre-sanitized (matches the CCD filename).
func issueClientCert(pkiDir, cn string) (*ClientCert, error) {
	// ca.crt is the server's CA bundle — returned as <ca> so the customer can
	// verify the server. (When a dedicated client-issuer CA is used, its cert is
	// also appended here so the server trusts the clients we sign.)
	caCertPEM, err := os.ReadFile(filepath.Join(pkiDir, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("read ca.crt: %w", err)
	}
	tcKey, err := os.ReadFile(filepath.Join(pkiDir, "tc.key"))
	if err != nil {
		return nil, fmt.Errorf("read tc.key (tls-crypt): %w", err)
	}

	clientsDir := filepath.Join(pkiDir, "clients")
	if err := os.MkdirAll(clientsDir, 0o700); err != nil {
		return nil, fmt.Errorf("clients dir: %w", err)
	}
	crtPath := filepath.Join(clientsDir, cn+".crt")
	keyPath := filepath.Join(clientsDir, cn+".key")

	// reuse a previously-issued identity for this CN if present
	if crt, err1 := os.ReadFile(crtPath); err1 == nil {
		if key, err2 := os.ReadFile(keyPath); err2 == nil {
			return &ClientCert{
				CACert: string(caCertPEM), ClientCert: string(crt),
				ClientKey: string(key), TLSCryptKey: string(tcKey),
			}, nil
		}
	}

	caCert, caKey, err := loadSigningCA(pkiDir)
	if err != nil {
		return nil, err
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("gen client key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(clientCertValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &priv.PublicKey, caKey)
	if err != nil {
		return nil, fmt.Errorf("sign client cert: %w", err)
	}
	crtPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})

	keyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})

	// persist for reuse (best-effort; a failure here is non-fatal)
	_ = os.WriteFile(crtPath, crtPEM, 0o644)
	_ = os.WriteFile(keyPath, keyPEM, 0o600)

	return &ClientCert{
		CACert: string(caCertPEM), ClientCert: string(crtPEM),
		ClientKey: string(keyPEM), TLSCryptKey: string(tcKey),
	}, nil
}

// loadSigningCA parses the CA used to SIGN client certs. It prefers a dedicated
// client-issuer CA (issuer-ca.crt/issuer-ca.key) — generated at deploy time and
// trusted by the server's ca bundle — so we don't need the original easy-rsa CA
// private key. It falls back to ca.crt/ca.key when that key IS available (the
// simpler single-CA setup). easy-rsa builds an RSA CA by default, but accept EC
// too; the key may be PKCS#8, PKCS#1, or SEC1.
func loadSigningCA(pkiDir string) (*x509.Certificate, any, error) {
	certName, keyName := "issuer-ca.crt", "issuer-ca.key"
	if _, err := os.Stat(filepath.Join(pkiDir, keyName)); err != nil {
		// no dedicated issuer key — fall back to the original CA key (if present)
		certName, keyName = "ca.crt", "ca.key"
	}
	certPEM, err := os.ReadFile(filepath.Join(pkiDir, certName))
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", certName, err)
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, nil, fmt.Errorf("ca.crt: no PEM block")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", certName, err)
	}

	keyPEM, err := os.ReadFile(filepath.Join(pkiDir, keyName))
	if err != nil {
		return nil, nil, fmt.Errorf("read %s (must be readable by the agent): %w", keyName, err)
	}
	kb, _ := pem.Decode(keyPEM)
	if kb == nil {
		return nil, nil, fmt.Errorf("%s: no PEM block", keyName)
	}
	if k, err := x509.ParsePKCS8PrivateKey(kb.Bytes); err == nil {
		return cert, k, nil
	}
	if k, err := x509.ParsePKCS1PrivateKey(kb.Bytes); err == nil {
		return cert, k, nil
	}
	if k, err := x509.ParseECPrivateKey(kb.Bytes); err == nil {
		return cert, k, nil
	}
	return nil, nil, fmt.Errorf("ca.key: unsupported private key format")
}
