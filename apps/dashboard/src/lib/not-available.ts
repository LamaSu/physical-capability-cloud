export class NotAvailableReply {
  constructor(readonly message: string | null) {}
}

export function isNotAvailable(value: unknown): value is NotAvailableReply {
  return value instanceof NotAvailableReply;
}

function replyFromBody(body: unknown): NotAvailableReply | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  if (data.error !== "not_available") return null;
  return new NotAvailableReply(typeof data.message === "string" && data.message.length > 0 ? data.message : null);
}

export async function readGatewayJson(res: Response): Promise<any> {
  const body = await res.json();
  return res.status === 501 ? replyFromBody(body) ?? body : body;
}

export async function readNotAvailable(res: Response): Promise<NotAvailableReply | null> {
  if (res.status !== 501) return null;
  try {
    return replyFromBody(await res.clone().json());
  } catch {
    return null;
  }
}
