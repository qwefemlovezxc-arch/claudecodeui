# Deployment runbook

End-to-end steps for bringing up `claude.alskdjfh.xyz` on the home
cluster. Execute on the macbook unless a step explicitly says `server3`
or `homelab`.

All image names assume the fork's GHCR namespace
`ghcr.io/qwefemlovezxc-arch/`. Both images are built locally on server3
and imported into k3s containerd — no push required.

---

## 0. Prerequisites

- k3s cluster up, server3 healthy (`kubectl get nodes`)
- cert-manager installed, `letsencrypt-prod` ClusterIssuer available
- Traefik is the default ingress-controller
- `/Users/macbook/Documents/nl.conf` present (AmneziaWG config)
- `~/.config/slava/secrets.env` present (not used here, just a sanity
  check that the workspace is in the right state)

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

# Import into containerd — `:latest` tag needs to be removed first
# or k3s will ignore the new image (known bug, see agents.md).
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
has `imagePullPolicy: Always`, which is wrong for local-only images —
patch it **or** switch to `Never` after import:

```bash
kubectl -n claudecode patch deployment claudecodeui --type=json \
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"},
       {"op":"replace","path":"/spec/template/spec/initContainers/0/imagePullPolicy","value":"Never"}]'
```

---

## 2. Prepare secrets

### 2a. JWT secret for the UI auth

```bash
cp deploy/k3s/03-secret.yaml.template deploy/k3s/03-secret.yaml
sed -i '' "s|REPLACE_WITH_openssl_rand_hex_32|$(openssl rand -hex 32)|" \
  deploy/k3s/03-secret.yaml
```

(Leave `deploy/k3s/03-secret.yaml` on the macbook; it's gitignored.)

### 2b. VPN config secret

Straight from nl.conf — no template edit needed:

```bash
kubectl -n claudecode create secret generic claudecode-vpn \
  --from-file=wg0.conf=/Users/macbook/Documents/nl.conf
```

### 2c. Backup SSH key (run on server3)

```bash
ssh server3-vps '
  ssh-keygen -t ed25519 -N "" -f /tmp/claudecode-backup -C claudecode-backup
  cat /tmp/claudecode-backup.pub
'
```

Copy the printed public key. Append it to homelab's authorized_keys
with an rsync-only forced command:

```bash
ssh homelab "echo '<paste>' >> ~/.ssh/authorized_keys"
# Or edit manually to add: command=\"rsync --server -vlogDtprz --delete . /mnt/pv-hdd/backups/claudecode-workspace/\",no-pty ...
```

Make sure `/mnt/pv-hdd/backups/claudecode-workspace/` exists on homelab:

```bash
ssh homelab 'mkdir -p /mnt/pv-hdd/backups/claudecode-workspace'
```

Back on server3, turn the private key into a k8s secret and wipe it:

```bash
ssh server3-vps '
  kubectl create secret generic claudecode-backup-ssh \
    --namespace=claudecode \
    --from-file=id_ed25519=/tmp/claudecode-backup \
    --from-literal=known_hosts="$(ssh-keyscan -t ed25519 192.168.100.200 2>/dev/null)"
  shred -u /tmp/claudecode-backup /tmp/claudecode-backup.pub
'
```

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

## 4. Apply manifests

```bash
kubectl apply -f deploy/k3s/01-namespace.yaml
kubectl apply -f deploy/k3s/02-pvc.yaml
kubectl apply -f deploy/k3s/03-secret.yaml            # JWT
# claudecode-vpn and claudecode-backup-ssh already applied above
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

- [ ] From the pod, confirm outbound IP is NL:
  ```bash
  kubectl -n claudecode exec deployment/claudecodeui -c app -- \
    sh -c "apt-get update >/dev/null 2>&1 && apt-get install -y curl >/dev/null; curl -s ifconfig.io"
  ```
  Should return the NL exit IP (check via `whois` or `ipinfo.io/<ip>`),
  not 194.39.99.225 (home RU IP) and not the Clouvider SpaceProxy IP.

### Backup check

- [ ] After 24h (or trigger manually), verify snapshot on homelab:
  ```bash
  ssh homelab 'ls -lt /mnt/pv-hdd/backups/claudecode-workspace/ | head -5'
  ```
- [ ] Run a Job ad-hoc to validate without waiting:
  ```bash
  kubectl -n claudecode create job --from=cronjob/workspace-backup \
    backup-manual-$(date -u +%s)
  ```

---

## 7. Known caveats

- `imagePullPolicy: Always` in the YAML vs local-only images — see
  step 1. If pods CrashLoopBackOff with `ErrImagePull`, this is why.
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

```bash
kubectl delete namespace claudecode
# PVCs are deleted too — that is intentional; the daily backup on homelab
# has the workspace snapshot.
# To restore, re-create namespace + PVCs + rsync the latest snapshot
# back into /workspace before starting the deployment.
```
