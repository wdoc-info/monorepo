import { SignJWT } from "jose";

export type JwtPayload = {
  sub: string;
  email: string;
};

export const signJwt = async (
  payload: JwtPayload,
  secret: string,
  expiresInSeconds: number,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(secret));
};
