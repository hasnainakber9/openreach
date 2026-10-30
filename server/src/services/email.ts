import nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface Mailer {
  send(smtp: SmtpConfig | null, to: string, subject: string, text: string): Promise<'sent' | 'simulated'>;
}

// Without SMTP settings (e.g. simulator accounts) emails are recorded but not delivered.
export const smtpMailer: Mailer = {
  async send(smtp, to, subject, text) {
    if (!smtp) return 'simulated';
    const t = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    await t.sendMail({ from: smtp.from || smtp.user, to, subject, text });
    return 'sent';
  },
};
