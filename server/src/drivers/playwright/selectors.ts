// Everything that depends on LinkedIn's markup lives here. LinkedIn changes class names
// often, so the driver leans on accessible names (aria-labels, roles, visible text), which
// change far less. When an action starts failing, this is the file to update.

export const URLS = {
  feed: 'https://www.linkedin.com/feed/',
  me: 'https://www.linkedin.com/in/me/',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  messaging: 'https://www.linkedin.com/messaging/',
  groupMembers: (groupId: string) => `https://www.linkedin.com/groups/${encodeURIComponent(groupId)}/members/`,
};

export const BLOCKED_PATHS = {
  sessionExpired: /\/(login|authwall|uas\/login|signup)/,
  checkpoint: /\/checkpoint\//,
};

export const SEL = {
  // Profiles come in two layouts, and LinkedIn moves accounts between them gradually, so both are kept.
  // 2026 layout: no h1, the name is the first h2 in main, classes are obfuscated (never select on them),
  // and the details are plain <p> lines read by parse.ts. Older layout: the name is main h1 and the
  // details have stable classes (the selectors below), used when the page has an h1.
  profileName: 'main h1, main h2',
  // Shows once the top card has rendered, which takes a few seconds after the document loads.
  profileReady: 'main h1, main section h2',
  profileHeadline: ['main section .text-body-medium', 'main section div[data-generated-suggestion-target]'],
  profileLocation: ['main section span.text-body-small.inline', 'main section .pv-text-details__left-panel span.text-body-small'],
  profileDegree: ['main section .dist-value', 'main section span.distance-badge'],
  currentCompany: 'main section button[aria-label^="Current company"]',
  contactInfoLink: 'a[href*="overlay/contact-info"]',
  // Dialogs other than a messaging bubble: LinkedIn keeps conversation bubbles open across pages and
  // marks them role="dialog" too, and their Send button must never be taken for an invitation's.
  dialog: '[role="dialog"]:not(.msg-convo-wrapper):not(.msg-overlay-conversation-bubble):not([aria-label="Messaging"])',
  modalClose: 'button[aria-label="Dismiss"], button[aria-label^="Close"]',
  // The profile's "More" menu: 2026 items are role=menuitem (some <a>, some <div>); older ones sat in an
  // artdeco dropdown.
  menuItems: '[role="menu"] [role="menuitem"], div.artdeco-dropdown__content [role="button"], div.artdeco-dropdown__content button',
  inviteNote: 'textarea[name="message"], textarea#custom-message',
  inviteEmail: 'input[type="email"], input[name="email"]',
  // The composer opens as a conversation bubble; in 2026 it is inside an open shadow root
  // (div#interop-outlet). Playwright's CSS locators reach into open shadow roots; page.evaluate does not.
  messageBubble: '.msg-overlay-conversation-bubble, .msg-convo-wrapper',
  // Only the floating bubbles (the /messaging/ page's own thread is a .msg-convo-wrapper too).
  overlayBubble: '.msg-overlay-conversation-bubble',
  // Where a bubble names its own participant (the profile card at the top, or the header). Links further
  // down (a message body, a shared profile) can be anyone.
  bubbleOwnerLink: (id: string) => `.msg-s-profile-card a[href*="/in/${id}/" i], .msg-overlay-bubble-header a[href*="/in/${id}/" i]`,
  messageBox: 'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
  messageSend: 'button.msg-form__send-button, button[type="submit"].msg-form__send-btn',
  // The bubble's header has two unlabeled controls, expand then close.
  messageOverlayClose:
    'button.msg-overlay-bubble-header__control:has(svg[data-test-icon="close-small"]), button[aria-label^="Close your conversation"], .msg-overlay-conversation-bubble button.msg-overlay-bubble-header__control:not(.msg-overlay-conversation-bubble__expand-btn)',
  threadItem: 'li.msg-conversation-listitem, li.msg-conversations-container__convo-item',
  threadUnread: '.msg-conversation-card__convo-item-container--unread, .notification-badge--show',
  // The open thread's participant link, from the thread's own header or profile card only: a link inside
  // a message (a shared profile, a pasted URL) is someone else, and the driver also skips any match inside
  // a message. Older threads linked the name in the title bar. 2026 threads have no link at all (the name
  // is a button that opens a hovercard, threadParticipantTrigger).
  threadHeaderLink:
    '.msg-title-bar a[href*="/in/"], .msg-thread a.msg-thread__link-to-profile, .msg-thread .msg-entity-lockup a[href*="/in/"], .msg-thread .msg-s-profile-card-one-to-one a[href*="/in/"]',
  threadParticipantTrigger: '.msg-thread .msg-title-bar button.msg-s-message-group__name[aria-controls], .msg-thread .msg-s-profile-card-one-to-one button.msg-s-message-group__name[aria-controls]',
  threadTitle: '.msg-thread .msg-entity-lockup__entity-title, .msg-thread .profile-card-one-to-one__profile-link, .msg-thread .msg-s-profile-card .artdeco-entity-lockup__title',
  threadEvent: 'li.msg-s-message-list__event',
  eventUrn: '[data-event-urn]',
  eventSender: '.msg-s-message-group__name',
  eventBody: '.msg-s-event-listitem__body',
  connectionLinks: 'main a[href*="/in/"]',
  searchResultLinks: 'main a[href*="linkedin.com/in/"], main a[href*="/sales/lead/"]',
  endorseButtons: 'button[aria-label^="Endorse"]',
  // 2026: "Reaction button state: no reaction" (and "...: Like" once liked). Older: aria-pressed buttons.
  likeButtons: 'button[aria-label="Reaction button state: no reaction"], button[aria-label*="React Like"][aria-pressed="false"], button[aria-label^="Like"][aria-pressed="false"]',
  // Lead sources and InMail (g1-sources). Best effort: written from LinkedIn's public markup and
  // checked only against the local mock, not against the live site.
  reactionsDialog: 'div[role="dialog"]',
  reactorLinks: 'div[role="dialog"] a[href*="/in/"]',
  commentAuthorLinks: 'article.comments-comment-entity a[href*="/in/"], article.comments-comment-item a[href*="/in/"], .comments-comment-meta__actor a[href*="/in/"]',
  groupMemberLinks: 'main a[href*="/in/"]',
  inmailSubject: 'input[name="subject"], input[placeholder^="Subject"]',
  inmailBody: 'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea[name="message"]',
};

