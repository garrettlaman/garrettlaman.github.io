---
title: "Learning Talos: Building a 3‑Control‑Plane / 3‑Worker Kubernetes Cluster on Proxmox (VIP + PTP)"
description: "I moved from Rancher-managed clusters to a lightweight, declarative Talos build to avoid OS management overhead. This linear guide covers a 3‑control‑plane/3‑worker cluster on Proxmox using DHCP reservations, a floating VIP (control planes only), PTP time sync, persistent talosctl config, and clear host naming. Intel iGPU passthrough is planned as a follow‑up."
tags: ["homelab", "kubernetes", "talos", "proxmox", "ptp", "vip", "gitops", "workers", "control-plane", "dns-dhcp"]
created: 2025-08-24
draft: true
---

## Why Talos for This Build

I’ve previously deployed Kubernetes with **Rancher** on general‑purpose Linux. It worked, but I wanted to learn a **lighter, declarative** approach that doesn’t require maintaining the base OS (e.g., with Ansible). **Talos** is an immutable, minimal OS built specifically for Kubernetes and configured entirely via YAML. This post is a **linear guide** to the cluster I built with Talos on Proxmox, written to help others repeat the process and to showcase my approach for potential employers.

> **Availability target:** with three control planes, the cluster tolerates **one** host failure (etcd majority = 2/3). The VIP keeps the API stable across control‑plane failover.

---

## Final Topology (What We’re Building)

- **Proxmox**: 3 physical nodes (PVE cluster), each hosting **1 control‑plane VM** + **1 worker VM**.
- **Networking**: one L2/VLAN for control planes and workers.
- **Host naming**:
  - Control planes: `talos-cp01`, `talos-cp02`, `talos-cp03`
  - Workers: `talos-wk01`, `talos-wk02`, `talos-wk03`
- **Addressing (DHCP reservations)**:
  - **Kubernetes API VIP**: `10.10.102.10` (outside DHCP range, same L2 as control planes)
  - Control planes: `10.10.102.101–103`
  - Workers: `10.10.102.201–203`
- **Time Sync**: **PTP** from hypervisor (`/dev/ptp0`) on **all** nodes (control plane + workers). No public NTP.
- **Future plan**: Intel **iGPU passthrough** to **workers** (not control planes) for Jellyfin and other GPU workloads.

---

## Workstation: Tools and Environment

```bash
# Install Homebrew for Linux and add it to your shell environment
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo >> ~/.bashrc
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

# Toolchain used by some brew formulas
sudo apt install build-essential -y

# CLI tools
brew install siderolabs/tap/talosctl
brew install kubectl
```

I use the following variables throughout:

```bash
export CLUSTER=talos
export VIP=10.10.102.10
export CP1=10.10.102.101
export CP2=10.10.102.102
export CP3=10.10.102.103
# worker examples if you want shortcuts:
export W1=10.10.102.201
export W2=10.10.102.202
export W3=10.10.102.203
```

> **Why set variables?** It keeps commands readable and reduces copy/paste mistakes. Use your own values if they differ.

---

## Proxmox VMs (One CP + One Worker per Host)

Create six VMs total—**3 control planes** and **3 workers**—spreading them across the three Proxmox hosts.

**Settings I use (per VM)**
- **CPU**: 2–4 vCPU for control planes; 4–8 vCPU for workers (depending on workloads); CPU model **host**.
- **RAM**: 4–8 GiB (CP), 8–16 GiB (worker), tune to your hardware.
- **Disk**: 20–40 GiB, VirtIO/SCSI.
- **Network**: VirtIO on the target bridge/VLAN.
- **Firmware**: UEFI (**OVMF**), machine type **q35**.
- **ISO**: Talos installer ISO (optionally include QEMU Guest Agent in the image).

Boot the first **control plane (CP1)** ISO into **Talos maintenance mode** and note its DHCP address.

Confirm the target install disk (Talos installs onto a **whole** disk):
```bash
talosctl get disks --insecure --nodes $CP1
# choose the correct disk (e.g., /dev/sda)
```

> Use **DHCP reservations** (e.g., Technitium DNS + DHCP) so each VM always receives the same address and hostname.

---

## Generate Base Talos Configs

This step creates initial, cluster‑scoped configuration and sets the Kubernetes API endpoint to the **VIP**.

```bash
talosctl gen config $CLUSTER https://$VIP:6443 --output-dir _out
```

What’s created:
- `_out/controlplane.yaml` and `_out/worker.yaml`: template machine configs (OS + Kubernetes).
- `_out/talosconfig`: credentials and context for `talosctl`.
- A kubeconfig embedded with the **VIP** so `kubectl` always hits the floating API endpoint.

