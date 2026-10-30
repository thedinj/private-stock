# Running private-stock on the QNAP

The app is one container running two processes (`entrypoint.sh` starts the web server and the
worker, and takes the container down if either dies). Everything it writes goes to `/data`;
media roots are mounted read-only unless a library is deliberately made writable for deletion
(§18.1) — see "Deletable libraries" below.

| File                              | What it is                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `docker-compose.yml`              | Local development, same image as the NAS                                      |
| `docker-compose.qnap.example.yml` | Copy to `docker-compose.qnap.yml` (git-ignored): share paths, PUID/PGID, caps |
| `docker-compose.proxy.yml`        | Optional Caddy front door — HTTPS, one command                                |
| `Caddyfile`                       | The proxy config, entirely environment-driven                                 |
| `.env.example`                    | Copy to `.env`; only the proxy overlay reads it                               |
| `ship.sh`                         | Dev box: check, build, copy to the NAS, and roll it out                       |
| `rollout.sh`                      | NAS: load the image, recreate the container, roll back                        |
| `deploy.env.example`              | Copy to `deploy.env`; where `ship.sh` sends things                            |

## Start here: LAN, no TLS

```bash
cp docker/docker-compose.qnap.example.yml docker/docker-compose.qnap.yml   # then edit its paths
docker compose -f docker/docker-compose.qnap.yml up -d
```

The app is on `http://<nas>:8842`. This is a complete, working deployment, and it is the
quickest way to a running library — but **it is not the right place to stop, even on the LAN**,
because plain HTTP costs the grid more than it costs the security model. See "Why plain HTTP is
slow here" below.

**Claim the library straight away**, and have the container log open when you do:

```bash
docker logs private-stock | grep -A2 "Setup token"
```

`/setup` creates the first account and is reachable only while no users exist — so whoever
reaches it first owns the library, and the token is what stops that being a stranger. With no
proxy in front, nothing can vouch for where a caller is, so the token is asked for every time
rather than only from outside. It is regenerated on every restart, which is why it is read
from the log rather than written down. The first account is necessarily both `admin` and
`delete`; nobody else could grant those.

Two other things behave differently in this mode, both deliberately:

- The refresh cookie is **not** marked `Secure`, because a browser silently drops a Secure
  cookie on plain HTTP and the symptom is "login does nothing".
- Login rate limiting falls back to a **single shared bucket** rather than one per address.
  Nothing can identify a caller without a trusted proxy, and believing an unverified
  `X-Forwarded-For` would let anyone lock somebody else out by forging one.

### Why plain HTTP is slow here

No TLS means no HTTP/2, and HTTP/1.1 limits a browser to **six connections per origin**. A
library grid opens far more requests than six: sixty covers, the page's own JS chunks, the
API calls behind them, and the live-updates stream — which is an `EventSource` and holds one
of the six open for as long as the tab is, leaving five.

This is not a small effect and it is not the NAS's fault. Measured on a cold grid load against
a real library, from a browser HAR:

|                                              |           |
| -------------------------------------------- | --------- |
| Peak requests in flight                      | 76        |
| Time spent queued in the browser (`blocked`) | **854 s** |
| Time the NAS spent answering (`wait`)        | 93 s      |
| Server time for all 120 covers, together     | **0.1 s** |

The covers are served from disk in well under a millisecond each and then wait up to fifteen
seconds for a connection. Worse, the queue is shared and unordered by importance, so the JS
chunk for the page someone just clicked lands _behind_ sixty thumbnails: the symptom is a UI
that works, works, works and then locks up for fifteen seconds on an ordinary click.

Nothing in the app fixes this, because the limit is per-origin in the browser and the app only
gets one origin. It does not need a domain either -- "HTTPS on the LAN, with no domain" below is
the whole fix with none of the DDNS. Caddy with a certificate does fix it: HTTP/2 multiplexes every one of those
requests over a single connection, and the queue disappears rather than being reordered. That
is why the section below is a performance step as much as a security one.

Two things reduce the pressure without solving it, and both are already in place: covers are
versioned and served `immutable`, so this is a cold-load cost and not a per-navigation one,
and viewport prefetch is off on the navbar and the grid tiles (§20) so the browser is not also
fetching pages nobody opened.

### When it is slow and you need to know why

```yaml
# in docker-compose.qnap.yml, under environment:
PRIVATE_STOCK_REQUEST_LOG: "1"
# and, when it is video that stalls, one line per media stream as it ends (ARCHITECTURE §8b):
PRIVATE_STOCK_STREAM_LOG: "1"
```

**Which copy of that file you edit depends on `PS_SEND_COMPOSE`** (deploy.env, or `--send-compose`
for a single run). At `1`, `ship.sh`
sends this repository's compose files and overwrites the NAS's — so an edit made over SSH works
until the next deployment silently reverts it, and the place to put the flag is the repository
copy. At `0`, the opposite: the NAS's copy is authoritative and the repository's is ignored. Two
round trips were lost to this, both of them looking like "the setting does not work".

**Environment changes need `up -d`, not `restart`.** `docker restart` starts the same container
with the same environment it was created with, so the flag silently does nothing and the logs
look exactly as they did before. `docker compose ... up -d` recreates it. To be sure it took:

```bash
docker exec private-stock env | grep PRIVATE_STOCK
```

Off by default, for the reason `PRIVATE_STOCK_SQL_LOG` is: a diagnostic that floods stdout can
block the process it is diagnosing. With it on, the web process logs two things.

