# Deploying

Step-by-step guide to standing up Sanad on a public server: `sanad.mohammed-hussein.me`,
a DigitalOcean droplet (Frankfurt, 2 shared vCPU / 2GB RAM / 50GB SSD), Ubuntu 24.04.

## 1. DNS first

Namecheap → Domain List → **Manage** → **Advanced DNS** → add an **A record**,
host `sanad`, value the droplet's public IP.

Verify it resolves before doing anything else:

```bash
dig +short sanad.mohammed-hussein.me
```

Expect the droplet's IP address back. **Do not proceed until this resolves.**
Let's Encrypt allows only 5 certificates per domain per week, and retrying a
deploy against an unresolved name burns through that quota for nothing.

## 2. Server preparation

From your machine:

```bash
scp deploy/setup-server.sh root@<droplet-ip>:/root/
ssh root@<droplet-ip> "bash /root/setup-server.sh sanad"
```

Expect a summary at the end listing the Docker/Compose versions, the created
user, firewall status, and swap size. If root has no `authorized_keys`, the
script warns loudly and stops before locking anyone out — add your key and
re-run.

Log out, then log back in as the new user:

```bash
ssh sanad@<droplet-ip>
docker ps
```

If `docker ps` says `permission denied`, log out and back in again — group
membership only takes effect on a fresh login session.

## 3. Clone the repository

```bash
git clone <repo-url> sanad-prod
cd sanad-prod
```

## 4. Secrets

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 48   # JWT_DEVICE_SECRET
openssl rand -base64 24   # GRAFANA_PASSWORD
```

```bash
cp .env.example .env
# fill in DOMAIN, ACME_EMAIL, the three JWT secrets, GRAFANA_PASSWORD, etc.
chmod 600 .env
git check-ignore -v .env   # confirms .env is not tracked
```

Database, Redis and Kafka hostnames in `.env` must be the Compose **service
names** — `postgres`, `redis`, `kafka` — never `localhost`. Containers each
have their own network namespace; `localhost` inside a container means the
container itself, not the host or another service. This is the single most
common cause of a container that starts cleanly and then can't connect to
anything.

## 5. Deploy

```bash
./deploy/deploy.sh
```

Expect preflight checks, an image build, migrations, then a health check
poll and a summary of URLs.

Common failure modes:

- **`localhost` left in `.env`** — services start but can't reach Postgres,
  Redis or Kafka. Fix the hostnames per step 4 and re-run.
- **Certificate still issuing** — `https://$DOMAIN/health` fails but
  `http://$DOMAIN/health` works. Check `docker compose logs --tail=40 caddy`
  for `certificate obtained successfully`; it usually appears within a
  minute of DNS resolving correctly.

## 6. Verify

```bash
curl https://sanad.mohammed-hussein.me/health
curl https://sanad.mohammed-hussein.me/ready
curl -X POST https://sanad.mohammed-hussein.me/demo/scenario/conflict | jq '.data.outcome'
```

Expect `resolution: field_wins` and `job_status_now: delivered`.

| | |
|---|---|
| Driver PWA | https://sanad.mohammed-hussein.me/ |
| Dispatch console | https://sanad.mohammed-hussein.me/dispatch |
| Grafana | https://sanad.mohammed-hussein.me/grafana/ |
| Jaeger | https://sanad.mohammed-hussein.me/jaeger/ |
| Prometheus | https://sanad.mohammed-hussein.me/prometheus/ |

Grafana, Jaeger and Prometheus all open without a login — that's intentional
for this demo. Grafana is read-only for anonymous visitors (Viewer role);
Jaeger and Prometheus have no access control of their own, so treat anything
sensitive as unfit for this deployment.

## 7. Point the driver app at the deployment

Set `BACKEND` in `web/driver/index.html` to the deployed API origin, then
redeploy:

```bash
./deploy/deploy.sh
```

---

## Operations

**Logs**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api        # follow one service
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=200    # last N lines, all services
```

**Container status**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps -a
```

Use `-a`, not just `ps` — without it a container that crashed on boot is
hidden and looks as though it was never defined.

**Updating**

```bash
git pull && ./deploy/deploy.sh
```

**Reaching Prometheus without going through the public URL** (useful if you
ever lock `/prometheus/` back down):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec prometheus wget -qO- 'http://localhost:9090/api/v1/targets' | jq
```

**Database access**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres psql -U sanad -d sanad
```

**Backups**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_dump -U sanad sanad | gzip > backup-$(date +%F).sql.gz
```

Copy it off the box. A backup that exists only on the machine it protects is
not a backup.

**Resource usage** — worth watching on a 2GB box:

```bash
docker stats --no-stream
free -h
```

**Shutdown**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down       # stops containers, keeps volumes
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v    # also deletes volumes
```

The Caddy certificate volume (`caddy_data`) is separate from `-v` on the
base stack's volumes conceptually, but is still deleted by `down -v` on this
overlay — use `down` without `-v` for a routine restart so certificates
survive it.

---

## Cost

DigitalOcean bills hourly for the droplet **existing**, not for traffic — an
idle server costs the same as a busy one, and billing only stops when the
droplet is destroyed. If you attach a reserved IP, release it when
destroying the droplet (free while attached, billed while detached). Skip
DigitalOcean's automatic backups (20% surcharge on the droplet price); take
manual snapshots when you want one and delete old ones.

---

## A note on load testing

The figures in [`TEST_RESULTS.md`](../TEST_RESULTS.md) were measured on a
20-CPU machine. This server has 2 shared vCPUs and will hit its ceiling far
earlier. **Do not run the reconnect storm test against it** — the numbers
would not be comparable to the documented results, and the box will fall
over.
