---
title: "Deploying a Talos k8s cluster on Proxmox"
description: "I deployed a lightweight, declarative Talos cluster on Proxmox to cut down on OS management overhead. These are the steps I took and commands I used."
tags:
  - homelab
  - kubernetes
  - talos
  - proxmox
created: 2025-09-14
---

## Why Talos

I've been fascinated with Kubernetes for a few months now. My first foray into containerization was discovering Docker back in ~2018, and as my recent interest in highly available and scalable workloads grew, I decided to look into Kubernetes.

A year ago, I set up a single-node RKE2 cluster using Rancher on an Ubuntu host. I was happy with that for a while. It worked fine, but I wanted to learn a lighter, declarative approach that requires less focus on maintaining the base OS.

Enter [Talos](https://github.com/siderolabs/talos) , an immutable, minimal OS built specifically for Kubernetes and configured entirely via YAML, just like k8s itself. What drew me to Talos were the three main points defined in the project's `README`:

- **Security**: Talos reduces your attack surface: It's minimal, hardened, and immutable. All API access is secured with mutual TLS (mTLS) authentication.
- **Predictability**: Talos eliminates configuration drift, reduces unknown factors by employing immutable infrastructure ideology, and delivers atomic updates.
- **Evolvability**: Talos simplifies your architecture, increases your agility, and always delivers current stable Kubernetes and Linux versions.

After discovering Talos, I made the financially questionable decision to buy several used [HP EliteDesk 800 G5 SFF PCs](https://www.ebay.com/sch/i.html?_nkw=HP+EliteDesk+800+G5+SFF&_sacat=0&_from=R40&_trksid=p2553889.m570.l1313) (plus M.2 SSDs and additional memory) from eBay to use as Proxmox nodes, where I planned to virtualize my Talos clusters. 

This post describes how I built my first Talos cluster on Proxmox, written to document the steps I took and help others repeat the process.

---

## Final topology

- **Proxmox**: I'll be using 3 physical nodes joined in a non-HA PVE cluster, each hosting 1 control‑plane VM + 1 worker VM. This will allow the cluster (specifically `etcd`) to tolerate 1 PVE host failure, which is fine for my use case. Using 5 sets of control-plane and worker nodes would be ideal so that the cluster maintains quorum at up to 2 host failures, but I don't have the hardware for that right now.
- **Host naming**:
	- Control planes: `dev-talos-cp01`, `dev-talos-cp02`, `dev-talos-cp03`
	- Workers: `dev-talos-wk01`, `dev-talos-wk02`, `dev-talos-wk03`
- **Networking**: one /24 VLAN for control planes and workers. (`10.10.104.0/24`)
- **Addressing (DHCP reservations)**:
	- **Kubernetes API VIP**: `10.10.104.10` (outside DHCP range, same VLAN as control planes)
	- **Control planes**: `10.10.104.101–103`
	- **Workers**: `10.10.104.201–203`

---

## Workstation prep - installing `talosctl`, `kubectl`, and setting environment variables

I booted up my Debian Windows Subsystem for Linux environment and kicked this project off by installing Homebrew, a package manager which makes it easy to install `talosctl` and `kubectl`, two binaries that I will need to manage talos and k8s.

```bash
# Install Homebrew for Linux and add it to the shell environment
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

Then I set some environment variables to hold cluster IP addresses. This will make it easier to type out `talosctl` commands; `talosctl` often accepts an IP address as an argument to scope commands, and this way, I can pass short variable names instead of full IPs.

```bash
export CLUSTER=dev-talos
export VIP=10.10.104.10
export CP1=10.10.104.101
export CP2=10.10.104.102
export CP3=10.10.104.103
export WK1=10.10.104.201
export WK2=10.10.104.202
export WK3=10.10.104.203
```

---
## Downloading the Talos installation media

Grabbing an ISO file works a bit differently in Talos than it does in other Linux distributions. In Talos, because the OS is largely immutable and configured through YAML, adding packages after installation isn't supported. Instead, Sidero Labs makes an "[Image Factory](https://factory.talos.dev/)" available, where versions of the installation media with different system extensions and packages are available to download.

In my case, I chose to deploy Talos `1.11.1`, using the `amd64` machine architecture, with the following system extensions:

- `siderolabs/intel-ucode` - provides Intel microcode binaries, relevant for me because my Proxmox nodes are running Intel CPUs.
- `siderolabs/qemu-guest-agent` - provides the [QEMU Guest Agent](https://pve.proxmox.com/wiki/Qemu-guest-agent) service, which enables communication between the VM and hypervisor.
- `siderolabs/util-linux-tools` - prerequisite for Longhorn, which I plan to use later as a persistent storage provider.
- `siderolabs/iscsi-tools` - another prerequisite for Longhorn.

After making these selections, the Image Factory spat out an ISO download link that I used to load the installation media with my selected system extensions into Proxmox.

In my case, the full URL was `https://factory.talos.dev/image/cc493cae44e0bdbbefb5b5d1fb22ff724134cd7c6bb65172fa84e181568be45d/v1.11.1/metal-amd64.iso`.

I also copied down the installer image path for use in my talos machineconfig later: `factory.talos.dev/metal-installer/cc493cae44e0bdbbefb5b5d1fb22ff724134cd7c6bb65172fa84e181568be45d:v1.11.1`

![[Deploying a Talos k8s cluster on Proxmox.png]]

Now that the ISO file was available on Proxmox, I could proceed with creating the VMs and passing the ISO to them for installation.

---

## Creating the Proxmox VMs

In Proxmox, I created six VMs total: 3 control planes and 3 workers, spreading them across my three Proxmox hypervisors.

I followed the [Talos docs](https://www.talos.dev/v1.11/introduction/system-requirements/) for recommended resource allocations for each VM:
- **CPU**: 4 CPU for control planes; 2 CPU for workers; set CPU model to `host`.
- **RAM**: 4 GB for control planes, 4 GB for workers.
- **System**: Qemu Agent enabled
- **Disk**: 48 GB, VirtIO/SCSI.
- **Network**: VirtIO on my k8s VLAN (ID 104).
- **ISO**: Talos ISO downloaded in the last section.

I also tagged the VMs in Proxmox so that they're logically grouped together and easier to find.

![[Deploying a Talos k8s cluster on Proxmox-1.png]]

I booted the first control plane node and confirmed that it was offered the first available IP address in the DHCP range I had defined for the VLAN - `10.10.104.101`.

In this stage, Talos hasn't written anything to disk. It's ephemeral, meaning that if the node is powered down, all data is going to be wiped from it. It will stay in this state until  a Talos `machineconfig` is applied to the node.

![[Deploying a Talos k8s cluster on Proxmox-2.png]]

Before applying a `machineconfig` and "installing" Talos, I had to use `talosctl` to verify the ID of the disk that was attached to the VM. `talosctl` commands generally follow a predictable pattern: `talosctl <command> --nodes <ip address of node to run against>`. 

This is the command I ran to get the disk info and the output:

```bash
❯ talosctl get disks --insecure --nodes $CP1
NODE   NAMESPACE   TYPE   ID      VERSION   SIZE     READ ONLY   TRANSPORT   ROTATIONAL   WWID   MODEL           SERIAL
       runtime     Disk   loop0   2         4.1 kB   true                                                        
       runtime     Disk   loop1   2         57 kB    true                                                        
       runtime     Disk   loop2   2         696 kB   true                                                        
       runtime     Disk   loop3   2         475 kB   true                                                        
       runtime     Disk   loop4   2         4.1 kB   true                                                        
       runtime     Disk   loop5   2         73 MB    true                                                        
       runtime     Disk   sda     2         52 GB    false       virtio      true                QEMU HARDDISK   
       runtime     Disk   sr0     2         351 MB   false       ata                             QEMU DVD-ROM    QEMU_DVD-ROM_QM00003
```

`sda` is labeled as a `QEMU HARDDISK` and has 52 GB of available space. This is the virtual hard drive that I want to install Talos to - I made a note of that for later. `sr0` is the Talos ISO file that I mounted.

> [!CAUTION] Understanding the --insecure flag
> Since the Node is in maintenance mode, meaning that no configuration has been provided yet, we'll also pass the `--insecure` flag to the command. When the `--insecure` flag is passed, the `talosctl` client and the Talos node **do not** verify each other's identities. Anyone with network access to the node can freely manipulate it.
> 
> For this reason, it's smart to provision Talos nodes in a locked down VLAN with strict inbound filtering. 

> [!NOTE] DHCP reservations
> At this point, I also made a static DHCP reservation for the first control plane node. As I brought more nodes online, I created additional reservations. I wanted to be in control of when a node's IP address changes, and in my case the best way to do that was by assigning static DHCP reservations.
> 
> Along with defining a reserved IP for each node, I defined a hostname for each. 

![[Deploying a Talos k8s cluster on Proxmox-6.png]]

---

## Generating base Talos configs

Next, I used `talosctl gen config` to generate the base cluster configuration files for the nodes, as well as the `talosconfig` file which is used by `talosctl` to authenticate to the cluster.

This step creates the initial cluster configuration and sets the Kubernetes API endpoint to the VIP.

```bash
❯ talosctl gen config $CLUSTER https://$VIP:6443 --install-disk /dev/sda --install-image "factory.talos.dev/metal-installer/cc493cae44e0bdbbefb5b5d1fb22ff724134cd7c6bb65172fa84e181568be45d:v1.11.1"
generating PKI and tokens
Created /home/garrettlaman/k8s/clusters/dev-talos/controlplane.yaml
Created /home/garrettlaman/k8s/clusters/dev-talos/worker.yaml
Created /home/garrettlaman/k8s/clusters/dev-talos/talosconfig
```

This created:
- `controlplane.yaml` and `worker.yaml`: template machine configs (OS + Kubernetes).
- `talosconfig`: credentials and context for `talosctl`.

---

## Patches: DHCP and VIP

Created two small patches to apply to the generated templates - one to enable DHCP and VIP functionality on the Control Plane nodes, and one to enable DHCP on the Worker nodes.

Patches are a way that you can modify a `machineconfig` file without completely rewriting it. Check out the Talos documentation for more info on how these work: [Configuration Patches](https://www.talos.dev/v1.11/talos-guides/configuration/patching/)
**`patch-common-cp.yaml`** — control‑plane network (DHCP) + VIP + install disk
```yaml
machine:
  network:
    interfaces:
      - deviceSelector:
          physical: true
        dhcp: true
        vip:
          ip: 10.10.104.10
```

**`patch-common-wk.yaml`** — worker network (DHCP), **NO VIP**
```yaml
machine:
  network:
    interfaces:
      - deviceSelector:
          physical: true
        dhcp: true
```

I applied the patches to the generated `controlplane.yaml` and `worker.yaml` files to create base configs for each type of node:
```bash
❯ talosctl machineconfig patch controlplane.yaml --patch @patch-common-cp.yaml -o controlplane.common.yaml
❯ talosctl machineconfig patch worker.yaml --patch @patch-common-wk.yaml -o worker.common.yaml
```

The file structure now looked like this:
```shell
../dev-talos/
├── controlplane.common.yaml  # Control Plane machineconfig file with patch applied
├── controlplane.yaml         # original Control Plane machineconfig from talosctl gen config
├── patch-common-cp.yaml      # DHCP + VIP configuration patch for CP nodes
├── patch-common-wk.yaml      # DHCP configuration patch for Worker nodes
├── talosconfig               # contains authentication data (certificate for mTLS)
├── worker.common.yaml        # Control Plane machineconfig file with patch applied
└── worker.yaml               # original Worker machineconfig from talosctl gen config
```

---

## Installing & bootstrapping Control Plane nodes

Next, I moved the `talosconfig` file to the directory that `talosctl` expects to see it at. This is more of a convienence thing so that I don't have to specify the config file location in each command.

```shell
mkdir -p ~/.talos
cp talosconfig ~/.talos/config
```

### 1) Install CP01 and bootstrap etcd

From CP1’s maintenance mode:
```bash
❯ talosctl apply-config --insecure --nodes $CP1 --file controlplane.common.yaml
```

I dropped into a console session on `dev-talos-cp01` and noticed that the Stage had changed to "Installing", and the cluster name was now present.

![[Deploying a Talos k8s cluster on Proxmox-3.png]]

After a few seconds, the VM rebooted and started nagging me about bootstrapping `etcd`, so I did that:
```bash
# Set Talos API endpoints. Should be node IPs (not the VIP)
# These commands will write to ~/.talos/config
talosctl config endpoint $CP1
talosctl config node $CP1

# Initialize etcd once
talosctl bootstrap

# Retrieve kubeconfig that talks to the VIP
talosctl kubeconfig .

# Copy kubeconfig to directory where kubectl expects it by default
mkdir -p ~/.kube
cp kubeconfig ~/.kube/config
```

After running `talosctl bootstrap`, `dev-talos-cp01` looked like this:
![[Deploying a Talos k8s cluster on Proxmox-4.png]]

I ran a health check to verify that the first control plane node was healthy:
```shell
❯ talosctl --nodes $CP1 health
discovered nodes: ["10.10.104.10"]
waiting for etcd to be healthy: ...
waiting for etcd to be healthy: OK
waiting for etcd members to be consistent across nodes: ...
waiting for etcd members to be consistent across nodes: OK
...
```

### 2) Install CP02 and CP03

Now that I had the first Control Plane node successfully bootstrapped, it was time to join the other two CP nodes to the cluster:
```bash
❯ talosctl apply-config --insecure --nodes $CP2 --file controlplane.common.yaml
❯ talosctl apply-config --insecure --nodes $CP3 --file controlplane.common.yaml

# Add all CP endpoints for convenience
❯ talosctl config endpoint $CP1,$CP2,$CP3
```

Then I verified that all control plane nodes were joined to the cluster:
```bash
❯ kubectl get nodes
NAME             STATUS   ROLES           AGE     VERSION
dev-talos-cp01   Ready    control-plane   5m56s   v1.33.3
dev-talos-cp02   Ready    control-plane   112s    v1.33.3
dev-talos-cp03   Ready    control-plane   2m19s   v1.33.3

❯ talosctl etcd members
NODE            ID                 HOSTNAME         PEER URLS                    CLIENT URLS                  LEARNER
10.10.104.101   447d4be9d5e7e836   dev-talos-cp02   https://10.10.104.102:2380   https://10.10.104.102:2379   false
10.10.104.101   58a1eea8ea159a06   dev-talos-cp01   https://10.10.104.101:2380   https://10.10.104.101:2379   false
10.10.104.101   9652b8b193878fe2   dev-talos-cp03   https://10.10.104.103:2380   https://10.10.104.103:2379   false
```

---

## Adding Workers

Next, I joined the worker nodes to the cluster. I booted each worker VM into maintenance mode and applied its per‑node file:
```bash
❯ talosctl apply-config --insecure --nodes $WK1 --file worker.common.yaml
❯ talosctl apply-config --insecure --nodes $WK2 --file dev-talos-wk02.yaml
❯ talosctl apply-config --insecure --nodes $WK3 --file dev-talos-wk03.yaml
```

Used `kubectl` to check that all six nodes were present and healthy:
```bash
❯ kubectl get nodes
NAME             STATUS   ROLES           AGE     VERSION
dev-talos-cp01   Ready    control-plane   11m     v1.33.3
dev-talos-cp02   Ready    control-plane   7m43s   v1.33.3
dev-talos-cp03   Ready    control-plane   8m10s   v1.33.3
dev-talos-wk01   Ready    <none>          49s     v1.33.3
dev-talos-wk02   Ready    <none>          3m4s    v1.33.3
dev-talos-wk03   Ready    <none>          69s     v1.33.3
```

---

## Command summary

```bash
# Install Homebrew for Linux and add it to the shell environment
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo >> ~/.bashrc
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

# Install toolchain used by some brew formulas
sudo apt install build-essential -y

# Install Talos and k8s CLI tools
brew install siderolabs/tap/talosctl
brew install kubectl

# Generate Talos configs with VIP
talosctl gen config $CLUSTER https://$VIP:6443 --install-disk /dev/sda --install-image "factory.talos.dev/metal-installer/cc493cae44e0bdbbefb5b5d1fb22ff724134cd7c6bb65172fa84e181568be45d:v1.11.1"

# Build common files
talosctl machineconfig patch controlplane.yaml --patch @patch-common-cp.yaml -o controlplane.common.yaml
talosctl machineconfig patch worker.yaml --patch @patch-common-wk.yaml -o worker.common.yaml

# Move talos config file to its expected directory
mkdir -p ~/.talos
cp talosconfig ~/.talos/config

# Install Talos to disk & bootstrap etcd on first CP node
talosctl apply-config --insecure --nodes $CP1 --file controlplane.common.yaml
talosctl config endpoint $CP1
talosctl config node $CP1
talosctl bootstrap
talosctl kubeconfig .

# Add remaining CPs and workers
talosctl apply-config --insecure --nodes $CP2 --file controlplane.common.yaml
talosctl apply-config --insecure --nodes $CP3 --file controlplane.common.yaml
talosctl config endpoint $CP1,$CP2,$CP3

talosctl apply-config --insecure --nodes $WK1 --file worker.common.yaml
talosctl apply-config --insecure --nodes $WK2 --file worker.common.yaml
talosctl apply-config --insecure --nodes $WK3 --file worker.common.yaml

# Verify
kubectl get nodes -o wide
talosctl --nodes $CP1 members.etcd
```

---

## Closing

This was a fun first step into Talos, and I look forward to building out the cluster further as I learn more about k8s and GitOps. My short list of future projects include:

- Learn about distributed Persistent Volumes by deploying [Longhorn](https://longhorn.io/).
- Deploy [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) to monitor cluster health and performance.
- Dive into cluster network security by implementing [cilium](https://cilium.io/).

As a follow up to this manual deployment process, I also want to learn how to use [Terraform](https://developer.hashicorp.com/terraform) to automate the deployment of additional Talos clusters in as few manual steps as possible.