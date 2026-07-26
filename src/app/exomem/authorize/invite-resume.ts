const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/;

export function parseInvitationUrl(value: string, origin: string): string | null {
  let invitation: URL;
  try {
    invitation = new URL(value.trim());
  } catch {
    return null;
  }
  const token = invitation.hash.slice(1);
  if (
    invitation.origin !== origin ||
    invitation.username ||
    invitation.password ||
    invitation.pathname !== "/exomem/invite" ||
    invitation.search ||
    token.length < 43 ||
    token.length % 4 === 1 ||
    !BASE64URL_TOKEN.test(token)
  ) {
    return null;
  }
  return token;
}

type InvitationRedeemDependencies = {
  clear: () => void;
  post: (
    path: "/api/exomem/access/redeem",
    body: { token: string }
  ) => Promise<Record<string, unknown>>;
  replace: (destination: string) => void;
};

export async function redeemInvitationUrl(
  input: { invitationUrl: string; origin: string },
  dependencies: InvitationRedeemDependencies
): Promise<"invalid" | "redeemed"> {
  dependencies.clear();
  const token = parseInvitationUrl(input.invitationUrl, input.origin);
  if (!token) return "invalid";
  const result = await dependencies.post("/api/exomem/access/redeem", { token });
  if (typeof result.destination !== "string" || !result.destination) {
    throw new Error("invalid invite redemption response");
  }
  dependencies.replace(result.destination);
  return "redeemed";
}
