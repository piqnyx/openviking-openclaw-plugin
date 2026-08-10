# OpenViking for OpenClaw with per-agent account isolation

This repository is a focused fork of the OpenViking OpenClaw context-engine plugin, based on upstream plugin version **2026.7.15**.

The fork keeps the upstream context-engine behavior while routing each OpenClaw agent to a separate OpenViking account/API key. Release **2026.7.15-isolation.6** also adds a guarded `remove_resource` tool backed by the OpenViking filesystem DELETE API.

## Design goals

- Preserve upstream OpenViking/OpenClaw behavior unless a change is required for per-agent account isolation or `remove_resource`.
- Keep each OpenClaw agent in a separate OpenViking account.
- Route unattributed traffic to a dedicated system account instead of guessing another agent.
- Keep destructive resource deletion disabled unless explicitly enabled.
- Let OpenViking perform deletion, vector cleanup, resource-memory reference cleanup, and semantic refresh using its own server-side implementation.
- Return OpenViking deletion status to the calling agent instead of reporting success before consistency work has finished.

## Compatibility

| Component | Version |
| --- | --- |
| Forked OpenViking OpenClaw plugin | 2026.7.15 |
| This release | 2026.7.15-isolation.6 |
| Minimum OpenClaw | 2026.5.27 |
| Minimum OpenViking for this release | 0.4.4 |
| Recommended/tested OpenViking | 0.4.12 |

`remove_resource` relies on the OpenViking filesystem DELETE API with `wait`/`timeout` support and semantic cleanup status. OpenViking 0.4.12 is the deployment target used for the final implementation audit.

## Changes from upstream

The isolation layer is intentionally narrow:

| Area | Change |
| --- | --- |
| `agent-keys.ts` | Loads the per-agent API-key map and enforces fail-closed key rules. |
| `plugin/openviking-client-runtime.ts` | Maintains one OpenViking client per configured account instead of one shared client. |
| `plugin/openviking-session-routing-runtime.ts` | Sends unresolved sessions to the system account instead of guessing `main`. |
| `config.ts`, `openclaw.plugin.json` | Add `agentKeysFile` and related configuration. |
| Runtime call sites | Pass the resolved OpenClaw agent ID to client selection. |

Release `isolation.6` adds only the resource-removal path on top of that baseline:

| Area | Change |
| --- | --- |
| `client.ts` | Adds the OpenViking `removeResource()` client call and a resource-only destructive URI guard. |
| `plugin/openviking-import-tools.ts` | Registers the agent-facing `remove_resource` tool. |
| `config.ts`, `registries/openviking-tools.ts` | Add the explicit destructive-tool gate and the `resource_manage` tool group. |
| Plugin manifest/schema | Expose `enableRemoveResourceTool` and `remove_resource`. |
| Tests | Cover API contract, destructive boundary, per-agent routing, wait behavior, and configuration gating. |

The existing `add_resource` path, memory tools, session routing logic, context engine, recall logic, and per-agent client runtime are not rewritten for `remove_resource`.

## Account model

Create one OpenViking account/user for every OpenClaw agent plus a system fallback account. For example:

```text
openclaw-system / agent-system
openclaw-main   / agent-main
openclaw-igor   / agent-igor
openclaw-kate   / agent-kate
```

The plugin normally runs with:

```jsonc
{
  "peer_role": "none",
  "peer_prefix": ""
}
```

Isolation is therefore enforced by the OpenViking account/API-key boundary rather than by peer folders inside one shared account.

## Build and verify

```bash
npm ci
npm run verify
npm run typecheck
```

`npm run verify` performs a clean TypeScript build and runs the Vitest suite. `npm run typecheck` checks the full TypeScript project, including tests.

OpenClaw loads `dist/`, so rebuild after any source change.

## OpenClaw installation

Register the checked-out plugin directory as a linked plugin:

```bash
openclaw plugins install --link /path/to/openviking-openclaw-plugin --force
```

The plugin ID remains `openviking`, matching upstream. Do not register the upstream plugin and this fork at the same time because both use the same plugin ID and context-engine slot.

If a fresh installation is disabled until configuration is present:

```bash
openclaw plugins enable openviking
```

## OpenClaw configuration

Example:

```jsonc
{
  "plugins": {
    "slots": {
      "contextEngine": "openviking"
    },
    "entries": {
      "openviking": {
        "config": {
          "baseUrl": "http://127.0.0.1:1933",
          "peer_role": "none",
          "peer_prefix": "",
          "apiKey": "<system-account-api-key>",
          "agentKeysFile": "/home/openclaw/memory/secrets/openviking-keys/secrets.conf",
          "enableRemoveResourceTool": true
        }
      }
    }
  }
}
```

Important fields:

- `apiKey` is the system-account key used only when an OpenClaw request cannot be attributed to a configured agent.
- `agentKeysFile` maps OpenClaw agent IDs to their dedicated OpenViking API keys.
- `peer_prefix` should remain empty for the account-per-agent deployment model.
- `enableRemoveResourceTool` is `false` unless explicitly set to `true`.

