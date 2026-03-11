/**
 * Auth routes — consolidated into the siweAuthPlugin.
 *
 * This file is kept for backwards compatibility with server.ts imports.
 * All auth routes (nonce, verify, me, logout, sessions) are registered
 * by the siweAuthPlugin in `../auth/siwe-auth.ts`.
 *
 * This plugin is intentionally empty — it does not register any routes.
 */

import type { FastifyInstance } from "fastify";

export async function authRoutes(_app: FastifyInstance) {
  // All auth routes are handled by siweAuthPlugin.
  // This is a no-op to avoid breaking the import in server.ts.
}
