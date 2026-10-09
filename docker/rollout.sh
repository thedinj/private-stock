#!/bin/sh
#
# Put a shipped image live — the NAS half of an update. Runs on the QNAP, over SSH.
#
#   sh rollout.sh                                  # newest tarball in this directory
#   sh rollout.sh private-stock-2026-09-25-ab12.tar.gz
#   sh rollout.sh --rollback private-stock:2026-09-21   # an image already loaded here
#   sh rollout.sh --keep 5                         # builds to keep loaded (default 3; 0 = all)
#
# `sh`, not `bash`, and POSIX throughout: this runs on QTS, where the shell that is certain to
# exist is BusyBox ash and `bash` is a package that may or may not be installed. The dev-box
# half (`ship.sh`) has a real bash and uses it.
#
# The database is not backed up here, because the container already does it: the entrypoint
# snapshots to /data/backups/pre-migration-<timestamp>.db and applies pending migrations
# before either process starts. A container that comes up is a container with a current
# schema, and there is no "did you remember to migrate" for anyone to get wrong.
#
# Once healthy, the main pages and the API routes they call are requested once each, so the
# first person to open the app after an update does not pay Next's route loading.
#
# Then old builds are cleared out: only the newest few dated images stay loaded, and only the
# newest tarball stays on the share. See "Tidy" at the end for what is never removed.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"

TARBALL=""
ROLLBACK=""
KEEP=""

while [ $# -gt 0 ]; do
    case "$1" in
        --rollback)
            shift
            ROLLBACK="${1:-}"
            [ -n "$ROLLBACK" ] || { echo "rollout.sh: --rollback needs an image tag" >&2; exit 2; }
            ;;
        # Accepted and ignored: pruning is part of every tidy now (see "Tidy").
        --prune) ;;
        --keep)
            shift
            KEEP="${1:-}"
            ;;
        -h | --help)
            sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) TARBALL="$1" ;;
    esac
    shift
done

die() {
    echo "" >&2
    echo "rollout.sh: $*" >&2
    exit 1
}

step() {
    echo ""
    echo "── $* ──"
}

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

# Optional, and next to the script: an install that keeps its compose file somewhere else says
# so once here rather than in every invocation. Defaults cover the layout docker/README.md
# describes, which is the only one this repository has ever deployed to.
if [ -f "$HERE/rollout.env" ]; then
    # shellcheck disable=SC1091
    . "$HERE/rollout.env"
fi

# One compose file, or several separated by spaces when a front door is overlaid on the app:
#
#   PS_COMPOSE_FILE="$HERE/docker-compose.qnap.yml $HERE/docker-compose.lan.yml"
#
# A list rather than a single path because the proxy is an overlay by design (§12) — the app's
# own file plus one that adds Caddy — and a rollout that could only pass one of them would bring
# the app up without its front door, publishing 8842 to the LAN as a side effect of updating.
#
# Paths must not contain spaces, which is what separates them here. The deploy directory is ours
# to choose and docker/README.md chooses one without any.
COMPOSE_FILE="${PS_COMPOSE_FILE:-$HERE/docker-compose.qnap.yml}"

COMPOSE_ARGS=""
for compose_file in $COMPOSE_FILE; do
    [ -f "$compose_file" ] ||
        die "no compose file at $compose_file (set PS_COMPOSE_FILE in rollout.env)"
    COMPOSE_ARGS="$COMPOSE_ARGS -f $compose_file"
done
CONTAINER="${PS_CONTAINER:-private-stock}"
IMAGE="${PS_IMAGE:-private-stock}"
# Longer than the image's own `--start-period`, or this gives up while Docker is still withholding
# judgement and reports a failure for a container that was about to pass. Boot on the NAS is a
# snapshot, then migrations, then a scan competing with the artifact backlog (§20).
HEALTH_TIMEOUT="${PS_HEALTH_TIMEOUT:-300}"

# How many dated builds stay loaded after a successful rollout: the rollback window. `--keep`
# beats rollout.env beats 3, and ship.sh passes its own PS_KEEP_BUILDS so the two machines keep
# the same number. 0 keeps everything, which is how this behaved before it tidied at all.
KEEP="${KEEP:-${PS_KEEP_BUILDS:-3}}"
case "$KEEP" in
    '' | *[!0-9]*) die "--keep needs a number, not '$KEEP'" ;;
esac

