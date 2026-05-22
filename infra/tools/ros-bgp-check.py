#!/usr/bin/env python3
"""Read-only BGP/route check against the Mikrotik gateway via the RouterOS
binary API (port 8728). Credentials come from the environment — never hardcode:

    ROS_HOST=185.213.250.89 ROS_USER=asbr-read ROS_PASS=... \
        python3 infra/tools/ros-bgp-check.py [extra-dst ...]

Prints the gateway↔node BGP sessions and, for each customer /32 (or any extra
dst-address args), which node Mikrotik routes it to + whether it's active. Use
it to confirm dynamic routing after an IP move (gateway should flip between the
WG node 185.213.250.90 and the OVPN node .91, never an internal 10.x next-hop).
"""
import os
import socket
import sys

HOST = os.environ.get("ROS_HOST", "185.213.250.89")
PORT = int(os.environ.get("ROS_PORT", "8728"))
USER = os.environ.get("ROS_USER", "")
PW = os.environ.get("ROS_PASS", "")
DSTS = sys.argv[1:] or ["104.238.11.1/32", "104.238.11.0/32"]


def enc_len(l):
    if l < 0x80:
        return bytes([l])
    if l < 0x4000:
        l |= 0x8000
        return bytes([(l >> 8) & 0xFF, l & 0xFF])
    if l < 0x200000:
        l |= 0xC00000
        return bytes([(l >> 16) & 0xFF, (l >> 8) & 0xFF, l & 0xFF])
    if l < 0x10000000:
        l |= 0xE0000000
        return bytes([(l >> 24) & 0xFF, (l >> 16) & 0xFF, (l >> 8) & 0xFF, l & 0xFF])
    return bytes([0xF0, (l >> 24) & 0xFF, (l >> 16) & 0xFF, (l >> 8) & 0xFF, l & 0xFF])


def recvall(s, n):
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise EOFError("connection closed (source IP allowed on the API service?)")
        b += c
    return b


def read_len(s):
    c = recvall(s, 1)[0]
    if c & 0x80 == 0:
        return c
    if c & 0xC0 == 0x80:
        return ((c & ~0xC0) << 8) + recvall(s, 1)[0]
    if c & 0xE0 == 0xC0:
        n = (c & ~0xE0) << 16
        n += recvall(s, 1)[0] << 8
        n += recvall(s, 1)[0]
        return n
    if c & 0xF0 == 0xE0:
        n = (c & ~0xF0) << 24
        for _ in range(3):
            n = (n << 8) + recvall(s, 1)[0]
        return n
    n = 0
    for _ in range(4):
        n = (n << 8) + recvall(s, 1)[0]
    return n


def send(s, *ws):
    for x in ws:
        b = x.encode()
        s.sendall(enc_len(len(b)) + b)
    s.sendall(b"\x00")


def read_sent(s):
    out = []
    while True:
        l = read_len(s)
        if l == 0:
            break
        out.append(recvall(s, l).decode("utf-8", "replace"))
    return out


def cmd(s, *ws):
    send(s, *ws)
    res = []
    while True:
        st = read_sent(s)
        if not st:
            break
        res.append(st)
        if st[0] in ("!done", "!trap", "!fatal"):
            break
    return res


def kv(st):
    return {x.split("=", 2)[1]: x.split("=", 2)[2] for x in st[1:] if x.startswith("=")}


def main():
    if not USER or not PW:
        sys.exit("set ROS_USER and ROS_PASS in the environment")
    s = socket.create_connection((HOST, PORT), timeout=12)
    if cmd(s, "/login", "=name=" + USER, "=password=" + PW)[-1][0] != "!done":
        sys.exit("login failed")
    print("== BGP sessions ==")
    for st in cmd(s, "/routing/bgp/session/print"):
        if st[0] == "!re":
            d = kv(st)
            print(
                "  %-16s remote.as=%-8s established=%-6s %s"
                % (d.get("name", "?"), d.get("remote.as", "?"),
                   d.get("established", "?"), d.get("remote.address", ""))
            )
    print("== routes ==")
    for ip in DSTS:
        res = cmd(s, "/ip/route/print", "?dst-address=" + ip,
                  "=.proplist=dst-address,gateway,active,distance,bgp")
        hits = [kv(st) for st in res if st[0] == "!re"]
        if not hits:
            print("  %s -> (no route)" % ip)
        for d in hits:
            print("  %s -> gw=%s active=%s distance=%s bgp=%s"
                  % (ip, d.get("gateway", "?"), d.get("active", "?"),
                     d.get("distance", "?"), d.get("bgp", "?")))
    s.close()


if __name__ == "__main__":
    main()