```
[slow]   1240ms 200 GET /api/media?limit=60&page=0
[loop] over 30s — mean 4.1ms, p99 18.0ms, max 1210.3ms
```

`[slow]` is any request over 250ms (`PRIVATE_STOCK_REQUEST_LOG_MS` moves the threshold), timed
at the HTTP layer so it covers static files and media as well as API routes. `[loop]` is
event-loop delay, and it is the line that assigns blame:

- **Lag high, requests slow, worker busy** — the process is not getting a CPU. Nothing in the
  web app will fix that; look at what the worker is doing (§7c quiet hours, and the processing
  card).
- **Lag high, requests slow, worker idle** — the web process is blocking _itself_, and the
  `[slow]` lines say on what. This is what a video transfer used to look like: one open-ended
  range was answered with a whole 565 MB file, so `[slow]` showed a multi-minute
  `GET /api/media/<id>/stream` and every unrelated request on the same thread queued behind it
  (§8, §20). Ranges are bounded to 8 MB now, so a `stream` line lasting minutes means the bound
  is not in the running image.
- **Lag near zero, requests slow** — the work really is in the handler, and the request line
  says which one.

### Which statement, and why

Request timing and `[loop]` between them say "the process was blocked for 19 seconds doing real
work in this handler". They cannot say which query. Two things go one level further, and both are
opt-in for the same reason as everything else here.

```yaml
PRIVATE_STOCK_SQL_SLOW_MS: "250"
```

One line per statement slower than that, in both processes — duration, method, row count, SQL:

```
[sql]  18980ms get rows=1 SELECT count(*) AS "total", COALESCE(sum(CASE WHEN m."kind" = 'video' …
```

This is not `PRIVATE_STOCK_SQL_LOG`, which prints _every_ statement and produces 1.6 GB an hour
(§15) — unusable on the box where the question arises. A threshold is the difference.

Then, against the real database, inside the container:

```bash
docker exec private-stock node packages/db/dist/cli/diagnose.js
```

Row counts for every table that can plausibly be large, **the queue broken down by state**, **the
`Job` indexes as the database actually has them** (because "No pending migrations" is what a
container prints whether or not an index migration took, and a missing index then looks like every
other reason a query is slow here), the database's size in pages, the page cache it is allowed, and
each of the summary's four queries timed separately — then timed again,
because the first run of one is partly a measurement of a cold cache and the difference between
"slow twice" and "slow once" is the difference between a bad query and a bad disk.

To see a plan, paste in the SQL a `[sql]` line printed:

```bash
docker exec private-stock node packages/db/dist/cli/diagnose.js --explain "SELECT count(*) …"
```

It binds nulls for whatever parameters the statement takes, since a plan does not depend on their
values. `pnpm db:diagnose` is the same thing on the dev box. Add the values as a JSON array (or an
object, for named parameters) and it also runs the statement twice and reports its pages, as below:
`--explain "SELECT … WHERE kind = ?" '["video"]'`.

#### Pages, not milliseconds

On the NAS a statement's time is mostly the pages it reads: every query is a few milliseconds
when its pages are cached, and a page that is not costs on the order of 100 ms on a disk ffmpeg is
saturating. So the same statement is 3 ms on one run and 17 s on the next, and timing it says more
about the page cache than about the query. The number that does not move is **pages touched**:

```bash
docker exec -u 1000:100 -w /app/packages/db private-stock \
    node /app/packages/db/dist/cli/diagnose.js --cost [user email or id]
```

`-u 1000:100` so nothing it touches in `/data` ends up owned by root. It is read-only (the
connection is `query_only`) and safe against the live database while the app is serving. It runs
the repo calls behind the web process's hot endpoints — cookie auth, `/api/library/stats`, the
per-library summaries of `/api/library/roots`, the Processing view's queue summary, the default
grid page and its count, a cover per grid tile, one item's detail, the performer tag list, and
`/api/home` one shelf at a time plus the whole request — as a real user (the first one, unless
named) over that user's own libraries, and prints per statement:

```
GET /api/art (a cover per grid tile) — 1140 pages, cold 228.6 ms, warm 216.4 ms
    pages   cold ms   warm ms  calls  sql
     1140     199.3     196.6     60  SELECT a."id", a."mediaId", a."kind", …
                                      SEARCH m USING INDEX sqlite_autoindex_Media_1 (id=?)
                                      …
```

endpoints worst first, statements worst first within each, repeats folded into one row with a
call count, the plan under each, and a top-ten across all of them at the end.

- **pages** — bytes the statement asked the kernel for (`rchar` in `/proc/self/io`) divided by
  the page size. Its own connection runs with mmap off and a 1 MiB SQLite cache, released before
  every statement, so this is every page the statement touched from an empty cache — whether or
  not the OS happened to have it. **Pages × ~100 ms is what the statement costs on a busy disk
  when nothing is cached.** It is an upper bound for point lookups (the app's own 48 MB cache
  usually holds the upper levels of each index) and close to exact for anything that scans.
- **cold ms** — the first run in this process: the real disk cost, _if_ the OS cache did not
  already hold those pages. Against a running app it often does.
- **warm ms** — the same work again, from the OS cache. The floor.

The home shelves are the viewer's own layout (or the admin default) with their pinned filters
appended, one endpoint each, named by position and source (`GET /api/home shelf 3: random`). A
shuffled shelf is measured as it costs when its cached sample has expired — the shuffle that
refills it, then a dozen hydrated by id — which is the worst case; a visit within ten minutes
of the last pays only the hydration. `GET /api/home (whole request, one snapshot)` runs them all
the way `getHome` does: one read transaction, the app's own cache size, nothing released between
statements, so a page two shelves share is counted once. That line, not the sum of the shelves,
is the request's cost.

