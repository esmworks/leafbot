# Names service

Gives each server set up with `docker/install.sh` a name under `leafbot.cloud`, such as `k3x9q2mf.leafbot.cloud`.

Let's Encrypt gives 50 new certificates a week per registered domain. Under a shared IP-address DNS service every
install shares that count with everyone else who uses the service; under this domain only Leaf Bot servers share it.
Renewals of existing certificates do not count.

## How it works

- `POST /v1/names` makes a random name and an A record (DNS only, not proxied) pointing at the address the request
  came from (`CF-Connecting-IP`), and answers `{ name, token }`. The caller has shown it holds that address, so nobody
  can point a name at someone else's server. Only public IPv4 addresses get a name; the installer asks over IPv4.
- One name per address: a server set up again on the same address gets a new name and the old one is removed.
- `PUT /v1/names/<label>` with `Authorization: Bearer <token>` says the server is still there and moves the name if
  the address changed. The installer's `leafbot-name` systemd timer calls it once a day and after a boot.
- `DELETE /v1/names/<label>` with the token gives the name up.
- `GET /<IPv4 address>` redirects to the server's name, for someone who set the server up through their provider's
  user data and knows only its address.
- Once a day the Worker removes names not renewed for 30 days, so a name does not keep pointing at an address that has
  since gone to someone else.

The database keeps each name's label, address, DNS record id, a SHA-256 hash of its token and two times, and for eight
days the address and time of each name handed out. The token itself stays on the server, in `docker/.env`.

## Limits

| Limit                   | Default | Variable         | Why                                                                              |
| ----------------------- | ------- | ---------------- | -------------------------------------------------------------------------------- |
| New names per address   | 3 a day | `PER_IP_PER_DAY` | One server rarely needs more                                                     |
| New names in seven days | 40      | `PER_WEEK`       | Stays under Let's Encrypt's 50 new certificates a week for the domain            |
| Names at once           | 180     | `TOTAL`          | Cloudflare's free plan allows 200 DNS records in a zone created after 2024-09-01 |
| Days before removal     | 30      | `STALE_DAYS`     | A server switched off for a month gives its name back                            |

When a limit is reached the service answers 429 or 503 and the installer uses an sslip.io name instead. More than 180
servers need a paid Cloudflare plan for the zone (3,500 records on Pro) and a higher `TOTAL`; more than 40 new servers
a week need a rate limit increase from Let's Encrypt (their rate limit adjustment form).

## Deploying

Both domains, `leafbot.app` and `leafbot.cloud`, must be zones in the same Cloudflare account. Run these from this
folder; `wrangler login` opens a browser to sign in to Cloudflare.

1. Sign in: `pnpm dlx wrangler login`
2. Make the database: `pnpm dlx wrangler d1 create leafbot-names`, and put the `database_id` it prints into
   `wrangler.toml`.
3. Make the tables: `pnpm dlx wrangler d1 execute leafbot-names --remote --file schema.sql`
4. Put the zone ID of `leafbot.cloud` (Cloudflare dashboard → leafbot.cloud → Overview, right-hand column) into
   `ZONE_ID` in `wrangler.toml`.
5. Make an API token (My Profile → API Tokens → Create Token → "Edit zone DNS" template) limited to Zone → DNS → Edit on
   the `leafbot.cloud` zone only, and store it: `pnpm dlx wrangler secret put CF_API_TOKEN` (it asks for the value).
6. Deploy: `pnpm dlx wrangler deploy`. This also attaches `names.leafbot.app` to the Worker.
7. Check it: `curl https://names.leafbot.app/` answers "Leaf Bot server names".

Nothing in the installer changes before a release: the installer's second stage runs from the release being installed,
so servers start asking for names with the first release that contains this change.
