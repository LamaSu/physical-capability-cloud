/**
 * N80 (rehearsal R0 G4): no certificate is served or minted until minting is real. Before N80,
 * POST /api/certificates/mint answered `minted: true` for any kernelDid, with a caller-chosen
 * tier, a placeholder Merkle tree and a mintedAt from module load (before the kernel existed),
 * and the list served three certificates for kernels that do not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { rewardRoutes } from "../routes/rewards.js";

describe("certificates (N80): none served, none minted", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(rewardRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("NEGATIVE: the rehearsal's mint request is refused with 501, and nothing claims a mint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/certificates/mint",
      payload: {
        kernelDid: "did:pcc:kernel:kernel_mun95p2q_plz8",
        capabilityType: "lab.absorbance",
        assuranceTier: 1,
        metadata: { settledJobId: "job-af6d5056-0af" },
      },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body).toMatchObject({ minted: false, error: "not_implemented" });
    expect(body).not.toHaveProperty("certificate");
    expect(JSON.stringify(body)).not.toMatch(/TreeAAAA|"minted":true|mintedAt/);
  });

  it("NEGATIVE: the list holds no certificate, for any kernel, before or after a mint attempt", async () => {
    for (const url of ["/api/certificates", "/api/certificates?kernelDid=did:pcc:kernel:biolab-01", "/api/certificates?status=active"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json(), url).toEqual({ certificates: [], total: 0 });
    }
  });

  it("NEGATIVE: the certificates that used to be listed, for kernels that do not exist, are not found", async () => {
    for (const id of ["cnft_biolab_fdm_001", "cnft_metalshop_cnc_001", "cnft_biolab_hplc_001"]) {
      const res = await app.inject({ method: "GET", url: `/api/certificates/${id}` });
      expect(res.statusCode, id).toBe(404);
    }
  });
});