A statement whose pages grow with a table — a `SCAN` in its plan — is the one that gets worse
every month. On the dev box (Windows, no `/proc/self/io`) it prints timings and plans and says
that page counts are unavailable; it does not estimate them.

A fourth line appears when the database itself is the contention:

```
[a1b2c3d4] DATABASE_BUSY: /api/media/9f3.../progress
```

The write never got the lock within the web process's 750 ms, so it was abandoned — deliberately,
because waiting in that process freezes every other request in it (§4, §20). A few of these while
the worker chews through a backlog is the system working as intended; a steady stream of them
while the worker is idle is not, and means something else is holding the write lock. They are
logged to stdout and never to the error-log table, which is in the database that is busy.

The distinction matters because it is not guessable from outside. A HAR taken from a browser
shows a seven-second response either way: Node serves on one thread and `better-sqlite3` is
synchronous, so a request starved of CPU and a request doing seven seconds of work are
indistinguishable until the server says which it was.

## HTTPS on the LAN, with no domain

The shortest route to HTTP/2, and the answer to "do I have to set up DDNS for this?" -- no.

```bash
cp docker/.env.example .env              # on the NAS; set PS_DOMAIN, with its port
docker compose -f docker-compose.qnap.yml -f docker-compose.lan.yml up -d
```

`.env` lives **on the NAS, beside the compose file** — `/share/Container/private-stock/docker/.env`
— because that is where `docker compose` reads it. It is git-ignored and `ship.sh` does not send
it: it describes one deployment rather than the project, and a routine image update has no
business rewriting the front door's settings. Copy `.env.example` there once by hand.

`PS_DOMAIN` is the name you type into the browser and must carry the port: `mediaserver:9443`.
The name the NAS already answers to on the LAN is the obvious choice — no DNS work is then
needed at all, because that name already resolves.
The app is already published on loopback only (`127.0.0.1:8842:8842`), which is what makes this
the front door rather than one of two — a browser that can still reach 8842 directly goes back
to six connections without telling you. Caddy is unaffected: it reaches the app over the compose
network, not through the published port.

Caddy issues its own certificate. **Nothing trusts it until you say so**, which is one step per
machine you browse from:

```bash
docker cp private-stock-caddy:/data/caddy/pki/authorities/local/root.crt .
```

On Windows: double-click, Install Certificate, Local Machine, _Trusted Root Certification
Authorities_. Restart the browser. On a Mac, add it to the login keychain and mark it trusted.

Then open `https://mediaserver:9443` and check DevTools -> Network -> Protocol: every row
should say `h2`.

### Switching between the two front doors

The overlays are alternatives, and swapping one for the other has an ordering trap: each
declares the variables it needs with `:?`, so once `.env` has been edited for the _new_ front
door, any `docker compose` command naming the _old_ one fails before it does anything —
including `down`. The teardown then needs the settings you have just removed.

Take the container out by name instead, which needs no overlay at all:

```bash
docker rm -f private-stock-caddy
sh rollout.sh <tarball>          # brings it back from whichever overlay rollout.env now names
```

The named volumes survive `rm -f`, so a certificate and ACME account obtained on the public
path are still there if you switch back to it later. Nothing has to be re-issued, which also
means Let's Encrypt's rate limits are not spent on changing your mind.

### What this path gives up, and what it avoids

It stays inside the house -- there is no public name and nothing is reachable from outside.

It does **not** give up casting, though this section used to say it did. A Chromecast fetches
the media itself and cannot be told about Caddy's CA, so it cannot fetch from the HTTPS site --
but it does play plain HTTP. The LAN overlay therefore also publishes a **cast port**: plain
HTTP, serving signed media URLs and nothing else. Set two values in `docker/.env`:

```
PS_CAST_HOST=192.168.1.10   # the NAS's LAN IP, as the TV reaches it -- reserve it in DHCP
PS_CAST_PORT=8843           # optional; 8843 is the default
```

**Never forward the cast port on the router.** It is plain HTTP by design. Everything but
`/api/media/<id>/stream?t=...` is a 404 on it, so what crosses the LAN in clear is a day's access
to one item -- but it belongs on the LAN.

The phone you cast from still needs Caddy's root installed, as every browsing device does: the
Cast SDK only loads on a page the browser trusts. On Android: Settings -> Security -> Encryption
& credentials -> Install a certificate -> CA certificate, then pick `root.crt`.

What it avoids is most of the work. No DDNS, no Let's Encrypt, no challenge relay on the Pi, and
**no fight with QTS over ports 80 and 443** -- without ACME nothing needs a well-known port, so
Caddy sits on 9443 and QTS keeps its own listeners where they are. HTTP/2 is negotiated in the
TLS handshake and does not care which port that happens on.

### One trap worth knowing before you hit it

HSTS is remembered per _hostname_, not per port. Once the app has been served over TLS it sends
`Strict-Transport-Security: max-age=31536000` (see `next.config.ts`, and only ever behind a
trusted proxy), so the browser will afterwards upgrade `http://mediaserver:8842` to _https_ on
that port and fail there. That is correct behaviour and it is also surprising. To go back, clear
the entry at `chrome://net-internals/#hsts`.

## Adding HTTPS

```bash
cp docker/.env.example .env              # on the NAS; set PS_DOMAIN and PS_ACME_EMAIL
docker compose -f docker-compose.qnap.yml -f docker-compose.proxy.yml up -d
```

