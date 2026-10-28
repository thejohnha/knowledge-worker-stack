# Mattermost on your own Mac

A private chat server on your laptop, for one reason: so your agents can message you, and you can message the chief of staff, from the Mattermost app. It runs Mattermost Team Edition and PostgreSQL in Docker (through OrbStack), answers only on this Mac (`http://localhost:8065`), keeps its data in Docker volumes, and starts when you log in.

Read this first:
- **Your phone cannot reach it as installed.** It answers on this Mac only. A VPN such as Tailscale is the way to reach it from the phone (untested). Opening it to the Wi-Fi also works (below, untested), but then anyone on that network can take over your chief of staff.
- **Nothing works while the Mac sleeps.** Messages you send from the phone wait until it wakes.
- The server is not backed up unless you do it (below).

## 1. OrbStack
If you followed the [OrbStack browser guide](../../browser/orbstack/README.md), OrbStack is installed and its ports stay off your network. Otherwise:
```bash
brew install --cask orbstack
orbctl config set setup.use_admin false
orbctl config set docker.expose_ports_to_lan false # keep Docker's ports off your network
orbctl config set machines.expose_ports_to_lan false
orbctl config set docker.set_context false         # else it rewrites ~/.docker/config.json
orbctl config set app.start_at_login true          # so Mattermost comes back after a restart
orbctl stop; orbctl start
```
Point `docker` at OrbStack's own engine, for every shell and the agent:
```bash
grep -q 'orbstack/run/docker.sock' ~/.zshrc 2>/dev/null || cat >> ~/.zshrc <<'EOF'
# Docker: OrbStack's CLI and engine, without changing the default Docker context
export PATH="$HOME/.orbstack/bin:$PATH" DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
EOF
export PATH="$HOME/.orbstack/bin:$PATH" DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
docker version --format '{{.Server.Version}}'      # a version number, not an error
```
- With `set_context` off, OrbStack leaves the Docker context alone. `DOCKER_HOST` names OrbStack's engine directly, so nothing depends on which context is current, or on Docker Desktop also being installed.
- License: OrbStack is free for personal use; business use needs a paid plan (see the browser guide).