// Accessible names of profile actions. LinkedIn localizes these; English shown.
// Profile controls are buttons or links (2026: Connect and Message are <a>), and 2026 menu items often
// carry just a word ("Follow"), so the person's name is optional.
export const LABELS = {
  connect: /^(Invite .+ to connect|Connect)$/i,
  pending: /^Pending(, click to withdraw invitation.*)?$/i,
  follow: /^Follow( .+)?$/i,
  following: /^(Following|Unfollow)( .+)?$/i,
  message: /^Message( .+)?$/i,
  more: /^More( actions)?$/i,
  addNote: /^Add a note$/i,
  sendWithoutNote: /^Send without a note$/i,
  sendInvite: /^(Send invitation|Send now|Send)$/i,
  withdraw: /^Withdraw$/i,
  weeklyLimit: /weekly invitation limit|reached the limit/i,
  premiumNoteUpsell: /personalize.*premium|out of personalized invitations/i,
  // Lead sources and InMail (g1-sources); best effort, see SEL.
  reactionsCount: /^[\d,.]+[KkM]?\s+reactions?$|\breactions?$/i,
  showMoreResults: /^Show more results$/i,
  moreComments: /^(Load more comments|See more comments|Show more comments)$/i,
  eventAttendees: /attendee/i,
  viewInSalesNav: /^View in Sales Navigator$/i,
  send: /^Send$/i,
  inmailNoCredits: /(no|0) (more )?InMail credits|used all (of )?your InMail credits|out of InMail credits/i,
};
