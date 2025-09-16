---
title: Automating internal certificate management with ACME DNS‑01 and Traefik
description: How I replaced Nginx Proxy Manager with Traefik as a load balancer/proxy and automated certificate management for internal services using ACME DNS‑01 (Cloudflare), split‑horizon DNS, and a Debian LXC—with notes on firewalling and resolver behavior.
tags:
- homelab
- traefik
- cloudflare
- acme
- automation
- opnsense
- proxmox
- networking
created: 2025-08-24
---

> **Context:** This write‑up is a record of how I implemented internal TLS automation in my homelab. It’s intentionally opinionated and focused on design choices and trade‑offs rather than a prescriptive “do X, then Y.”
>
> **Privacy note:** I use `<yourdomain.tld>` and `internal.<yourdomain.tld>` as placeholders.

---

## Goodbye Nginx Proxy Manager, hello Traefik

I had been running [Nginx Proxy Manager (NPM)](https://nginxproxymanager.com/) as my edge proxy for a while. It has an approachable UI and it's easy to get up and running, but I eventually wanted:

- Native load balancing and richer middleware/routing for apps.
- A single external load balancer that could front both Kubernetes and non‑Kubernetes services.
- A cleaner way to automate internal certificate issuance aligned with how I structure routes.

I switched to [Traefik](https://traefik.io/traefik) running outside the cluster. It’s lightweight, configuration‑driven, and plays nicely with ACME DNS‑01. Traefik became the front door for all services exposed on my LAN.

I also wanted to shift certificate issuance from my internal self-signed [step-ca](https://smallstep.com/docs/step-ca/) Certificate Authority to [Let's Encrypt](https://letsencrypt.org/) by leveraging the ACME protocol. This would bring even more benefits:

- No more manually importing a self-signed CA to new systems and containers. Let's Encrypt is a trusted Certificate Authority by default.
- Automated certificate issuance and renewal aligned with the current [cert expiration best practices](https://www.digicert.com/blog/tls-certificate-lifetimes-will-officially-reduce-to-47-days).
- No reliance on long-lived wildcard certificates, which I used as an easy button when I was first setting up my lab.

Overall, this setup feels much more "production" grade, and Traefik will pair nicely with my new Talos k8s cluster going forward.


---

## The platform I chose (and why)

I run Traefik in a Proxmox LXC based on Debian:

- Debian keeps the base system small and familiar, which reduces attack surface and makes patching predictable.
- The container is deliberately modest: **8 GB disk, 1 vCPU, 512 MB RAM**. This is fine for my current workload, but may need increased as I scale up and add new services. 
- Networking‑wise, I placed the LXC on **VLAN 103** (`10.10.103.0/24`) with a **DHCP reservation** at **`10.10.103.100`**. I prefer reservations so IP management is centralized at the DHCP server, rather than manually-configured static addresses scattered across hosts.

This LXC does one job: terminate TLS and reverse proxy to internal apps.

---

## DNS model: split‑horizon with delegated responsibility

I run an internal zone such as `internal.<yourdomain.tld>` (my actual domain omitted) on [Technitium DNS](https://technitium.com/dns/) for clients on the LAN. Public DNS for the parent `<yourdomain.tld>` lives in **Cloudflare**.

- **LAN clients** look up `*.internal.<yourdomain.tld>` in **Technitium**, which returns private addresses (e.g., the Traefik LXC at `10.10.103.100`).  
- **ACME validation** happens through **Cloudflare**: Traefik (via the lego client) uses the Cloudflare API to create ephemeral **`_acme-challenge` TXT** records when a certificate is requested or renewed. No internal services are exposed to the internet for this to work. This is called a [DNS-01 challenge](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge).

### Important nuance: certificates are per host, not wildcard

In this setup, Traefik issues **host‑specific** certificates 1:1 with the hostnames I define in my Traefik config (routers). That is intentional here. If I define a router for `app.internal.<yourdomain.tld>`, Traefik requests a cert **for that exact FQDN**. If I later add `app2.internal.<yourdomain.tld>`, it will obtain another cert for that FQDN on first use.

I originally expected to use a wildcard, but after inspecting the issued certs I confirmed Traefik was requesting **single‑host** certs based on the router rules - and I kept it that way. I like the blast‑radius isolation: revoking or rotating a cert impacts exactly one service.

---

## OPNsense firewall configuration

The Traefik LXC lives in a locked‑down VLAN with a default deny rule. Egress is extremely limited:

- **DNS to a recursive resolver** used by the ACME client checks:
  - UDP **53** → **1.1.1.1/32** (Cloudflare Resolver)
- **DNS to authoritative nameservers** when the client queries them directly:
  - UDP **53** → *an alias* `CloudflareNS_<yourdomain>` pointing at the NS set for my public zone
- **HTTPS to ACME + Cloudflare API**:
  - TCP **443** → `acme‑v02.api.letsencrypt.org`
  - TCP **443** → `api.cloudflare.com`
  - I accomplished this by simply allowing all outbound HTTP(S) traffic to non-RFC 1918 addresses. It would be nice to scope this access down to specific URLs, but I don't have a URL-aware method of performing traffic filtering at the firewall yet.

As I add services to be proxied by Traefik, additional rules will need to be created to allow Traefik to connect to the upstream services.

Everything else is blocked by default. I don’t currently accept inbound from WAN to the proxy; management comes from inside the LAN.

Screenshot from my ruleset (domain name redacted):

![[Automating internal TLS 1.png]]

**Why the authoritative‑NS alias?** In practice, I saw the ACME client attempt to query the **authoritative nameserver** directly during TXT validation. Those packets were initially blocked; allowing them (to the explicit NS set) removed issuance failures.

I created the alias in OPNsense to make it easier to maintain this rule. The IP addresses within the alias are hard-coded, so if Cloudflare makes an Infra change to their nameservers, I could run into issues. I'll circle back to this some day and do some more research on how best to automate this to gracefully handle any changes in Cloudflare's IP addressing.

---

## How I configured Traefik

I deployed Traefik with Docker inside the Debian LXC. I default to use LXCs over Virtual Machines because of how lightweight they are, and I generally prefer Docker over installing software directly on a host for its portability and ease of management.

My filesystem layout:

```
/opt/traefik/
├── docker-compose.yml
├── traefik.yml            # static config: entrypoints, providers, ACME
├── dynamic/               # file provider: routers/services by hostname
│   ├── k8s-nginx.yml
│   └── another-app.yml
└── acme.json              # cert store (0600); persists across restarts
```

### `traefik.yml` — static configuration

```yaml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure         # I always redirect HTTP → HTTPS at the edge
  websecure:
    address: ":443"

api:
  dashboard: true               # firewalled; I keep it on for quick checks

log:
  level: INFO                   # bump to DEBUG only when chasing ACME issues

providers:
  file:
    directory: /opt/traefik/dynamic
    watch: true                 # hot‑reload file changes

certificatesResolvers:
  cloudflare:
    acme:
      email: you@<yourdomain.tld>
      storage: /opt/traefik/acme.json
      # During initial bring‑up, I used staging to dodge rate limits:
      # caServer: https://acme-staging-v02.api.letsencrypt.org/directory
      dnsChallenge:
        provider: cloudflare
        # Pin resolvers so DNS propagation checks are deterministic
        resolvers:
          - "1.1.1.1:53"
```

**Why pin `resolvers`?** With strict egress, I don’t want the client choosing a resolver I haven’t allowed. Pinning to `1.1.1.1:53` kept the validation path crisp and made failures obvious if a rule was missing. 

### `docker-compose.yml` — token handling and mounts

```yaml
services:
  traefik:
    image: traefik:v3.5
    container_name: traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      # I pass tokens via env to keep them out of the config file
      - CF_DNS_API_TOKEN=$CF_DNS_API_TOKEN
      # Helpful when the client needs to read zone metadata
      - CF_ZONE_API_TOKEN=$CF_ZONE_API_TOKEN
    volumes:
      - /opt/traefik/traefik.yml:/traefik.yml:ro
      - /opt/traefik/dynamic:/opt/traefik/dynamic:ro
      - /opt/traefik/acme.json:/opt/traefik/acme.json
```

I keep a `.env` beside it (not in version control):

```
CF_DNS_API_TOKEN=…
CF_ZONE_API_TOKEN=…
```

**Cloudflare permissions that mattered:** granting **Zone:Read** alongside **DNS:Edit** to **All zones** in my domain was the key to fixing a “zone not found” error.

This was my first time creating a Cloudflare API token, but I was pleasently surprised with how easy the process was. Here are the steps I took:

1. Logged into [dash.cloudflare.com](dash.cloudflare.com) and went to Manage Account -> Account API tokens -> Create Token.
2. Created a new token using the "Edit zone DNS" template.
3. Added a permission to read Zones, and switched the Zone Resources to "All zones from an account" (needed because Cloudflare seems to treat subdomains as a separate zone).
4. I also chose to populate the Client IP Address Filtering field, so that my token can only be used from my static external IP address.

After that, Cloudflare spat out an API token which I securely saved in my password manager and entered into the `.env` file on my Traefik LXC.

### Dynamic routes

Here’s the file provider route that triggered my first cert issuance.

`/opt/traefik/dynamic/k8s-nginx.yml`
```yaml
http:
  routers:
    nginx_router:
      rule: Host(`nginx.internal.<yourdomain.tld>`)
      entryPoints: [websecure]
      tls:
        certResolver: cloudflare  # → ACME DNS‑01 via Cloudflare
      service: nginx_service

  services:
    nginx_service:
      loadBalancer:
        servers:
          # For the initial test, I pointed at a NodePort on a K8s node.
          # Use any stable internal endpoint reachable from the LXC.
          - url: "http://10.10.102.202:30080"
```

A second app simply means a second router/service file, which will obtain its own **per‑host** certificate on first use:

`/opt/traefik/dynamic/another-app.yml`
```yaml
http:
  routers:
    another_router:
      rule: Host(`another.internal.<yourdomain.tld>`)
      entryPoints: [websecure]
      tls:
        certResolver: cloudflare
      service: another_service

  services:
    another_service:
      loadBalancer:
        serversTransport: insecureSkipVerifyTransport
        servers:
          - url: "https://10.10.102.203:12345"

  serversTransports:
    insecureSkipVerifyTransport:
      insecureSkipVerify: true
```

**Why allow `insecureSkipVerify` here?** This isn't always needed. In my lab, I discovered that some internal apps ship with self‑signed certs that cannot be easily removed. If Traefik doesn't trust the certificate of the upstream service, it will refuse to connect.

I terminate TLS at Traefik with a browser‑trusted cert, then connect upstream with TLS but skip verification. For production internet‑facing apps I’d rather fix upstream trust or use mTLS; internally this lets me move fast while keeping the edge clean.

## Seeing the end result

Each proxied service required the following steps to be completed before it was usable:

1. Configure a router/service file.
2. Create a firewall rule in OPNsense to allow the Traefik to reach the upstream service.
3. Configure an A record in my internal DNS server so that when clients resolve the app's FQDN, they connect to Traefik.

After completing these steps, browsing to a proxied service displays a beautiful, trusted, and completely automated Let's Encrypt certificate.

![[Automating internal TLS 2.png]]

---

## Certificate behavior and renewal (mechanics I verified)

- **Issuance trigger:** Traefik requests a cert the **first time** a router with `tls.certResolver` sees a matching SNI (or at startup depending on config). The domain(s) are inferred from the router rule (e.g., `Host(...)`).  
- **Challenge flow:** Traefik (lego) adds a `_acme-challenge.<name>` TXT record via the Cloudflare API. I saw DNS queries to my recursive resolver *and* sometimes to the authoritative NSs - hence the firewall rules above.
- **Scope:** Each router’s FQDN becomes a separate certificate. Adding a new hostname creates a new 1:1 cert on demand.
- **Storage:** Certificates and account keys are persisted in `acme.json`. I back this up; losing it forces re‑issuance (rate limits!).
- **Renewal:** Traefik renews certificates 30 days before their expiration. This happens automatically, without any reconfiguration or manual effort needed. Huge win for security and convenience.

---

## The two fixes that unblocked issuance for me

I ran into this error early on when trying to issue my first certificate for a service on my internal subdomain:

```
acme: error presenting token: cloudflare: failed to find zone internal.<yourdomain.tld>.: zone could not be found
```

What worked immediately:

1. **Cloudflare token scope:** Add **Zone:Read** in addition to **DNS:Edit**. This let the client map `*.internal.<yourdomain.tld>` FQDNs to the correct parent zone for TXT placement.
2. **Pinned DNS resolvers:** Set `dnsChallenge.resolvers: ["1.1.1.1:53"]` so that ACME’s propagation checks use a resolver that my firewall explicitly allows.

After that, each new router/hostname acquired its own certificate on contact.

---

## Next steps

Next, I'll be moving over all of my existing NPM-proxied services to Traefik. That will include a couple of Internet-facing services which are on the parent domain. I might try to handle these through a conventional HTTP challenge, or maybe just stick to the DNS-01 challenge for consistency with the rest of my internal services.

After that, I want to explore how Traefik can integrate with Kubernetes to automate service discovery and configuration. This is one of the big reasons that I chose Traefik as my proxy/load balancer, and I'm excited to see how it handles my Kubernetes services.

---

## Appendix — Full configs as implemented

`/opt/traefik/traefik.yml`
```yaml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
  websecure:
    address: ":443"

api:
  dashboard: true

log:
  level: INFO

providers:
  file:
    directory: /opt/traefik/dynamic
    watch: true

certificatesResolvers:
  cloudflare:
    acme:
      email: you@<yourdomain.tld>
      storage: /opt/traefik/acme.json
      # caServer: https://acme-staging-v02.api.letsencrypt.org/directory
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - "1.1.1.1:53"
```

`/opt/traefik/docker-compose.yml`
```yaml
version: "3.8"
services:
  traefik:
    image: traefik:v3.5
    container_name: traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - CF_DNS_API_TOKEN=$CF_DNS_API_TOKEN
      - CF_ZONE_API_TOKEN=$CF_ZONE_API_TOKEN
    volumes:
      - /opt/traefik/traefik.yml:/traefik.yml:ro
      - /opt/traefik/dynamic:/opt/traefik/dynamic:ro
      - /opt/traefik/acme.json:/opt/traefik/acme.json
    command:
      - "--configFile=/traefik.yml"
```

`/opt/traefik/dynamic/k8s-nginx.yml`
```yaml
http:
  routers:
    nginx_router:
      rule: Host(`nginx.internal.<yourdomain.tld>`)
      entryPoints: [websecure]
      tls:
        certResolver: cloudflare
      service: nginx_service

  services:
    nginx_service:
      loadBalancer:
        servers:
          - url: "http://10.10.102.100:30080"
```

`/opt/traefik/dynamic/another-app.yml`
```yaml
http:
  routers:
    another_router:
      rule: Host(`another.internal.<yourdomain.tld>`)
      entryPoints: [websecure]
      tls:
        certResolver: cloudflare
      service: another_service

  services:
    another_service:
      loadBalancer:
        serversTransport: insecureSkipVerifyTransport
        servers:
          - url: "https://10.10.103.60:8443"

  serversTransports:
    insecureSkipVerifyTransport:
      insecureSkipVerify: true
```
