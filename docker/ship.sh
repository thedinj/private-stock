#!/bin/bash
#
# Build the image here, put it on the NAS and roll it out — the whole of an update.
#
#   ./docker/ship.sh                 # check, build, save, copy, then run docker/rollout.sh over
#                                    #    SSH, which waits for health and warms the main routes
#   ./docker/ship.sh --no-rollout    # stop after the copy; the NAS keeps running what it has
#   ./docker/ship.sh --no-checks     # skip pnpm build + smoke.sh (they have just been run)
#   ./docker/ship.sh --no-build      # reuse the image already tagged here, just send it
#   ./docker/ship.sh --send-compose  # ...and the compose files, overwriting the NAS's copies
#
# The other half is `rollout.sh`, which runs on the NAS and is copied up by this script, so
# the two always arrive as a pair and cannot drift apart.
#
# Settings come from docker/deploy.env, which is git-ignored — see deploy.env.example. The
# password is not among them, and never will be: a deployment credential written into a file
# beside the repository is the one thing here that could leak without anybody noticing.
#
# It is asked for **once** per run instead, at the start: the three connections a deployment makes
# share one authenticated session. Set up a key (docker/README.md, "One prompt, or none") and it
# stops asking at all.
#
# Rolling out is the default because shipping is nearly always done to be running it, and a
# second command to type over SSH is a step that gets forgotten. Every check still comes first:
# a failed build or smoke test closes the connection before anything is sent, so the NAS only
# changes once there is a working image to change to. `--no-rollout` keeps the old split --
# ship now, roll out by hand when the library is idle.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

RUN_CHECKS=1
RUN_BUILD=1
RUN_ROLLOUT=1
SEND_COMPOSE=""

for arg in "$@"; do
    case "$arg" in
        --no-checks | --skip-checks) RUN_CHECKS=0 ;;
        --no-build) RUN_BUILD=0 ;;
        # Still accepted: it was the way to ask for this before it became the default.
        --rollout) RUN_ROLLOUT=1 ;;
        --no-rollout) RUN_ROLLOUT=0 ;;
        --send-compose) SEND_COMPOSE=1 ;;
        -h | --help)
            sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "ship.sh: unknown option $arg" >&2
            exit 2
            ;;
    esac
done

die() {
    echo "" >&2
    echo "ship.sh: $*" >&2
    exit 1
}

step() {
    echo ""
    echo "── $* ──"
}

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

SETTINGS="$REPO/docker/deploy.env"

[ -f "$SETTINGS" ] || die "no docker/deploy.env — copy docker/deploy.env.example and fill it in"

# Sourced rather than parsed: it is a file of shell assignments that only ever describes this
# machine, and a parser would be inventing a format for the sake of it.
# shellcheck disable=SC1090
. "$SETTINGS"

PS_NAS_HOST="${PS_NAS_HOST:-}"
PS_NAS_USER="${PS_NAS_USER:-}"
PS_NAS_PORT="${PS_NAS_PORT:-22}"
PS_NAS_DIR="${PS_NAS_DIR:-}"
PS_IMAGE="${PS_IMAGE:-private-stock}"
PS_TAG="${PS_TAG:-}"
PS_SEND_COMPOSE="${PS_SEND_COMPOSE:-0}"
PS_KEEP_BUILDS="${PS_KEEP_BUILDS:-3}"

case "$PS_KEEP_BUILDS" in
    '' | *[!0-9]*) die "PS_KEEP_BUILDS must be a number, not '$PS_KEEP_BUILDS'" ;;
esac

# The flag beats deploy.env: sending the compose files is a decision about *this* update (a
# mount or an overlay changed), not a standing setting of the machine.
[ -n "$SEND_COMPOSE" ] && PS_SEND_COMPOSE=1
PS_SSH_OPTS="${PS_SSH_OPTS:-}"

[ -n "$PS_NAS_HOST" ] || die "PS_NAS_HOST is not set in docker/deploy.env"
[ -n "$PS_NAS_USER" ] || die "PS_NAS_USER is not set in docker/deploy.env"
[ -n "$PS_NAS_DIR" ] || die "PS_NAS_DIR is not set in docker/deploy.env"

# `word splitting is wanted here` — PS_SSH_OPTS is a list of flags, not one argument.
# shellcheck disable=SC2206
SSH_OPTS=($PS_SSH_OPTS)

