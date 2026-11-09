# Wraps the commands in docs/dev/BASELINE.md so there is one name per gate, and
# so CI and a laptop run the same thing. Every target is safe to run against an
# empty tree: this repository has tooling before it has code.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

UV ?= uv
COMPOSE ?= docker compose

.PHONY: help lint format typecheck test authz up down logs precommit clean
.PHONY: contract-version-selftest contract-change-selftest

contract-version-selftest: ## Prove the offline contract version policy accepts and rejects correctly
	$(UV) run bash contracts/check-version-policy.selftest.sh

contract-change-selftest: ## Prove the contract breaking-change gate, then that each weakening is refused (needs oasdiff on PATH)
	bash contracts/check-contract-change.selftest.sh
	bash contracts/check-contract-change-ci.selftest.sh
	bash contracts/check-contract-change.mutations.sh

help: ## List the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

lint: ## ruff check + ruff format --check (what CI runs)
	$(UV) run ruff check .
	$(UV) run ruff format --check --diff .

format: ## Apply ruff fixes and formatting
	$(UV) run ruff check --fix .
	$(UV) run ruff format .

typecheck: ## mypy, strict on services/ and the job queue (apps/jobs, apps/outbox, apps/audit, core/db)
	$(UV) run mypy .

# The suite runs against the disposable, fsync-off `test-db` compose service,
# never the development database: see compose.yaml and docs/dev/TESTING.md.
CORE_TEST_DB_PORT ?= 5434
TEST_DATABASE_URL ?= postgres://kodera:kodera@127.0.0.1:$(CORE_TEST_DB_PORT)/kodera_server

.PHONY: test-db require-test-db
test-db: ## Start the disposable, fsync-off Postgres the test suite runs against
	CORE_TEST_DB_PORT=$(CORE_TEST_DB_PORT) $(COMPOSE) --profile test up -d --wait test-db

# Fail fast, with the fix, when no Postgres server answers the test credentials
# on the test database port. A TCP-only probe passed any listener there; this
# one connects and queries, and refuses a foreign service or a rejected
# credential by what it found (tests/test_require_test_db.py proves each
# refusal). A check rather than a dependency on test-db: starting a container
# implicitly under a shared project name recreates another worktree's test-db.
require-test-db:
	@$(UV) run python dev/require_test_db.py "$(TEST_DATABASE_URL)"

test: require-test-db ## pytest with coverage, against test-db (start it with make test-db)
	DATABASE_URL=$(TEST_DATABASE_URL) $(UV) run pytest --cov --cov-report=term-missing

authz: ## Contract roles match docs/api/AUTHZ.md §5, after proving the check can fail (what CI runs)
	$(UV) run scripts/ci/check-authz-matrix.selftest.sh
	$(UV) run python scripts/ci/check-authz-matrix.py

up: ## Start the development stack (Postgres, Keycloak, Mailpit)
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d
	$(COMPOSE) ps

down: ## Stop the development stack, keeping the databases
	$(COMPOSE) down

logs: ## Follow the development stack logs
	$(COMPOSE) logs -f

precommit: ## Install the hooks, then run every one over the whole tree
	$(UV) run pre-commit install
	$(UV) run pre-commit run --all-files

clean: ## Remove tool caches and coverage artefacts
	$(RM) -r .ruff_cache .mypy_cache .pytest_cache htmlcov coverage.xml
	$(RM) .coverage
	find . -type d -name __pycache__ -prune -exec $(RM) -r {} +

.PHONY: acceptance-first-slice
acceptance-first-slice: export CASE := $(CASE)
acceptance-first-slice: ## Report mandatory first-slice scenarios; absent behavior is non-passing
	@$(UV) run python dev/accept_first_slice.py

.PHONY: first-slice-scenarios
first-slice-scenarios: export FIRST_SLICE_CASE := $(CASE)
first-slice-scenarios: export FIRST_SLICE_REQUIRE_PASS := 1
first-slice-scenarios: require-test-db ## First-slice acceptance: nonzero unless every selected scenario passes; CASE=FS-BOOT-01 runs one
	DATABASE_URL=$(TEST_DATABASE_URL) $(UV) run pytest tests/first_slice

.PHONY: check-first-slice-expected-red
check-first-slice-expected-red: ## G1 planning gate: require exactly 0 pass, 32 xfail and 1 owner-blocked scenario
	$(UV) run python dev/check_first_slice_expected_red.py

.PHONY: mutate-first-slice-expected-red
mutate-first-slice-expected-red: ## Prove each G1 expected-red guard catches its weakening
	$(UV) run python dev/mutate_first_slice_expected_red.py

.PHONY: mutate-first-slice-bootstrap
mutate-first-slice-bootstrap: ## Prove the FS-BOOT guards refuse twenty weakenings, each by its message
	$(UV) run python dev/mutate_first_slice_bootstrap.py

.PHONY: check-first-slice-fault-points
check-first-slice-fault-points: ## G1.4: every fault point has one reach() where the inventory says, and every scenario arms a recorded name
	$(UV) run python dev/check_first_slice_fault_points.py

.PHONY: mutate-first-slice-fault-points
mutate-first-slice-fault-points: ## Prove each fault-point guard refuses its weakening by its own message, with a control that stays green
	$(UV) run python dev/mutate_first_slice_fault_points.py
