import type { AppConfig } from "../config";
import type { EmailSender } from "./types";
import { consoleEmailSender } from "./providers/console";
import { sesEmailSender } from "./providers/ses";

export const buildEmailSender = (config: AppConfig): EmailSender => {
  switch (config.emailProvider) {
    case "ses":
      return sesEmailSender(config.emailFrom);
    case "console":
    default:
      return consoleEmailSender();
  }
};
