---
title: Redundant remote access with Tailscale subnet routers
description: Making remote access redundant by setting up a "HA pair" of Tailscale subnet routers
tags:
  - homelab
  - tailscale
  - networking
  - proxmox
created: 2025-09-27
modified:
---

I've used [Tailscale](https://tailscale.com/) for remote access to my homelab for some time now. Vanilla Wireguard works fine too, but I prefer Tailscale for its dead simple key management, access control, and QoL utilities that it provides on top of Wireguard.

As I was building out a network diagram of my homelab, I realized that only having one Tailscale subnet router was a pretty risky single point of failure. If my Tailscale LXC goes down, or the Proxmox host that it lives on fails, I would be locked out of my homelab. I currently live a few hours away from my lab, and it would be inconvenient to drive there to correct the issue.

I figured that setting up a second Tailscale subnet router on a different Proxmox node in my cluster would be sufficient redundancy for my use case. That way, my cluster can tolerate the failure of any one Proxmox host or one Tailscale LXC and still allow remote access.

Luckily, this type of high availability is [supported and documented by Tailscale](https://tailscale.com/kb/1115/high-availability#subnet-router-high-availability).

---

## Creating a Debian 13 LXC for Tailscale

I prefer to host most of my services (excluding my [[Deploying a Talos k8s cluster on Proxmox|Talos k8s cluster]]) in Debian LXCs. These are incredibly lightweight, don't have any bloat installed by default, and have a very small attack surface.

I logged into one of my Proxmox nodes and opened the local storage, which was pre-configured as a repository for container templates and downloaded the latest Debian 13 container image:

![[Redundant remote access with Tailscale subnet routers.png]]

Then, I created a new LXC called `tailscale03` with the following settings to mirror the existing Tailscale LXC:

- Template: `debian-13-standard_13.1-1_amd64.tar.zst`
- Storage: `rootfs`, size `8gb`
- Cores: `1`
- Memory: `512mb`
- Network interface: My server VLAN, address to be assigned via DHCP

### Granting the LXC access to /dev/tun

By default, unprivileged LXCs do not have access to the `/dev/tun` device, which Tailscale needs.

To address this, I simply dropped into a shell on my Proxmox node and added the following lines to the `/etc/pve/lxc/101.conf` file to grant the Tailscale LXC access to this device:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

More info here: [Tailscale in LXC containers](https://tailscale.com/kb/1130/lxc-unprivileged)

---

## Installing Tailscale

After creating the LXC and modifying its configuration file, I booted it up and ran `apt update && apt upgrade -y` to bring all installed packages up to date.

With the LXC provisioned and updated, it was time to install Tailscale. Luckily, Tailscale makes this extremely simple by providing a [nifty installation script](https://tailscale.com/install.sh) that does all the heavy lifting. I only had to fetch the script with `wget` and execute it with `sh`.

```shell
wget -qO - https://tailscale.com/install.sh | sh
```

After the installation finished, I ran `tailscale up`. Tailscale displayed a login link, which I opened with my browser and completed authentication in.

Now `tailscale03` was joined to my tailnet:
![[Redundant remote access with Tailscale subnet routers-1.png]]

---

## Configuring subnet router

The next step was to configure the Tailscale node as a subnet router, so that other devices on the tailnet can use it to access services on my network.

First, I enabled IP forwarding on the LXC:

```shell
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
```

Then I instructed the Tailscale client to advertise my network's route to the tailnet:

```shell
tailscale set --advertise-routes=10.10.0.0/16 
```

Before I activated the route, I made sure that the LXC had the appropriate network access to reach all of the systems in my lab. This was a simple solve with a firewall rule to allow `tailscale03` to access anything:
![[Redundant remote access with Tailscale subnet routers-3.png]]

I have granular access control policies set up through [Tailscale ACLs](https://tailscale.com/kb/1018/acls), so this isn't as bad as it looks. 

I also converted the LXC's dynamic DHCP lease to a static one so that it's IP won't change in the future, which would cause issues with this firewall rule. 

Then I logged into the Tailscale console and approved the advertised route:
![[Redundant remote access with Tailscale subnet routers-2.png]]

And with that, the new node was advertising its route. I tested this out by disabling the route on `tailscale02` and running a `tracert` to an internal host from my remote device.

```shell
C:\Users\garre>tracert pve-node01.<redacted>.<redacted>.<redacted>

Tracing route to pve-node01.<redacted>.<redacted>.<redacted> [10.10.153.11]
over a maximum of 30 hops:

  1    22 ms    24 ms    22 ms  tailscale03.tailaae1a.ts.net. [100.99.4.47]
  2    96 ms    22 ms    21 ms  10.10.100.1
  3    21 ms    21 ms    25 ms  10.10.153.11

Trace complete.
```

All done! Now I have two redundant Tailscale subnet routers which I can use to access all the services in my homelab. 

For more info on subnet router configuration, see the official docs here: [Subnet routers](https://tailscale.com/kb/1019/subnets)