`.env` lives **on the NAS, beside the compose file** — `/share/Container/private-stock/docker/.env`
— because that is where `docker compose` reads it. It is git-ignored and `ship.sh` does not send
it: it describes one deployment rather than the project, and a routine image update has no
business rewriting the front door's settings. Copy `.env.example` there once by hand.

The app is already published on loopback only (`127.0.0.1:8842:8842`), so Caddy is the only way
in; it reaches the app over the compose network rather than through the published port. Caddy
asks Let's Encrypt for a certificate on first run and renews it by itself — there is no certbot
step and nothing to put in cron.

**The default ports are 8880 and 9443, not 80 and 443**, and that is what makes this a change
to one machine rather than two. See below.

The overlay also sets `PRIVATE_STOCK_TRUSTED_PROXY_HOPS=1`, which is what makes the app
believe the forwarded headers. Raise it to `2` if something else sits in front of Caddy. Set
it higher than the number of proxies actually present and the app starts believing a header
the client wrote itself, which is the failure worth being careful about.

**Then point `PS_DOMAIN` at the NAS's LAN address in your local resolver.** "Casting, and why
it needs split-horizon DNS" below explains the mechanism and is the place it is set up; it is
listed there because a Chromecast is the case that fails loudest without it. But it is not a
casting feature. It is what makes browsers on the LAN reach the app by its certificate's name
— and therefore over HTTP/2 — instead of falling back to `http://<nas>:8842` and the six
connections above. Without it the proxy is running and nothing on the LAN is using it.

A quick check that it worked, from a browser on the LAN: open DevTools → Network, add the
**Protocol** column, and reload the grid. Every row should say `h2`. If they say `http/1.1`
you are still reaching the app directly on 8842.

### QNAP is using some of these ports, and you do not have to fight it

QTS occupies 80, 443, 8080, 8081 and 8443 out of the box. The defaults here — **8880** for the
challenge and **9443** for the app — avoid all five, so Container Station can bind them and
nothing in Control Panel has to move.

This works because a certificate binds to a **name**, not a port. Let's Encrypt insists on
reaching port 80 of the _public address_, and on this network that address belongs to the Pi,
which relays the challenge onward. What it relays _to_ is ours to pick. So the NAS answers the
challenge on 8880 and serves the app on 9443, and QTS keeps its own listeners.

The cost is that the port travels with the URL: `https://example.ddns.net:9443`. Signed
media URLs are relative (§12d), so a TV handed a `:9443` address keeps using it and nothing
else has to be told which port it is on.

To use the standard layout instead, set `PS_HTTP_PORT=80` and `PS_HTTPS_PORT=443` in
`docker/.env`, drop the port from `PS_DOMAIN`, and move QTS's listeners in **Control Panel →
System → General Settings** first — or Container Station will fail to bind and say very little
about why.

## Getting a certificate

The Pi keeps ports 80 and 443 and keeps serving its own two apps. It is **not** in the media
path — it cannot carry video, which is measured rather than suspected, and nothing here
proxies through it.

The one thing it does is relay the Let's Encrypt challenge, which is a few hundred bytes of
text every sixty days.

### Why a relay, and not a port of our own

A certificate binds to a **name**, not a port. Once issued, the certificate for
`example.ddns.net` is equally valid on 443, 8443 or anything else, and the router may
forward whatever external port you like to whatever internal one.

Obtaining it is the part that is fussy. Let's Encrypt's two automatic challenges connect to
fixed ports and will not follow a redirect to another:

- **HTTP-01** connects to `<name>:80`
- **TLS-ALPN-01** connects to `<name>:443`

That is Let's Encrypt policy, not a Caddy limitation, and No-IP's own port-redirect feature
does not help — it answers with an HTTP 302, which carries no TLS and is not what a validator
follows. Only DNS-01 escapes the port requirement, and it needs API control of TXT records
that a free DDNS hostname does not provide.

So the NAS cannot answer on port 80 of the public address, because the Pi does. But the Pi can
be told to hand that one URL path over.

### One site block on the Pi

Add `/etc/caddy/conf.d/private-stock.caddy` — the same `conf.d` layout the other two apps use,
so `install.sh` will not disturb it and nothing else has to change:

```caddy
# Relays the Let's Encrypt challenge for private-stock to the NAS, and nothing else.
#
# The NAS runs its own Caddy and owns its own certificate; this exists only because Let's
# Encrypt insists on validating over port 80, which this machine holds. No video passes
# through here.
#
# 8880 rather than 80 on the far side: the validator's port requirement applies to the public
# address only, so the NAS can answer wherever suits it and leave QTS's own ports alone. Must
# match PS_HTTP_PORT in docker/.env.
http://example.ddns.net {
	handle /.well-known/acme-challenge/* {
		reverse_proxy 192.168.1.10:8880
	}

	handle {
		respond "Not here" 404
	}
}
```

Two details carry the design:

- **`http://` on the site address** binds port 80 only and stops this Caddy from trying to get
  a certificate for the name itself. Without the prefix it would compete with the NAS for the
  same certificate, and both would fail in confusing ways.
- **The `handle` fallback returning 404** means the public name exposes nothing from the Pi.
  Someone who finds the hostname gets a blank refusal rather than a login page on the wrong
  machine.

