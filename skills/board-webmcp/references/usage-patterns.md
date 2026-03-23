# Usage Patterns

## Create or refresh links

```bash
command -v board-webmcp
skills/board-webmcp/scripts/ensure-links.sh
board-webmcp -h
```

## Read path

```bash
board-webmcp nodes.list
board-webmcp edges.list
```

For a human + AI collaborative session on the same visible board, switch the runtime first:

```bash
board-webmcp bridge.session.mode.get
board-webmcp bridge.session.mode.set '{"mode":"headed"}'
board-webmcp bridge.open
board-webmcp diagram.get
board-webmcp nodes.list
board-webmcp edges.list
```

Inspect a specific tool first when the payload matters:

```bash
board-webmcp nodes.upsert -h
board-webmcp edges.upsert -h
board-webmcp layout.apply -h
```

## Write path

Create or update nodes:

```bash
board-webmcp nodes.upsert '{"nodes":[{"label":"Fraud Service","kind":"service","x":1440,"y":120}]}'
```

Create or update edges:

```bash
board-webmcp edges.upsert '{"edges":[{"sourceNodeId":"gateway","targetNodeId":"orders","protocol":"grpc"}]}'
```

Apply deterministic layout:

```bash
board-webmcp layout.apply mode=grid
```

Export the document:

```bash
board-webmcp diagram.export format=json
```

For a collaborative visible session, use the same operations after switching to `headed`:

```bash
board-webmcp nodes.upsert '{"nodes":[{"label":"Fraud Service","kind":"service","x":1440,"y":120}]}'
board-webmcp edges.upsert '{"edges":[{"sourceNodeId":"gateway","targetNodeId":"orders","protocol":"grpc"}]}'
board-webmcp layout.apply mode=grid
board-webmcp diagram.export format=json
```

## Local development target

```bash
skills/board-webmcp/scripts/ensure-links.sh --url http://127.0.0.1:4173
```

## UI collaboration session

```bash
board-webmcp bridge.session.mode.set '{"mode":"headed"}'
board-webmcp bridge.open
board-webmcp selection.get
board-webmcp bridge.close
```
