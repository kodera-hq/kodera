# Control-Plane Security Documentation

**Status:** Active · **Owner:** SEC

This directory holds the security architecture, threat model, supply-chain policy, and secure development lifecycle for the Kodera control plane (`apps/server`).

## Reporting a vulnerability

Never open a public GitHub issue for a security vulnerability. Follow the root [SECURITY.md](../../../../SECURITY.md) policy (GitHub Private Vulnerability Reporting or `support@kodera.io`).

## Documents in this directory

- [`THREAT_MODEL.md`](THREAT_MODEL.md) — assets, trust boundaries, attacker profiles, STRIDE controls, worker isolation model, and architectural trade-offs.
- [`SECURE_SDLC.md`](SECURE_SDLC.md) — branch, review, secret-scanning, dependency-advisory, and security-review rules aligned with root [`GOVERNANCE.md`](../../../../GOVERNANCE.md).
- [`SUPPLY_CHAIN_POLICY.md`](SUPPLY_CHAIN_POLICY.md) — dependency lockfile, image digest pinning, vulnerability gating, and SBOM policy.
- [`THIRD_PARTY_ACTIONS.md`](THIRD_PARTY_ACTIONS.md) — SHA-pinned GitHub Actions review record.

## Core rules

- **Never commit or log secrets.** All test and development fixtures use synthetic values.
- **Never log, fixture, or test with real customer data.** Only synthetic data is permitted in tests and development environments.
