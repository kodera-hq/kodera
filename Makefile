.PHONY: help dev build test test-tokens test-sdk test-rust test-server test-web check community-config community-up community-down

help:
	@echo "Kodera Monorepo Targets:"
	@echo "  make dev               Start @kodera/web development server"
	@echo "  make build             Build @kodera/design-tokens, @kodera/web, and Rust workspace"
	@echo "  make test              Run fast offline unit suites across tokens, SDK, Rust core, and web"
	@echo "  make test-server       Run full apps/server suite against disposable test-db (run 'make -C apps/server test-db' first)"
	@echo "  make check             Run attribution, required-clauses, token grammar/contrast, Rust fmt/clippy, and typechecks"
	@echo "  make community-config  Validate deploy/community/docker-compose.yml"
	@echo "  make community-up      Boot the self-hosted Kodera Community stack"
	@echo "  make community-down    Stop the Kodera Community stack"

dev:
	npm run dev

build:
	npm run build
	cargo build --locked --workspace

test-tokens:
	npm run test:tokens

test-sdk:
	npm run test:sdk

test-rust:
	cargo test --locked --workspace

test-web:
	npm run test:web

test-server:
	$(MAKE) -C apps/server test

test: test-tokens test-sdk test-rust test-web

check:
	python3 .github/scripts/check-vendor-attribution.py .
	python3 .github/scripts/check-required-clauses.py .
	npm run test:tokens
	npm run typecheck
	cargo fmt --all -- --check
	cargo clippy --locked --workspace --all-targets -- -D warnings

community-config:
	docker compose --project-directory deploy/community -f deploy/community/docker-compose.yml --env-file deploy/community/.env.example config -q

community-up:
	@test -f deploy/community/.env || (echo "Copy deploy/community/.env.example to deploy/community/.env and set secrets first." >&2; exit 1)
	docker compose --project-directory deploy/community -f deploy/community/docker-compose.yml up -d

community-down:
	docker compose --project-directory deploy/community -f deploy/community/docker-compose.yml down
