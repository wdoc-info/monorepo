import type { EmailSender } from "../types";

export const consoleEmailSender = (): EmailSender => {
  return async ({ to, subject, text }) => {
    console.info("[email:console]", { to, subject, text });
  };
};
