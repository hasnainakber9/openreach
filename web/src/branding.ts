import { useEffect, useState } from 'react';
import { api, type Branding } from './api';

export const DEFAULT_BRANDING: Branding = { productName: 'OpenReach', logoUrl: null, primaryColor: null, supportEmail: null };

// White-label: the product name goes in the tab title, the primary color replaces the accent
// (styles.css derives the soft and text shades from --brand).
export function applyBranding(b: Branding) {
  document.title = b.productName;
  const root = document.documentElement;
  if (b.primaryColor) {
    root.style.setProperty('--brand', b.primaryColor);
    root.dataset.brand = 'on';
  } else {
    root.style.removeProperty('--brand');
    delete root.dataset.brand;
  }
}

// Asks the app to load branding again (after sign-in, a workspace switch or saving the branding form).
export const refreshBranding = () => window.dispatchEvent(new Event('openreach:branding'));

// The branding for this domain or the signed-in workspace; loaded before sign-in so the sign-in page has it.
export function useBranding() {
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => {
    const load = () =>
      api<Branding>('/api/branding')
        .then((b) => setBranding({ productName: b.productName, logoUrl: b.logoUrl, primaryColor: b.primaryColor, supportEmail: b.supportEmail }))
        .catch(() => setBranding(DEFAULT_BRANDING));
    void load();
    window.addEventListener('openreach:branding', load);
    return () => window.removeEventListener('openreach:branding', load);
  }, []);
  useEffect(() => {
    if (branding) applyBranding(branding);
  }, [branding]);
  return branding;
}