Then `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

### Setting it up with No-IP

1. **Create the hostname** in the No-IP portal — `example.ddns.net`, or any free name.

2. **Add it to the DUC the Pi already runs.** Every hostname resolves to the same public
   address, so one client can update them all; a second client on the NAS would only be
   another thing to keep alive.

    **Add yours alongside whatever is already listed — do not retype the line from here.** Not
    every name on this network is necessarily updated by this client (a name served by the Pi
    may be updated elsewhere), and a hostname the DUC's key does not cover fails the update call,
    which can take the working names down with it. In `/etc/default/noip-duc`:

    ```bash
    NOIP_HOSTNAMES=otherapp.ddns.net,example.ddns.net
    ```

    then `sudo systemctl restart noip-duc`.

3. **Reserve the NAS's address** in the router's DHCP table, and put that address in the site
   block above.

4. **Add the site block to the Pi** and reload Caddy. Nothing on the QNAP needs moving: Caddy
   binds 8880 and 9443 there, and QTS is not using either.

5. **Start the stack and watch the certificate arrive:**

    ```bash
    docker compose -f docker/docker-compose.qnap.yml -f docker/docker-compose.proxy.yml up -d
    docker logs -f private-stock-caddy
    ```

    `certificate obtained successfully` means the whole chain worked: DDNS record, the Pi's
    relay, and the NAS answering. Get this right before anything else, because every later
    symptom looks identical from a TV — a black screen.

### How this fails, because it is not foolproof

Nothing involving a public CA is. These are the ways it breaks, worst first:

- **The free No-IP hostname lapses.** Free names need confirming every 30 days or they are
  deleted, and a deleted name takes DNS, the certificate renewal and casting with it. This is
  the likeliest failure by a wide margin, and it is a calendar problem rather than a technical
  one.
- **The Pi is down across the whole renewal window.** Caddy begins renewing about 30 days
  before expiry and keeps retrying, so an afternoon of downtime costs nothing — but a Pi that
  stays off for a month takes the certificate with it. The relay makes the NAS depend on the
  Pi for this one thing, and that is the price of not moving the port forwards.
- **The site block is edited or lost** during a future `install.sh` run on the Pi. It lives in
  `conf.d` under its own filename, which the scripts do not touch, but it is worth a look
  after any deploy there.
- **The LAN address changes.** The site block names the NAS by IP, so a lease that moves
  breaks the relay silently. Hence the DHCP reservation.
- **Let's Encrypt rate limits.** Five failed validations per hostname per hour. A
  misconfiguration can lock out retries for an hour, which reads like a deeper failure than it
  is. `acme_ca` in the Caddyfile's global block points at the staging directory for testing.

The NAS's Caddyfile disables TLS-ALPN-01 deliberately, so issuance does not first attempt the
challenge on port 443 — which the Pi holds, and which would therefore spend one of those five
failures on every renewal.

**Check it rather than assume it.** The whole arrangement is exercised roughly every sixty
days, unattended, and a failure is silent until the certificate actually expires:

```bash
# What is the expiry, and who issued it? The port is the app's, not 443 -- see PS_HTTPS_PORT.
echo | openssl s_client -connect example.ddns.net:9443 -servername example.ddns.net 2>/dev/null     | openssl x509 -noout -issuer -dates

# On the NAS, after the first issuance, force the path to be proven end to end.
docker exec private-stock-caddy caddy reload --config /etc/caddy/Caddyfile
```

### Later: remote access

Nothing above makes the app reachable from outside; it only makes the certificate real. When
remote access is wanted, forward external 9443 to the NAS's 9443. The certificate already covers
it, because it always did: it is for the name.

Note that the challenge port, 8880, should **not** be forwarded. It exists for the Pi to reach
over the LAN and has no business being reachable from outside.

The app returns relative paths for signed media URLs (§12d) precisely so that this works. A
browser that reached the app on `:9443` hands a receiver URLs on `:9443`; one that reached it
on the LAN hands out LAN ones. Neither the server nor the TV has to be told which world it is
in.

## Casting, and why it needs split-horizon DNS

This section is about the **public** path. On the LAN path the TV is sent to the cast port by IP
instead, and none of it applies -- see "What this path gives up, and what it avoids" above.

A Chromecast or Android TV does not receive a stream from your phone. Your phone hands it a
**URL**, and the TV fetches the bytes itself — its own DNS, its own TLS stack, no cookies.
That is what signed media tokens are for (§12d), and it has two consequences for this setup:

1. **The certificate must be publicly trusted.** A self-signed certificate, or Caddy's
   `internal` CA, fails with a black screen and no error -- which is why the LAN path sends the
   TV to a plain-HTTP port instead of its HTTPS site.
2. **The name the app hands out must be reachable from the TV.** If `PS_DOMAIN` resolves to
   your public address, the TV in the next room fetches the video out through your upstream
   and back in again — or, on the many consumer routers that do not hairpin NAT, not at all.

Point `PS_DOMAIN` at the NAS's LAN address in your local resolver. Same name, same
certificate, no round trip. Give the NAS a reserved DHCP address first, or the record goes
stale.

**It is not only a casting feature**, which is the reason this section is easy to skip and
should not be. Once the front door is the public name, that name is how browsers on the LAN
reach the app too — without a local record they resolve the public address, where nothing is
listening unless a port has been forwarded. Split DNS is what makes the library reachable from
inside the house at all.

### Doing it here, where the router cannot

Google Nest Wifi hands out DNS _servers_ and cannot hold a record of its own, which is the
common case rather than an unlucky one. The resolver therefore lives on the Pi, which is
already always-on and already load-bearing for this deployment.

```bash
sudo apt install -y dnsmasq
```

`/etc/dnsmasq.d/private-stock.conf`:

```ini
# On the LAN this name is the NAS, not the public address.
address=/example.ddns.net/192.168.1.10

