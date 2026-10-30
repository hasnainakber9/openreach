// A driver performs actions as one LinkedIn member. The engine never touches LinkedIn
// directly, so the simulator and the real browser driver are interchangeable.

export interface Person {
  publicId: string; // the slug in linkedin.com/in/<publicId>
  profileUrl: string;
  firstName: string;
  lastName: string;
  headline?: string;
  title?: string;
  company?: string;
  location?: string;
  email?: string | null;
  phone?: string | null;
  degree?: 1 | 2 | 3 | null;
}

export type ConnectResult = 'sent' | 'already_connected' | 'already_pending';

export interface InboxMessage {
  externalId: string;
  direction: 'in' | 'out';
  body: string;
  sentAt: number;
}

export interface InboxThread {
  threadId: string;
  participant: { name: string; publicId: string | null; profileUrl: string };
  lastMessageAt: number;
  unread: boolean;
  messages: InboxMessage[];
}

export interface SessionInfo {
  name: string;
  profileUrl: string;
}

export interface LinkedInDriver {
  checkSession(): Promise<SessionInfo>;
  viewProfile(profileUrl: string): Promise<Person>;
  follow(profileUrl: string): Promise<void>;
  endorse(profileUrl: string, count: number): Promise<number>;
  likeRecentPost(profileUrl: string): Promise<boolean>;
  connect(profileUrl: string, note: string): Promise<ConnectResult>;
  withdrawInvite(profileUrl: string): Promise<boolean>;
  sendMessage(profileUrl: string, text: string): Promise<void>;
  // People who accepted invitations recently, newest first.
  recentConnections(limit: number): Promise<Person[]>;
  inbox(since: number): Promise<InboxThread[]>;
  search(url: string, limit: number, onPage?: (found: number) => void): Promise<Person[]>;
  close(): Promise<void>;
}

export type DriverErrorCode =
  | 'SESSION_EXPIRED' // cookie no longer valid; account needs a new session
  | 'CHECKPOINT' // LinkedIn wants a captcha / verification
  | 'LIMIT_REACHED' // LinkedIn itself refused (e.g. weekly invitation cap)
  | 'NOT_AVAILABLE' // action not possible for this person (no Connect button, not a 1st-degree, ...)
  | 'NOT_FOUND'
  | 'TRANSIENT';

export class DriverError extends Error {
  constructor(public code: DriverErrorCode, message: string) {
    super(message);
    this.name = 'DriverError';
  }
}

export function publicIdFromUrl(url: string): string | null {
  const m = url.match(/linkedin\.com\/(?:in|sales\/(?:people|lead))\/([^/?#,]+)/i);
  const id = m ? decodeURIComponent(m[1]) : /^[\w-]{3,100}$/.test(url.trim()) ? url.trim() : null;
  if (!id) return null;
  // Member URNs (from Sales Navigator, "ACwAA...") are case-sensitive; vanity slugs are not.
  return /^AC[\w-]{20,}$/.test(id) ? id : id.toLowerCase();
}

export function profileUrl(publicId: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
}
