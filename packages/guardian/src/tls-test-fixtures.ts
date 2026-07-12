/**
 * TEST ONLY — committed PEM fixtures for the guardian direct-listener mTLS
 * passthrough tests (`tls-passthrough.test.ts`, `server-tls.test.ts`).
 *
 * Per spec 435 D5: committed fixtures, not runtime openssl. This is hermetic
 * (no openssl-CLI dependency, no LibreSSL/OpenSSL flag drift across dev
 * machines), deterministic, and mirrors the committed `oc-doc-fixture.ts`
 * idiom.
 *
 * EVERY KEY/CERT BELOW IS TEST ONLY. None of these private keys protect
 * anything real; they exist solely so the mTLS test suite can exercise real
 * TLS handshakes without a live openssl toolchain. This file MUST be excluded
 * from the published npm package (`packages/guardian/package.json` `files`
 * allowlist — test-only private keys must never ship).
 *
 * Chain:
 *   - CA_CERT_PEM / (CA key not exported — only used to mint the fixtures
 *     below at generation time) — the operator's adapter CA.
 *   - SERVER_CERT_PEM/SERVER_KEY_PEM — signed by the CA above. CN=127.0.0.1,
 *     subjectAltName=IP:127.0.0.1,DNS:localhost — matches what tests dial.
 *   - CLIENT_CERT_PEM/CLIENT_KEY_PEM — signed by the CA above. A CA-signed
 *     adapter client cert; the "good cert" case.
 *   - WRONG_CA_CLIENT_CERT_PEM/WRONG_CA_CLIENT_KEY_PEM — signed by a SEPARATE,
 *     unrelated CA (also test-only, its own cert/key are not exported since
 *     nothing needs to trust it) that the guardian's `ca:` trust store does
 *     NOT include. This is the fixture the wrong-CA rejection tests use — the
 *     one case naive `Bun.serve tls:` accepts and the design in spec 435
 *     exists to reject (D1).
 *
 * Key type: EC P-256 (prime256v1) throughout — small, fast to generate/parse,
 * and fully supported by Bun's TLS stack. Validity: 100 years (36500 days)
 * so the fixtures never expire and never need silent regeneration.
 *
 * Regeneration one-liners (openssl 3.x; run in a scratch directory):
 *
 *   # Operator adapter CA
 *   openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
 *   openssl req -x509 -new -key ca-key.pem -sha256 -days 36500 \
 *     -subj "/CN=OpenPalm Guardian Adapter CA (TEST ONLY)" -out ca-cert.pem
 *
 *   # Guardian server cert (CN=127.0.0.1, SAN IP:127.0.0.1,DNS:localhost)
 *   openssl ecparam -name prime256v1 -genkey -noout -out server-key.pem
 *   openssl req -new -key server-key.pem -subj "/CN=127.0.0.1" -out server-csr.pem
 *   printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' > server-ext.cnf
 *   openssl x509 -req -in server-csr.pem -CA ca-cert.pem -CAkey ca-key.pem \
 *     -CAcreateserial -days 36500 -sha256 -extfile server-ext.cnf -out server-cert.pem
 *
 *   # CA-signed adapter client cert
 *   openssl ecparam -name prime256v1 -genkey -noout -out client-key.pem
 *   openssl req -new -key client-key.pem -subj "/CN=test-adapter (TEST ONLY)" -out client-csr.pem
 *   printf 'extendedKeyUsage=clientAuth\n' > client-ext.cnf
 *   openssl x509 -req -in client-csr.pem -CA ca-cert.pem -CAkey ca-key.pem \
 *     -CAcreateserial -days 36500 -sha256 -extfile client-ext.cnf -out client-cert.pem
 *
 *   # Wrong CA + a client cert it signs (the CA the guardian must NOT trust)
 *   openssl ecparam -name prime256v1 -genkey -noout -out wrong-ca-key.pem
 *   openssl req -x509 -new -key wrong-ca-key.pem -sha256 -days 36500 \
 *     -subj "/CN=Wrong Adapter CA (TEST ONLY, not trusted by guardian)" -out wrong-ca-cert.pem
 *   openssl ecparam -name prime256v1 -genkey -noout -out wrong-client-key.pem
 *   openssl req -new -key wrong-client-key.pem -subj "/CN=wrong-ca-adapter (TEST ONLY)" -out wrong-client-csr.pem
 *   openssl x509 -req -in wrong-client-csr.pem -CA wrong-ca-cert.pem -CAkey wrong-ca-key.pem \
 *     -CAcreateserial -days 36500 -sha256 -extfile client-ext.cnf -out wrong-client-cert.pem
 */

