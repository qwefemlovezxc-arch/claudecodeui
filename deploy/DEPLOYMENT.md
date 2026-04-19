# Deployment runbook

End-to-end steps for bringing up `claude.alskdjfh.xyz` on the home
cluster. Execute on the macbook unless a step explicitly says `server3`
or `homelab`.

All image names assume the fork's GHCR namespace
`ghcr.io/qwefemlovezxc-arch/`. Both images are built locally on server3
and imported into k3s containerd — no push required. The deployment
manifest pins `imagePullPolicy: Never` so kubelet never tries to fetch
from GHCR.

---

## 0. Prerequisites

- k3s cluster up, server3 healthy (`kubectl get nodes`)
- cert-manager installed, `letsencrypt-prod` ClusterIssuer available
- Traefik is the default ingress-controller
- `/Users/macbook/Documents/nl.conf` present (AmneziaWG config)
- `~/.config/slava/secrets.env` present (sanity check that the
  workspace is in the right state)

---

## 1. Build the two Docker images on server3

SSH into server3 (via the VPS reverse tunnel when Tailscale is down):

```bash
ssh server3-vps   # or just `ssh server3` if Tailscale is up
git clone git@github-qwefem:qwefemlovezxc-arch/claudecodeui.git
cd claudecodeui
git checkout feat/subprocess-sandbox
```

### 1a. Build the app image

```bash
sudo docker build \
  -t ghcr.io/qwefemlovezxc-arch/claudecodeui-sandbox:latest \
  -f Dockerfile \
  .

# Import into containerd. The `:latest` tag has to be removed first or
# k3s ctr import silently no-ops (known bug, documented in agents.md).
sudo k3s ctr images rm ghcr.io/qwefemlovezxc-arch/claudecodeui-sandbox:latest 2>/dev/null || true
sudo docker save ghcr.io/qwefemlovezxc-arch/claudecodeui-sandbox:latest \
  | sudo k3s ctr images import -
```

### 1b. Build the VPN sidecar image

```bash
sudo docker build \
  -t ghcr.io/qwefemlovezxc-arch/amneziawg-sidecar:latest \
  -f deploy/vpn-sidecar/Dockerfile \
  deploy/vpn-sidecar

sudo k3s ctr images rm ghcr.io/qwefemlovezxc-arch/amneziawg-sidecar:latest 2>/dev/null || true
sudo docker save ghcr.io/qwefemlovezxc-arch/amneziawg-sidecar:latest \
  | sudo k3s ctr images import -
```

Both images now live only in k3s containerd on server3. The deployment
YAML already sets `imagePullPolicy: Never` on both containers, so no
further patching is needed.

---

## 2. Namespace + secrets

### 2a. Create the namespace first (everything else lives inside it)

```bash
kubectl apply -f deploy/k3s/01-namespace.yaml
```

### 2b. JWT secret for the UI auth

```bash
cp deploy/k3s/03-secret.yaml.template deploy/k3s/03-secret.yaml
sed -i '' "s|REPLACE_WITH_openssl_rand_hex_32|$(openssl rand -hex 32)|" \
  deploy/k3s/03-secret.yaml
kubectl apply -f deploy/k3s/03-secret.yaml
```

(`deploy/k3s/03-secret.yaml` is gitignored; it stays on the macbook.)

### 2c. VPN config secret

Straight from nl.conf — no template edit needed:

```bash
kubectl -n claudecode create secret generic claudecode-vpn \
  --from-file=wg0.conf=/Users/macbook/Documents/nl.conf
```

### 2d. Backup SSH key + homelab-side rrsync

#### Generate the keypair on server3

```bash
ssh server3-vps '
  set -euo pipefail
  ssh-keygen -t ed25519 -N "" -f /tmp/claudecode-backup -C claudecode-backup
  cat /tmp/claudecode-backup.pub
'
```

Copy the printed public key (single `ssh-ed25519 AAAA… claudecode-backup`
line). You will paste it into `$PUBKEY` below — do **not** append the
raw key directly to authorized_keys, the forced-command wrapper is
mandatory for the rsync-only confinement.

#### Install rrsync on homelab (one-time)

`rrsync` ships with rsync but is not on PATH by default. The forced
command in authorized_keys references it.

```bash
ssh homelab '
  set -euo pipefail
  # Path to the bundled rrsync varies between distros; check both.
  SRC=$(ls /usr/share/doc/rsync/scripts/rrsync* /usr/share/doc/rsync/examples/rrsync* 2>/dev/null | head -1)
  [ -n "$SRC" ] || { echo "rrsync not bundled with rsync — install via apt"; exit 1; }
  case "$SRC" in
    *.gz) sudo gunzip -ck "$SRC" | sudo tee /usr/local/bin/rrsync >/dev/null ;;
    *)    sudo cp "$SRC" /usr/local/bin/rrsync ;;
  esac
  sudo chmod +x /usr/local/bin/rrsync
  /usr/local/bin/rrsync --help >/dev/null && echo "rrsync ready"
  mkdir -p /mnt/pv-hdd/backups/claudecode-workspace
'
```

