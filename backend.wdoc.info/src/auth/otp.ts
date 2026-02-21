import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const generateOtpCode = (): string => {
  const value = randomInt(0, 1_000_000);
  return value.toString().padStart(6, "0");
};

export const hashOtpCode = (secret: string, code: string): string => {
  return createHmac("sha256", secret).update(code).digest("hex");
};

export const verifyOtpCode = (secret: string, code: string, hash: string): boolean => {
  const computed = hashOtpCode(secret, code);
  const computedBuffer = Buffer.from(computed, "hex");
  const hashBuffer = Buffer.from(hash, "hex");
  if (computedBuffer.length !== hashBuffer.length) {
    return false;
  }
  return timingSafeEqual(computedBuffer, hashBuffer);
};
