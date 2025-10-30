---
title:
description: 
tags:
  - kubernetes
  - metallb
created: 2025-10-10
modified:
draft: true
---

## Resources


## Adding MetalLB helm repo and setting up namespace

First, created a namespace for MetalLB and added the MetalLB helm chart:
```shell
❯ helm repo add metallb https://metallb.github.io/metallb
```

Created `metallb-system.yaml` namespace manifest and added labels to elevate permissions, as described in the [MetalLB documentation](https://metallb.universe.tf/installation/#installation-with-helm):
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: metallb-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: privileged
```

Applied the manifest to the cluster:
```shell
❯ kubectl apply -f metallb-system.yaml
```

## Installing MetalLB helm chart

Installed metallb to the metallb-system namespace:
```shell
❯ helm install metallb metallb/metallb --namespace metallb-system
```

Verified that the metallb-controller pod was running:
```shell
❯ kubectl get pods -n metallb-system
NAME                                  READY   STATUS    RESTARTS   AGE
metallb-controller-5754956df6-clnkj   1/1     Running   0          36s
```

Created file called `metallb-ip-pool.yaml`:
```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: lan-pool
  namespace: metallb-system
spec:
  addresses:
    - 10.10.102.20-10.10.102.29
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: lan-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - lan-pool
```

Applied the file to the cluster:
```shell
❯ kubectl apply -n metallb-system -f metallb-ip-pool.yaml
ipaddresspool.metallb.io/lan-pool created
l2advertisement.metallb.io/lan-l2 created
```