#### Append the restricted line to homelab's authorized_keys

```bash
PUBKEY='<paste single-line pubkey from above>'
ssh homelab "echo 'command=\"/usr/local/bin/rrsync /mnt/pv-hdd/backups/claudecode-workspace\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding $PUBKEY' >> ~/.ssh/authorized_keys"
```

The `command=` directive locks this key to rrsync chrooted to the
backups base directory. The CronJob writes to per-run subdirs like
`${STAMP}/`; rrsync resolves them inside the base. Anything else
(interactive shell, scp outside the base, port-forwarding) is denied.

#### Add the homelab-side rotation cron

```bash
ssh homelab '
  set -euo pipefail
  echo "30 5 * * * find /mnt/pv-hdd/backups/claudecode-workspace -maxdepth 1 -mindepth 1 -type d -mtime +14 -exec rm -rf {} +" \
    | sudo tee /etc/cron.d/claudecode-backup-rotate >/dev/null
  sudo chmod 644 /etc/cron.d/claudecode-backup-rotate
'
```

This runs nightly at 05:30 UTC (two hours after the cluster Job at
03:30 UTC, plenty of slack). Why server-side: the SSH key in the pod
is rsync-only by design — running a shell pipeline from the pod would
either leak shell access (if we removed the forced command) or be
silently rewritten by it.

#### Bake the private key into the k8s Secret and shred locally

```bash
ssh server3-vps '
  set -euo pipefail
  KH="$(ssh-keyscan -t ed25519 192.168.100.200)"
  [ -n "$KH" ] || { echo "ssh-keyscan returned empty; aborting" >&2; exit 1; }
  kubectl create secret generic claudecode-backup-ssh \
    --namespace=claudecode \
    --from-file=id_ed25519=/tmp/claudecode-backup \
    --from-literal=known_hosts="$KH" \
  && shred -u /tmp/claudecode-backup /tmp/claudecode-backup.pub
'
```

Notes on this block:
- `set -euo pipefail` aborts the heredoc on any failure.
- `ssh-keyscan` runs **without** `2>/dev/null` so transient errors are
  visible, and the explicit emptiness check stops us from creating a
  Secret with empty `known_hosts` (which would fail the StrictHostKey
  check on every Job run).
- `shred` runs only when `kubectl create secret` succeeded (the `&&`).
  If anything fails, the private key on `/tmp/` is preserved so you
  can rerun without regenerating + re-appending to authorized_keys.

---

## 3. DNS record

Cloudflare dashboard → alskdjfh.xyz zone → Add record:

- Type: **A**
- Name: **claude**
- Content: **194.39.99.225**
- Proxy: **DNS only** (grey cloud) — mandatory per workspace rules
- TTL: Auto

Wait 30 seconds for propagation.

---

## 4. Apply the rest of the manifests

The namespace and three secrets are already in place from §2. Apply
everything else:

```bash
kubectl apply -f deploy/k3s/02-pvc.yaml
kubectl apply -f deploy/k3s/04-deployment.yaml
kubectl apply -f deploy/k3s/05-service.yaml
kubectl apply -f deploy/k3s/07-networkpolicy.yaml
kubectl apply -f deploy/k3s/08-ingress.yaml
kubectl apply -f deploy/k3s/09-backup.yaml
```

Watch the rollout:

```bash
kubectl -n claudecode get pods -w
kubectl -n claudecode logs deployment/claudecodeui -c vpn -f     # tunnel
kubectl -n claudecode logs deployment/claudecodeui -c app -f     # app
kubectl -n claudecode describe certificate claudecodeui-tls       # cert
```

The pod should go through:
1. `Init:0/1` — VPN sidecar starting up (waiting for wg0 handshake)
2. `Init:1/1` — VPN ready (app container starting)
3. `Running` — app serving on :3001, ready for HTTP

---

## 5. First-run login

Claude OAuth needs to happen **inside the pod** so the credentials land
in the PVC-backed `/home/claude/.claude` and survive pod restarts:

```bash
kubectl -n claudecode exec -it deployment/claudecodeui -c app -- claude login
# Follow the OAuth flow in a browser; paste back the code.
```

Bootstrap the UI admin user:

```bash
open https://claude.alskdjfh.xyz/
# Register the single allowed user. After this, further registration is
# blocked until the user is deleted from the SQLite db.
```

---

## 6. Smoke checks (Stage 10 E2E)