---

## Patches: Common Settings + PTP

Create **two small patches** to apply to the generated templates.

**`patch-common-cp.yaml`** — control‑plane network (DHCP) + VIP + install disk
```yaml
machine:
  install:
    disk: /dev/sda
  network:
    interfaces:
      - deviceSelector:
          physical: true
        dhcp: true
        vip:
          ip: 10.10.102.10   # VIP is valid on CONTROL PLANES ONLY
```

**`patch-common-wk.yaml`** — worker network (DHCP), **NO VIP**
```yaml
machine:
  install:
    disk: /dev/sda
  network:
    interfaces:
      - deviceSelector:
          physical: true
        dhcp: true
```

> If you mistakenly include a VIP on a worker, Talos will error:  
> **“virtual (shared) IP is not allowed on non-controlplane nodes”**. Remove the VIP stanza from worker configs.

**`ptp.yaml`** — use hypervisor PTP for time sync (both CP and worker)
```yaml
machine:
  time:
    servers:
      - /dev/ptp0
```

Build reusable **common** files:
```bash
talosctl machineconfig patch _out/controlplane.yaml   --patch @patch-common-cp.yaml   --patch @ptp.yaml   -o _out/controlplane.common.yaml

talosctl machineconfig patch _out/worker.yaml   --patch @patch-common-wk.yaml   --patch @ptp.yaml   -o _out/worker.common.yaml
```

Why patches?
- They’re **declarative** and composable—easy to audit and reuse.
- Adding new settings later is as simple as adding another patch.

---

## Hostnames (Per‑Node)

Use small per‑node patches so node names are stable even if you recreate a VM.

**Control planes**
```bash
cat > cp1-hostname.yaml <<'YAML'
machine:
  network:
    hostname: talos-cp01
YAML

cat > cp2-hostname.yaml <<'YAML'
machine:
  network:
    hostname: talos-cp02
YAML

cat > cp3-hostname.yaml <<'YAML'
machine:
  network:
    hostname: talos-cp03
YAML
```

**Workers**
```bash
cat > wk1-hostname.yaml <<'YAML'
machine:
  network:
    hostname: talos-wk01
YAML

cat > wk2-hostname.yaml <<'YAML'
machine:
  network:
    hostname: talos-wk02
YAML

cat > wk3-hostname.yaml <<'YAML'
machine:
  network:
    hostname: talos-wk03
YAML
```

Create final per‑node files by layering hostname onto the common files:

```bash
talosctl machineconfig patch _out/controlplane.common.yaml --patch @cp1-hostname.yaml -o _out/cp1.yaml
talosctl machineconfig patch _out/controlplane.common.yaml --patch @cp2-hostname.yaml -o _out/cp2.yaml
talosctl machineconfig patch _out/controlplane.common.yaml --patch @cp3-hostname.yaml -o _out/cp3.yaml

talosctl machineconfig patch _out/worker.common.yaml --patch @wk1-hostname.yaml -o _out/wk1.yaml
talosctl machineconfig patch _out/worker.common.yaml --patch @wk2-hostname.yaml -o _out/wk2.yaml
talosctl machineconfig patch _out/worker.common.yaml --patch @wk3-hostname.yaml -o _out/wk3.yaml
```

---

## Install & Bootstrap (Control Planes)

### 1) Install CP1 and bootstrap etcd

From CP1’s maintenance mode:

```bash
talosctl apply-config --insecure --nodes $CP1 --file _out/cp1.yaml
```

Make `talosctl` persistent and bootstrap:

```bash
mkdir -p ~/.talos
cp _out/talosconfig ~/.talos/config

# Talos API endpoints should be node IPs (not the VIP)
talosctl config endpoint $CP1
talosctl config node $CP1

# Initialize etcd once
talosctl bootstrap

# Retrieve kubeconfig that talks to the VIP
talosctl kubeconfig .
export KUBECONFIG=$(pwd)/kubeconfig
```

### 2) Install CP2 and CP3

```bash
talosctl apply-config --insecure --nodes $CP2 --file _out/cp2.yaml
talosctl apply-config --insecure --nodes $CP3 --file _out/cp3.yaml

# Add all CP endpoints for convenience
talosctl config endpoint $CP1,$CP2,$CP3
```

Verify that all control plane nodes are joined to the cluster:

```bash
kubectl get nodes -o wide
talosctl etcd members
```

---

## Add Workers

Boot each worker VM into maintenance mode and apply its per‑node file:

```bash
talosctl apply-config --insecure --nodes $W1 --file _out/wk1.yaml
talosctl apply-config --insecure --nodes $W2 --file _out/wk2.yaml
talosctl apply-config --insecure --nodes $W3 --file _out/wk3.yaml
```

