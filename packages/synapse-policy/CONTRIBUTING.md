# Contributing

Thank you for looking at this module. It is small on purpose: each rule refuses one way of routing around the control plane's room policy, and each has a test that fails when the rule is broken.

## Before you open a pull request

1. Branch from `main`; never push to `main` directly.
2. Run the three suites from the [README](README.md#test): the unit tests, `python3 tests/mutate.py`, and the integration test with and without the module (`WITHOUT_MODULE=1` must fail).
3. A new rule or a changed rule comes with a test that fails without it, and a mutation in `tests/mutate.py` that names that test.
4. Write a one-line commit message that says why, with no trailers.
5. In the pull request body, state the change, how to check it, and the evidence (the suite outputs).

`ci-ok` is the one required check. It must be green on the head of your branch before a merge.

## Licence

By contributing you agree that your contribution is licensed under AGPL-3.0-or-later ([LICENSE](LICENSE)) and the Contributor License Grant in [../../CONTRIBUTING.md](../../CONTRIBUTING.md) §3.

## Contact

Questions: **support@kodera.io**. Security reports: see [SECURITY.md](SECURITY.md), never a public issue.
