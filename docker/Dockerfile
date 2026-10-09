# syntax=docker/dockerfile:1.7
#
# Multi-arch image: linux/amd64 for Intel QNAPs, linux/arm64 for the ARM models.
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile -t private-stock .
#
# Three stages so the runtime layer carries ffmpeg and compiled output only — not the
# toolchain, not the source, not dev dependencies.

# ──────────────────────────────────────────────────────────────────────────────
# deps — install once, cached on the lockfile alone
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 has no prebuild for every arch/libc combination, so the toolchain has to
# be present at install time. It is discarded with this stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
# pnpm applies these during install (`patchedDependencies` in pnpm-workspace.yaml), and a patch
# that is not in the context fails the install rather than being skipped.
COPY patches/ patches/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
# models — the §5e model files, downloaded and checksum-verified
# ──────────────────────────────────────────────────────────────────────────────
# A stage of its own, built from the manifest and the fetch script alone, so the few hundred MB
# are downloaded when the manifest changes and come from the layer cache on every other build.
# The models are part of the image rather than of /data: they belong to the build that knows how
# to use them, and a release that changes model must not find the old one waiting in a volume.
FROM node:22-bookworm-slim AS models
WORKDIR /fetch
COPY models/manifest.json models/
COPY scripts/fetch-models.mjs scripts/
RUN node scripts/fetch-models.mjs

# ──────────────────────────────────────────────────────────────────────────────
# build — compile packages, then Next in standalone mode
# ──────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV BUILD_STANDALONE=1
ENV TURBO_TELEMETRY_DISABLED=1

# pnpm 10 treats removing node_modules as destructive and asks for confirmation. There is no
# TTY inside a build, so the prune below aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
# and the image fails to build. `CI=true` is pnpm's own documented answer.
ENV CI=true

# Which build this is, shown in the app's About dialog. Passed in by `docker/ship.sh` because
# `.git` is not in the build context. Declared here, after the install, so a new commit does not
# invalidate the dependency layers above.
ARG BUILD_SHA=unknown
ARG BUILD_DATE=
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_DATE=${BUILD_DATE}

RUN pnpm build

# onnxruntime-node ships its runtime for every platform: 70 MB for macOS and 120 MB for Windows,
# which the image would otherwise carry twice -- once in node_modules for the worker and once in
# the web app's standalone output, where Next's tracing pulls them in and its excludes do not
# reach (next.config.ts). Only linux/ is ever loaded here. A targeted delete, not a prune.
RUN find . -path "*/onnxruntime-node/bin/napi-v6/*" -type f ! -path "*/napi-v6/linux/*" -delete

# No prune here, deliberately.
#
# `pnpm prune --prod` is a root-project command and is not workspace-aware: run at the root of
# this workspace it removes three root devDependencies and, as collateral, empties every
# workspace package's node_modules -- including `packages/db/node_modules/better-sqlite3`,
# which is a production dependency. The .pnpm store still holds the package, but the symlink
# that let Node resolve it is gone, so the container built and then died on every boot with
#
#     Cannot find package 'better-sqlite3' imported from /app/packages/db/dist/db.js
#
# Measured: packages/db/node_modules goes from 11 entries to 0, while the prune log names only
# prettier, turbo and typescript. It was destroying the runtime to save three root packages.
#
# The workspace dev dependencies it never touched anyway are the bulk of what is left here.
# `pnpm deploy --filter` is the workspace-aware way to slim this down and is worth doing, but
# it changes the runtime layout the entrypoint depends on, so it is a separate change.

# ──────────────────────────────────────────────────────────────────────────────
# runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg and ffprobe are the whole reason this image is not tiny. The distro build is used
# rather than ffmpeg-static because it links the system libraries the hwaccel paths need.
# gosu drops to PUID:PGID once the entrypoint has done the work that needs root (§15).
#
# Linking those libraries is not the same as having a driver, which cost a deployment to
# learn. Debian's ffmpeg depends on libva2 -- the API -- and on no VA driver at all, so every
# hwaccel path failed with "Failed to initialise VAAPI connection: -1 (unknown libva error)"
# on a box whose /dev/dri was mounted, readable and correct. /usr/lib/*/dri held only Mesa's
# OpenGL drivers (iris, crocus, i915); a libva driver is named *_drv_video.so and there was
# none. QSV fails identically and for the same reason: on Linux it initialises through VAAPI.
#
# Both Intel drivers are installed because they cover different silicon and neither is a
# superset -- i965 is Gen7.5 and older (the Haswell i3 this first shipped to), iHD is Gen8 and
# newer. libva picks by PCI id at runtime, so carrying both costs a layer and removes a
# hardware-specific build. vainfo comes too: it reports what the driver actually offers, in
# one command, from inside the container where the answer differs from the host's.
#
# tesseract-ocr is a distro package rather than an npm one because the bundled builds carry
# their own language data and are large, and because only English is wanted: every enabled
# language is scored against every frame, so an unused one is a permanent tax (§5d). OCR is
# onDemand, so a library that never asks for text pays for nothing but the layer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates tini gosu tesseract-ocr tesseract-ocr-eng \
        i965-va-driver intel-media-va-driver vainfo \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRIVATE_STOCK_DATA_DIR=/data
ENV PRIVATE_STOCK_MEDIA_DIR=/media
ENV PRIVATE_STOCK_PORT=8842

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json

# The worker's own node_modules, which is not optional.
#
# pnpm resolves a workspace dependency through a symlink inside the *dependent* package --
# apps/worker/node_modules/@private-stock/core -> ../../../packages/core. Copying the root
# node_modules and the packages tree is not enough: without this line the worker started and
# immediately died with
#
#     Cannot find package '@private-stock/core' imported from /app/apps/worker/dist/index.js
#
# and the entrypoint took the container down with it. apps/web needs no equivalent because
# Next's standalone output carries its own traced node_modules.
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public


# /app/models, found by walking up from either process (core/server `findModelsDir`).
COPY --from=models /fetch/models ./models

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# CRs stripped here as well as refused by ship.sh: a Windows checkout with CRLF endings would
# otherwise build an image whose entrypoint dies on its first line, and nothing before rollout
# would notice.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]
EXPOSE 8842

# The healthcheck hits the endpoint that touches the database, so a container whose data
# volume failed to mount reports unhealthy instead of quietly serving nothing.
#
# **The timings are set against a boot on the real NAS, not a dev box.** They were 5s / 40s / 3,
# and a rollout failed its healthcheck on a container that was serving perfectly well: booting
# takes a pre-migration snapshot, runs migrations, and then the worker starts a full scan and
# re-queues its artifact backlog — so `/api/health`, which deliberately reads the database, was
# answering from behind a saturated disk and took longer than 5s. Next reported "Ready in 16.6s"
# for the same reason, against a 40s start period that also has to cover the snapshot.
#
# The endpoint still touches the database, because a container that cannot reach its data must not
# report healthy. What changes is the patience, which now allows for the one minute of a
# container's life when it competes with its own start-up work (§20).
HEALTHCHECK --interval=30s --timeout=20s --start-period=180s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PRIVATE_STOCK_PORT||8842)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the ffmpeg children the worker spawns; without it a long-running container
# accumulates zombies.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
