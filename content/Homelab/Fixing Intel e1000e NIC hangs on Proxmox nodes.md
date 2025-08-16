---
title: "Fixing Intel e1000e NIC hangs on Proxmox nodes"
description: "How I diagnosed recurring network drops on my Proxmox node caused by Intel e1000e hardware hangs, and built a script to permanently disable problematic NIC offloads."
tags:
  - homelab
  - proxmox
  - networking
  - troubleshooting
  - automation
created: 2025-08-16
modified: 2025-08-16
---


While running my Proxmox 9 cluster, I ran into an issue where one of my nodes would randomly drop off the network. The host wouldn’t respond to pings, SSH, or the web UI, and I had to go out-of-band to see what was going on. After digging into the logs, I found repeated errors from the Intel `e1000e` driver:

```
e1000e 0000:00:1f.6 eno1: Detected Hardware Unit Hang:
    TDH                  <85>
    TDT                  <c9>
    next_to_use          <c9>
    next_to_clean        <84>
    ...
```

---

## Understanding the issue

This is a well-known problem with Intel’s I21x NICs (e.g., I219-LM/V) under Linux because they use the **`e1000e`** driver, which has long-standing TX-path quirks on some SKUs. The “Detected Hardware Unit Hang” string isn’t generic—it’s emitted directly by `e1000e` when the driver detects a transmit ring stall and prints the TX head/tail and related registers before resetting the adapter ([driver source showing the exact log path](https://android.googlesource.com/kernel/common/%2B/a7827a2a60218b25f222b54f77ed38f57aebe08b/drivers/net/ethernet/intel/e1000e/netdev.c#63-72)). Intel documents that **I217/I218/I219** are handled by `e1000e` ([Intel support note](https://www.intel.com/content/www/us/en/support/articles/000005480/ethernet-products.html)).

Multiple reports (and a proposed upstream change) tie these hangs specifically to **TSO (TCP Segmentation Offload)** on certain I219 devices. A 2019 patch submission titled *“e1000e: Work around hardware unit hang by disabling TSO”* includes syslog extracts of the exact hang and states “**Disabling TSO seems to be the only way to work around this problem**,” with Intel acknowledging it as an **“old known HW bug”** and recommending `ethtool -K <iface> tso off` as a workaround ([patch & maintainer discussion](https://patchwork.ozlabs.org/comment/2175801/)). The kernel’s own changelog also shows targeted mitigations on I219—e.g., **disabling TSO on i219-LM to restore throughput** after a regression ([Linux 6.2.13 changelog entry](https://www.kernel.org/pub/linux/kernel/v6.x/ChangeLog-6.2.13)).

In the field, you’ll see the same signatures across distros and appliances: Ubuntu’s tracker has an **I219-V** bug about link drops with `e1000e` ([Launchpad #1785171](https://bugs.launchpad.net/bugs/1785171)), and Proxmox threads document that **disabling TSO/GSO/GRO** stops the hangs on affected hosts ([Proxmox staff guidance](https://forum.proxmox.com/threads/e1000e-0000-00-19-0-eth0-detected-hardware-unit-hang.74275/)). Community troubleshooting also points to **power-saving interactions** as aggravating factors on some systems—users report fewer hangs after turning off PCIe **ASPM** and **EEE** for `e1000e` ([Arch forum example](https://bbs.archlinux.org/viewtopic.php?id=280098))—but the clearest, vendor-acknowledged mitigation remains **turning off TSO** on the NIC.


---

## Troubleshooting steps

To understand what was happening, I went through several steps:

1. **Checked system logs**  
   Used `journalctl -xe` and `dmesg -T` to confirm the kernel was reporting NIC hangs and resets.

2. **Reviewed Proxmox networking**  
   Verified that my `vmbr0` bridge was configured correctly and that nothing in Proxmox itself was restarting the interface.

3. **Correlated with driver issues**  
   The error string matches known `e1000e` issues related to offloading and power management on Intel NICs.

---

## Temporary fix: disable offloading with `ethtool`

Many reports suggested that disabling packet offloading features can prevent these hangs. I tested this by running:

```bash
ethtool -K eno1 gso off gro off tso off tx off rx off rxvlan off txvlan off
```

After this, the interface remained stable. Disabling these features shifts work from the NIC back to the CPU, but at gigabit speeds on a modern CPU (in my case, an i5-9500) the performance impact is negligible for my homelab's workload.

---

## Making it permanent with a script

Manually running `ethtool` after every reboot isn’t practical. To automate the fix, I worked with ChatGPT to build a script that:

- Checks current offload status before and after changes
- Disables all toggleable offloads at runtime if needed
- Installs a systemd unit to re-apply the settings automatically at boot
- Skips unnecessary work if everything is already configured

You can find the script on my [homelab-scripts GitHub repository](https://github.com/garrettlaman/homelab-scripts/blob/main/disable_offloads.sh).

The script accepts a network interface name as an argument. For example:

```bash
./disable_offloads.sh eno1
```

If published to a GitHub repo, it can be executed directly with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/garrettlaman/homelab-scripts/main/disable_offloads.sh | bash -s -- eno1
```

---

## Results

Since deploying this change, my Proxmox node has been stable with no further `e1000e` hang events in the logs. While the “real” fix would be upgrading to a more reliable NIC (which I plan to do whenever I get around to implementing 10 GbE in my lab), this workaround is an effective and lightweight solution in the meantime.

---

## Takeaways

- Kernel logs (`journalctl`, `dmesg`) are invaluable when troubleshooting random outages.  
- Intel’s consumer-grade NICs (especially I219 variants) can exhibit stability issues under Linux.  
- Disabling offloads is a pragmatic fix with minimal downsides at 1 GbE.  
- Automating small but critical workarounds with scripts is a good way to keep homelab infrastructure reliable.