### From iPhone Safari

- [ ] `https://claude.alskdjfh.xyz/` loads
- [ ] TLS cert valid (Let's Encrypt, issued by R3/R10)
- [ ] Login succeeds
- [ ] File browser shows `/workspace/nastya/` and nothing outside
- [ ] Sending a prompt streams tokens back
- [ ] Token budget shows in bottom-right, decrements as you chat
- [ ] Permission mode badge cycles through default/acceptEdits/bypass/plan

### Sandbox enforcement

- [ ] Ask Claude to `Read /etc/passwd` → must fail
- [ ] Ask Claude to `cd /root` → must fail
- [ ] Ask Claude to `Bash rm -rf /` → contained inside /workspace/nastya
- [ ] File-create endpoint rejects paths with `..` in them

### Egress check

```bash
kubectl -n claudecode exec deployment/claudecodeui -c app -- \
  curl -s ifconfig.io
```

Expect the NL exit IP (verify with `curl ipinfo.io/<ip>`), **not**
194.39.99.225 (home RU IP) and **not** the Clouvider SpaceProxy IP.

### Backup check

- [ ] Trigger a Job ad-hoc to validate end-to-end without waiting:
  ```bash
  kubectl -n claudecode create job --from=cronjob/workspace-backup \
    backup-manual-$(date -u +%s)
  kubectl -n claudecode get jobs -w
  ```
- [ ] After completion, verify the snapshot landed on homelab:
  ```bash
  ssh homelab 'ls -lt /mnt/pv-hdd/backups/claudecode-workspace/ | head -5'
  ```

---

## 7. Known caveats

- k3s `:latest` + `ctr images import` does not overwrite; you must
  `ctr images rm` first (documented in agents.md).
- AmneziaWG sidecar burns ~3 minutes for `latest handshake` to show up
  under cold start — the startupProbe has 45s × 2s = 90s timeout; if
  your VPN endpoint is slow, increase `failureThreshold` in
  `04-deployment.yaml`.
- Claude OAuth token lives in `/home/claude/.claude/.credentials.json`,
  persisted on PVC. If the pod gets re-created with a fresh PVC you
  must re-run `claude login`.
- Home IP 194.39.99.225 is residential and could drop / change. If the
  domain stops resolving, check the static-IP assignment with the ISP
  (P.A.K.T LLC) before debugging cluster config.

---

## 8. Rollback

**Verify a recoverable backup exists before deleting anything.** The
nightly CronJob fires at 03:30 UTC; if the deploy happened more
recently than that, run a manual snapshot first:

```bash
kubectl -n claudecode create job --from=cronjob/workspace-backup \
  pre-rollback-$(date -u +%s)
kubectl -n claudecode wait --for=condition=complete \
  job/pre-rollback-<paste id> --timeout=10m
ssh homelab 'ls -lt /mnt/pv-hdd/backups/claudecode-workspace/ | head -3'
```

Only when you can see at least one snapshot directory:

```bash
kubectl delete namespace claudecode
# PVCs are deleted with the namespace; that is intentional. The latest
# snapshot on homelab is the only remaining copy of /workspace/nastya.
```

### Restore

The full restore is **not** just "PVCs + rsync back" — three secrets
were created imperatively in §2 and live nowhere in git, and the
backup private key was shredded after the Secret was sealed:

1. Recreate namespace + PVCs:
   ```bash
   kubectl apply -f deploy/k3s/01-namespace.yaml
   kubectl apply -f deploy/k3s/02-pvc.yaml
   ```
2. Re-create the JWT secret (§2b — same `openssl rand -hex 32` flow,
   gives a new value, all old UI sessions become invalid).
3. Re-create the VPN secret from `~/Documents/nl.conf` (§2c).
4. Re-do the backup keypair (§2d): generate a fresh ed25519 keypair on
   server3, append the new public half to homelab's `authorized_keys`
   (replacing the orphan from before deletion), and create the new
   `claudecode-backup-ssh` Secret.
5. Mount the workspace PVC into a one-shot pod and rsync the latest
   snapshot back:
   ```bash
   kubectl -n claudecode run restore --rm -it --restart=Never \
     --image=alpine:3.20 \
     --overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"server3"},"containers":[{"name":"restore","image":"alpine:3.20","command":["sh","-c","apk add --no-cache rsync openssh-client; sleep 3600"],"volumeMounts":[{"name":"ws","mountPath":"/workspace"}]}],"volumes":[{"name":"ws","persistentVolumeClaim":{"claimName":"claude-workspace"}}]}}'
   # In another terminal, exec in and run the rsync from homelab.
   ```
6. Apply the rest of the manifests as in §4.
7. Run `claude login` again (§5) — the OAuth state was on the PVC and
   wasn't part of the workspace backup.
