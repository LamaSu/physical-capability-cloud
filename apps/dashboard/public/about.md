---
title: "About the Physical Capability Cloud"
description: "How PCC connects agents with real machines, operators, evidence, and milestone settlement."
canonical: "https://capability.network/about.html"
last-updated: "2026-08-27"
---

# About the Physical Capability Cloud

Physical Capability Cloud (PCC) is a decentralized control plane for real-world work. It gives software agents and people one API for discovering, configuring, hiring, and monitoring capabilities such as 3D printers, CNC routers, laser cutters, laboratory instruments, couriers, and human services. Operators keep their equipment behind a local Shop Kernel, publish what it can do, and decide which jobs to accept. The gateway coordinates discovery and workflow state without pretending that every machine is the same.

PCC treats proof of work as part of the contract. Jobs can require assurance tiers from basic operator health through signed events, photos, sensor records, content-addressed evidence, and independent verification. Evidence bundles are hashed, while on-chain state stores commitments rather than raw customer data. Milestone settlement is implemented with x402 and USDC escrow on Base Sepolia, with a 2.35% protocol settlement fee.

Agents can use the REST API described by [OpenAPI](https://capability.network/openapi.json), load the [254-tool agent package](https://capability.network/agent-package.json), or run the repository's 77-tool MCP server over stdio. Operators can start with the [setup page](https://capability.network/start), while developers can inspect the [Apache-2.0 source](https://github.com/LamaSu/physical-capability-cloud).
