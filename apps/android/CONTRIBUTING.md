# Contributing to Kodera for Android

Status: Native development through feature branches and pull requests.

Read [README.md](README.md) and [the development guide](docs/DEVELOPMENT.md). Use Kotlin and Jetpack Compose, generated design tokens, catalogue copy and explicit cancellation/lifecycle boundaries. Keep product plans separate from verified behavior.

## Pull request workflow

1. **Create a feature branch** from `main`, or from an explicitly declared prerequisite branch for a stacked change.
2. Define the problem and runnable acceptance before implementation. Keep changes focused.
3. Run the applicable repository checks. Put the commands you ran and their results in the pull request.
4. Commit with one concise line explaining why. No trailers, co-authors or generator attribution. Never commit on main or master.
5. Push the feature branch and open a pull request with a summary and test plan, including specification, acceptance and evidence.

## Merge policy

Required CI must pass on the current head; follow the review rings in the root [GOVERNANCE.md](../../GOVERNANCE.md) and `.github/CODEOWNERS`.

Keep the mandatory Vendor attribution aggregate, required clauses, canonical checkers and refusal self-tests intact. Do not bypass failed, skipped, stale or unavailable gates. Local checks do not replace the required remote status. Publication does not authorize workflow activation, signing or distribution.

## Reports and licensing

Use the repository issue templates for ordinary bugs and feature requests. **Do not open a public issue for a security vulnerability.** Follow [SECURITY.md](SECURITY.md). Support is support@kodera.io. Contributions use the project's [LICENSE](LICENSE).
