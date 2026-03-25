# Manual Test: X Article Draft Lifecycle

This page summarizes the real-world regression flow used to verify X Articles support.

## Covered Flow

1. create a draft from markdown
2. add a cover image
3. read the draft by id
4. confirm it appears in the draft list
5. read the same draft by preview URL
6. update the draft body in place
7. reread and confirm the update
8. delete the temporary draft

## Why It Matters

This flow verifies the hardest article path in the current adapter:

- stable draft ids
- stable preview and edit URLs
- cover-image confirmation
- update in place without duplicate drafts

The longer operator-oriented version lives in the repo docs and is intended for maintainers.
