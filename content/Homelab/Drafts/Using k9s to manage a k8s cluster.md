---
title: Using k9s to manage a k8s cluster
description:
tags:
created:
modified:
draft: true
---

## Installing k9s

Install k9s using `brew`
```shell
 brew install derailed/k9s/k9s
```

Run `k9s version` to verify installation
```shell
❯ k9s version
 ____  __ ________       
|    |/  /   __   \______
|       /\____    /  ___/
|    \   \  /    /\___  \
|____|\__ \/____//____  /
         \/           \/ 

Version:    v0.50.9
Commit:     ffdc7b70f044e1f26c2f6fbb93b5495e4ebdb1ad
Date:       2025-07-19T15:32:56Z
```

## Managing pods with k9s

Run `k9s` to enter the UI. By default it will drop you a view of the pods in your active namespace (in my case, `actual-budget`)
![[Using k9s to manage a k8s cluster.png]]

Across the top of the screen, various pod-level commands are available (`attach` to pod, `delete` pod, `describe` pod, etc..)

If I use `d` to describe my `actual-budget` pod, I get this output which is equivalent to `kubectl describe`, but doesn't require me to type out the full `kubectl` command.
![[Using k9s to manage a k8s cluster-1.png]]

You can go back one step in the UI by simply pressing `ESC`. `CTRL + C` will exit `k9s` entirely.

### Switching namespaces

To manage pods in other namespaces, you'll need to switch your active namespace:

- Enter **Command Mode** by pressing the colon key on your keyboard (`:`).
- Enter `namespace` (or `ns` for short) in the command bar. This will open a list of namespaces in your cluster.
- Use the arrow keys to select a namespace and press `Enter` to make that namespace active.
- Alternatively, use the command `ns <namespace>` to switch directly to a namespace different namespace. 

![[Using k9s to manage a k8s cluster-2.png]]


> [!NOTE] Symbols next to namespaces
> The plus sign (+) next to a namespace in k9s indicates that the namespace is marked as a "favorite" namespace, and will show up in the k9s header. To mark a namespace as a favorite, enter the namespace view, select a namespace, and press the `u` ("Use") key. 
> 
> The asterisk (\*) next to a namespace means that it is the currently active namespace.


## References

[k9s installation docs](https://k9scli.io/topics/install/)
[k9s cheat sheet](https://www.hackingnote.com/en/cheatsheets/k9s/)

