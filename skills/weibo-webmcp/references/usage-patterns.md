# Usage Patterns

## Create or refresh the Weibo link

```bash
command -v weibo-webmcp-cli
skills/weibo-webmcp/scripts/ensure-links.sh
weibo-webmcp-cli bridge.session.status
```

## Authenticate the managed Weibo profile

```bash
weibo-webmcp-cli auth.get
weibo-webmcp-cli bridge.session.bootstrap
weibo-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
weibo-webmcp-cli bridge.open
```

## Read home timeline and posts

```bash
weibo-webmcp-cli timeline.home.list limit=10
weibo-webmcp-cli post.get '{"id":"5279584255214211"}'
weibo-webmcp-cli post.replies.list '{"id":"5279584255214211"}'
weibo-webmcp-cli post.repost.list '{"id":"5279584255214211"}'
```

## Dry-run writes first

```bash
weibo-webmcp-cli post.create '{"text":"webmcp dry run","dryRun":true}'
weibo-webmcp-cli comment.create '{"id":"5279584255214211","text":"webmcp dry run","dryRun":true}'
weibo-webmcp-cli article.listDrafts
weibo-webmcp-cli article.draftMarkdown '{"markdownPath":"/abs/path/article.md"}'
weibo-webmcp-cli article.publishMarkdown '{"markdownPath":"/abs/path/article.md","coverImagePath":"/abs/path/cover.png","dryRun":true}'
```

## Read profiles and user posts

```bash
weibo-webmcp-cli user.get screenName=jolestar
weibo-webmcp-cli user.posts.list '{"uid":"1648815335"}'
```

## Search Weibo and read AI summary

```bash
weibo-webmcp-cli search.weibo '{"query":"OpenAI","limit":10}'
weibo-webmcp-cli search.ai.summary '{"query":"OpenAI"}'
```
