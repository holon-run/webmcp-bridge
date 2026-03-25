# Security

## Principles

- Operate only inside user-owned authenticated browser sessions.
- Keep tokens/cookies in browser profile storage; avoid exporting secrets.
- Execute privileged site actions through browser-side WebMCP or shim fallback paths, not by storing external credentials in local-mcp.
- Return least data needed for tool responses.
- Keep the project focused on research, development, testing, and normal user-authorized workflows, not unauthorized collection.

## Operational guidance

- Run with dedicated automation profiles per account.
- Keep adapter logging redacted by default.
- Treat unknown upstream UI states as errors (`AUTH_REQUIRED`, `UPSTREAM_CHANGED`).

## Acceptable Use

- Do not use repository-provided adapters as a framework for unauthorized data harvesting or bulk scraping.
- Do not use the bridge to bypass authentication, access controls, rate limits, or platform restrictions.
- Do not use it for abusive automation, privacy-invasive collection, or conduct that violates website terms or law.
- The operator is responsible for ensuring each use is compliant with applicable laws, platform rules, and contractual terms.
