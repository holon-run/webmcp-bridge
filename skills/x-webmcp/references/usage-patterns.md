# Usage Patterns

## Create or refresh the X link

```bash
command -v x-webmcp-cli
skills/x-webmcp/scripts/ensure-links.sh
x-webmcp-cli bridge.session.status
```

## Authenticate the managed X profile

```bash
x-webmcp-cli auth.get
x-webmcp-cli bridge.session.bootstrap
x-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
x-webmcp-cli bridge.open
```

## Read timelines and conversations

```bash
x-webmcp-cli timeline.home.list limit=10
x-webmcp-cli search.tweets.list '{"query":"playwright","mode":"latest","limit":10}'
x-webmcp-cli tweet.conversation.get '{"id":"2033895522382319922","limit":10}'
```

## Chat with Grok

```bash
x-webmcp-cli grok.chat '{"prompt":"Summarize the latest replies in this thread","timeoutMs":180000}'
```

## Dry-run a post or article publish

```bash
x-webmcp-cli tweet.create '{"text":"hello from webmcp","dryRun":true}'
x-webmcp-cli article.publishMarkdown '{"markdownPath":"/abs/path/post.md","dryRun":true}'
```