# Container Station does not put its binaries on the login PATH, and the path itself moves
# with the volume the QPKG was installed on — so look, rather than assume. A wrong guess here
# reads as "docker: not found" on a box that is plainly running containers.
find_docker() {
    if command -v docker > /dev/null 2>&1; then
        command -v docker
        return
    fi

    for candidate in /share/*/.qpkg/container-station/bin/docker \
        /share/.qpkg/container-station/bin/docker \
        /usr/local/bin/docker; do
        [ -x "$candidate" ] && { echo "$candidate"; return; }
    done

    return 1
}

DOCKER="$(find_docker)" || die "docker not found — is Container Station running?"
DOCKER_BIN_DIR="$(dirname "$DOCKER")"

# `docker compose` (v2, a subcommand) or `docker-compose` (v1, its own binary). Container
# Station has shipped both depending on vintage, and the difference is invisible until one of
# them is missing.
if "$DOCKER" compose version > /dev/null 2>&1; then
    # shellcheck disable=SC2086 # deliberate word splitting: one -f per file
    compose() { "$DOCKER" compose $COMPOSE_ARGS "$@"; }
elif [ -x "$DOCKER_BIN_DIR/docker-compose" ]; then
    # shellcheck disable=SC2086
    compose() { "$DOCKER_BIN_DIR/docker-compose" $COMPOSE_ARGS "$@"; }
elif command -v docker-compose > /dev/null 2>&1; then
    # shellcheck disable=SC2086
    compose() { docker-compose $COMPOSE_ARGS "$@"; }
else
    die "neither 'docker compose' nor 'docker-compose' is available"
fi

echo "private-stock rollout"
echo "  docker    $DOCKER"
echo "  compose   $COMPOSE_FILE"

# ---------------------------------------------------------------------------
# What is live now
# ---------------------------------------------------------------------------

# Read before anything changes, and printed again at the end: "what was I running before" is
# the question a bad update makes urgent, and by then the tag that answers it is gone.
#
# The name to roll back *to* is never `latest` — the load below moves that onto the incoming
# image, so by the time anyone wants it, `latest` is the build that went wrong. The dated tag
# ship.sh applies is the whole point of applying one.
rollback_name() {
    "$DOCKER" inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$1" 2> /dev/null |
        grep -v ':latest$' | head -n 1
}

PREVIOUS="$("$DOCKER" inspect --format '{{.Image}}' "$CONTAINER" 2> /dev/null || true)"
PREVIOUS_TAG=""

if [ -n "$PREVIOUS" ]; then
    PREVIOUS_TAG="$(rollback_name "$PREVIOUS" || true)"
    echo "  running   ${PREVIOUS_TAG:-$PREVIOUS}"
fi

# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------

if [ -n "$ROLLBACK" ]; then
    # Rolling back is the same operation with the load skipped: move `latest` onto an image
    # that is already here, and let the recreate below do the rest.
    "$DOCKER" image inspect "$ROLLBACK" > /dev/null 2>&1 ||
        die "$ROLLBACK is not loaded here — '$DOCKER images $IMAGE' lists what is"

    step "rolling back to $ROLLBACK"
    "$DOCKER" tag "$ROLLBACK" "${IMAGE}:latest"
else
    if [ -z "$TARBALL" ]; then
        # Newest by modification time, which is the one that has just been copied up. Named
        # explicitly when that is not what is wanted.
        TARBALL="$(ls -t "$HERE"/${IMAGE}-*.tar.gz 2> /dev/null | head -n 1 || true)"
        [ -n "$TARBALL" ] || die "no ${IMAGE}-*.tar.gz in $HERE — name one, or run ship.sh first"
    fi

    [ -f "$TARBALL" ] || die "no such file: $TARBALL"

    step "docker load < $(basename "$TARBALL")"

    # gunzip into load rather than `docker load -i`: it is what the README has always
    # described, it works the same on every Container Station vintage, and the pipe means the
    # uncompressed image never needs room on the share.
    gunzip -c "$TARBALL" | "$DOCKER" load

    "$DOCKER" image inspect "${IMAGE}:latest" > /dev/null 2>&1 ||
        die "${IMAGE}:latest is not here after the load — did the tarball carry both tags?"
fi

# ---------------------------------------------------------------------------
# Recreate
# ---------------------------------------------------------------------------

step "compose up -d"

# `up -d` sees a new image id behind the same tag and recreates the container. Nothing else
# needs saying: /data is a bind mount to the share, so the database, artifacts, variants and
# trash outlive the container, and media roots are read-only apart from the deletable ones.
compose up -d || die "compose refused to start the new container${PREVIOUS_TAG:+ — roll back with: sh $0 --rollback $PREVIOUS_TAG}"

# ---------------------------------------------------------------------------
# Wait for it to actually be up
# ---------------------------------------------------------------------------

step "waiting for health"

# The compose file has a healthcheck against /api/health, so there is a real answer to wait
# for rather than a sleep and a hope. This matters more here than it would elsewhere: the
# entrypoint migrates the database before starting either process, so a slow first boot after
# a schema change is expected and is exactly when somebody would otherwise conclude the update
# had failed and start pulling at it.
WAITED=0
STATUS=""

while [ "$WAITED" -lt "$HEALTH_TIMEOUT" ]; do
    STATUS="$("$DOCKER" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$CONTAINER" 2> /dev/null || echo missing)"

    case "$STATUS" in
        healthy | running)
            break
            ;;
        unhealthy | exited | dead | missing)
            echo ""
            "$DOCKER" logs --tail 40 "$CONTAINER" 2>&1 || true
            die "container is $STATUS — see the log above${PREVIOUS_TAG:+; roll back with: sh $0 --rollback $PREVIOUS_TAG}"
            ;;
    esac

    sleep 3
    WAITED=$((WAITED + 3))
    printf '.'
done

echo ""

if [ "$STATUS" != "healthy" ] && [ "$STATUS" != "running" ]; then
    "$DOCKER" logs --tail 40 "$CONTAINER" 2>&1 || true
    die "still '$STATUS' after ${HEALTH_TIMEOUT}s — see the log above"
fi

# ---------------------------------------------------------------------------
# Warm it up
# ---------------------------------------------------------------------------

step "warming up"

# Next loads each route's compiled code on its first request, not at boot, and on the NAS that
# is seconds per route. Healthy only proves /api/health was loaded; without this, whoever opens
# the app first after an update gets a slow first page and concludes the update made it slow.
#
# From inside the container, like the healthcheck: the port is bound to the NAS's loopback, or
# reachable only through Caddy, and this avoids depending on curl or wget being on QTS. Going
# around Caddy also keeps these requests out of the access log fail2ban reads.
#
# Unauthenticated, so the API routes answer 401. That is enough: the module is loaded before the
# handler rejects the request, and loading it is the whole point. Only GETs, and nothing under
# /api/auth that a rate limit counts.
#
# Best effort. A cold route is a slow first click, not a broken deployment, so a failure here is
# reported and the rollout still succeeds.
"$DOCKER" exec "$CONTAINER" node -e '
const port = process.env.PRIVATE_STOCK_PORT || 8842;
(async () => {
    for (const route of process.argv.slice(1)) {
        const started = Date.now();
        try {
            const res = await fetch("http://127.0.0.1:" + port + route, {
                signal: AbortSignal.timeout(60000),
            });
            await res.arrayBuffer();
            console.log("  " + route + "  " + res.status + "  " + (Date.now() - started) + "ms");
        } catch (error) {
            console.log("  " + route + "  failed: " + error.message);
        }
    }
})();
' -- / /login /api/home /api/library/roots /api/auth/me ||
    echo "  warmup did not run — harmless; the first visitor pays the start-up cost instead"

# ---------------------------------------------------------------------------
# Tidy, and say what happened
# ---------------------------------------------------------------------------

NOW="$("$DOCKER" inspect --format '{{.Image}}' "$CONTAINER" 2> /dev/null || true)"

# Only here, after the container is healthy: a rollout that fails dies above with everything
# still in place, which is when the older builds are wanted. Each build is a ~640 MB tarball and
# a loaded image, on the same disks the library is read from, and nothing else ever removed them.
#
# Tarballs: the newest one only. Once it is loaded the image is the rollback, and the tarball is
# just what a bare `sh rollout.sh` would load again.
#
# Images: the newest $KEEP dated tags, which after an ordinary rollout are the live build, the
# one it replaced and one more. Whatever is live or was live a minute ago is kept even when it
# is older than that, as after a --rollback. `latest` is never touched. A tag is removed with
# `rmi`, which deletes the image only once no tag is left on it and refuses one a container
# still uses; a refusal is reported and the rollout still succeeds.
if [ "$KEEP" -gt 0 ]; then
    step "keeping the newest $KEEP builds"

    # shellcheck disable=SC2012 # our own names: no spaces, no newlines
    ls -t "$HERE"/${IMAGE}-*.tar.gz 2> /dev/null | tail -n +2 | while read -r old; do
        rm -f "$old" && echo "  removed $(basename "$old")"
    done

    # Newest first, which is the order `docker images` lists in.
    KEPT=0
    "$DOCKER" images "$IMAGE" --format '{{.Tag}} {{.ID}}' | while read -r tag id; do
        [ "$tag" = latest ] || [ "$tag" = "<none>" ] && continue

        KEPT=$((KEPT + 1))
        [ "$KEPT" -le "$KEEP" ] && continue

        # Past the window, but live or just replaced: counted, never removed.
        case "$NOW $PREVIOUS" in
            *"sha256:$id"*)
                echo "  kept    ${IMAGE}:$tag (live or previous)"
                continue
                ;;
        esac

        "$DOCKER" rmi "${IMAGE}:$tag" > /dev/null 2>&1 &&
            echo "  removed ${IMAGE}:$tag" ||
            echo "  could not remove ${IMAGE}:$tag — in use?"
    done

    # Removing a tag does not always remove the image: on Container Station `rmi` by tag left
    # each one behind untagged, and the first tidy freed no space at all -- 27 images, 8 GB.
    # A load that replaces a tag (shipping the same commit twice) leaves the same behind. So
    # dangling images go too: untagged, unused by any container, and unreachable by any name
    # a rollback could give. Never `-a`, which would take the dated tags with it.
    "$DOCKER" image prune -f | tail -n 1
fi
NOW_TAGS="$("$DOCKER" inspect --format '{{join .RepoTags ", "}}' "$NOW" 2> /dev/null || true)"

echo ""
echo "Live: ${NOW_TAGS:-$NOW}  ($STATUS)"
echo ""
echo "  logs      $DOCKER logs -f $CONTAINER"
echo "  images    $DOCKER images $IMAGE"

if [ -n "$PREVIOUS_TAG" ] && [ "$PREVIOUS" != "$NOW" ]; then
    echo "  rollback  sh $0 --rollback $PREVIOUS_TAG"
fi

exit 0
