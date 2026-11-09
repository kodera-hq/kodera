# Security policy

## Reporting a vulnerability

If you find a vulnerability in this module, **do not open a public issue or pull request**. Write to:

**support@kodera.io**

Include what a reviewer needs to reproduce it: the Synapse version, the module configuration, the requests or events involved, and what the module let through or refused.

We acknowledge the report, agree a fix and a disclosure date with you, and credit you in the release notes unless you ask us not to.

## Scope

In scope: a request or event that the module should refuse (see the table in the [README](README.md)) and does not, a crash or refusal that breaks a flow the module should allow, and anything in this repository's CI that would let such a change merge.

Out of scope: vulnerabilities in Synapse itself (report them to the [Matrix.org security disclosure policy](https://matrix.org/security-disclosure-policy/)), and denial of service against a homeserver.

## Supported versions

Only the latest commit on `main` is supported.