# Answer only on the LAN. An open resolver is a DNS amplification reflector, and this box
# already has 80 and 443 forwarded to it, so it is the one most likely to be probed.
interface=eth0
interface=wlan0
bind-dynamic

# Explicit upstreams rather than /etc/resolv.conf, which can end up pointing back at this
# service once it is running and then resolve nothing at all.
no-resolv
server=1.1.1.1
server=8.8.8.8

domain-needed
bogus-priv
```

**Open port 53 to the LAN, and only the LAN.** The Pi runs ufw with `policy DROP`, so without
this dnsmasq answers itself and nothing else — which looks exactly like a broken resolver:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 53 proto udp
sudo ufw allow from 192.168.1.0/24 to any port 53 proto tcp
```

A bare `ufw allow 53` would make the Pi an open resolver reachable from the internet. Do not.

**Test it before pointing the LAN at it.** Making an unverified resolver the whole network's DNS
is how a small mistake becomes a house-wide outage:

```bash
dig @192.168.1.2 example.ddns.net +short   # 192.168.1.10
dig @192.168.1.2 google.com +short                  # anything
```

The second is not redundant: it proves forwarding works rather than having built a resolver that
knows one name. Run both again from another machine — passing locally and failing across the
network is the ufw symptom above.

Then set the router's DNS to the Pi. If it demands a secondary, **give it the Pi twice**: a
public resolver in that slot answers with the public address some of the time, producing a site
that works four times in five, which is far worse to diagnose than one that fails cleanly.

Know the undo before you need it — setting the router's DNS back to Automatic — and know that
you will be doing it from a phone on cellular, because nothing on the wifi will be resolving.

The Pi is now the LAN's DNS, which on wifi is thin footing for something everything depends
on: put it on a cable, and keep its address when you do — the dnsmasq record, the ACME relay
and the ufw rule are all pinned to it.

### Android TV first

Of the three receivers, Android TV and Chromecast take the same path — the Cast sender SDK —
and Roku does not. The sender is built: in Chrome, an item's player bar has a cast control (in
the "more" menu on a phone). It loads the SDK from `https://www.gstatic.com`, which the app's
Content Security Policy allows.

The sender page must itself be HTTPS, because the Cast SDK only runs in a secure context. So on
the public path casting needs everything above, in order: certificate, then split DNS. On the
LAN path it needs Caddy's root on the phone and `PS_CAST_HOST` set.

## Updating

Building the image is the update. `/data` is a bind mount to the share, so the database,
artifacts, variants and trash outlive the container; media roots are read-only, except the
deletable ones, and the app never writes to those except to delete.

### Deletable libraries

A library can be deleted from only when two things agree: its folder is mounted `:rw` in
`docker-compose.qnap.yml`, and it is flagged **Deletable** in the admin page. The first is the
list — one volume line per folder, laid over the read-only `Multimedia` mount at the same
container path, so the library keeps its path:

```yaml
- /share/CACHEDEV1_DATA/Multimedia/Downloads:/media/multimedia/Downloads:rw
```

The app checks the mount when Deletable is switched on (or chosen while adding a library) and
refuses, naming the folder, if the mount is read-only. It cannot add the mount itself: a
container's mounts are fixed when it is created, and the only way for the app to change them
would be handing it the Docker socket — root on the NAS, from an internet-facing process.

To add one: add the line, then `./docker/ship.sh --send-compose` (the flag is implied
when deploy.env already has `PS_SEND_COMPOSE=1`) so the container is recreated with it. PUID must be able to write the folder.

### The two scripts

`ship.sh` runs here and `rollout.sh` runs on the NAS. They are the steps below with the
mistakes taken out, and they are a pair: `ship.sh` copies `rollout.sh` up with every image, so
the half on the NAS cannot drift behind the half in the repository.

```bash
cp docker/deploy.env.example docker/deploy.env   # once: host, account, share path
./docker/ship.sh                                 # check, build, save, copy, roll out
```

`deploy.env` is git-ignored because it describes _your_ NAS rather than the project. No
password lives in it: ssh asks, which is the one credential that should not be written down
beside the repository.

### One prompt, or none

A deployment is **one** ssh connection, opened at the start — before the build, so the prompt
comes while you are still watching. The far side makes the directory, says it is ready, and then
waits: after the build `ship.sh` sends `go <bytes>` and a tar stream (the tarball last), the NAS
checks the tarball arrived whole, and (unless `--no-rollout`) runs `rollout.sh` in the same login. If
anything fails first — the build, the smoke test, Ctrl-C — the connection closes, the far side
reads end of input instead of `go`, and the NAS is left as it was.

It used to be three connections sharing one login through `ssh -M` (multiplexing). That does not
work from Git Bash: handing a session to the master means passing file descriptors over a Unix
socket, which MSYS does not implement, so each step failed with `read from master failed:
Connection reset by peer` and asked again anyway.

**A key removes the prompt entirely**, including for the ad-hoc `docker exec` commands elsewhere in
this file, which do not go through `ship.sh` at all:

```bash
ssh-keygen -t ed25519 -C "private-stock deploy"        # once, if you have no key yet
ssh-copy-id -p 22 admin@192.168.1.10                 # asks for the password one last time
ssh -p 22 admin@192.168.1.10 true && echo "no prompt"
```

If `ssh-copy-id` is missing from Git Bash, the manual form is the same thing:

```bash
ssh -p 22 admin@192.168.1.10 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys"     < ~/.ssh/id_ed25519.pub
ssh -p 22 admin@192.168.1.10 "chmod 600 ~/.ssh/authorized_keys"
```