# The dated tag, and why there is one at all: `docker load` moves `latest` onto the incoming
# image and leaves the previous build holding nothing but an id. A name is what makes rolling
# back a command instead of an archaeology session. The short sha is in it because two builds
# in one day are ordinary and a tag that collides silently replaces its predecessor.
if [ -z "$PS_TAG" ]; then
    SHA="$(git rev-parse --short HEAD 2> /dev/null || echo nogit)"
    DIRTY=""
    git diff --quiet 2> /dev/null || DIRTY="-wip"
    PS_TAG="$(date +%Y-%m-%d)-${SHA}${DIRTY}"
fi

TARBALL="$REPO/dist-image/${PS_IMAGE}-${PS_TAG}.tar.gz"

echo "private-stock → ${PS_NAS_USER}@${PS_NAS_HOST}:${PS_NAS_DIR}"
echo "  image        ${PS_IMAGE}:${PS_TAG}  (and ${PS_IMAGE}:latest)"
echo "  tarball      ${TARBALL#"$REPO"/}"

# ---------------------------------------------------------------------------
# One connection for the whole run
# ---------------------------------------------------------------------------

# Refuse Windows line endings before asking for anything. A shell script with CRLF dies on its
# first line (`set: -: invalid option`), and entrypoint.sh is baked into the image, so a CR here
# is a container that cannot boot -- the most expensive way to find out.
#
# Counted with `tr`, not `grep`: Git Bash's grep reads files in text mode and never sees a CR.
CRLF=""
for script in "$REPO"/docker/*.sh; do
    [ "$(tr -cd '\r' < "$script" | wc -c)" -eq 0 ] || CRLF="$CRLF ${script#"$REPO"/}"
done
[ -z "$CRLF" ] || die "Windows line endings in:$CRLF — convert to LF (sed -i 's/\r\$//' <file>)"

# What goes up, named relative to the two directories tar takes them from. The tarball goes
# *last*, so a stream cut short leaves it short too, and the size check on the far side catches
# every truncation rather than only the ones that happen to land inside it.
EXTRAS=(rollout.sh)

# The compose files only when asked: the copy on the NAS carries that box's share paths and
# resource caps, and quietly replacing it during a routine image update is how a deployment
# loses its mounts.
#
# Both overlays and the Caddyfile go too, and which of them the NAS actually reads is
# `PS_COMPOSE_FILE` in its own rollout.env. Sending the unused one costs a few kilobytes;
# leaving it out means a front door that cannot be switched on without a second trip, and the
# Caddyfile in particular is mounted by the overlay rather than baked into the image, so a
# proxy brought up without it fails at startup with nothing to read.
if [ "$PS_SEND_COMPOSE" = 1 ]; then
    for extra in docker-compose.qnap.yml docker-compose.proxy.yml docker-compose.lan.yml \
        docker-compose.fail2ban.yml Caddyfile fail2ban; do
        if [ -e "$REPO/docker/$extra" ]; then
            EXTRAS+=("$extra")
            echo "  including    $extra (overwrites the NAS's copy)"
        fi
    done
fi

REMOTE_TARBALL="${PS_NAS_DIR}/${TARBALL##*/}"

