# claudecodeui — k3s deployment

Manifests for deploying the subprocess-patched claudecodeui on the home
k3s cluster (server3 master). Applied in numerical order.

## Order of apply

```
kubectl apply -f deploy/k3s/01-namespace.yaml
# fill in real values in 03-secret.yaml (see template), then:
kubectl apply -f deploy/k3s/03-secret.yaml
kubectl apply -f deploy/k3s/02-pvc.yaml
kubectl apply -f deploy/k3s/04-deployment.yaml
kubectl apply -f deploy/k3s/05-service.yaml
kubectl apply -f deploy/k3s/07-networkpolicy.yaml
# Stage 7 adds 06-vpn.yaml (AmneziaWG sidecar)
# Stage 8 adds 08-ingress.yaml (claude.alskdjfh.xyz + cert-manager)
# Stage 9 adds 09-backup.yaml (daily rsync CronJob)
```

## Invariants

- `WORKSPACES_ROOT=/workspace/nastya` — claude CLI and all file APIs are
  clamped inside this tree (see sandbox patch in Stage 4). Do not change
  this env without also updating the PVC mount path.
- Single replica, `Recreate` strategy — PVCs are RWO local-path and we
  never want two writers.
- Pinned to `server3` via nodeSelector — that's where local-path volumes
  live and where ~420Gi free disk is available.
- Non-root user uid 1000, all caps dropped. VPN sidecar (Stage 7) runs
  separately with `NET_ADMIN` for the WG interface.
