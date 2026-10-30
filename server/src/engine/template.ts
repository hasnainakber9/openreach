// Message templates support:
//   {{firstName}}            lead variables (and any custom field by name)
//   {{company|your team}}    fallback when the value is empty
//   {Hi|Hello|Hey}           spintax, nestable, picked at random per send

export interface TemplateLead {
  first_name: string;
  last_name: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  email: string | null;
  custom: Record<string, unknown>;
}

export function leadVars(lead: TemplateLead): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(lead.custom ?? {})) vars[k] = v == null ? '' : String(v);
  Object.assign(vars, {
    firstName: lead.first_name,
    lastName: lead.last_name,
    fullName: `${lead.first_name} ${lead.last_name}`.trim(),
    headline: lead.headline,
    title: lead.title,
    company: lead.company,
    location: lead.location,
    email: lead.email ?? '',
  });
  return vars;
}

export const VARIABLE_NAMES = ['firstName', 'lastName', 'fullName', 'company', 'title', 'headline', 'location', 'email'];

export function render(template: string, vars: Record<string, string>, random: () => number = Math.random): string {
  // Swap variables for placeholders first so values containing { or | survive spintax.
  const values: string[] = [];
  const withSlots = template.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_, name: string, fallback?: string) => {
    const v = (vars[name] ?? '').trim();
    values.push(v || (fallback ?? '').trim());
    return `\u0000${values.length - 1}\u0000`;
  });
  const spun = spin(withSlots, random);
  return spun
    .replace(/\u0000(\d+)\u0000/g, (_, i) => values[Number(i)])
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim();
}

function spin(text: string, random: () => number): string {
  // Resolve innermost {a|b} groups until none are left.
  const inner = /\{([^{}]*)\}/;
  let out = text;
  for (let guard = 0; guard < 1000 && inner.test(out); guard++) {
    out = out.replace(inner, (_, body: string) => {
      const options = body.split('|');
      return options[Math.floor(random() * options.length)] ?? '';
    });
  }
  return out;
}

// Variables used in a template that are not known lead fields; shown as warnings in the builder.
export function unknownVariables(template: string, known = VARIABLE_NAMES): string[] {
  const names = [...template.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]);
  return [...new Set(names.filter((n) => !known.includes(n)))];
}

// LinkedIn rejects invitation notes over the limit, so trim at a word boundary.
export function clampNote(note: string, limit: number): string {
  if (note.length <= limit) return note;
  const cut = note.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}
