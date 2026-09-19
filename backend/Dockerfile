#syntax=docker/dockerfile:1

# No Mercure. Inspired by dunglas/symfony-docker's Dockerfile, trimmed to what backend/ actually
# needs (see AGENTS.md's "Local development in a container" and "Two deployables").
#
# The php service (infra/compose.yaml) builds this with `context: ..` (the monorepo root,
# relative to infra/ where that compose file lives) and `dockerfile: backend/Dockerfile`, so
# every COPY path below is rooted at the repo root, not at backend/ — that's what lets the built
# image and the bind-mounted dev container agree on where things live (WORKDIR is /app/backend,
# and the repo root is mounted at /app, so `%kernel.project_dir%/../taxonomy/taxonomy.yaml`
# resolves exactly as it does on the host).

FROM dunglas/frankenphp:1-php8.5 AS frankenphp_base

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

WORKDIR /app/backend

# persistent deps
#
# `apt-get upgrade` is deliberate and must stay: the upstream frankenphp tag is rebuilt on
# FrankenPHP's release cadence, not Debian's security cadence, so by the time we build there are
# always pending trixie security updates (perl, libpcre2, libsqlite3, libssh2, gzip...) already
# published as .deb but not yet baked into the base layer. Without this line the image ships
# every OS CVE fixed since the base image was last built.
# hadolint ignore=DL3008
RUN <<-EOF
	apt-get update
	apt-get upgrade -y
	apt-get install -y --no-install-recommends \
		file \
		git
	install-php-extensions \
		@composer \
		apcu \
		intl \
		opcache \
		pdo_pgsql \
		zip
	apt-get clean
	rm -rf /var/lib/apt/lists/*
EOF

# https://getcomposer.org/doc/03-cli.md#composer-allow-superuser
ENV COMPOSER_ALLOW_SUPERUSER=1

ENV PHP_INI_SCAN_DIR=":$PHP_INI_DIR/app.conf.d"

COPY --link backend/frankenphp/conf.d/10-app.ini $PHP_INI_DIR/app.conf.d/
COPY --link --chmod=755 backend/frankenphp/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
COPY --link backend/frankenphp/Caddyfile /etc/frankenphp/Caddyfile

ENTRYPOINT ["docker-entrypoint"]

HEALTHCHECK --start-period=60s CMD php -r 'exit(false === @file_get_contents("http://localhost:2019/metrics", context: stream_context_create(["http" => ["timeout" => 5]])) ? 1 : 0);'
CMD [ "frankenphp", "run", "--config", "/etc/frankenphp/Caddyfile" ]

# Prod FrankenPHP image — self-contained: unlike frankenphp_dev (below), it bakes in vendor/ and
# the app source rather than relying on a bind mount. This is the stage CI builds, SBOMs, scans
# and (on main/tags) pushes to GHCR (.github/workflows/backend-image.yml). Kept ahead of
# frankenphp_dev in this file so an unqualified `docker build .` / `docker compose up` still
# resolves to the dev stage (Docker's default target is the last one) without compose.yaml
# having to pin `target:` itself.
FROM frankenphp_base AS frankenphp_prod

ENV APP_ENV=prod

COPY --link backend/frankenphp/conf.d/20-app.prod.ini $PHP_INI_DIR/app.conf.d/

# Composer deps in their own layer first, so a source-only change doesn't invalidate them.
COPY --link backend/composer.json backend/composer.lock backend/symfony.lock ./
RUN composer install --no-cache --no-dev --no-autoloader --no-scripts --no-progress

# App source, plus the taxonomy file it loads from one directory up (AGENTS.md §6 — shared
# unchanged with apps/web, so it lives at the repo root, not under backend/). What's excluded
# from both is .dockerignore's job, same as it always was for the dev stage.
COPY --link backend/ ./
COPY --link taxonomy/ /app/taxonomy/

# A full `composer install` here (not just dump-autoload) is deliberate: it's what runs Flex's
# auto-scripts (cache:clear, assets:install) now that real app source exists to run them
# against — packages are already present from the layer above, so this touches no network.
RUN <<-EOF
	mkdir -p var/cache var/log
	composer install --no-cache --no-dev --no-progress --optimize-autoloader --classmap-authoritative
	composer dump-env prod
	chmod +x bin/console
	sync
EOF

# Dev FrankenPHP image
FROM frankenphp_base AS frankenphp_dev

ENV APP_ENV=dev
ENV XDEBUG_MODE=off
ENV FRANKENPHP_WORKER_CONFIG=watch

# dev dependencies
RUN <<-EOF
	mv "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini"
	install-php-extensions xdebug
	useradd -m -s /bin/bash nonroot
	git config --system --add safe.directory /app
	git config --system --add safe.directory /app/backend
EOF

COPY --link backend/frankenphp/conf.d/20-app.dev.ini $PHP_INI_DIR/app.conf.d/

CMD [ "frankenphp", "run", "--config", "/etc/frankenphp/Caddyfile", "--watch" ]
