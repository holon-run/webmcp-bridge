# Request Template Patterns

Turn one successful observed request into a reusable template.

## Template Shape

A practical template usually needs:

- `url`
- `method`
- a sanitized header subset when required by in-page fetch
- stable query parameters or body sections
- placeholders for variable fields

For pagination-capable reads, also define:

- where the incoming cursor goes
- where the next cursor is extracted from the response

## Extraction Strategy

1. Capture one successful request.
2. Remove values that should not be hard-coded forever.
3. Keep only the minimal stable request shape.
4. Replace changeable values with adapter-level variables.

Typical variable fields:

- `tweetId`
- `userId`
- `screenName`
- `query`
- `cursor`
- `count`

## Execution Pattern

Inside the adapter, execute the request from the page context:

- build the next request URL or body from the template
- inject variable fields
- call `fetch()` in the page context
- parse the JSON response
- extract `items` and optional `nextCursor`

## Fallback Pattern

When there is no captured template yet, or the request fails after an upstream site change:

- return `source: "dom"`
- include a concrete `reason`, such as `no_template` or `request_failed`
- fall back to DOM extraction only if the DOM path is still meaningful

## Cache Scope

Template caching should be explicit.

Reasonable cache scopes:

- page lifetime cache for one navigation session
- process-level cache for repeated reads in one bridge process

Refresh the template when:

- the page navigates to a materially different route
- the request starts failing in a way that suggests upstream changes
- response parsing no longer matches the previous shape
