# Adapter Runtime Patterns

These patterns come from real adapter work where a site's UI was not stable enough to support a DOM-first implementation.

Use them when a fallback adapter needs authenticated reads or writes that are driven by browser-side requests.

## 1. Prefer Real Request Interception Over Reconstructed Fetch

If the page already knows how to make the request, intercept that real request before trying to reconstruct it yourself.

Why:

- manually replaying auth-heavy requests often fails even when URL and body look correct
- dynamic headers, transaction ids, and internal conversation state are easy to miss
- the page's own request shape is usually the most reliable source of truth

Recommended order:

1. intercept the real browser request
2. inspect whether the intercepted response already contains the data you need
3. only fall back to manual in-page replay if interception cannot expose the response body

## 2. `route.fetch()` Is Better Than DOM Guessing For Streamed Responses

For some sites, the request is normal HTTP but the response is streamed or chunked.

In this case:

- CDP `getResponseBody` may return nothing useful
- DOM extraction often captures intermediate UI text instead of the final answer
- `page.route(..., route => route.fetch())` can still read the real response text

Recommended pattern:

1. intercept the real request with `page.route`
2. skip preflight `OPTIONS`
3. call `route.fetch()`
4. read the response text
5. parse the stream format
6. `route.fulfill({ response })` so the page still behaves normally

This lets the adapter observe the site's real response while preserving the page's normal execution path.

## 3. Treat Sessions As First-Class Tool Inputs

If the upstream product has a session or conversation concept, the adapter should expose it explicitly.

Do not rely on "whatever page is currently open" as the conversation source.

Recommended tool contract:

- default behavior creates a new session
- optional `conversationId` continues an existing session
- return `conversationId` in successful results

This makes agent behavior reproducible and avoids hidden context leaks between calls.

## 4. New Session Must Be Explicit, Not Implicit

If the tool should start a fresh session when no session id is supplied, make that an explicit browser action.

Example pattern:

1. open the product landing route
2. detect the current session id from the URL or page state
3. click `New Chat` or equivalent
4. wait until the previous session id disappears or changes
5. only then send the new request

Do not assume that navigating to the same route automatically starts a new session.

## 5. Parse The Protocol, Not The Rendered Text

For assistant-like products, the DOM often exposes:

- thinking text
- partial tokens
- button labels
- suggestion chips
- replay artifacts

If the response stream contains structured events, parse those instead of reading visible text.

Look for fields such as:

- event type
- message tag
- final chunk markers
- conversation/session ids

Then build the final answer from the protocol itself.

## 6. Keep DOM As Fallback Only

DOM extraction is still useful, but only as a last resort.

Use DOM fallback when:

- the request cannot be intercepted
- the response body is unavailable
- the upstream site changed and the request path is temporarily broken

When falling back:

- return a clear reason internally or in debug output
- keep DOM parsing narrow and conservative
- prefer fail-closed over silently returning noisy text

## 7. Validate Runtime Assumptions With Minimal Probes

When adapter behavior is ambiguous, write a tiny probe before rewriting production code.

Good probe targets:

- can `route.fetch()` read the body?
- is the response streamed or plain JSON?
- does manual in-page replay return 404 or CORS failure?
- does the page use a new session by default or preserve the old one?

These probes help separate:

- a bad implementation idea
- a good idea with one missing runtime detail

## 8. Keep The Reusable Logic In Patterns, Not Site Constants

The reusable part is usually the execution pattern, not the exact endpoint name.

Examples of reusable adapter-library patterns:

- request interception wrappers
- streamed NDJSON parsing helpers
- session-aware tool input/output conventions
- "network first, DOM fallback" execution scaffolding
- explicit confirmation and fail-closed result mapping

Examples of site-specific details that should stay in the adapter:

- endpoint paths
- query ids
- request body fields
- URL shapes
- product button labels

When documenting or extracting shared helpers, keep this boundary explicit.

## 9. Prefer A Small Shared Utility Layer For Cross-Site Pieces

If several adapters need the same low-level mechanics, put them in a shared adapter utility package instead of copying them between site adapters.

Good candidates for that package:

- text normalization and dedupe helpers
- streamed NDJSON parsing helpers
- routed-response capture helpers around `page.route(...)/route.fetch()`
- request-template data structures and simple cache helpers
- generic request-capture script builders for page-side fetch/XHR recording

Keep these out of the shared package:

- site endpoint names
- query ids
- site-specific request matchers
- response parsers tied to one product
- button labels and DOM selectors with product semantics

Use the shared package for low-level mechanics, then keep matching, templating, and response interpretation inside the site adapter.

If you discover a reusable helper while building an adapter and it looks broadly useful, consider contributing it back to the `webmcp-bridge` repository as a focused PR.
