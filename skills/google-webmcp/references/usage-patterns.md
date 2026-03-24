# Usage Patterns

## Create or refresh the Google link

```bash
command -v google-webmcp-cli
skills/google-webmcp/scripts/ensure-links.sh
google-webmcp-cli bridge.session.status
```

## Authenticate the managed Google profile

```bash
google-webmcp-cli auth.get
google-webmcp-cli bridge.session.bootstrap
google-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
google-webmcp-cli bridge.open
```

## Search the web

```bash
google-webmcp-cli search.web '{"query":"playwright browser automation","limit":10}'
```

## Chat with Gemini

```bash
google-webmcp-cli gemini.chat '{"prompt":"Summarize these results","mode":"text","timeoutMs":180000}'
google-webmcp-cli gemini.chat '{"prompt":"a watercolor fox reading documentation","mode":"image","timeoutMs":300000}'
```

## Download generated images

```bash
google-webmcp-cli gemini.image.download '{"limit":4,"timeoutMs":120000}'
```
