---
title: "Deploying GeoIP blocking, CrowdSec, and IP block lists on OPNsense"
tags:
  - homelab
  - how-to
  - opnsense
  - firewall
  - crowdsec
modified: 2025-09-01
created: 2025-09-01
---

In my homelab, I expose some services to the Internet for use by family and friends. I've already spent a lot of time securing these services because I know the risks associated with exposing anything externally - but I wanted to do more.

I decided that I wanted a reliable, low maintenance way to block malicious inbound traffic using OPNsense (version 25.7.2). I ultimately landed on three controls:

- **Leverage OPNsense aliases to block all inbound traffic that is not initiated from within the United States.** GeoIP blocking is a low-hanging fruit. There is no reason for anyone to access my publicly-exposed resources from outside of the United States.
- **Implement [CrowdSec](https://www.crowdsec.net/) on OPNsense for curated, real-time threat intel.** Enables inbound and outbound traffic filtering based on reputation and behavior. 
- **Integrate other reputable, publicly available IP blocklists** to further enhance inbound traffic filtering.

---

## First, the truth about blocklists

I know what you're probably thinking - IP based blocks are not an effective way to secure the edge. And to an extent, you're right. If you implement these controls and think that your external services are "secure" because you're blocking the bad guys from reaching them, then I have a bridge to sell you.

> [!IMPORTANT] IP blocks ≠ comprehensive security
> These controls reduce opportunistic noise and stop some known bads. They do **not** fix vulnerable services, weak auth, or bad segmentation. Treat them as **defense-in-depth**, not a silver bullet.

IP blocking is a control best used in a larger defense-in-depth strategy. These techniques will reduce your external attack surface by making your services inaccessible to opportunistic attackers and threats that are already identified in CTI, but they are no replacement for properly hardening your edge.

The fewer things that you have exposed to the Internet, the better. Your first step in assessing your Internet facing attack surface should be reducing the number of things you have exposed. Assess each publicly exposed service and ask yourself:

- **"Does this really need this to be accessible to the Internet?"**
- **"Does this need to be accessible to the whole Internet, or can I restrict access to one public IP that I own?"**
- **"Can I put this behind VPN/Wireguard or a Cloudflare tunnel?"**

If you determine that you absolutely need a service exposed to the entire Internet, focus on the basics **before** you spend time on blocklists:

- **Patching** to resolve known vulnerabilities. An exploitable Internet-facing vulnerability is a fast track for an attacker to gain access to your internal network. Engineer a solution to automate patching external services if possible.
- **Configuration hardening** using established best practices for securing whatever service you are deploying. The [CIS Benchmarks](https://www.cisecurity.org/cis-benchmarks) are a great place to go for hardening guidance.
- **Segmentation** from the rest of your network to reduce blast radius in case of a compromise.
- **Monitoring** to detect suspicious behavior on the exposed service.

If you already have a handle on these concepts, layering IP-based blocklisting is a worthwhile defense-in-depth measure to further reduce your external attack surface.

---

## GeoIP blocking - low hanging fruit

I consider GeoIP blocking to be the simplest method for reducing a publicly exposed service's attack surface. All of my users are located in the U.S., so my services shouldn't be accessible anywhere outside of the U.S. This is a basic extension of least-privilege and a solid way to cut down on scanning and opportunistic attacks. 

> [!NOTE] Note about VPNs
> Attackers can use US-based VPNs to circumvent GeoIP based blocks. If you care about that, you can also look into blocking known VPN IP ranges, but that's a rapidly moving target and your hardening efforts are probably better spent elsewhere.   

It's possible to implement GeoIP blocks at multiple layers - at the router, the firewall, the reverse proxy, or at the host/application itself. In my case, I wanted to perform this filtering as far up the stack as possible, which meant deploying firewall rules in OPNsense.  

### Configuring MaxMind integration and OPNsense aliases

OPNsense has a native integration with [MaxMind](https://docs.opnsense.org/manual/how-tos/maxmind_geo_ip.html) that allows GeoIP data to be added to aliases, which are then leveraged for firewall block rules.

1. I followed the OPNsense documentation here to create a MaxMind account and generate a license key.
2. Added the license key to OPNsense at `Firewall -> Aliases -> GeoIP settings`.
3. Created a new alias called `usa_geoip` of type **GeoIP** and selected **United States, IPv4 + IPv6**

![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-17.png]]


> [!WARNING] Table size pressure
> If creating an alias with both IPv4 and IPv6 addresses, keep an eye on the Current Table Entries number in OPNsense. This GeoIP alias can get quite large, and may exhaust OPNsense's table entry limit. 

### Creating the WAN rule

Now that the alias was configured, I created a firewall rule on my WAN interface to block all inbound connections on any port/protocol if the source IP is NOT in the `usa_geoip` alias. I leveraged the **Source / Invert** option for this.

![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-1.png]]

It's important to place this rule above any NAT / port forwarding rules that are set up in the WAN interface, otherwise the non-US traffic will hit those rules first and be passed.

You can also achieve this by adding an inverted source IP match in each NAT rule, but I chose to implement it this way so I wouldn't need to remember to configure the block each time I created a new NAT rule.

I checked `Firewall -> Log Files -> Live View` and observed WAN traffic from Russia already getting blocked by the rule.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-2-1.png]]

