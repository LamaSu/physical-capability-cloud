import { GlassPanel } from "@pcc/ui";
import type { NotAvailableReply } from "../lib/not-available.js";

export function NotAvailablePanel({
  reply,
  heading = "Some data is not available on this gateway",
  fallback = "This gateway does not make this data available.",
}: {
  reply: NotAvailableReply;
  heading?: string;
  fallback?: string;
}) {
  return (
    <GlassPanel padding="lg" role="status">
      <h2>{heading}</h2>
      <p>{reply.message ?? fallback}</p>
    </GlassPanel>
  );
}