/** TEST ONLY — operator adapter CA certificate (self-signed). */
export const CA_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBvTCCAWOgAwIBAgIUG3ugCBUABDwvAkgUXT0yk4eVvXswCgYIKoZIzj0EAwIw
MzExMC8GA1UEAwwoT3BlblBhbG0gR3VhcmRpYW4gQWRhcHRlciBDQSAoVEVTVCBP
TkxZKTAgFw0yNjA3MTIwMzAzNDRaGA8yMTI2MDYxODAzMDM0NFowMzExMC8GA1UE
AwwoT3BlblBhbG0gR3VhcmRpYW4gQWRhcHRlciBDQSAoVEVTVCBPTkxZKTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFl1cC39dGBXif9Jf5D34/+lybzM20XDselv
uqstfQEZHkrowvKeg3o1btx8l1cT33YpeTgxIP766S6AT8Slyv+jUzBRMB0GA1Ud
DgQWBBQ0XNbYinC4byy2OhwiVpuGkjTMHjAfBgNVHSMEGDAWgBQ0XNbYinC4byy2
OhwiVpuGkjTMHjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCICzb
lO9KcJhUEasEcjHYQTotiWjifQwFnQEZs+kLilSPAiEAyEhZDDSyAhGn1B5SBUbU
8OjZPR0ZXTdxYsBWk++NVlg=
-----END CERTIFICATE-----
`;

/** TEST ONLY — guardian server cert, signed by CA_CERT_PEM. CN=127.0.0.1, SAN IP:127.0.0.1,DNS:localhost. */
export const SERVER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBvjCCAWSgAwIBAgIUW7dvdJgxwKcdTP7q7nik4q984jwwCgYIKoZIzj0EAwIw
MzExMC8GA1UEAwwoT3BlblBhbG0gR3VhcmRpYW4gQWRhcHRlciBDQSAoVEVTVCBP
TkxZKTAgFw0yNjA3MTIwMzAzNDRaGA8yMTI2MDYxODAzMDM0NFowFDESMBAGA1UE
AwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2flQq/AN6bHN
e4V3PwctsvUlVCJSp9oG+kkrYUuoBg1fq/qIGYgUEdgkJrgDlSWdDU/SRWX89eGV
/ZwddaWjbaNzMHEwGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MBMGA1UdJQQM
MAoGCCsGAQUFBwMBMB0GA1UdDgQWBBRBEO2YEXaxro36ZkQ+EHkaPEL7YjAfBgNV
HSMEGDAWgBQ0XNbYinC4byy2OhwiVpuGkjTMHjAKBggqhkjOPQQDAgNIADBFAiEA
0JPdy9hIN94acdZBijRxaykbDT+QjTLqlFf0WwDLjMkCIEqiOh57xMjAfbqSpmQi
NPykPyowogpVF5SqkC7wQOsp
-----END CERTIFICATE-----
`;

