---
title: Using ArgoCD to deploy k8s resources
description: 
tags:
  - kubernetes
  - argocd
  - gitops
created: 2025-09-22
modified:
draft: true
---

## Resources

https://argo-cd.readthedocs.io/en/stable/getting_started/

## Installing ArgoCD

First, created a namespace for ArgoCD and applied the ArgoCD manifests

```shell
❯ kubectl create namespace argocd
❯ kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

