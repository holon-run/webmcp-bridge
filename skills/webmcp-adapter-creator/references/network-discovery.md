# Network Discovery

Discover the site's real read or write interface by observing actual browser behavior.

## Goal

Capture the request that the page already knows how to make, then reuse that shape from the page context.

This is usually more stable than trying to reconstruct auth headers or cookies outside the browser.

## Discovery Procedure

1. Open the target page in a real logged-in browser session.
2. Trigger one concrete action that matches the tool you want.
3. Observe network traffic and identify the request that produced the result.
4. Record the stable parts:
   - URL path
   - method
   - request body or query structure
   - variables payload
   - feature flags or toggles
   - cursor location for pagination
5. Record the variable parts separately:
   - item id
   - user id or screen name
   - query string
   - cursor
   - limit or count
6. Check whether the same request shape works across several examples.

## What To Look For

Look for a request shape that is:

- initiated by page code, not by a browser extension
- repeatable across multiple actions
- parameterized in obvious places
- valid inside `page.evaluate()` or in-page fetch

## Good Signals

Good candidates usually have:

- one stable endpoint path
- one stable request method
- a JSON variable payload that changes only in a few fields
- cursors embedded in response entries or metadata

## Bad Signals

Avoid anchoring the adapter on:

- volatile DOM class names alone
- one-off bootstrap responses that are not repeatable
- requests that only appear once during initial hydration and cannot be replayed in-page
- headers or tokens captured outside the browser and replayed from local-mcp

## Browser-Side Principle

The goal is not to emulate the site's auth model in Node.js.
The goal is to let the page execute the request while the browser session already holds the necessary auth state.
