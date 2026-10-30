// Everything that depends on LinkedIn's markup lives here. LinkedIn changes class names
// often, so the driver leans on accessible names (aria-labels, roles, visible text), which
// change far less. When an action starts failing, this is the file to update.

export const URLS = {
  feed: 'https://www.linkedin.com/feed/',
  me: 'https://www.linkedin.com/in/me/',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  messaging: 'https://www.linkedin.com/messaging/',
};

export const BLOCKED_PATHS = {
  sessionExpired: /\/(login|authwall|uas\/login|signup)/,
  checkpoint: /\/checkpoint\//,
};

export const SEL = {
  profileName: 'main h1',
  profileHeadline: ['main section .text-body-medium', 'main section div[data-generated-suggestion-target]'],
  profileLocation: ['main section span.text-body-small.inline', 'main section .pv-text-details__left-panel span.text-body-small'],
  profileDegree: ['main section .dist-value', 'main section span.distance-badge'],
  currentCompany: 'main section button[aria-label^="Current company"]',
  topCard: 'main section',
  contactInfoLink: 'a[href*="overlay/contact-info"]',
  contactModal: 'div[role="dialog"]',
  modalClose: 'button[aria-label="Dismiss"]',
  dropdownItems: 'div.artdeco-dropdown__content [role="button"], div.artdeco-dropdown__content button',
  inviteNote: 'textarea[name="message"], textarea#custom-message',
  inviteEmail: 'div[role="dialog"] input[type="email"], div[role="dialog"] input[name="email"]',
  messageBox: 'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
  messageSend: 'button.msg-form__send-button, button[type="submit"].msg-form__send-btn',
  messageOverlayClose: 'button.msg-overlay-bubble-header__control:has(svg[data-test-icon="close-small"]), button[aria-label^="Close your conversation"]',
  connectionCard: 'main li',
  threadItem: 'li.msg-conversation-listitem, li.msg-conversations-container__convo-item',
  threadUnread: '.msg-conversation-card__convo-item-container--unread, .notification-badge--show',
  threadHeaderLink: '.msg-thread a[href*="/in/"], .msg-title-bar a[href*="/in/"], .msg-entity-lockup a[href*="/in/"]',
  threadEvent: 'li.msg-s-message-list__event',
  eventUrn: '[data-event-urn]',
  eventSender: '.msg-s-message-group__name',
  eventBody: '.msg-s-event-listitem__body',
  searchResultLinks: 'main a[href*="linkedin.com/in/"], main a[href*="/sales/lead/"]',
  endorseButtons: 'button[aria-label^="Endorse"]',
  likeButtons: 'button[aria-label*="React Like"][aria-pressed="false"], button[aria-label^="Like"][aria-pressed="false"]',
};

// Accessible names of profile action buttons. LinkedIn localizes these; English shown.
export const LABELS = {
  connect: /^Invite .+ to connect$/i,
  pending: /^Pending, click to withdraw invitation/i,
  follow: /^Follow .+/i,
  following: /^(Following|Unfollow) .+/i,
  message: /^Message .+/i,
  more: /^More actions$/i,
  addNote: /^Add a note$/i,
  sendWithoutNote: /^Send without a note$/i,
  sendInvite: /^(Send invitation|Send now|Send)$/i,
  withdraw: /^Withdraw$/i,
  weeklyLimit: /weekly invitation limit|reached the limit/i,
  premiumNoteUpsell: /personalize.*premium|out of personalized invitations/i,
};
