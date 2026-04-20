#!/bin/sh
# AmneziaWG userspace tunnel — manual setup, no awg-quick.
#
# awg-quick wants policy-based routing (fwmark tables) and ip6tables
# rules, both of which are rejected inside a k8s pod without extra
# capabilities / sysctls. For a single-tunnel "route everything via wg0"
# case we don't need any of that — a plain default route on the main
# table works.

set -eu

log() { echo "[vpn] $*" >&2; }

CONFIG_PATH="${AWG_CONFIG_PATH:-/etc/amneziawg/wg0.conf}"
IFACE="${AWG_INTERFACE:-wg0}"

if [ ! -f "$CONFIG_PATH" ]; then
    log "config not found at $CONFIG_PATH"
    exit 1
fi

# Ensure /dev/net/tun exists — amneziawg-go needs it
if [ ! -c /dev/net/tun ]; then
    mkdir -p /dev/net
    mknod /dev/net/tun c 10 200
    chmod 600 /dev/net/tun
fi

# Parse what we need from the config
ADDRESS="$(awk -F'[ =]+' '/^Address/ {print $2; exit}' "$CONFIG_PATH")"
ENDPOINT_IP="$(awk -F'[ =]+' '/^Endpoint/ {split($2, a, ":"); print a[1]; exit}' "$CONFIG_PATH")"

if [ -z "$ADDRESS" ] || [ -z "$ENDPOINT_IP" ]; then
    log "config missing Address or Endpoint"
    exit 1
fi

# Original gateway (needed to keep a direct path to the VPN peer)
ORIG_GW="$(ip route show default | awk '/default/ {print $3; exit}')"
ORIG_DEV="$(ip route show default | awk '/default/ {print $5; exit}')"
log "original gateway: $ORIG_GW dev $ORIG_DEV"
log "endpoint: $ENDPOINT_IP, tunnel address: $ADDRESS"

# Pin the peer IP via the original gateway BEFORE we swap the default
# route, otherwise the handshake packets would try to route through wg0
# (which doesn't exist yet) and hang.
ip route replace "$ENDPOINT_IP/32" via "$ORIG_GW" dev "$ORIG_DEV"

# Boot the userspace daemon. This creates the wg0 TUN interface.
/usr/local/bin/amneziawg-go -f "$IFACE" &
AWG_PID=$!

trap 'log "shutting down"; kill "$AWG_PID" 2>/dev/null || true; wait "$AWG_PID" 2>/dev/null || true; exit 0' TERM INT

# Wait up to ~10s for the interface to appear
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    ip link show "$IFACE" >/dev/null 2>&1 && break
    sleep 0.5
done
if ! ip link show "$IFACE" >/dev/null 2>&1; then
    log "interface $IFACE never appeared"
    exit 1
fi

# Apply the AmneziaWG config (handshake obfuscation fields included).
# `awg setconf` consumes the stripped config; we filter DNS= and Address=
# which are interface-level directives awg doesn't understand.
STRIPPED="$(mktemp)"
awk '
    /^\[Interface\]/  {in_iface=1; print; next}
    /^\[Peer\]/       {in_iface=0; print; next}
    in_iface && /^(Address|DNS|MTU|Table|PreUp|PostUp|PreDown|PostDown|SaveConfig)/ {next}
    {print}
' "$CONFIG_PATH" > "$STRIPPED"
awg setconf "$IFACE" "$STRIPPED"
rm -f "$STRIPPED"

# Bring the interface up with its tunnel address.
ip address add "$ADDRESS" dev "$IFACE"
ip link set "$IFACE" up mtu 1280

# Swap the pod's default route to wg0. Kernel already has the /32 pin
# to the endpoint so outer packets still exit via eth0.
ip route del default 2>/dev/null || true
ip route replace default dev "$IFACE"

log "tunnel up:"
awg show "$IFACE" 2>&1 | sed 's/^/[vpn]   /' >&2
ip route show | sed 's/^/[vpn]   route /' >&2

# Hold the process for the pod lifetime.
wait "$AWG_PID"