Two QTS caveats. The permissions matter — `sshd` ignores an `authorized_keys` that is group- or
world-writable, and fails silently by falling back to the password, so "it still asks" is the
symptom of a mode bit rather than of a bad key. And a firmware update can reset the admin account's
home directory, which takes the file with it; if the prompt comes back after updating QTS, this is
why.

**What is deliberately not done: storing the password, or piping it to `sshpass`.** Both would also
give one prompt, and both would put the credential somewhere — a file beside the repository, or
this script's environment, which is readable from `/proc` by anything running as you and inherited
by every child process it spawns. A single connection needs no copy of the secret, and a key needs
no secret on the wire at all.

`ship.sh` runs `pnpm build` and `smoke.sh` before it builds anything, tags the image
`<date>-<short sha>` as well as `latest`, saves both, and copies the tarball and `rollout.sh`
to `PS_NAS_DIR`, then runs `rollout.sh` there over the same connection. Nothing running is
touched until every check has passed and the tarball has arrived whole. `--no-checks` and
`--no-build` skip the slow parts when they have just been done, and `--no-rollout` stops after
the copy and prints the command instead — for shipping now and rolling out when the library is
idle.

Builds do not pile up. `PS_KEEP_BUILDS` in `deploy.env` (default 3) is how many tarballs
`ship.sh` leaves in `dist-image/`, and is passed to `rollout.sh` as `--keep`: once the new
container is healthy, it keeps that many dated images loaded and only the newest tarball on the
share, then drops the untagged images that leaves behind. The live image and the one it replaced
are never removed, and nothing is removed when a rollout fails, which is when the older builds
are wanted.

What runs on the NAS — by `ship.sh`, or by hand after `--no-rollout`:

```bash
sh /share/Container/private-stock/docker/rollout.sh
```

It finds Container Station's `docker` — which is not on the login PATH, and moves with the
volume the QPKG was installed on — loads the newest tarball sitting next to it, recreates the
container, and waits for the healthcheck to answer rather than returning while the entrypoint
is still migrating. If it does not come up, it prints the tail of the log and the exact
rollback command, which is what the dated tag is for:

```bash
sh rollout.sh --rollback private-stock:2026-09-21
```

Every successful rollout also drops dangling images — on Container Station, removing an old
build's tag leaves the image behind untagged, so without this the tidy freed nothing. Never
`prune -a`: that would take the dated tags with it, and those _are_ the rollback. (`--prune`,
which used to ask for this, is still accepted and does nothing extra.)

### The same thing by hand

On the development box — `smoke.sh` first, because it is the only check that loads `dist` the
way the container does, using plain `node` rather than `tsx` or Next's bundler:

```bash
pnpm build && ./docker/smoke.sh
docker build -f docker/Dockerfile -t private-stock:latest .
docker save private-stock:latest private-stock:2026-09-21 | gzip > private-stock.tar.gz
```

Copy the tarball to the NAS, then over SSH:

```bash
gunzip -c private-stock.tar.gz | docker load
docker compose -f docker-compose.qnap.yml up -d
```

`up -d` sees a new image id behind the same tag and recreates the container; nothing else
needs saying. The tarball route is here rather than a registry because it needs nothing
outside the house — the same reason the rest of this deployment does not phone anywhere.

**Tag the build as well as `latest`, and save both.** `docker load` moves `latest` onto the new
image and the previous one keeps only its id, so rolling back means finding a nameless image by
hand at exactly the moment that is least welcome. `-t private-stock:2026-09-21 -t
private-stock:latest` costs nothing and makes the last good build something you can name.

`docker save` takes tags, not images — naming only `latest` there saves only that one, and the
dated tag silently fails to arrive on the NAS. Both must appear in the save command, which is
why the one above lists them. If it has already happened, the image is still there and
`docker tag private-stock:latest private-stock:<date>` on the NAS restores the name.

On boot the entrypoint snapshots the database to `/data/backups/pre-migration-<timestamp>.db`
and migrates before either process starts, so a container that comes up is a container with a
current schema. There is no "did you remember to migrate" state for anyone to get wrong. Watch
it land with `docker logs -f private-stock`; the healthcheck calls `/api/health` and
`docker ps` reports the result.

### A schema change is an ordinary update

`HAS_RELEASED` is `true` (`packages/db/src/released.ts`), so every schema change ships as its
own timestamped migration in `packages/db/src/migrations/`. The entrypoint snapshots the
database and runs the pending ones before either process starts, so the rebuild above _is_ the
schema update: nothing extra to run, and nothing to remember.

The baseline is frozen history now. On a first install it is what creates the schema; on an
install that already has tables the runner skips it and applies only what came after.

This is what the flip bought. Before it there was exactly one migration, regenerated from
`init.ts` on every schema change, and because the runner skips the baseline against a populated
database, boot-time migration could not carry a schema change to an install that already had
one — so a release touching `init.ts` meant destroying the catalogue on the NAS and rescanning.
That is over. The cost on the other side is that a shipped migration can never be edited, only
followed by another.

## Security: what is set where

Set **in the app** (`next.config.ts`, `lib/auth/`), so it holds however the app is reached —
including on the LAN with no proxy at all:

- `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy`
- `Referrer-Policy: no-referrer` — the strictest there is, because a signed media URL carries
  its token in the query string and any weaker policy hands that to whatever a page links to
- `Strict-Transport-Security`, but only on a request a trusted proxy says arrived over TLS.
  Sending it over plain HTTP would pin the hostname to HTTPS for a year on a deployment with
  no certificate, and the only cure is clearing site data in every browser that saw it.