# The whole deployment is **one** ssh connection, opened here and fed later.
#
# It used to be three -- mkdir, scp, rollout -- sharing one login through `ssh -M`. That cannot
# work from Git Bash: a multiplexed session is handed to the master by passing file descriptors
# over a Unix socket, which MSYS does not implement, so every step failed with "read from master
# failed: Connection reset by peer" and asked for the password again anyway.
#
# So the connection is opened now, before minutes of building, and its remote side waits:
#
#   1. makes the directory and says `ready` -- which is how this script knows the password was
#      accepted, and the only thing it waits for before building;
#   2. reads one line. `go <bytes>` means the build succeeded and a tar stream follows. End of
#      input means this script gave up, and the NAS is left exactly as it was;
#   3. unpacks the stream, and refuses to go further unless the tarball is the size it should be;
#   4. with --rollout, runs rollout.sh -- still within the same login.
#
# Nothing is stored: the password is typed into ssh itself, and no copy of it exists anywhere.
# `sh` for rollout.sh, because tar does not carry the executable bit onto every QTS share.
REMOTE_SCRIPT="set -e
mkdir -p '${PS_NAS_DIR}'
echo ready
read go size
[ \"\$go\" = go ] || exit 3
tar -xf - -C '${PS_NAS_DIR}'
[ \"\$(wc -c < '${REMOTE_TARBALL}')\" -eq \"\$size\" ] || { echo 'copy incomplete' >&2; exit 4; }
echo copied"

if [ "$RUN_ROLLOUT" = 1 ]; then
    REMOTE_SCRIPT="${REMOTE_SCRIPT}
sh '${PS_NAS_DIR}/rollout.sh' --keep '${PS_KEEP_BUILDS}' '${REMOTE_TARBALL}'"
fi

step "connecting to ${PS_NAS_USER}@${PS_NAS_HOST}"

# A coprocess, so both ends of ssh are ours: its output to read `ready` from, and its input to
# send the stream into once the build is done. The descriptors are copied straight away because
# bash closes a coprocess's own ones the moment it exits, which would lose rollout's last words.
#
# The keepalive is for the build: the connection sits idle for minutes, and an idle connection
# is the kind a router or sshd drops.
coproc NAS {
    ssh "${SSH_OPTS[@]}" -o ServerAliveInterval=30 -p "$PS_NAS_PORT" \
        "${PS_NAS_USER}@${PS_NAS_HOST}" "$REMOTE_SCRIPT"
}
SSH_PID=$NAS_PID
exec {NAS_OUT}<&"${NAS[0]}" {NAS_IN}>&"${NAS[1]}"

# Whatever ends this script early -- a failed build, a failed smoke test, Ctrl-C -- ends the
# connection with it. The far side is waiting for `go` and reads end of input instead, so it
# exits having changed nothing.
close_nas() {
    kill "$SSH_PID" 2> /dev/null || true
}

trap close_nas EXIT

READY=0
while IFS= read -r line <&"$NAS_OUT"; do
    if [ "$line" = ready ]; then
        READY=1
        break
    fi
    echo "  $line"
done

[ "$READY" = 1 ] ||
    die "could not log in to ${PS_NAS_USER}@${PS_NAS_HOST}:${PS_NAS_PORT}, or could not create ${PS_NAS_DIR}"

echo "  connected; the NAS waits until the image is built"

# Docker Desktop installs `docker.exe` but only puts it on the PATH of the shells it knows
# about, and Git Bash is not always one of them — the wrapper it ships beside it is a shell
# script that calls `docker.exe` by bare name and fails the same way. So look for the binary
# rather than taking "command not found" at face value on a machine that is plainly running it.
find_docker() {
    if command -v docker > /dev/null 2>&1; then
        command -v docker
        return
    fi

    for candidate in         "/c/Program Files/Docker/Docker/resources/bin/docker.exe"         "${PROGRAMFILES:-/c/Program Files}/Docker/Docker/resources/bin/docker.exe"; do
        [ -x "$candidate" ] && {
            echo "$candidate"
            return
        }
    done

    return 1
}

DOCKER="$(find_docker)" || die "docker not found — is Docker Desktop installed and running?"

docker() { "$DOCKER" "$@"; }

# ---------------------------------------------------------------------------
# Check
# ---------------------------------------------------------------------------

# `smoke.sh` is the only check that loads `dist` the way the container does — plain `node`,
# no tsx, no Next bundler — so it is the only one that can catch an import Node cannot
# resolve. It costs seconds and it is the reason this runs before the build rather than after
# the NAS has the image.
if [ "$RUN_CHECKS" = 1 ]; then
    step "pnpm build"
    pnpm build

    step "docker/smoke.sh"
    ./docker/smoke.sh || die "smoke test failed — the container would not boot this build"
fi

# ---------------------------------------------------------------------------
# Build and save
# ---------------------------------------------------------------------------

if [ "$RUN_BUILD" = 1 ]; then
    step "docker build ${PS_IMAGE}:${PS_TAG}"

    # What the About dialog shows. The image cannot ask git itself: `.git` is not in the context.
    BUILD_SHA="$(git rev-parse --short HEAD 2> /dev/null || echo nogit)"
    git diff --quiet 2> /dev/null || BUILD_SHA="${BUILD_SHA}-wip"

    docker build \
        -f docker/Dockerfile \
        --build-arg BUILD_SHA="$BUILD_SHA" \
        --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        -t "${PS_IMAGE}:${PS_TAG}" \
        -t "${PS_IMAGE}:latest" \
        .
else
    docker image inspect "${PS_IMAGE}:${PS_TAG}" > /dev/null 2>&1 ||
        die "--no-build, but ${PS_IMAGE}:${PS_TAG} does not exist here"
fi

# --no-build reuses an image that has to exist, and the tag it looks for follows HEAD -- so a
# commit made after the build (a doc fix, a config change) silently moves the target and the
# save fails on an image nobody expected to be missing. Say so here instead.
if [ "$RUN_BUILD" = 0 ] && ! docker image inspect "${PS_IMAGE}:${PS_TAG}" > /dev/null 2>&1; then
    echo "ship.sh: --no-build was given but ${PS_IMAGE}:${PS_TAG} does not exist here." >&2
    echo "" >&2
    echo "  The tag follows HEAD, which has moved since the last build. Either:" >&2
    echo "    - drop --no-build to build the current commit, or" >&2
    echo "    - name the image you meant, e.g. PS_TAG=<tag> ./docker/ship.sh --no-build" >&2
    echo "" >&2
    echo "  Built here:" >&2
    docker images "${PS_IMAGE}" --format "    {{.Repository}}:{{.Tag}}" >&2
    exit 1
fi

step "docker save"

mkdir -p "$(dirname "$TARBALL")"

# Both tags in one save, because `docker save` takes tags rather than images: naming only
# `latest` ships only that one and the dated tag never arrives on the NAS, which is exactly
# when it is wanted. Written to a temporary name first so an interrupted save cannot leave a
# truncated archive sitting there looking finished.
docker save "${PS_IMAGE}:${PS_TAG}" "${PS_IMAGE}:latest" | gzip > "${TARBALL}.part"
mv "${TARBALL}.part" "$TARBALL"

SIZE="$(du -h "$TARBALL" | cut -f1)"
echo "  ${SIZE}  ${TARBALL##*/}"

# The newest PS_KEEP_BUILDS tarballs stay -- the local half of a rollback -- and the rest go.
# They are ~640 MB each and a day of shipping made several, so "yours to delete" meant 18 GB
# before anybody did. The one just saved is the newest by mtime, so it is always among those
# kept; 0 keeps everything. rollout.sh does the same on the NAS once the new build is healthy.
if [ "$PS_KEEP_BUILDS" -gt 0 ]; then
    # shellcheck disable=SC2012 # our own names: no spaces, no newlines
    ls -t "$(dirname "$TARBALL")"/"${PS_IMAGE}"-*.tar.gz 2> /dev/null |
        tail -n +"$((PS_KEEP_BUILDS + 1))" |
        while read -r old; do
            [ "$old" = "$TARBALL" ] && continue
            rm -f "$old" && echo "  removed ${old##*/}"
        done
fi

# ---------------------------------------------------------------------------
# Copy, and roll out if asked
# ---------------------------------------------------------------------------

step "copy to ${PS_NAS_HOST}"

kill -0 "$SSH_PID" 2> /dev/null ||
    die "the connection to the NAS dropped during the build — run again with --no-checks --no-build"

SIZE_BYTES="$(wc -c < "$TARBALL" | tr -d ' ')"

# `go` first, then the archive: the extras from docker/, the tarball last (see above). Closing
# our end afterwards is what tells the far side the stream is complete.
{
    printf 'go %s\n' "$SIZE_BYTES"
    tar -cf - -C "$REPO/docker" "${EXTRAS[@]}" -C "$(dirname "$TARBALL")" "${TARBALL##*/}"
} >&"$NAS_IN" || die "copy failed — the connection broke mid-stream"

exec {NAS_IN}>&-

[ "$RUN_ROLLOUT" = 1 ] && step "rollout on ${PS_NAS_HOST}"

# Everything the far side says from here on: `copied`, and with --rollout the whole of rollout.sh.
cat <&"$NAS_OUT"

STATUS=0
wait "$SSH_PID" || STATUS=$?
trap - EXIT

case "$STATUS" in
    0) ;;
    4) die "the tarball arrived incomplete — nothing was rolled out; run again with --no-checks --no-build" ;;
    *) die "the NAS side failed (exit $STATUS) — see its output above" ;;
esac

[ "$RUN_ROLLOUT" = 1 ] && exit 0

cat << EOT

Shipped. Nothing on the NAS has changed yet — to roll it out:

  ssh${PS_SSH_OPTS:+ $PS_SSH_OPTS} -p ${PS_NAS_PORT} ${PS_NAS_USER}@${PS_NAS_HOST}
  sh ${REMOTE_TARBALL%/*}/rollout.sh ${REMOTE_TARBALL}

(--no-rollout was given; without it this script does both.)
EOT