With that, OPNsense was now blocking all inbound traffic sourced from outside of the U.S.  

---

## CrowdSec - the easy button for real-time threat intel

As the name suggests, CrowdSec is a crowdsourced threat intelligence provider. Enthusiasts and enterprises deploy [CrowdSec Security Engines](https://www.crowdsec.net/security-engine) to their assets which both ingest data from CrowdSec's threat intel and enforce remediation actions as well as send signals back to CrowdSec for analysis and further refinement of their blocklists.

CrowdSec's free tier is fairly limited in what blocklists you can apply, but is a good starting point for anyone who is just getting into leveraging threat intel. It's extremely easy to set up on most devices, including OPNsense.

The best blocklists are locked behind CrowdSec's [Platinum tier](https://www.crowdsec.net/pricing), which is targeted for businesses and costs **\$900/month per blocklist**. A less expensive [Enterprise Plan](https://www.crowdsec.net/pricing#saas-enterprise) is available for **\$30/month per enrolled Security Engine**, which grants access to the middle tier Premium blocklists.

For this write up, I'll be using the Free tier.

### Adding the CrowdSec plugin to OPNsense

To start using CrowdSec on OPnsense, the first step was to install the CrowdSec plugin. Luckily it is included in OPNsense's community plugin repository, so installing it was very simple. 

In OPNsense, I went to `System -> Firmware -> Plugins`. Enabled the "Show community plugins" option, searched for `os-crowdsec`, and installed it.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-3-1.png]]

It installed successfully and I saw the following message in the output:
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-4-1.png]]

Opened the `Services -> CrowdSec -> Settings` menu and clicked the checkboxes for:

- Enable Log Processor (IDS)
- Enable LAPI
- Enable Remediation Component

The Log Processor is responsible for performing the following actions as described by the [CrowdSec documentation](https://docs.crowdsec.net/docs/next/log_processor/intro/): 

- Read logs from [Data Sources](https://docs.crowdsec.net/docs/next/log_processor/data_sources/intro) in the form of Acquisitions.
- Parse the logs and extract relevant information using [Parsers](https://docs.crowdsec.net/docs/next/log_processor/parsers/intro).
- Enrich the parsed information with additional context such as GEOIP, ASN using [Enrichers](https://docs.crowdsec.net/docs/next/log_processor/parsers/enricher).
- Monitor the logs for patterns of interest known as [Scenarios](https://docs.crowdsec.net/docs/next/log_processor/scenarios/intro).
- Push alerts to the Local API (LAPI) for alert/decisions to be stored within the database.

After the [Local API ](https://docs.crowdsec.net/docs/local_api/intro/) receives the alerts from the Log Processor, Remediation Components will connect to the Local API to consume those alerts and take remediation action.

Next, I enrolled the CrowdSec plugin with my CrowdSec account by providing my enrollment key. The enrollment key can be retrieved from the CrowdSec console, under `Engines -> Enroll Command`.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-5-1.png]]

This is what my full settings page looks like. I also enabled logging for the block rules so that connections dropped by CrowdSec are logged by OPNsense.

![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-6-1.png]]

Clicked **Apply** to enable CrowdSec. Next, I went to the Engines page in the CrowdSec console to accept the pending enrollment.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-7-1.png]]

Back in OPNsense. I noticed that CrowdSec did a few things after enabling the plugin. It created four firewall rules in the **automatically generated rules** category which block inbound and outbound IPv4/6 traffic to IP addresses defined in `crowdsec_blocklists` and `crowdsec6_blocklists` aliases.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-8-1.png]]

These aliases are defined in `Firewall -> Aliases`. The `Loaded` column shows how many entries (IP addresses or ranges) are active in each blocklist.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-9-1.png]]

Because I enabled logging in the CrowdSec plugin configuration, I could see that some inbound traffic was already being dropped by the CrowdSec block rules.
![[Pasted image 20250901142726.png]]

### Subscribing to additional blocklists

