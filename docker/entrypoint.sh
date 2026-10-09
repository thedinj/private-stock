#!/bin/bash
set -eu

# bash, not sh, and specifically for `wait -n` at the bottom of this file. Debian's /bin/sh is
# dash, which has no such option: the script would start both processes, fail with
# "wait: Illegal option -n", and exit 2 under `set -e` -- so the container would boot-loop,
# restarting cleanly every few seconds while never serving anything. bash is Essential in
# Debian and present in the node:22-bookworm-slim base, so this costs nothing.

# Container entrypoint: back up, migrate, then run both processes.
#
# Migrating on boot rather than on demand means a container that starts is a container with
# a current schema — there is no "did you remember to run migrations" state for a NAS user
# to get wrong.

DATA_DIR="${PRIVATE_STOCK_DATA_DIR:-/data}"
DB_PATH="$DATA_DIR/private-stock.db"

mkdir -p "$DATA_DIR/backups"

# PUID/PGID so files the app writes land with sane QNAP ownership (§15). Applied to /data
# only — media roots are never chowned, because the app must not modify them (deleting from a
# deletable one is the single exception, and needs no change of ownership).
#
# The chown is half of it. The other half is `RUN_AS` below: this script starts as root, and
# without dropping privileges both processes keep running as root and everything they write
# from that point on is root-owned again. The chown would then be fixing the *previous* run's
# files on every boot, one restart behind for ever, and the ownership asked for here would
# never apply to anything the app actually produced.
RUN_AS=""
if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ]; then
    if [ "$(id -u)" = "0" ]; then
        echo "Setting ownership of $DATA_DIR to ${PUID}:${PGID}"
        chown -R "${PUID}:${PGID}" "$DATA_DIR" || echo "warning: could not chown $DATA_DIR"
        RUN_AS="${PUID}:${PGID}"
    else
        # Already non-root, because the runtime was told to run as a specific user
        # (Container Station can do this, and so can `docker run --user`). The chown would
        # fail and there is nothing to drop to; running as whoever we are is correct.
        echo "Already running as $(id -u):$(id -g); ignoring PUID/PGID"
    fi
fi

# QuickSync/VAAPI, when the device is mounted in (see docker-compose.qnap.yml).
#
# QTS ships /dev/dri/renderD128 as crw------- root:administrators -- no group bits at all --
# so the moment this script drops to PUID:PGID the app can no longer open it. There is no
# group to join, which is why `group_add` in compose does not solve this. Hardware encoding
# then fails inside ffmpeg on every job, which is the least legible place it could fail; the
# admin page's hwaccel "test" button exists largely so that this is findable.
#
# Relaxing it here changes nothing on the NAS. Docker gives the container its own device node
# carrying the host's mode, so this chown applies to the container's copy and QTS keeps its
# own permissions on the real one. Done before the drop, because afterwards we could not.
#
# A missing /dev/dri is the normal case, not an error: hwaccel is opt-in, most deployments
# will not mount it, and the software encoder is the documented fallback.
if [ -n "$RUN_AS" ] && [ -d /dev/dri ]; then
    echo "Granting $RUN_AS access to /dev/dri"
    chown -R "${PUID}:${PGID}" /dev/dri &&
        chmod -R u+rw /dev/dri ||
        echo "warning: could not take ownership of /dev/dri; hwaccel will be unavailable"
fi

# Run a command as the target user, or directly when there is no user to drop to.
#
# Media roots are never chowned, so the drop has one consequence worth knowing before it bites:
# **PUID must be able to read the media mounts**, and write the deletable (`:rw`) ones. It could
# before only because root can read everything. A library that reads as empty after this change
# is a permissions problem on the share, not a scanning one.
as_app() {
    if [ -n "$RUN_AS" ]; then
        exec gosu "$RUN_AS" "$@"
    fi

    exec "$@"
}

