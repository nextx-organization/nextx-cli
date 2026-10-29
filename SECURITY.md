# Security

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/nextx-organization/nextx-cli/security/advisories/new). Do not open a public issue.

We acknowledge reports within two business days and publish fixes as new releases.

## Verifying a download

Every file in a GitHub release has a signed build provenance attestation, and `SHA256SUMS` lists its checksum:

```bash
gh attestation verify nextx-darwin-arm64.tar.gz --repo nextx-organization/nextx-cli
shasum -a 256 -c SHA256SUMS --ignore-missing
```

npm releases of `@nextxai/cli` carry provenance attestations.