I wanted to see what CrowdSec blocklists I was subscribed to by default and whether there were other relevant blocklists that I should add.

First I checked my OPNsense Engine in the CrowdSec console to see what blocklists were applied, and I saw that only one was active - `CrowdSec Community Blocklist (Lite)`. 
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-11-1.png]]

Accounts on the Free Tier of CrowdSec get access to three additional blocklists on top of the default `CrowdSec Community Blocklist (Lite)`. I browsed to [the catalogue of free CrowdSec blocklists](https://app.crowdsec.net/blocklists/search?pricingTiers=%5B%22free%22%5D) and chose the following to subscribe to:

[Free Proxies List](https://app.crowdsec.net/blocklists/65a567bdec04bcd4f51670bd) - a list of free web proxies. These services are wonderful tools for attackers because they provide a no-cost method of anonymization to use in attacks.

[Firehol greensnow.co List](https://app.crowdsec.net/blocklists/65a56c520469607d9badb817) - an IP list generated by identifying IP addresses on the Internet which are performing attacks or bruteforce related to "Scan Port, FTP, POP3, mod_security, IMAP, SMTP, SSH, cPanel, etc."

[OTX WebScanners List](https://app.crowdsec.net/blocklists/65a56c010469607d9badb80f) - a list of "web scanners" which are scanning publicly exposed hosts for specific filepaths. These types of requests are noisy and I would like to block them at the firewall to prevent them from being handed to my downstream services.

It can take up to two hours for the Security Engine to update the aliases with the new blocklists. To speed this up, I restarted the CrowdSec services on OPNsense using the `Services -> CrowdSec -> Settings` menu. After restarting the services, the `crowdsec_blocklist` alias was significantly larger, indicating that the blocklists were successfully applied.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-12-1.png]]

---

## Deploying web-based IP blocklists to fill in the gaps

As a final layer of IP blocklisting, I wanted to test out configuring a web-based IP blocklist within OPNsense. I poked around online and found [bitwire-it/blocklist](https://github.com/bitwire-it/ipblocklist). It's a frequently updated aggregated blocklist that pulls from numerous reputable blocklists, and is freely available on GitHub. 

### Increasing Maximum Firewall Table Entires

Before I could experiment with adding the bitwire-it blocklist, I needed to increase the number of firewall entries that OPNsense could handle. After creating the US GeoIP alias which added around ~500,000 entries against my 1,000,000 maximum, I was running pretty low on available entries.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-13-1.png]]

At the time of writing, the bitwire-ip blocklist has just over 1 million entries, so I would need to increase the maximum table entries by ~700,000 at a minimum. 

To do this, I went to `Firewall -> Settings -> Advanced` and found the `Firewall Maximum Table Entries` setting. Since my OPNsense was only running at around ~15% memory and ~10% CPU, I felt comfortable adding another 2,000,000 entries. I entered `3000000` in the field and then clicked **Save**.

### Creating an alias and firewall rules

In `Firewall -> Aliases`, I created a new alias for the blocklist with the following settings:

**Name**: `bitwire_ipblocklist`
**Type**: `URL Table (IPs)`
**Refresh Frequency**: `2 hours` (to align with the repository's update interval)
**Content**: `https://raw.githubusercontent.com/bitwire-it/ipblocklist/refs/heads/main/inbound.txt`
**Description**: `bitwire-it/blocklist`

After creating the alias, I immediately noticed that my table entry usage had increased dramatically as expected, because the bitwire blocklist is just over 1 million entries.
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-14-1.png]]

I created a new firewall rule on my WAN interface to block any incoming traffic from IPs defined in that alias. I placed this directly below my GeoIP rule that I created earlier. Here's what the rule looks like:
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-15-1.png]]

Checking the dashboard page in OPNsense, I confirmed that creating this rule which references the bitwire alias increased memory consumption by about 3%, or 241mb. For me, this isn't a problem at all since memory usage is only sitting at around 16%, but if you're pushing your OPNsense hardware closer to its limits, you may want to use caution here.

I confirmed that the block rule was working as expected by opening up the firewall logs Live View and filtering for traffic handled by the bitwire rule. I could already see some traffic being dropped because the source IP matched
![[Deploying GeoIP blocking, CrowdSec, and IP block lists to OPNsense-16.png]]

## Wrapping up

With that, I had configured three different IP-based controls to reduce my external attack surface. In the future, I will also create a write up about how I use Cloudflare to implement similar controls for services that are proxied through their CDN.

These low-cost, low-impact controls are effective at reducing noise and preventing opportunistic attackers from using well-known malicious IP addresses to recon and attack my externally exposed services, but they are no substitute for a **patched**, **segmented**, and **properly hardened** edge.
