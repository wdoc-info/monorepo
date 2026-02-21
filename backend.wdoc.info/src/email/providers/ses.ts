import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { EmailSender } from "../types";

export const sesEmailSender = (from: string): EmailSender => {
  const client = new SESClient({
    region: process.env.AWS_REGION,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
        }
      : undefined,
  });

  return async ({ to, subject, text }) => {
    const command = new SendEmailCommand({
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: text } },
      },
      Source: from,
    });
    await client.send(command);
  };
};
