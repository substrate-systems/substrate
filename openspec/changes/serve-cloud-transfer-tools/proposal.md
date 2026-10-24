## Why

An assistant on the Cloud MCP URL can read and write memory, but it cannot see or control an import or an export. Those records belong to the control plane, and the gateway has no database access to them. The owner has to leave the assistant for Home or a terminal, and the assistant cannot say what happened.

## What Changes

- The gateway answers two tools, `observe_transfer` and `transfer_memory`, by calling the existing Substrate web API with the caller's own bearer. It answers them before the cell desired-state gate, so a held or stopped cell still lets its owner see and control a transfer.
- The tools return state, fixed next steps and confirmable actions. They never return upload URLs, recipients, export links or file bytes.
- The owner's export status, request and link routes accept the owner's Cloud OAuth bearer, through one resolver that imports share. This lets the Exomem command line download an export without a browser session.
- The export display includes the archive digest of a ready export, so the command line can verify its download.
- Home's "Your data" section gets a `#your-data` anchor that the tools link to.
- The tool names and actions come from a module that the existing instruction-block sync script generates from Exomem's tool schema fixture. The weekly drift job checks it.
- The flag `EXOMEM_CLOUD_TRANSFER_TOOLS_ENABLED` is off by default and with it off every request path is unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities

- `exomem-hosted-gateway`: Serve the Cloud transfer tools from the control plane.
- `exomem-tenant-control-plane`: Accept the owner's Cloud OAuth bearer on the export routes.

The export link requirement in `launch-exomem-cloud-web` (specs/exomem-home) said a link comes only from a Home request. It now says a Home request or a request that carries the owner's Cloud OAuth bearer, such as `exomem cloud export`. That change is still active and its delta is amended in place, dated 2026-10-24.

## Impact

The gateway gains one outbound HTTPS call to the public base URL, enabled by the Exomem chart flag `cloudGateway.transferTools.enabled`. It gains no database grant. The web app's export routes accept a second credential type. The Exomem registry, cell envelope and export command are a separate change in the Exomem repository.
