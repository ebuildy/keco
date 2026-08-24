/**
 * The one search field on the page, addressed by id rather than by ref.
 *
 * A ref could not do this job. The field lives in `SiteHeader` on most routes and in the hero
 * on `/`, and `AppShell` — which owns the global `/` shortcut — is a parent of both, so there
 * is no ref to pass upward. Worse, the previous arrangement kept a second, `lg:hidden` copy on
 * the search page and pointed the ref at *that*: at desktop widths `focus()` was being called
 * on a `display:none` element, which silently does nothing. `/` appeared to be implemented and
 * was inert on every screen wide enough to show the layout it belongs to.
 *
 * The two fields never coexist, which is what makes a shared id legal: `SiteHeader` renders
 * its form only when `pathname !== '/'`, and the hero exists only on `/`. Exactly one element
 * carries `SITE_SEARCH_ID` at any time.
 */
export const SITE_SEARCH_ID = 'site-search';

/** Focus whichever field is currently mounted. A no-op if none is, which is not an error. */
export function focusSiteSearch(): void {
  const field = document.getElementById(SITE_SEARCH_ID);
  if (field instanceof HTMLInputElement) {
    field.focus();
    // Put the caret at the end rather than selecting the text: `/` is a jump-to-search
    // shortcut, and silently arming the next keystroke to replace an existing query is a
    // surprise a reader only discovers after losing what they typed.
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }
}

/**
 * Typed loosely so the rule is testable with a plain object, matching `keyboard.ts`.
 *
 * The search field is an `<input>`, so `isEditableTarget` is true for it — which is correct
 * for `/` (it must stay a slash while typing) and wrong for the arrow keys (§9 says `↓` from
 * the search field enters the result list). Callers need to tell the two apart.
 */
export const isSiteSearchTarget = (target: { id?: string } | null): boolean =>
  target?.id === SITE_SEARCH_ID;
