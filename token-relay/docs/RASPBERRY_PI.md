# Hosting on a Raspberry Pi

A Raspberry Pi 5 with 8 GB of RAM can run the relay, its Postgres database
and the tunnel together, with room to spare. The relay does very little work
per request. It checks a key, writes a few database rows and forwards a text
stream. The heavy work, running the model, happens on the sellers' machines.

## How much machine does the relay need?

Measured with `npm run loadtest` on one x86 cloud core. The relay used Postgres,
and each request streamed a ~22-token answer from the mock upstream.

| Concurrent streams | Requests/s | Relay CPU | Relay memory | p50 / p99 latency |
|---|---|---|---|---|
| 50 | 66 | 68% of 1 core | 128 MB | 0.7 s / 1.4 s |
| 200 | 125 | 97% of 1 core (saturated) | 182 MB | 1.5 s / 2.2 s |
| 500 | 117 | 91% | 214 MB | 4.2 s / 5.3 s |
| 1000 | 111 | 87% | 245 MB | 8.6 s / 10.6 s |

No requests failed at any level. What the numbers mean:

* **The limit is CPU.** One Node process uses one core and handles about
  120 short streams per second. Longer answers cost more CPU, because every
  streamed chunk is parsed for usage accounting. Expect about 40–60 req/s per
  core for typical 300–800-token coding answers.
* **Memory is small.** About 70 MB idle and about 250 MB with 1,000 open
  streams. Postgres needs another 0.5–1 GB.
* **In user terms:** a developer who is actively coding in Cursor sends
  roughly one request every 10–30 s. So one core serves on the order of
  **1,000+ developers coding at the same time**.

## Recommended machines

| Stage | Machine | Why |
|---|---|---|
| Dev / private beta | **Raspberry Pi 5, 8 GB**, with an SSD | Roughly ⅓–½ the per-core speed of a cloud core: about 40 short or 15–25 long streams per second on the relay's core. That covers hundreds of active developers. |
| Public launch | 2 vCPU / 2 GB cloud VM, plus managed Postgres (1 vCPU / 1–2 GB) | Uptime, backups and a stable network matter more than speed at this stage. |
| Growth | Add relay instances (1 vCPU / 512 MB each) behind the load balancer | The relay is stateless; budgets and money live in Postgres. |

A Pi 4 with 8 GB also works, at about half a Pi 5's speed. Use a 64-bit OS on
either one.

## Before you use a Pi for real users

| Risk | What to do |
|---|---|
| **SD cards wear out** under database writes and can corrupt the ledger | Put Postgres on a USB 3 or NVMe **SSD** (`DATA_DIR=/mnt/ssd/token-relay`). Keep only the OS on the SD card. |
| **Home upload bandwidth.** Editors send large contexts, about 50–200 KB per request. The relay receives each request and sends it on to the seller, so every request goes out over your upload link. | 10 req/s × 150 KB ≈ **12 Mbit/s of upload**. Check your plan's upload speed; it is usually the first thing you run out of. |
| **Exposing your home IP and router** | Use a **Cloudflare Tunnel** (included in the compose file). You open no router ports, get free HTTPS, and your IP stays hidden. |
| **Power and internet outages** cut off every buyer | Use a UPS HAT or a small UPS. Keep it for dev and beta, and move to a VM for launch. |
| **Losing money records** | Run nightly `pg_dump` to off-device storage (B2, S3 or another disk). Also back up `TR_MASTER_KEY` separately. |
| **ISP terms** | Some residential plans forbid hosting servers. A tunnel works, but check your plan's terms. |
| **Heat.** A Pi 5 throttles under sustained load. | Use the official active cooler. |

## Setup (Raspberry Pi OS 64-bit, Bookworm or later)

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # log out and back in

# 2. SSD mounted at /mnt/ssd (format ext4, add to /etc/fstab), then:
sudo mkdir -p /mnt/ssd/token-relay && sudo chown $USER /mnt/ssd/token-relay

# 3. Code
git clone -b token-relay https://github.com/C-sirui/ChatGPT-disord-bot.git
cd ChatGPT-disord-bot/token-relay
cp .env.example .env
#   set TR_MASTER_KEY (openssl rand -base64 32), TR_ADMIN_TOKEN, POSTGRES_PASSWORD,
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TR_SERVER__PUBLIC_BASE_URL=https://relay.yourdomain.com
#   and CLOUDFLARE_TUNNEL_TOKEN (step 4). Remove the DATABASE_URL line; compose sets it.

# 4. Cloudflare Tunnel: Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create.
#    Copy the token into .env. Add a public hostname relay.yourdomain.com → service http://relay:8787

# 5. Start (the first build on a Pi 5 takes a few minutes)
docker compose -f docker-compose.pi.yml up -d --build
docker compose -f docker-compose.pi.yml exec relay node dist/cli.js create-admin you@example.com 'long-password'
curl https://relay.yourdomain.com/readyz
```

Updates: `git pull && docker compose -f docker-compose.pi.yml up -d --build`.
Migrations run automatically before the relay starts.

Nightly backup (crontab):
```
15 3 * * * docker compose -f ~/ChatGPT-disord-bot/token-relay/docker-compose.pi.yml exec -T db pg_dump -U relay relay | gzip > /mnt/ssd/backups/relay-$(date +\%F).sql.gz
```

## Measure your own Pi

```bash
npm install && npm run dev          # dev build with the mock upstream
node scripts/loadtest.mjs $(pgrep -f "src/main.ts" | head -1)
```

The script prints requests/s, the relay's CPU and memory, and p50/p99
latency at 50, 200 and 500 concurrent streams. Set `LEVELS`, `SECONDS` or
`MAX_TOKENS` to change the test. The dev seed's mock credential allows 16
concurrent streams. To go beyond that, register more credentials, or raise its
`max_concurrency` and `hourly_token_limit` in the database first.

## Can the Pi also be a seller?

Only for small models. An 8 GB Pi 5 runs 1–3B-parameter models with Ollama
at about 5–15 tokens/s, which is too slow and too weak for coding help.
Selling useful capacity (Llama 3.3 70B, Qwen 2.5 Coder 32B) takes a GPU
machine with 24–80 GB of VRAM.
