# Usage Patterns

## Create or refresh links

```bash
command -v board-webmcp-cli
skills/board-webmcp/scripts/ensure-links.sh
board-webmcp-cli -h
```

## Read path

```bash
board-webmcp-cli nodes.list
board-webmcp-cli edges.list
```

For a human + AI collaborative session on the same visible board, switch the runtime first:

```bash
board-webmcp-cli bridge.session.mode.get
board-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
board-webmcp-cli bridge.open
board-webmcp-cli diagram.get
board-webmcp-cli nodes.list
board-webmcp-cli edges.list
```

Inspect a specific tool first when the payload matters:

```bash
board-webmcp-cli nodes.upsert -h
board-webmcp-cli edges.upsert -h
board-webmcp-cli layout.apply -h
```

## Write path

Create or update nodes:

```bash
board-webmcp-cli nodes.upsert '{"nodes":[{"label":"Fraud Service","kind":"service","x":1440,"y":120}]}'
```

Create or update edges:

```bash
board-webmcp-cli edges.upsert '{"edges":[{"sourceNodeId":"gateway","targetNodeId":"orders","protocol":"grpc"}]}'
```

Apply deterministic layout:

```bash
board-webmcp-cli layout.apply mode=grid
```

Export the document:

```bash
board-webmcp-cli diagram.export format=json
```

For a collaborative visible session, use the same operations after switching to `headed`:

```bash
board-webmcp-cli nodes.upsert '{"nodes":[{"label":"Fraud Service","kind":"service","x":1440,"y":120}]}'
board-webmcp-cli edges.upsert '{"edges":[{"sourceNodeId":"gateway","targetNodeId":"orders","protocol":"grpc"}]}'
board-webmcp-cli layout.apply mode=grid
board-webmcp-cli diagram.export format=json
```

## Local development target

```bash
skills/board-webmcp/scripts/ensure-links.sh --url http://127.0.0.1:4173
```

## UI collaboration session

```bash
board-webmcp-cli bridge.session.mode.set '{"mode":"headed"}'
board-webmcp-cli bridge.open
board-webmcp-cli selection.get
board-webmcp-cli bridge.close
```
