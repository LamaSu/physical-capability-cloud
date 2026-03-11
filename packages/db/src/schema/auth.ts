import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** User sessions */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastActiveAt: text("last_active_at").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
});
