#!/usr/bin/env bash
# The host half of the family deploy (.github/workflows/deploy-compose.yml),
# run on the self-hosted runner by the deploy-compose action beside it.
#
#   deploy.sh preflight   the host is ready: compose with --wait, the
#                         traefik-global network and container, the family's
#                         two edge middlewares in Traefik's file provider
#   deploy.sh deploy      this commit's image goes live (below)
#   deploy.sh rollback    the image before it comes back (the release failed
#                         verify from outside)
#
# A deploy, in order; nothing on the host changes before step 3:
#   1. the env file is rendered (mode 600) and the image pulled by commit;
#   2. the migration, if any, runs in the new image with the new env;
#   3. the running container is renamed, not stopped: it keeps serving under
#      its own routers while the new one starts under a compose project and
#      routers of this deploy's own (a fixed project would make compose stop
#      the old container first, and that gap answered 502 - initeai, 09.2026);
#   4. `compose up --wait`: Traefik admits the new container only once its
#      healthcheck passes, and its routers outrank the old ones;
#   5. inside the container, the version path must report this commit;
#   6. only then is the old container stopped (SIGTERM, 30 s) and removed.
# If 4 or 5 fails, the new container goes, the old one takes its name back
# and the files are restored: production never stopped serving.
#
# What it never does: a host-wide prune, `down -v`, `--remove-orphans`, or
# removing anything that is not this app's (deploy-no-host-wide-destroy).
# Cleanup is this app's own images, keeping the newest three and the two the
# app can roll between.
#
# Files in /opt/projects/<app>: docker-compose.yml (no secrets), .env (600),
# .env.prev, .deployed (the image live now), .previous (the one before it),
# .project (the compose project of the live container).
set -euo pipefail

: "${APP:?APP is required}"
: "${IMAGE:?IMAGE is required}"
: "${SHA:?SHA is required}"
ROOT="${DEPLOY_ROOT:-/opt/projects}"
DIR="$ROOT/$APP"
TRAEFIK="${TRAEFIK_CONTAINER:-traefik-global}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"
SUFFIX="${EDGE_SUFFIX:-$(date +%s)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$HERE/render.mjs"
NEW="$IMAGE:$SHA"

say() { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*"; exit 1; }

if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi

preflight() {
  command -v docker >/dev/null || fail "no docker on this runner"
  command -v node >/dev/null || fail "no node on this runner (the deploy renders its files with it)"
  grep -q -- '--wait' <<<"$("${DC[@]}" up --help 2>&1)" || fail "${DC[*]} has no 'up --wait' (compose v2.1+ is needed)"
  docker network inspect traefik-global >/dev/null 2>&1 || fail "the traefik-global network does not exist on this host"
  [ "$(docker inspect -f '{{.State.Running}}' "$TRAEFIK" 2>/dev/null)" = true ] || fail "the $TRAEFIK container is not running"
  # The family's edge middlewares live once, in Traefik's file provider
  # (/opt/traefik/dynamic on the host = /etc/traefik/dynamic in the container).
  local edge
  edge=$(docker exec "$TRAEFIK" sh -c 'cat /etc/traefik/dynamic/*.yml /etc/traefik/dynamic/*.yaml 2>/dev/null' || true)
  local missing=()
  grep -Eq '^[[:space:]]+redirect-to-https:' <<<"$edge" || missing+=(redirect-to-https)
  if [ "$(DOMAINS="${DOMAINS:-}" node "$RENDER" www)" = yes ]; then
    grep -Eq '^[[:space:]]+www-to-apex:' <<<"$edge" || missing+=(www-to-apex)
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "Traefik's file provider does not define ${missing[*]}. Install inite-shared/devops/host/traefik/family-edge.yml as /opt/traefik/dynamic/family-edge.yml on the host (once, by the owner); nothing was changed."
  fi
  say "✓ preflight: ${DC[*]} --wait, traefik-global, edge middlewares @file"
}

# The image a container runs, pinned: a container started from a moving tag
# (:latest, before this deploy existed) gets a local tag by its image id, so
# a rollback restarts exactly those bytes.
pinned_image_of() {
  local name=$1 ref id short
  ref=$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null) || return 0
  case "${ref##*/}" in
    *:latest | *:main-latest) ;;
    *:*) printf '%s' "$ref"; return 0 ;;
  esac
  id=$(docker inspect -f '{{.Image}}' "$name")
  short=$(printf '%s' "${id#sha256:}" | cut -c1-12)
  docker tag "$id" "$IMAGE:pre-$short" >/dev/null
  printf '%s' "$IMAGE:pre-$short"
}

