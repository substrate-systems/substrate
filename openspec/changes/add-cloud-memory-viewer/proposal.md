# Cloud memory viewer

## Why

Owners need to inspect their memory in the browser. The approved viewer has no application route or owner-bound cell bridge.

## What changes

- Add fixed map, search and note-read routes through the existing first-party browser channel.
- Build the supplied viewer with real graph identities, assistant retrieval and governed note reads.
- Preserve partial, unknown, empty and unreachable states without inventing backend results.
- Add the Home link when the viewer capability is enabled after its cell rollout.

## Impact

The web batch depends on the bounded `viewer_map` cell command. Existing `ask_memory` and `read_memory` supply search and note content.
The bridge reuses the current token mint, gateway checks and bounded MCP transport. It adds no SDK or database schema.
The maintenance cost is three fixed request shapes, their response projections and the supplied viewer components.
This change replaces the earlier viewer deferral only when its implementation and rollout are verified.
