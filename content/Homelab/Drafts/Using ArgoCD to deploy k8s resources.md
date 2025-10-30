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

First, created a namespace for ArgoCD and added the ArgoCD helm chart

```shell
❯ kubectl create namespace argocd
❯ helm repo add argo https://argoproj.github.io/argo-helm
❯ helm repo update
```

Created a `values.yaml` file for the chart:
```yaml
global:
  image:
    imagePullPolicy: IfNotPresent
# Argo CD core
configs:
  params:
    server.insecure: "true"   # TLS will be handled through external Traefik instance
server:
  service:
    type: ClusterIP
    loadBalancerIP: 10.10.102.50
  ingress:
    enabled: false
controller:
  metrics:
    enabled: true
  # resources: {}     # tune if desired
repoServer:
  metrics:
    enabled: true
applicationSet:
  enabled: true
  metrics:
    enabled: true
```

Installed Helm chart using the `values.yaml` file:
```shell
❯ helm install argocd argo/argo-cd -n argocd -f values.yaml
```

Created a load balancer service in `svc-lb.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: argocd-lb
  namespace: argocd
  annotations:
    metallb.io/loadBalancerIPs: "10.10.104.20"
    metallb.io/allow-shared-ip: "cluster-vip"
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster
  ipFamilyPolicy: SingleStack
  ipFamilies: [IPv4]
  selector:
    app.kubernetes.io/instance: argocd
    app.kubernetes.io/name: argocd-server
  ports:
    - name: http
      port: 5009
      targetPort: 8080
```

Applied the LB service:
```shell
kubectl apply -f svc-lb.yaml
```

Verified that the service got the correct VIP assigned to it:
```shell
❯ kubectl -n argocd describe svc
Name:                     argocd-lb
Namespace:                argocd
...
Events:
  Type    Reason        Age   From                Message
  ----    ------        ----  ----                -------
  Normal  IPAllocated   22m   metallb-controller  Assigned IP ["10.10.104.20"]
  Normal  nodeAssigned  1s    metallb-speaker     announcing from node "dev-talos-wk02" with protocol "layer2"
```

## Installing ArgoCD CLI and changing the default admin password

Used brew to install the argocd command line tool:
```shell
❯ brew install argocd
```

Showed and saved the argocd admin password:
```shell
❯ argocd admin initial-password -n argocd
```

Logged into the ArgoCD instance using the CLI and changed the admin password:
```shell
❯ argocd login argocd.dev.internal.dwarflabs.xyz
❯ argocd account update-password
```

Navigated to the proxied ArgoCD site and logged in with the `admin` user and the new password. Now ArgoCD was deployed!

![[Using ArgoCD to deploy k8s resources.png]]

## Test deployment

Created a new repo called `argocd-test` and created a simple file structure:

```shell
argocd-test/
└── k8s/
    ├── deployment.yaml
    ├── namespace.yaml
    └── service.yaml
```

`k8s/deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  labels:
    app: hello
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello
  template:
    metadata:
      labels:
        app: hello
    spec:
      containers:
      - name: nginx
        image: nginx:1.25-alpine
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet: { path: /, port: 80 }
          initialDelaySeconds: 3
          periodSeconds: 5
        livenessProbe:
          httpGet: { path: /, port: 80 }
          initialDelaySeconds: 10
          periodSeconds: 10
```

`k8s/service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: hello
  labels:
    app: hello
spec:
  type: ClusterIP
  selector:
    app: hello
  ports:
  - name: http
    port: 80
    targetPort: 80
```

`namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  labels:
    name: hello
  name: hello
```

Created an ArgoCD Application manifest (`application-hello.yaml`) for the test application in my repo:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: hello
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/garrettlaman/argocd-test.git
    targetRevision: main
    path: k8s
  destination:
    server: https://kubernetes.default.svc
    namespace: hello
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```shell
❯ kubectl apply -f application-hello.yaml
❯ kubectl -n hello get deploy,po,svc
NAME                    READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/hello   1/1     1            1           63s

NAME                        READY   STATUS    RESTARTS   AGE
pod/hello-db64fdb88-xftmq   1/1     Running   0          62s
```

Also checked the ArgoCD web UI and saw that the application was present there:

![[Using ArgoCD to deploy k8s resources-1.png]]

Port forwarded the pod's HTTP port and opened it in a browser:
```shell
kubectl -n hello port-forward svc/hello 8080:80
```

![[Using ArgoCD to deploy k8s resources-2.png]]

Modified the replica count in `k8s/deployment.yaml` to 2, and then committed the change to the repo. ArgoCD synced the change and redeployed within a couple of minutes. Now my deployment has two replicas.

![[Using ArgoCD to deploy k8s resources-3.png]]