# Snapshot before migrating. Migrations run in a transaction and roll back on failure, but a
# migration that succeeds and is wrong is the case this protects against.
if [ -f "$DB_PATH" ]; then
    SNAPSHOT="$DATA_DIR/backups/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).db"
    echo "Snapshotting database to $SNAPSHOT"
    # A subshell, because as_app execs: without one this would replace the entrypoint and
    # the container would exit as soon as the snapshot finished.
    #
    # `cd` into packages/db first, and it matters. `node -e` resolves `require` against the
    # current directory, and under pnpm there is no /app/node_modules/better-sqlite3 -- the
    # package is in the .pnpm store, reachable only through the symlink in the node_modules
    # of a package that declares it. Run from /app this threw ERR_MODULE_NOT_FOUND, the
    # `|| echo` below swallowed it as "warning: snapshot failed, continuing", and the
    # pre-migration backup silently never happened on any boot.
    ( cd packages/db && as_app node -e "
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1], { readonly: true });
        db.exec(\`VACUUM INTO '\${process.argv[2].replace(/'/g, \"''\")}'\`);
        db.close();
    " "$DB_PATH" "$SNAPSHOT" ) || echo "warning: snapshot failed, continuing"
fi

# Migrate as the app user too, so the files it creates -- the database itself on a first
# boot, and its -wal and -shm siblings -- are owned correctly from the moment they exist
# rather than waiting for the next restart's chown.
echo "Running migrations..."
( as_app node packages/db/dist/cli/migrate.js )

# The worker's memory, which on a 3.8 GB NAS shared with Plex is the page cache the database lives
# in (§20 "The worker's own memory"). Set inside the subshell so they apply to the worker alone (the
# embed child it forks drops them again, `childEnv`; the web sets the same pins below); both are overridable from compose. The worker's
# smaller SQLite cache is the other half of the same budget, and lives in code (packages/db/src/db.ts).
#
# MALLOC_MMAP_THRESHOLD_ / MALLOC_TRIM_THRESHOLD_ (bytes) pin two glibc allocator settings at their
# documented defaults, and pinning is the point: left alone, glibc raises the mmap threshold to the
# size of every large block it frees, up to 32 MB, and from then on blocks below that come out of the
# main heap -- which only shrinks from the top, so SQLite's page cache growing between them pins the
# holes for the life of the process. The worker's large blocks are child output read whole (the
# Tesseract TSV for a burst of frames) and vector files of long videos, either of which can pass
# 128 KB. With multi-MB buffers freed while the cache grew, the main heap measured 90 MB unpinned and
# 47 MB pinned; with SQLite's own sorts alone it made ~3 MB of difference, so it matters where
# large buffers come and go, and costs nothing where they do not.
#
# --expose-gc lets the worker run a full collection every five minutes (apps/worker/src/memory.ts):
# much of what it frees is native memory behind small objects, which V8 only gives back when it
# collects them, and with a heap this small it rarely does on its own.
#
# No --max-old-space-size. The worker's live heap is ~15-20 MB and V8's limit is not a trigger for
# collecting -- it only decides where the process dies -- and the orphan sweep holds every path under
# /data at once, which at 200k items is far past any cap that would bind in normal running.
#
# MALLOC_ARENA_MAX is deliberately not set: it bounds the per-thread arenas, and the worker's growth
# was in the main one, where SQLite runs. Arenas and thread stacks together were ~23 MB.
echo "Starting worker..."
(
    export MALLOC_MMAP_THRESHOLD_="${MALLOC_MMAP_THRESHOLD_:-131072}"
    export MALLOC_TRIM_THRESHOLD_="${MALLOC_TRIM_THRESHOLD_:-131072}"
    as_app node --expose-gc apps/worker/dist/index.js
) &
WORKER_PID=$!

# Next's standalone server reads PORT and HOSTNAME, and neither name is ours (see
# apps/web/server.js, which Next generates: `parseInt(process.env.PORT) || 3000` and
# `process.env.HOSTNAME || '0.0.0.0'`).
#
#  - PORT is unset in the image, so the app listened on 3000 while the Dockerfile exposed
#    8842 and compose published it. Nothing answered on either. Derived from
#    PRIVATE_STOCK_PORT so the app keeps one port knob rather than two that can disagree.
#  - HOSTNAME is set by Docker to the container id, which resolves to the container's own
#    address -- so the server bound to that one interface instead of every interface, and
#    the HEALTHCHECK, which calls 127.0.0.1, could never have succeeded.
#
# UV_THREADPOOL_SIZE is libuv's pool for file I/O, 4 threads by default, and every art request
# goes through it (an async `stat`, an open, the reads). A grid page asks for sixty covers at
# once; on a spinning /data that ffmpeg is also reading, each operation waits ~100 ms, so four
# at a time put every tile ~5 s behind (§20). More in flight lets the disk queue reorder them.
# It is read once, when the pool first starts, so it has to be in the environment before node
# does -- setting process.env from inside the app is too late. Overridable from compose.
#
# KEEP_ALIVE_TIMEOUT (ms) is Next's name for Node's `server.keepAliveTimeout`, 5 s by default.
# Caddy keeps an idle upstream connection for 2 minutes, so it routinely reused one that Node
# was about to close -- and when the event loop had been blocked, Node's overdue idle timer ran
# before the request already waiting on that socket was read, and the connection was reset.
# Caddy will not retry a PUT, so saving a tag answered 502 with an empty body (§20). Whoever
# closes an idle connection must be the proxy, never the app: this has to stay longer than
# Caddy's keepalive, whatever that is set to.
#
# MALLOC_MMAP_THRESHOLD_ / MALLOC_TRIM_THRESHOLD_ are the worker's pins above, for the web's own
# reason (§20 "The web process's own memory"): it streams media in 1 MB reads, and unpinned, the
# first one freed raised glibc's mmap threshold past 1 MB, so every later read buffer came out of
# the main heap instead of a mapping of its own -- and a read buffer is freed only when V8 collects
# it, by which time newer allocations sit above it and the heap cannot shrink. Pinned, a stream's
# buffers (and the art route's previews and sprite sheets, read whole by `openSized`) go back to the
# system when collected. Measured in the production image on the production database after the
# same ten minutes of traffic and two idle: 242 MB resident unpinned, 205 MB pinned (main heap 64 ->
# 54 MB, other native 27 -> 8 MB). No --expose-gc here, unlike the worker: an idle web process
# collects on its own, a forced collection then freed ~4 MB, and it would be a pause on the thread
# that answers every request.
#
# Set inside the subshell so they apply to the web process alone; the worker prints
# $HOSTNAME in its banner and should go on reporting the real one.
echo "Starting web..."
(
    export PORT="${PRIVATE_STOCK_PORT:-8842}"
    export HOSTNAME="0.0.0.0"
    export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"
    export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-300000}"
    export MALLOC_MMAP_THRESHOLD_="${MALLOC_MMAP_THRESHOLD_:-131072}"
    export MALLOC_TRIM_THRESHOLD_="${MALLOC_TRIM_THRESHOLD_:-131072}"
    as_app node apps/web/server.js
) &
WEB_PID=$!

# Either process dying should take the container down so the restart policy applies —
# a container serving pages with a dead worker looks healthy and processes nothing.
term() {
    echo "Shutting down..."
    kill -TERM "$WORKER_PID" "$WEB_PID" 2>/dev/null || true
    wait
}
trap term TERM INT

wait -n
EXIT_CODE=$?
echo "A process exited with code $EXIT_CODE; stopping the container"
term
exit "$EXIT_CODE"