- Account creation (§12c): after the first admin, every account comes from an invitation code
  an administrator mints. There is no open sign-up and no setting that enables one. The code is
  generated rather than chosen — about fifty bits — which is what makes guessing it hopeless.
- Login rate limiting (§12). Per account it is a growing **delay**, not a lockout: three free
  attempts, then a wait doubling from half a second to a ceiling of ten. A lockout keyed on an
  email address would be a remote off switch anybody who knows the address could pull. Per
  address it _is_ a refusal — sixty attempts per fifteen minutes — because there the person
  inconvenienced is the one making the attempts.
- `POST /api/auth/password` and `POST /api/auth/refresh` are metered too: ten per account and
  240 per address per fifteen minutes. Neither is a way in; the limits keep somebody from
  turning a bcrypt comparison into a load generator on the box that is also transcoding.

Set **in Caddy**: TLS, the forwarded headers, and `encode` scoped to text — the default would
spend CPU gzipping video and WebP, which are already compressed and are the bulk of the bytes.

Set **in the host's firewall**, by the optional fail2ban overlay: bans for repeated failed
sign-ins. See "Banning repeat offenders" below.

Caddy deliberately sets **no security headers**. Setting them in both places is how the
sibling Pi apps ended up serving two different HSTS lifetimes and an `X-Frame-Options` that
says `SAMEORIGIN` in one header and `DENY` in another on the same response.

## Banning repeat offenders

Optional, and only meaningful with the Caddy overlay already in place — it reads Caddy's
access log and bans the address Caddy saw.

```bash
docker compose -f docker/docker-compose.qnap.yml \
               -f docker/docker-compose.proxy.yml \
               -f docker/docker-compose.fail2ban.yml up -d
```

Five failed sign-ins from one address in ten minutes and it is dropped at the host firewall
for an hour, multiplying towards a day if it comes back. Private ranges are never banned:
a tablet retrying a stale password is not an attacker, and locking the household out from
inside the house is the failure worth avoiding.

**Why it matters more than it looks.** The app's per-account control is a delay rather than a
lockout, deliberately (§12) — which means a patient attacker is slowed for ever rather than
stopped, and every attempt still costs a connection, a log line and a held socket. This is the
only layer in the stack that can make the attempts stop arriving at all. It also answers the
background noise any internet-facing deployment gets: scanners working through a list of
paths, which otherwise each cost a Next request.

### Check the filter actually matches

A filter that silently matches nothing looks exactly like a filter that is working, and the
log format belongs to Caddy rather than to us. After a couple of deliberately failed sign-ins:

```bash
docker exec private-stock-fail2ban \
    fail2ban-regex /var/log/caddy/private-stock-access.log \
                   /etc/fail2ban/filter.d/private-stock.conf --print-all-matched
```

It should report the failures it found. Then `fail2ban-client status private-stock` lists
current bans.

The filter has been checked against real Caddy 2 output: three failed logins, one rejected
registration and one successful request produce four matches and one miss, and the miss is the
success. Re-run it after a Caddy major upgrade, because the log format is Caddy's to change.

### Prove a ban actually reaches the host firewall

Matching the log and enforcing a ban are two independent things, and the second fails silently.
fail2ban runs in a container with its own `iptables` binary; if that one is the `nf_tables`
variant while the host runs legacy `iptables`, every ban is written to a table the host never
consults. `fail2ban-client status` still lists it. Nothing logs an error.

Ban a documentation address and look for it on the host:

```bash
docker exec private-stock-fail2ban fail2ban-client set private-stock banip 203.0.113.5
iptables -L -n | grep 203.0.113.5          # on the NAS itself, not in the container
docker exec private-stock-fail2ban fail2ban-client set private-stock unbanip 203.0.113.5
```

`203.0.113.0/24` is TEST-NET-3, reserved for documentation, so banning it cannot inconvenience
anyone. If the middle command prints nothing, the ban never left the container: switch
`banaction` between `iptables-allports` and `nftables-allports` and try again.

**This NAS is legacy iptables with no nftables ruleset**, which is why the jail ships with
`iptables-allports` — the opposite of what QTS 5 documentation would lead you to expect.

Worth noticing while you are in there: the NAS's `INPUT` policy is `ACCEPT` with no rules, so
fail2ban's bans will be the only host firewall rules on the box. That is workable — it is also
the reason the router's port forwarding is the only thing standing between the LAN services and
the internet, and why only 9443 should ever be forwarded.

### If bans are listed but traffic still arrives

Suspect `banaction` first, per the test above.

It is deliberately **allports** rather than a port list. The app's ports are configurable
(`PS_HTTP_PORT`, `PS_HTTPS_PORT`), so a port list in the jail is a second copy of that decision
in a file nothing checks against the first. It was wrong in exactly that way — `port =
http,https` means 80 and 443, and the app has never been on either, so bans were listed and
enforced nowhere.

### Getting yourself unbanned

```bash
docker exec private-stock-fail2ban fail2ban-client set private-stock unbanip <address>
```

Worth knowing before you need it, from a machine that is not the banned one.

## Still missing

- **No on-demand HLS** (phase 3). Remote playback is direct-play or nothing, so a
  high-bitrate original over a residential upstream buffers with no adaptive bitrate to fall
  back to. Irrelevant on the LAN, which is why LAN comes first.
- **No DLNA**, which is the only path to a Samsung TV (§11) and is LAN-only by nature — the
  protocol has no authentication at all.
