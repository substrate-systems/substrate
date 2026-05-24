---
title: "Coolify to K3s"
slug: coolify-to-k3s
subtitle: "How Q's production infrastructure became declarative"
description: "Migrating Q from Coolify to K3s + Terraform + Ansible — the conversation that started it, what got built, and the operational calm that followed."
published: 2026-05-24
date: 2026-05-24
status: draft
tags:
  - iac
  - kubernetes
  - terraform
  - ansible
  - infrastructure
author: Hugo Ander Kivi
---

Q runs on K3s these days. K3s, Hetzner, Terraform, Ansible, sealed secrets, automated backups to Backblaze R2, self-hosted GitHub Actions runners, Traefik with Let's Encrypt. It's clean. The whole thing is declarative: if the server dies, recovery is a `terraform apply` away.

That's now. Getting there started with a conversation, and took longer than it should have.

## The Coolify era

Q started on [Coolify](https://coolify.io), a self-hosted PaaS that got the product to first testers fast. That was the right call at the time. What it cost showed up later.

- Firewall rules clicked into the UI, then patched with direct `iptables` when the UI ran out
- Containers and persistent volumes provisioned through point-and-click
- SSH'ing into containers to run commands when something broke
- Manual changes that should have been declarative
- No reproducibility: if the server died, recovery meant remembering all the steps

The exact phrasing I used about it at the time: *"some manual work with provisioning firewalls, rules, running commands on the container my god. Was a nightmare lol."*

## The conversation with Pepe

The migration started as a conversation. My friend [Pepe Marquez Romero](https://www.linkedin.com/in/pmarquezromero/) had been pitching me on IaC: declarative provisioning, version-controlled infrastructure, the whole discipline. I took the recommendation seriously. I just didn't quite grasp what he meant. The words made sense individually without the picture they pointed at.

What I hadn't realized was the extent. Not just provisioning the box, but host bootstrap, workload management, secrets, backups, CI runners, TLS. Every layer declarative, all the way down. When that clicked, the gap had been comprehension, not persuasion.

The decision to migrate was downstream of that moment. Once I'd committed to declarative provisioning as the architecture, the rest of the stack started picking itself.

## What got built

| Layer | Before (Coolify) | After |
|---|---|---|
| Provisioning | UI click-through + iptables | Terraform |
| Host bootstrap | SSH + manual commands | Ansible |
| Workload management | Coolify containers | K3s |
| Secrets | Plaintext env vars | Sealed secrets + encryption at rest |
| Backups | Manual snapshots | CronJobs to Backblaze R2 |
| CI runners | GitHub-hosted | Self-hosted on cluster |
| TLS | Coolify-managed | Traefik + Let's Encrypt automation |

A few of the architecture calls worth naming.

**K3s rather than full Kubernetes.** It's a single-server platform with a low-overhead control plane. The full Kubernetes complexity buys nothing at this scale; K3s gives me the declarative workload model without the operational tax.

**Sealed secrets for secrets at rest.** I added these later in the migration rather than at the K3s switch. On a declarative stack, the addition was just another manifest pattern: the kind of thing that becomes trivial once the rest of the infrastructure is already declarative, which is itself a small payoff of the migration.

**Self-hosted GitHub Actions runners on the same cluster.** External CI is more expensive than CI running on infrastructure I already operate, and the cluster-to-CI latency is zero.

## What's different now

The operational mode is fundamentally different than it was a year ago.

When something breaks, I read declarative config, change it, apply. I don't SSH in to patch state. I don't try to remember what manual step I did three months ago. The state of the infrastructure is what's in version control.

When I want to add a service, I write the manifest, push, deploy. Not click through a UI praying I'm checking the right boxes.

When I think about scaling (adding nodes, regions, services), the answer is "extend the Terraform config" instead of "schedule a multi-day rebuild."

LLMs handled the implementation. Initial Terraform configs from my architectural intent, Ansible playbooks from the host hardening checklist, YAML debugging, `kubectl` edge cases. The architectural calls were mine; the keystroke work was largely theirs. The LLM piece on its own wasn't surprising: that's how I work now. But the compound — infrastructure entirely as code, with LLMs at the keystroke layer — opened up opportunities I hadn't fully reckoned with. Things that would've been too expensive to consider start looking tractable.

## What this enables

The migration unlocked things that weren't obvious upfront.

**Cleaner mental model.** When the infrastructure is declarative, the picture in my head matches the picture on disk; less load to carry.

**Faster recovery.** The whole stack can be rebuilt from a clean Hetzner box in under an hour. The last manual disaster recovery on Coolify took most of a day.

**Calmer ops.** Most days I don't touch the infrastructure at all. The cluster runs, CronJobs run, backups land in Backblaze, and I read logs occasionally, less often than I used to.

That last one was the surprise of running the new stack. Once the manual mode is gone, the cognitive overhead of running production drops to almost nothing. Most of the time the infrastructure isn't something I'm thinking about; I'm thinking about the product.

That's the actual payoff. Pepe was right about it; it just took me a while to see why.