Enabling `remove_resource` through `enabledTools`, `enabledTools: "all"`, or a tool group does **not** bypass the destructive safety flag. `enableRemoveResourceTool: true` is required. `disabledTools` still wins and can disable it again.

## Agent key file

Default path:

```text
/home/openclaw/memory/secrets/openviking-keys/secrets.conf
```

Recommended permissions:

```bash
install -d -m 700 /home/openclaw/memory/secrets/openviking-keys
install -m 600 /dev/null /home/openclaw/memory/secrets/openviking-keys/secrets.conf
```

Example content:

```ini
main = <openclaw-main-api-key>
igor = <openclaw-igor-api-key>
kate = <openclaw-kate-api-key>
```

The parser accepts blank lines, `#`/`;` comments, quoted values, and an optional `[agents]` section header.

The plugin refuses unsafe key maps, including:

- duplicate agent IDs;
- empty or malformed entries;
- two agents sharing the same API key;
- an agent key equal to the system key;
- configured agent keys without a system fallback key;
- an explicitly configured key file that cannot be read.

A key file readable by users other than its owner produces a permissions warning. The file is loaded at gateway startup, so restart the gateway after changing it.

## Agent attribution

The plugin resolves the agent from OpenClaw context and session identity, then selects that agent's OpenViking client/API key.

If attribution fails, the request is routed to the dedicated system OpenViking account. It is never silently assigned to another configured agent.

Routing diagnostics can be enabled with:

```jsonc
{
  "logFindRequests": true
}
```

or:

```bash
OPENVIKING_LOG_ROUTING=1
```

API keys are not written to routing logs.

## `remove_resource`

`remove_resource` deletes a file or directory below `viking://resources/` through the OpenViking filesystem API.

Example agent-level parameters:

```json
{
  "uri": "viking://resources/workspace",
  "recursive": true,
  "wait": true,
  "timeout": 900
}
```

### Safety boundary

The tool accepts only descendants of:

```text
viking://resources/
```

It refuses:

- `viking://resources` itself;
- memories, sessions, skills, and other namespaces;
- empty path segments;
- raw `.` or `..` path segments;
- raw backslash path separators;
- ambiguous raw `?` suffixes.

The validator intentionally does **not** percent-decode Viking URI path components. OpenViking treats percent sequences in the received Viking URI as literal path data; the plugin does not invent a second decoding step before a destructive operation.

To remove all resources, list `viking://resources` first and remove its top-level children individually. The root itself cannot be deleted through this tool.

### Recursive deletion

`recursive` defaults to `false`, matching the OpenViking API. A non-empty directory therefore requires:

```json
{
  "recursive": true
}
```

The plugin does not silently promote a failed non-recursive request into a recursive delete.

### Waiting and consistency

The agent-facing tool defaults `wait` to `true`.

With `wait=true`, the plugin sends the DELETE request with OpenViking wait semantics and waits for that request to finish. OpenViking remains responsible for filesystem deletion, vector-index cleanup, resource-memory reference cleanup, and semantic refresh.

The plugin does not perform its own Qdrant deletion, reindex, relation repair, or semantic refresh.

The structured OpenViking result is propagated in tool `details`, including fields such as:

- `uri`;
- `estimated_deleted_count`;
- `memory_cleanup`;
- `semantic_root_uri`;
- `semantic_status`;
- `queue_status`.

Known semantic states on the tested OpenViking server are:

- `complete`: the waited semantic refresh completed;
- `queued`: consistency work was queued and is still pending, normally when `wait=false` was explicitly requested;
- `failed`: the resource was removed but semantic refresh reported a failure.

If the DELETE request itself fails or times out, the tool throws instead of returning a false success. Because OpenViking deletion is idempotent for valid URIs, callers can inspect the resource state and retry deliberately when necessary.

### Tool groups

`remove_resource` belongs to:

```text
resource_manage
```

The existing import group remains:

```text
import = add_resource, add_skill
```

This keeps destructive resource management separate from resource ingestion.

## Post-start checks

Confirm that per-agent credentials loaded:

```bash
grep -a "openviking: per-agent credentials loaded" /tmp/openclaw/openclaw-$(date +%F).log
```

Then verify, in this order:

1. the `openviking` context engine is loaded;
2. normal recall still works for an existing agent;
3. `add_resource` still imports a disposable resource into that agent's account;
4. another agent cannot see that resource through its own OpenViking account;
5. `remove_resource` removes the disposable resource;
6. a recursive test directory disappears together with its descendants;
7. a protected URI such as `viking://resources` is rejected before an HTTP DELETE is sent.

## Updating an existing linked installation

For an existing checkout:

```bash
npm ci
npm run verify
npm run typecheck
```

After rebuilding, restart the OpenClaw gateway so it loads the new `dist/` files.

For a production replacement, keep the previous working source directory and the existing agent-key file intact until the new checkout has passed startup and smoke checks. This makes rollback a registration/configuration change instead of a data-recovery exercise.

## Minimal tool profiles

When OpenClaw uses a restrictive tool profile, plugin tools must also be allowed by the relevant OpenClaw tool policy. Enabling a tool in this plugin does not override OpenClaw's own tool/sandbox permissions.

## License

MIT, matching the upstream OpenViking OpenClaw plugin.
