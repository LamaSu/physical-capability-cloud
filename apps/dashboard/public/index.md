---
title: "Physical Capability Cloud"
description: "The capability network for the physical world — AI agents and people discover, configure, hire, monitor, and verify real-world work."
canonical: "https://capability.network/"
last-updated: "2026-08-27"
---

# Physical Capability Cloud

**The capability network for the physical world.** AI agents and people use PCC to discover, configure, hire, monitor, and verify real-world work. Operators publish machines, instruments, logistics, assets, and human services through a Shop Kernel while keeping execution under local control.

## For agents: get something done

Search live capabilities such as 3D printing, CNC machining, laser cutting, PCB work, laboratory analysis, and courier services. Inspect valid options before pricing, confirm the scope and evidence tier with the person authorizing the work, build a capability contract, and monitor the resulting job. PCC supports content-addressed evidence and assurance tiers 0–3 so acceptance can be based on the proof the job requires.

- Load the [254-tool agent package](https://capability.network/agent-package.json).
- Read the live [OpenAPI document](https://capability.network/openapi.json) or [API documentation](https://capability.network/docs).
- Provision a key with `POST /api/auth/provision`, then send it as `Authorization: Bearer <key>`.
- Start discovery with `GET /api/capabilities` or `GET /api/capabilities/search?q=<query>`.
- Read [authentication](https://capability.network/auth.md) and [pricing](https://capability.network/pricing.md) before committing.

## For operators: put a capability on the network

Connect a machine or service through the local Shop Kernel, validate its adapter configuration, register the device, publish its capability, and run a test job. Agents can then discover what the operator actually offers. The Python operator CLI is available as `pcc-node`, and the REST setup flow begins at `GET /api/setup/detect`.

[Get started](https://capability.network/start) · [Read the docs](https://capability.network/docs) · [View the source](https://github.com/LamaSu/physical-capability-cloud)

## Settlement and evidence

Jobs are priced per outcome rather than by subscription. PCC's implemented settlement flow uses x402 and USDC milestone escrow on Base Sepolia, and the protocol charges 2.35% when settlement occurs. Base Sepolia is a test network. Evidence requirements are part of the capability contract; on-chain state stores hashes or commitments, not raw evidence.

## Trust and community

[About PCC](https://capability.network/about.html) · [Contact](https://capability.network/contact.html) · [Privacy](https://capability.network/privacy.html) · [Discord](https://discord.gg/CRFvvUgeV4)
