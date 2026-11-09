import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

type SignInOptions = {
  purpose?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
};

export async function issueSignInMessage(app: FastifyInstance, address: string, options: SignInOptions = {}) {
  const purpose = options.purpose === undefined ? "" : `&purpose=${encodeURIComponent(options.purpose)}`;
  const response = await app.inject({
    method: "GET", url: `/api/auth/nonce?address=${encodeURIComponent(address)}${purpose}`,
    headers: options.headers, remoteAddress: options.remoteAddress,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ nonce: string; message: string; issuedAt: string; expiresAt: string; chainId: number }>();
}

export async function signInWithIssuedMessage(
  app: FastifyInstance,
  signer: { signMessage(args: { message: string }): Promise<string> },
  address: string,
  options: SignInOptions = {},
) {
  const { message } = await issueSignInMessage(app, address, options);
  const signature = await signer.signMessage({ message });
  return app.inject({
    method: "POST", url: "/api/auth/verify", payload: { message, signature },
    headers: options.headers, remoteAddress: options.remoteAddress,
  });
}
