#!/bin/bash
#
# Does the container's own boot sequence actually work? — without needing Docker.
#
#   ./docker/smoke.sh            # after pnpm build
#
# The compiled output under plain `node` is a combination nothing else exercises, and two
# release-blocking bugs lived in exactly that gap:
#
#  - `tsc` emitted the extensionless relative imports that `moduleResolution: "bundler"`
#    allows, and Node's ESM loader cannot resolve them. Both `node dist/cli/migrate.js` and
#    `node apps/worker/dist/index.js` — the two commands the entrypoint runs — died on
#    ERR_MODULE_NOT_FOUND. In development `tsx` resolves those specifiers, and the web app is
#    bundled by Next, so nothing else ever loaded this output the way the container does.
#  - A migration's recorded identity included its file extension, which is `.ts` under tsx and
#    `.js` in the container. A database stamped on a dev box therefore arrived in the container
#    as one unapplied migration, and replaying the baseline over a populated schema fails.
#
# Neither is caught by a type check, a unit test, or a build. Both are caught here in seconds.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/private-stock-smoke.$$"
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/data" "$WORK/media"
export PRIVATE_STOCK_DATA_DIR="$WORK/data"
export PRIVATE_STOCK_MEDIA_DIR="$WORK/media"

cd "$REPO" || exit 1

check() {
    local name="$1"
    shift

    if "$@" > "$WORK/out" 2>&1; then
        echo "  ok    $name"
    else
        echo "  FAIL  $name"
        sed 's/^/        /' "$WORK/out" | head -20
        FAILED=1
    fi
}

if [ ! -f "packages/db/dist/cli/migrate.js" ] || [ ! -f "apps/worker/dist/index.js" ]; then
    echo "Build first: pnpm build"
    exit 1
fi

echo "Container boot sequence:"

# First boot: an empty volume, the case a new NAS install is.
check "migrate an empty data directory" node packages/db/dist/cli/migrate.js

# Every later boot. Re-running must be a no-op, not a replay.
check "migrate again, finding nothing to do" node packages/db/dist/cli/migrate.js

# Set the database up for the next check.
#
# `cd` in a subshell, not `process.chdir` inside the script. Under pnpm there is no
# /app/node_modules/better-sqlite3 -- the package is reachable only through the symlink in
# packages/db/node_modules -- and `node -e` fixes its resolution paths from the cwd it
# *started* in, so chdir'ing afterwards is too late. That is the entrypoint's snapshot bug
# exactly, and it was here too: every fixture below threw ERR_MODULE_NOT_FOUND, the
# redirect swallowed it, and the check that followed ran against a database nothing had
# touched. A vacuous check reads identically to a passing one.
#
# Failing hard rather than warning, for the same reason: a fixture that did not run makes
# the assertion after it meaningless, and there is nothing useful left to report.
fixture() {
    if ! ( cd packages/db && node -e "$1" ) > "$WORK/out" 2>&1; then
        echo "  FAIL  could not set up: $2"
        sed 's/^/        /' "$WORK/out" | head -10
        exit 1
    fi
}

OPEN_DB="
    const Database = require('better-sqlite3');
    const db = new Database(process.env.PRIVATE_STOCK_DATA_DIR + '/private-stock.db');
"

# A database stamped by tsx and then read by the container, which is what copying a
# catalogued library up to the NAS looks like.
fixture "$OPEN_DB
    db.prepare('DELETE FROM \"_migrations\"').run();
    db.prepare('INSERT INTO \"_migrations\" (filename) VALUES (?)').run('00000000_000000_baseline.ts');
" "a database stamped by the dev runtime"
check "migrate a database stamped by the dev runtime" node packages/db/dist/cli/migrate.js

# A populated database carrying no stamp at all, which is the second defence against the
# same failure: the runner is supposed to see the tables, record the baseline and move on.
#
# Only reproducible here. `BASELINE_MIGRATION` is spelled `.ts`, and the guard compared it
# to the filename on disk -- which is `.js` under dist -- so the skip never fired in a
# container and the boot died on `table "Artifact" already exists`. Under tsx both spellings
# agree and the bug is invisible, which is why it outlived the fix to the stamp comparison.
fixture "$OPEN_DB
    db.prepare('DELETE FROM \"_migrations\"').run();
" "a populated database carrying no stamp"
check "migrate a populated database carrying no stamp" node packages/db/dist/cli/migrate.js

# The worker has to get as far as its main loop. Staying up is the pass condition, so the
# timeout expiring (124) is success and anything else is the process falling over.
if timeout 20 node apps/worker/dist/index.js > "$WORK/worker.log" 2>&1; then
    echo "  FAIL  worker starts and stays up (it exited cleanly, which it should not)"
    FAILED=1
elif [ $? -eq 124 ]; then
    echo "  ok    worker starts and stays up"
else
    echo "  FAIL  worker starts and stays up"
    sed 's/^/        /' "$WORK/worker.log" | head -20
    FAILED=1
fi

# The built-in models load under plain node and answer (§5e). onnxruntime-node is a native
# module found through pnpm's symlinks, and the models are found by walking up to
# models/manifest.json -- both are exactly the kind of resolution that works under tsx and
# fails in compiled output. Run `pnpm models:fetch` first in development; the image has them.
check "the built-in models load and answer" node apps/worker/dist/bench/embed.js --smoke

# The entrypoint itself parses. `wait -n` is a bash builtin and this file once said /bin/sh,
# which is dash on Debian: it would have boot-looped with "wait: Illegal option -n".
check "entrypoint parses under bash" bash -n docker/entrypoint.sh

if [ "$FAILED" -eq 0 ]; then
    echo "All good."
else
    echo "Something in the container's boot path is broken."
fi

exit "$FAILED"
