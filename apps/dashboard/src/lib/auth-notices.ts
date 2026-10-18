export const OPERATOR_SIGN_IN_NOTICE = "Sign in again to enable operator actions.";
export const EXPLICIT_CREDENTIAL_REQUIRED = "explicit_credential_required";

export async function requiresOperatorSignIn(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = await res.json().catch(() => null);
  return body?.error === EXPLICIT_CREDENTIAL_REQUIRED;
}
