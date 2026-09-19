# backend/ (Symfony) — self-contained task runner.
#
# The root of this repo drives everything else through mise (AGENTS.md §8), but mise isn't
# installed in backend/'s devcontainer (.devcontainer/devcontainer.json) — plain `make` is
# always available there, so it's the task runner for this half of the monorepo. Deliberately
# not wired into the root mise.toml: docs/superpowers/plans/2026-09-12-php-symfony-migration.md's
# ground rules keep every migration phase scoped to backend/ only, with root-level wiring left
# as its own later, explicitly-approved step.

.DEFAULT_GOAL := ci
.PHONY: install check lint lint-fix test taxonomy-check ci

install: ## Install PHP dependencies
	composer install

check: ## Static analysis (PHPStan, max level)
	# The default 128M CLI memory_limit isn't enough for phpstan's own process, separate from
	# --memory-limit's worker budget — it crashes mid-run rather than reporting a clean error.
	vendor/bin/phpstan analyse --memory-limit=1G

lint: ## Import-boundary rules (deptrac, AGENTS.md §7) + coding standard (php-cs-fixer, dry run)
	vendor/bin/deptrac analyse
	vendor/bin/php-cs-fixer fix --dry-run --diff

lint-fix: ## Apply php-cs-fixer's coding-standard fixes
	vendor/bin/php-cs-fixer fix

test: ## Run the PHPUnit test suite (needs Postgres up + an app_test database, see README)
	vendor/bin/phpunit

taxonomy-check: ## Validate taxonomy/taxonomy.yaml against the PHP-side loader
	bin/console app:taxonomy:check

ci: check lint test taxonomy-check ## Everything green before declaring backend work done (AGENTS.md §15)