render_compose() { # ref edge priority -> docker-compose.yml.next
  APP="$APP" EDGE="$2" IMAGE_REF="$1" DOMAINS="${DOMAINS:-}" PORT="${PORT:-3000}" \
    HEALTH_PATH="${HEALTH_PATH:-/api/version}" HEALTH_COMMAND="${HEALTH_COMMAND:-}" VOLUMES="${VOLUMES:-}" ENV_FILE=.env PRIORITY="$3" \
    node "$RENDER" compose > docker-compose.yml.next
}

restore_files() {
  if [ -f docker-compose.prev.yml ]; then mv -f docker-compose.prev.yml docker-compose.yml; else rm -f docker-compose.yml; fi
  if [ -f .env.prev ]; then cp -p .env.prev .env; fi
}

# Takes REF live with the env file ENV_SRC. Returns non-zero, with the old
# container serving again, when the new one never becomes healthy.
release() {
  local ref=$1 env_src=$2 migrate=${3:-}
  local edge priority stamp old_ids prev
  edge=$(printf '%s-%s' "$APP" "$SUFFIX" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_.\n-' '-')
  priority=$(date +%s)
  stamp=$(date +%s)
  prev=$(pinned_image_of "$APP")
  # This app's containers, whichever compose project made them (the first
  # deploy finds the one the old heredoc deploy made, project = directory).
  old_ids=$(docker ps -aq --filter "label=com.docker.compose.service=$APP" --filter "name=^$APP")

  render_compose "$ref" "$edge" "$priority" || { say "::error::the compose file for $ref could not be rendered"; rm -f docker-compose.yml.next; return 1; }
  [ -f docker-compose.yml ] && cp -p docker-compose.yml docker-compose.prev.yml
  [ -f .env ] && cp -p .env .env.prev
  mv -f docker-compose.yml.next docker-compose.yml
  cp -p "$env_src" .env
  chmod 600 .env

  local vol
  for vol in $(APP="$APP" VOLUMES="${VOLUMES:-}" node "$RENDER" volumes); do
    docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create --label "inite.deploy.app=$APP" "$vol" >/dev/null || {
      restore_files
      say "::error::the volume $vol could not be created"
      return 1
    }
  done

  if [ -n "$migrate" ]; then
    say "→ migration in $ref"
    if ! "${DC[@]}" -p "$edge" -f docker-compose.yml run --rm --no-deps -T --name "$edge-migrate" -l traefik.enable=false "$APP" sh -c "$migrate"; then
      restore_files
      say "::error::the migration failed in $ref; nothing was swapped, production keeps ${prev:-what it had}"
      return 1
    fi
  fi

  if docker container inspect "$APP" >/dev/null 2>&1; then docker rename "$APP" "$APP-retiring-$stamp"; fi
  say "→ starting $ref as $APP (project $edge)"
  local ok=1
  if ! "${DC[@]}" -p "$edge" -f docker-compose.yml up -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
    say "::error::$APP ($ref) never became healthy"
    ok=0
  elif [ -n "${VERSION_PATH:-}" ] && [ -n "${EXPECT_SHA:-}" ]; then
    local said
    said=$(docker exec "$APP" sh -c "wget -qO- -T 5 http://127.0.0.1:${PORT:-3000}${VERSION_PATH} 2>/dev/null || curl -fsS -m 5 http://127.0.0.1:${PORT:-3000}${VERSION_PATH}" 2>/dev/null || true)
    if grep -qF "$EXPECT_SHA" <<<"$said"; then
      say "✓ $VERSION_PATH reports ${EXPECT_SHA:0:8}"
    else
      say "::error::$VERSION_PATH inside $APP does not report $EXPECT_SHA: ${said:0:200}"
      ok=0
    fi
  fi
  if [ "$ok" = 0 ]; then
    "${DC[@]}" -p "$edge" -f docker-compose.yml logs --tail 200 || true
    "${DC[@]}" -p "$edge" -f docker-compose.yml down || true
    if docker container inspect "$APP-retiring-$stamp" >/dev/null 2>&1; then docker rename "$APP-retiring-$stamp" "$APP"; fi
    restore_files
    say "↩ the previous container ($prev) kept serving and has its name back"
    return 1
  fi

  # Traefik has the new routers (they outrank the old); let it settle, then retire the old.
  sleep "${SETTLE_SECONDS:-3}"
  local id
  # deploy-owns: old_ids are this app's containers, filtered by its compose service label above
  for id in $old_ids; do docker stop -t 30 "$id" >/dev/null 2>&1 || true; docker rm "$id" >/dev/null 2>&1 || true; done
  printf '%s\n' "$prev" > .previous
  printf '%s\n' "$ref" > .deployed
  printf '%s\n' "$edge" > .project
  rm -f docker-compose.prev.yml
  say "✓ $APP runs $ref (project $edge); previous: ${prev:-none}"
}

cleanup_images() {
  local keep ref
  keep=" $(cat .deployed 2>/dev/null || true) $(cat .previous 2>/dev/null || true) "
  # This app's images only (IMAGE is this app's repository): the newest three
  # stay, and so do the live one and the one before it. An image a container
  # uses cannot be removed anyway. Never a host-wide prune.
  docker images "$IMAGE" --format '{{if eq .Tag "<none>"}}{{.ID}}{{else}}{{.Repository}}:{{.Tag}}{{end}}' | tail -n +4 | while read -r ref; do
    case "$keep" in *" $ref "*) continue ;; esac
    # deploy-owns: ref is one of this app's own images, listed by its repository on the line above
    docker rmi "$ref" >/dev/null 2>&1 || true
  done
}

