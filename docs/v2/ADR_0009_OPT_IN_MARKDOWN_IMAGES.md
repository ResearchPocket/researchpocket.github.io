# ADR 0009: Load remote Markdown images only after per-item consent

- Status: accepted
- Date: 2026-07-27
- Issue: [#125](https://github.com/ResearchPocket/researchpocket.github.io/issues/125)

## Context

Firecrawl may retain bounded cleaned Markdown in an item's excerpt. That
Markdown can reference diagrams, screenshots, and other images useful to the
owner, but fetching them automatically would disclose a library-reading event
to arbitrary third-party hosts. The existing Reader therefore rendered every
image as inert text and the owner CSP denied remote images.

An image proxy would hide the owner's address from the source host, but it would
introduce a hosted backend, transfer private browsing choices to that service,
and weaken the offline/local-first boundary. Downloading image bytes into the
library would create an attachment and archive system outside V2 scope.

## Decision

Markdown images remain inert by default. Each inert image explains that loading
contacts its host and may reveal the owner's IP address. Choosing **Load images
for this item** enables valid HTTPS image sources only for that item while the
current Reader remains open.

The permission is React presentation state keyed by item UUID. It is not a
domain field, IndexedDB preference, protocol operation, export field, or
publication setting. Moving to another item does not grant that item
permission; returning to an already allowed item in the same Reader session
retains it. Closing the Reader unmounts the state and forgets every grant.

Relative image sources resolve against the saved item's URL. Only HTTPS URLs
without embedded credentials render. Images use lazy loading, asynchronous
decoding, useful alternative text, and `Referrer-Policy: no-referrer`. Raw HTML
remains disabled. Invalid, malformed, HTTP, data, blob, file, JavaScript, and
credential-bearing sources stay inert.

The owner document permits `img-src 'self' https:` so an opted-in image can
load. Script, style, font, frame, object, worker, and connection policies do not
change. The public landing, overview, and documentation documents retain
self-only image policies, and their Markdown renderer receives no image-loading
action. Cross-origin image requests bypass the service worker and are never
stored in ResearchPocket's shell cache.

## Consequences

The image host learns the owner's IP address, user agent, request timing, and
any cookies the browser elects to attach. Omitting the referrer prevents
disclosure of the ResearchPocket URL but cannot hide the network request
itself. Browser HTTP caches may retain image bytes outside ResearchPocket's
application storage controls.

The CSP can no longer independently prove that owner mode never fetches a
remote image. Safety instead depends on inert-by-default Markdown components,
explicit item-scoped consent, HTTPS URL validation, the owner-only CSP
exception, and production checks that keep public documents self-only.

Images are not available offline unless the browser independently retained
them, and ResearchPocket makes no promise about that cache. Broken, blocked, or
tracking-protected images do not affect the saved Markdown or local library.
