# Capek

Capek is a Bun-native, composable agent runtime. This repository contains the runtime, shared contracts, and tool authoring contracts used by Capek hosts.

## Packages

| Package | Purpose |
| --- | --- |
| [`@capekai/core`](packages/capek) | Agent execution, composition, providers, tools, storage, workflows, memory, skills, and sandbox behavior |
| [`@capekai/types`](packages/capek-types) | Shared runtime, event, conversation, and wire contracts |
| [`@capekai/tool`](packages/capek-tool) | Contracts for authoring tools and install manifests |

## Requirements

- Bun 1.3 or newer

## Setup

```bash
bun install
```

## Development

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Run a focused package test while developing:

```bash
bun run test:core
bun run test:tool
bun run test:types
```

## License

MIT
