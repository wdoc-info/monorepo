export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailSender = (message: EmailMessage) => Promise<void>;
