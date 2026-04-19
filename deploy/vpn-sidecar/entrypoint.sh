#!/bin/sh
# AmneziaWG userspace tunnel entrypoint.
#
# Flow:
#   1. Remember the pod's original default gateway — we still need it to
#      reach the VPN peer itself.
#   2. Pin a /32 route to the VPN endpoint via that gateway so the tunnel
#      handshake does not recurse into its own tunnel.
#   3. Start amneziawg-go, which creates the wg0 TUN device.
#   4. Push the AmneziaWG config (Jc/Jmin/Jmax/S1/S2/H1…H4/I1 fields) via
#      `awg setconf` — plain `wg` refuses these obfuscation fields.
#   5. Swap the pod's default route to wg0.
#   6. Stay in the foreground so k8s sees a live sidecar.

set -eu

log() { echo "[vpn] $*" >&2; }

CONFIG_PATH="${AWG_CONFIG_PATH:-/etc/amneziawg/wg0.conf}"
IFACE="${AWG_INTERFACE:-wg0}"

if [ ! -f "$CONFIG_PATH" ]; then
    log "config not found at $CONFIG_PATH"
    exit 1
fi

ORIG_GW="$(ip route show default | awk '/default/ {print $3; exit}')"
ORIG_DEV="$(ip route show default | awk '/default/ {print $5; exit}')"
log "original gateway: $ORIG_GW dev $ORIG_DEV"

ENDPOINT_IP="$(awk -F'[ =]+' '/^Endpoint/ {split($2, a, ":"); print a[1]; exit}' "$CONFIG_PATH")"
if [ -z "$ENDPOINT_IP" ]; then
    log "no Endpoint in config"
    exit 1
fi
log "endpoint: $ENDPOINT_IP"

# Pin route to the VPN peer through the pod's original gateway so the
# handshake packets have somewhere to go before wg0 exists.
ip route add "$ENDPOINT_IP/32" via "$ORIG_GW" dev "$ORIG_DEV" 2>/dev/null || true

# amneziawg-go refuses to run without /dev/net/tun
if [ ! -c /dev/net/tun ]; then
    mkdir -p /dev/net
    mknod /dev/net/tun c 10 200
    chmod 600 /dev/net/tun
fi

# Background the userspace VPN daemon; it creates the TUN interface.
/usr/local/bin/amneziawg-go -f "$IFACE" &
AWG_PID=$!

trap 'log "shutting down"; kill "$AWG_PID" 2>/dev/null || true; wait "$AWG_PID" 2>/dev/null || true; exit 0' TERM INT

# Wait for interface to appear (amneziawg-go is slow to fork on cold start)
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    ip link show "$IFACE" >/dev/null 2>&1 && break
    sleep 0.5
done
if ! ip link show "$IFACE" >/dev/null 2>&1; then
    log "interface $IFACE never appeared"
    kill "$AWG_PID" 2>/dev/null || true
    exit 1
fi

# Apply wg config (awg understands AmneziaWG obfuscation fields)
awg setconf "$IFACE" "$(awg-quick strip "$CONFIG_PATH")"

# Set the local address (Address = line in the config)
ADDRESS="$(awk -F'[ =]+' '/^Address/ {print $2; exit}' "$CONFIG_PATH")"
if [ -n "$ADDRESS" ]; then
    ip address add "$ADDRESS" dev "$IFACE"
fi
ip link set "$IFACE" up mtu 1280

# Swap default route so every sibling container egresses through wg0
ip route del default 2>/dev/null || true
ip route add default dev "$IFACE"

log "tunnel up. default route now via $IFACE"

# Stay alive as long as amneziawg-go is alive
wait "$AWG_PID"
