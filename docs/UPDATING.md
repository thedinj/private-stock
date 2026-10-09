# Updating the NAS

The short version. The why is in [`docker/README.md`](../docker/README.md).

```bash
./docker/ship.sh            # build, check, copy to mediaserver, roll it out
```

That is the whole update. `/data` is a bind mount, so the database, artifacts and trash
survive; the entrypoint snapshots the database and runs pending migrations before either
process starts, so a schema change needs nothing extra.

## If it does not come up

`rollout.sh` prints the log tail and the exact rollback command. It is:

```bash
sh rollout.sh --rollback private-stock:<date>-<sha>
```

`docker images private-stock` lists what is loaded there to go back to.

## Running a front door as well

`rollout.sh` takes a list, so the overlay travels with the app rather than being brought up by
hand once and then quietly left behind by every later update. In `rollout.env` on the NAS:

```sh
PS_COMPOSE_FILE="/share/Container/private-stock/docker/docker-compose.qnap.yml /share/Container/private-stock/docker/docker-compose.proxy.yml"
```

`docker-compose.lan.yml` in place of `proxy.yml` for the no-domain front door; one or the
other, never both. Add `docker-compose.fail2ban.yml` as a third if bans are switched on.
Space-separated, and the paths must not contain spaces.

Send the files up once with `PS_SEND_COMPOSE=1 ./docker/ship.sh`, which copies every overlay,
the Caddyfile and the `fail2ban/` directory. Those last two are mounted from disk rather than
baked into the image, so a front door or a jail started without them has nothing to read.

## Worth knowing

- `./docker/ship.sh --no-rollout` stops after the copy. Roll out later, on the NAS, with
  `sh /share/Container/private-stock/docker/rollout.sh`.
- `--no-checks` / `--no-build` skip `pnpm build` + `smoke.sh` / the image build.
- Settings live in `docker/deploy.env` (git-ignored). Nothing there is secret — ssh asks.
- `rollout.sh` lands beside the NAS's own compose file, which is how it finds one. Ship this
  repo's copy with `PS_SEND_COMPOSE=1` **only** when the compose file itself changed —
  otherwise it overwrites that box's mounts and caps.
- Old builds are cleared automatically: `PS_KEEP_BUILDS` (default 3) in `deploy.env` is how
  many tarballs stay in `dist-image/` and how many dated images stay loaded on the NAS, which
  is the rollback window. The NAS keeps only the newest tarball, and never removes the live
  image or the one it replaced. `0` keeps everything.
