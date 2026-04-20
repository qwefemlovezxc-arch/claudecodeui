# syntax=docker/dockerfile:1.7
#
# AmneziaWG userspace sidecar — compiles amneziawg-go + amneziawg-tools
# from source and ships a slim Alpine runtime.
#
# Target pod runs this as a native k8s sidecar container (initContainer
# with restartPolicy: Always). It brings up wg0 inside the pod's network
# namespace and routes every packet from sibling containers through the
# tunnel. Requires CAP_NET_ADMIN.

# ─── Build amneziawg-go ─────────────────────────────────────────────────
FROM mirror.gcr.io/library/golang:1.24-alpine AS build-awg-go
RUN apk add --no-cache git make build-base linux-headers
WORKDIR /src
RUN git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-go.git . && \
    go build -v -ldflags="-s -w" -o amneziawg-go .


# ─── Build amneziawg-tools (awg, awg-quick) ─────────────────────────────
FROM mirror.gcr.io/library/alpine:3.20 AS build-awg-tools
RUN apk add --no-cache git make build-base linux-headers bash
WORKDIR /src
RUN git clone --depth 1 https://github.com/amnezia-vpn/amneziawg-tools.git . && \
    cd src && make


# ─── Runtime ────────────────────────────────────────────────────────────
FROM mirror.gcr.io/library/alpine:3.20
RUN apk add --no-cache iptables iproute2 bash ca-certificates tini

COPY --from=build-awg-go    /src/amneziawg-go          /usr/local/bin/amneziawg-go
# amneziawg-tools is a fork of wireguard-tools, so the compiled binary
# keeps the upstream name `wg`. Rename to `awg` at copy time so the
# entrypoint.sh / runbook references `awg setconf` etc. unchanged.
COPY --from=build-awg-tools /src/src/wg                /usr/local/bin/awg
COPY --from=build-awg-tools /src/src/wg-quick/linux.bash /usr/local/bin/awg-quick
RUN chmod +x /usr/local/bin/amneziawg-go /usr/local/bin/awg /usr/local/bin/awg-quick && \
    mkdir -p /etc/amneziawg

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
