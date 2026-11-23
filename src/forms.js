// Public feedback and support forms (ClickUp, "Support" space). Every link on the
// site comes from here, so a form move or a renamed question is a one-file change.
//
// The feedback form fills its questions from URL parameters named after each
// question, exactly as worded in ClickUp. If a question is renamed there, rename
// the key here too, or the pre-fill silently stops working.
export const FORMS = {
  feedback: 'https://forms.clickup.com/8533149/f/84d4x-17611/V0NYLRDN8M8Z4EBVID',
  support: 'https://forms.clickup.com/8533149/f/84d4x-17591/EJCU58AQ5FXCC7GDX8',
};
const Q = { kind: 'What are you sharing?', town: 'Which town?' };
// Options of "What are you sharing?" that the site links to.
export const KIND = { resource: 'Suggest a local resource', town: 'Suggest a new town' };

/** Feedback form link, optionally pre-filled with what it's about and the town's display name. */
export function feedbackUrl({ kind, town } = {}) {
  const p = [];
  if (kind) p.push(`${encodeURIComponent(Q.kind)}=${encodeURIComponent(kind)}`);
  if (town) p.push(`${encodeURIComponent(Q.town)}=${encodeURIComponent(town)}`);
  return p.length ? `${FORMS.feedback}?${p.join('&')}` : FORMS.feedback;
}

/** The four form links a town's pages use (town = the town record's display name). */
export function formLinks(town) {
  return {
    suggestUrl: feedbackUrl({ kind: KIND.resource, town }),
    suggestTownUrl: feedbackUrl({ kind: KIND.town }),
    feedbackUrl: feedbackUrl({ town }),
    supportUrl: FORMS.support,
  };
}
