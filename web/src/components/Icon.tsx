const USER = (
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="8.5" cy="7" r="4" />
  </>
);

const ICONS: Record<string, React.ReactNode> = {
  view_profile: (
    <>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  follow: (
    <>
      {USER}
      <path d="M17 11l2 2 4-4" />
    </>
  ),
  endorse: <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-5.18 2.72L8 13.14 2 9.27l6.91-1.01L12 2z" />,
  like_post: <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />,
  connect: (
    <>
      {USER}
      <path d="M20 8v6M23 11h-6" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  email: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 6l-10 7L2 6" />
    </>
  ),
  inmail: (
    <>
      <rect x="1" y="6" width="15" height="12" rx="2" />
      <path d="M16 8l-7.5 5L1 8" />
      <path d="M19 9l3 3-3 3M22 12h-4" />
    </>
  ),
  withdraw_invite: (
    <>
      {USER}
      <path d="M18 8l5 5M23 8l-5 5" />
    </>
  ),
  wait: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  task: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 3v2h6V3M8 12l2.5 2.5L16 9" />
    </>
  ),
  sms: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M10 18h4" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M3 21l1.6-4.6A9 9 0 1 1 8 19.6L3 21z" />
      <path d="M9 10c0 3 2 5 5 5" />
    </>
  ),
  call: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />,
  condition: (
    <>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
};

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] ?? <circle cx="12" cy="12" r="4" />}
    </svg>
  );
}