deploy() {
  preflight
  mkdir -p "$DIR"
  cd "$DIR"
  umask 077
  node "$RENDER" env .env.next
  unset SECRETS_JSON ENV_TEMPLATE
  say "→ pulling $NEW"
  docker pull -q "$NEW" >/dev/null
  if ! EXPECT_SHA="$SHA" release "$NEW" .env.next "${MIGRATE:-}"; then
    rm -f .env.next
    fail "$NEW was not deployed; production is as it was"
  fi
  rm -f .env.next
  cleanup_images
}

rollback() {
  mkdir -p "$DIR"
  cd "$DIR"
  umask 077
  local live prev
  live=$(cat .deployed 2>/dev/null || true)
  prev=$(cat .previous 2>/dev/null || true)
  [ "$live" = "$NEW" ] || fail "production runs ${live:-nothing recorded}, not $NEW: someone deployed since; no rollback"
  [ -n "$prev" ] || fail "no previous image is recorded for $APP; roll back by dispatching deploy.yml on the previous release tag"
  docker image inspect "$prev" >/dev/null 2>&1 || docker pull -q "$prev" >/dev/null || fail "the previous image $prev is gone from the host and the registry"
  # The env the previous image ran with; after the first deploy through this
  # workflow there is none (the old deploy put it in the compose file), and
  # the current one is the same list of variables.
  if [ -f .env.prev ]; then cp -p .env.prev .env.rollback; else cp -p .env .env.rollback; say "::warning::no .env.prev; $prev comes back with the current env"; fi
  SUFFIX="$SUFFIX-rb"
  # No migration: the schema stays where the release left it (check-migrations
  # refuses a change the previous version cannot run on).
  if ! EXPECT_SHA="" release "$prev" .env.rollback ""; then
    rm -f .env.rollback
    fail "the rollback to $prev failed too; $NEW keeps serving"
  fi
  rm -f .env.rollback .previous
  say "↩ $APP rolled back to $prev"
}

case "${1:-}" in
  preflight) preflight ;;
  deploy) deploy ;;
  rollback) rollback ;;
  *) echo "usage: deploy.sh preflight|deploy|rollback" >&2; exit 2 ;;
esac
