import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const loginValidateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().regex(/^\d{6}$/),
});