## 2. Start Mattermost
From this folder:
```bash
mkdir -p ~/mattermost && cp docker-compose.yml ~/mattermost/
[ -f ~/mattermost/.env ] || (umask 077; echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > ~/mattermost/.env)
docker compose -f ~/mattermost/docker-compose.yml up -d
until curl -fs http://localhost:8065/api/v4/system/ping >/dev/null; do sleep 5; done; echo up
```
- The database password is generated into `~/mattermost/.env` and never shown. Back up that file with the data.
- Images, pinned: `mattermost/mattermost-team-edition:11.7.14` (11.7 is Mattermost's Extended Support Release, supported to 2027-05-15) and `postgres:18.6-alpine`. Both tags were checked on Docker Hub in October 2026.
- Mattermost publishes amd64 images only. On an Apple silicon Mac OrbStack runs it through Rosetta: expect a slower first start.
- `restart: unless-stopped` plus OrbStack starting at login is what brings it back after a restart.

## 3. Your account and team (you, once)
1. Open http://localhost:8065 and create your account. The first account is the system admin.
2. Create a team. Its URL name (in `http://localhost:8065/<team>/…`) is your `MM_TEAM`.
3. Install the Mattermost app on the Mac or phone if you want one, and sign in to `http://localhost:8065` (phone: see below).

Then the agent writes the shared config (use your own username and team):
```bash
mkdir -p ~/.config/knowledge-worker-stack
cat > ~/.config/knowledge-worker-stack/mattermost.env <<'EOF'
MM_URL=http://localhost:8065
MM_TEAM=home
MM_USER=alice
MM_BOT=chief
EOF
```
- `MM_USER` is who the bot talks to: alerts and the chief of staff arrive as a direct message from the bot.
- Optional `MM_CHANNEL=<channel name>` sends alerts to that channel of `MM_TEAM` instead of the DM (add the bot to it).

## 4. The bot and its token
The bot is the account your agents post as. Its token goes straight into the [agent vault](../../vault/) as the entry `Mattermost bot` and is never shown.

Scripted, once the [comms scripts](../README.md#install) are in `~/bin`:
```bash
~/bin/claude_chief_of_staff_phone_bridge.py --setup # bot "chief", owned by you, in your team; token into the vault
~/bin/mattermost_post.py --check                  # token ok, and where alerts go
```
- `--setup` copies the vault to the temp folder first, then adds the entry; it prints only that the read-back matches, and deletes the copy when it does.
- It manages Mattermost with `mmctl --local` inside the container, which the compose file allows from inside the container only.

By hand instead: System Console > Integrations > Bot Accounts: on. Then Integrations > Bot Accounts > Add Bot Account, username `chief`, and copy the token it shows once. Put it in the vault without pasting it anywhere else:
```bash
~/bin/ask_secret.sh "Mattermost bot token (paste it)" | keepassxc-cli add -q --no-password \
  -k ~/.config/agent-vault/agent-vault.keyx -u chief --url http://localhost:8065 -p ~/agent-vault/agent-vault.kdbx 'Mattermost bot'
docker compose -f ~/mattermost/docker-compose.yml exec -T mattermost mmctl --local team users add home chief
```

A channel the comms manager should watch needs the bot in it:
```bash
docker compose -f ~/mattermost/docker-compose.yml exec -T mattermost mmctl --local channel users add home:town-square chief
```

## Reach it from your phone (untested)
**Recommended: a VPN such as Tailscale** on the Mac and the phone, with `tailscale serve` passing `localhost:8065` to your own devices over HTTPS; nothing else reaches it. Not tested here.

On the same Wi-Fi without a VPN, only if you accept this: the server then speaks plain HTTP to the whole network. Anyone on it can read your messages, pick up your sign-in, and text the chief of staff as you, which reaches every session it manages. Never on shared or public Wi-Fi; put TLS in front if you keep it.
```bash
orbctl config set docker.expose_ports_to_lan true; orbctl stop; orbctl start
sed -i '' 's/"127.0.0.1:8065:8065"/"8065:8065"/' ~/mattermost/docker-compose.yml
echo "MM_SITEURL=http://$(scutil --get LocalHostName).local:8065" >> ~/mattermost/.env
docker compose -f ~/mattermost/docker-compose.yml up -d
```
- In the phone app, the server is `http://<that name>.local:8065`.
- `docker.expose_ports_to_lan true` applies to every Docker container on the Mac, not just this one.

## Back up
```bash
cd ~/mattermost
docker compose exec -T postgres pg_dump -U mmuser mattermost > ~/mattermost-db-$(date +%Y%m%d).sql
docker run --rm -v mattermost_data:/d:ro -v ~/:/b alpine tar czf /b/mattermost-files-$(date +%Y%m%d).tgz -C /d .
```
- Keep these and `~/mattermost/.env` together. The data is in Docker volumes `mattermost_db`, `mattermost_data` and `mattermost_config`.

## Upgrade
Change the `mattermost-team-edition` tag in `~/mattermost/docker-compose.yml` to a newer release (stay on an Extended Support Release unless you want a feature), then:
```bash
docker compose -f ~/mattermost/docker-compose.yml up -d
```
- Back up first. Mattermost upgrades its database on start and cannot downgrade it.
- A PostgreSQL major upgrade (18 to 19) needs a dump and restore; a minor one (18.6 to 18.7) is a tag change.

## Remove it
```bash
docker compose -f ~/mattermost/docker-compose.yml down -v    # -v deletes every message and file: back up first
rm -r ~/mattermost ~/.config/knowledge-worker-stack/mattermost.env
```
- Delete the vault entry `Mattermost bot` in KeePassXC, and the two Docker lines in `~/.zshrc` if nothing else uses Docker.

## Known limits
- Up only while the Mac is awake and OrbStack is running.
- No email: Mattermost has no mail server here, so password resets and email notifications do not work. Push notifications to the phone need Mattermost's push proxy and a server the phone can reach; untested.
- One user and one bot are what this was built for.

Tested: `docker compose config` accepts the compose file, and both image tags exist on Docker Hub (the Mattermost tag's manifest lists linux/amd64 only). Not tested: starting it, the bot setup against it, Rosetta performance, and every phone path.
