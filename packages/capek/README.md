# @capekai/core

Bun-native agent framework contracts and runtime implementations for composition, execution, hosts, providers, tools, sandbox, and storage.

Requires Bun 1.3 or newer.

## Install

```bash
npm install @capekai/core
```
Public subpaths include `composition`, `plugins`, `hosts`, `execution`, `providers`, `tools`, `ask-authority`, `sandbox`, `workspace`, `configuration`, `tool`, and `storage`.

## Workspace policy

Čapek owns path resolution and containment. Embedding hosts can supply their own blocked paths, sensitive patterns, and home directory when composing an agent:

```ts
import { createComposition } from '@capekai/core/composition';

const composition = await createComposition(processScope, {
  ...values,
  workspacePolicy: {
    blockedPaths: ['/proc/', '/sys/'],
    sensitivePatterns: ['.env', '.pem', '.key'],
    homeDir: '/home/agent',
  },
});
```

Hosts building a custom plugin profile can configure the same policy directly:

```ts
import { workspacePolicyPlugin } from '@capekai/core/plugins';

workspacePolicyPlugin('host.workspace-policy', {
  blockedPaths: [],
  sensitivePatterns: ['credentials'],
  homeDir: '/srv/agent',
});
```

For workspace helpers used outside an agent scope, configure the process-wide policy during host bootstrap:

```ts
import { configureWorkspacePolicy } from '@capekai/core/workspace';

configureWorkspacePolicy({
  blockedPaths: ['/proc/', '/sys/'],
  sensitivePatterns: ['.env', '.pem', '.key'],
  homeDir: '/home/agent',
});
```

Call `configureWorkspacePolicy()` with no argument, or omit composition options, to retain the compatibility defaults.
