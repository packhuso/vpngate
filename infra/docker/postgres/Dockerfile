# VPN Hub — PostgreSQL 16 + pgBackRest (design Section 4.5 / 12.1)
FROM postgres:16

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/*

# Repo + log + spool dirs (repo is a bind mount at runtime)
RUN install -d -o postgres -g postgres -m 750 \
      /var/lib/pgbackrest \
      /var/log/pgbackrest \
      /var/spool/pgbackrest