Check that all six nodes are present and Ready:

```bash
kubectl get nodes -o wide
```

### Confirm PTP on all nodes

```bash
talosctl ls /sys/class/ptp/ --nodes $CP1,$CP2,$CP3,$W1,$W2,$W3
talosctl read /sys/class/ptp/ptp0/clock_name --nodes $CP1,$CP2,$CP3,$W1,$W2,$W3  # expect "KVM virtual PTP"
talosctl get timestatus --nodes $CP1,$CP2,$CP3,$W1,$W2,$W3
```

---

## VIP vs `talosctl` Endpoints (Important)

- `kubectl` uses the **VIP** (`https://10.10.102.10:6443`) so API access continues through a single host loss.
- `talosctl` uses **node IPs** (e.g., CP1/2/3 addresses) because the VIP is available only when etcd and the API are healthy.

This separation makes bootstrap and failure modes predictable.

---

## Common Pitfalls (and Fixes)

- **Workers with VIP configured** → Talos fails with: *“virtual (shared) IP is not allowed on non-controlplane nodes”*.
  **Fix:** remove the VIP stanza from worker configs and rebuild `worker.common.yaml` / per‑worker files.

- **Using `@-` with `talosctl patch`** → error: *“open -: no such file or directory”*.
  **Fix:** pass a file path: `--patch @ptp.yaml`.

- **Endpoints mis-set** → *“produced zero addresses”* if you set endpoints with empty variables.
  **Fix:** set a single known IP, then add more:  
  `talosctl config endpoint $CP1` → later `talosctl config endpoint $CP1,$CP2,$CP3`.

---

## Next Steps

- **Intel iGPU passthrough** to the **worker** VMs and Intel’s Kubernetes device plugin for Jellyfin transcoding (follow‑up post).
- **GitOps + security**: Argo CD/Fleet, Pod Security Standards (Restricted), NetworkPolicies, image signing/verification.
- **Topology spreading**: label workers with `topology.kubernetes.io/zone` (e.g., `pve-a/b/c`) and add `topologySpreadConstraints` to your apps.

---

## Quick Command Summary

```bash
# Generate configs with VIP
talosctl gen config $CLUSTER https://$VIP:6443 --output-dir _out

# Build common files
talosctl machineconfig patch _out/controlplane.yaml --patch @patch-common-cp.yaml --patch @ptp.yaml -o _out/controlplane.common.yaml
talosctl machineconfig patch _out/worker.yaml       --patch @patch-common-wk.yaml --patch @ptp.yaml -o _out/worker.common.yaml

# Add hostnames (produce per-node files)
talosctl machineconfig patch _out/controlplane.common.yaml --patch @cp1-hostname.yaml -o _out/cp1.yaml
talosctl machineconfig patch _out/controlplane.common.yaml --patch @cp2-hostname.yaml -o _out/cp2.yaml
talosctl machineconfig patch _out/controlplane.common.yaml --patch @cp3-hostname.yaml -o _out/cp3.yaml
talosctl machineconfig patch _out/worker.common.yaml       --patch @wk1-hostname.yaml -o _out/wk1.yaml
talosctl machineconfig patch _out/worker.common.yaml       --patch @wk2-hostname.yaml -o _out/wk2.yaml
talosctl machineconfig patch _out/worker.common.yaml       --patch @wk3-hostname.yaml -o _out/wk3.yaml

# Install & bootstrap
talosctl apply-config --insecure --nodes $CP1 --file _out/cp1.yaml
mkdir -p ~/.talos && cp _out/talosconfig ~/.talos/config
talosctl config endpoint $CP1 && talosctl config node $CP1
talosctl bootstrap && talosctl kubeconfig .

# Add remaining CPs and workers
talosctl apply-config --insecure --nodes $CP2 --file _out/cp2.yaml
talosctl apply-config --insecure --nodes $CP3 --file _out/cp3.yaml
talosctl config endpoint $CP1,$CP2,$CP3

talosctl apply-config --insecure --nodes $W1 --file _out/wk1.yaml
talosctl apply-config --insecure --nodes $W2 --file _out/wk2.yaml
talosctl apply-config --insecure --nodes $W3 --file _out/wk3.yaml

# Verify
kubectl get nodes -o wide
talosctl get members.etcd
```

---

## Closing

This project let me learn a **declarative**, **immutable** Kubernetes deployment without OS management overhead, while keeping a production‑style separation of control planes and workers. The VIP and PTP choices keep things reliable; DHCP reservations and hostname patches make it repeatable. Next up: iGPU passthrough on the workers and a GitOps/security baseline to round out the platform.