/** TEST ONLY — guardian server private key, matching SERVER_CERT_PEM. */
export const SERVER_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIMzGM1Xlj8PDha0S/cZPZ//9ktBrLSLFdB5ebXWkDoYroAoGCCqGSM49
AwEHoUQDQgAE2flQq/AN6bHNe4V3PwctsvUlVCJSp9oG+kkrYUuoBg1fq/qIGYgU
EdgkJrgDlSWdDU/SRWX89eGV/ZwddaWjbQ==
-----END EC PRIVATE KEY-----
`;

/** TEST ONLY — CA-signed adapter client cert (the "good" client, accepted at handshake). */
export const CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVegAwIBAgIUW7dvdJgxwKcdTP7q7nik4q984j0wCgYIKoZIzj0EAwIw
MzExMC8GA1UEAwwoT3BlblBhbG0gR3VhcmRpYW4gQWRhcHRlciBDQSAoVEVTVCBP
TkxZKTAgFw0yNjA3MTIwMzAzNDRaGA8yMTI2MDYxODAzMDM0NFowIzEhMB8GA1UE
AwwYdGVzdC1hZGFwdGVyIChURVNUIE9OTFkpMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEWfHMD64r3p/4v5Ya8iUsQojN1STsEKYIA0+Rman3N7jSnLJ0NhzMjP2w
QkrJJzjuo7kUM4N8YrveuhG1cy0EGqNXMFUwEwYDVR0lBAwwCgYIKwYBBQUHAwIw
HQYDVR0OBBYEFCHxLGhARXO4t9NW35HcJwZD771/MB8GA1UdIwQYMBaAFDRc1tiK
cLhvLLY6HCJWm4aSNMweMAoGCCqGSM49BAMCA0cAMEQCIBf3DwwvniMvKKEsFreq
MHmtuDdLPuUtHPinNSAkWbIWAiA80VNok6RVpGlhq93f09k36udNUcjp5tO5T7o1
9nVWjA==
-----END CERTIFICATE-----
`;

/** TEST ONLY — private key matching CLIENT_CERT_PEM. */
export const CLIENT_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIHFopUv93ho7UKLV+0fAbFb98eoiieFRqd2OUMRl1kRtoAoGCCqGSM49
AwEHoUQDQgAEWfHMD64r3p/4v5Ya8iUsQojN1STsEKYIA0+Rman3N7jSnLJ0NhzM
jP2wQkrJJzjuo7kUM4N8YrveuhG1cy0EGg==
-----END EC PRIVATE KEY-----
`;

/**
 * TEST ONLY — client cert signed by a DIFFERENT, unrelated CA (not
 * CA_CERT_PEM). The guardian's TLS trust store (`ca: CA_CERT_PEM`) never
 * includes this CA, so a chain-verifying server must reject a handshake
 * presenting this cert. This is the fixture the D1 spike found naive
 * `Bun.serve tls:` accepts (broken) and `Bun.listen`'s handshake
 * `authorizationError` correctly flags.
 */
export const WRONG_CA_CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBwjCCAWigAwIBAgIUJvHL+BZNBFKPyKS0xB2u/iMYHCgwCgYIKoZIzj0EAwIw
QDE+MDwGA1UEAww1V3JvbmcgQWRhcHRlciBDQSAoVEVTVCBPTkxZLCBub3QgdHJ1
c3RlZCBieSBndWFyZGlhbikwIBcNMjYwNzEyMDMwMzQ0WhgPMjEyNjA2MTgwMzAz
NDRaMCcxJTAjBgNVBAMMHHdyb25nLWNhLWFkYXB0ZXIgKFRFU1QgT05MWSkwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAASrLOH9VCoQte3OJ7W/SgUXUlU9YvlfzTUj
OTrPr2QOzdKO36urKLhtU5AkN67NPMVghIkoSM/aFA8YY4XtkYdWo1cwVTATBgNV
HSUEDDAKBggrBgEFBQcDAjAdBgNVHQ4EFgQUUj/qmPf0uJSBcNf/i5CishsRtKcw
HwYDVR0jBBgwFoAUz5+cumT+FvNVOApD4DwEGo1dOq4wCgYIKoZIzj0EAwIDSAAw
RQIgae83EDe4oOsbFAFyDWzcCeMc+ZunXgDYnblcFiY2CZICIQCp7ZXjnfv3lo0S
V0yOTgAVfVSdICD9msVHUtfXTCl3jg==
-----END CERTIFICATE-----
`;

/** TEST ONLY — private key matching WRONG_CA_CLIENT_CERT_PEM. */
export const WRONG_CA_CLIENT_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJ9SsZ7Cmbcyt0j5m41+cwFV6KyAQQj9kP+6h1sh5l5qoAoGCCqGSM49
AwEHoUQDQgAEqyzh/VQqELXtzie1v0oFF1JVPWL5X801Izk6z69kDs3Sjt+rqyi4
bVOQJDeuzTzFYISJKEjP2hQPGGOF7ZGHVg==
-----END EC PRIVATE KEY-----
`;
