# Design

## Contract

Use the approved viewer board and shared components. Preserve its desktop and phone reader replacement, themes, graph interaction and reduced motion.
Do not add the offered but undrawn neighbourhood strip. This delivery is read-only; it adds no review or graph mutation commands.

## Cell bridge

Reuse the first-party browser grant and short-lived token mint in `cloud-home-mcp.ts`.
Keep Home's existing operations unchanged. Add a narrow viewer wrapper for exactly `viewer_map`, `ask_memory` and `read_memory`.
Routes select the operation and all fixed arguments. A browser never selects a tool, gateway, tenant or cell.

All three routes use POST, strict bodies, the existing session resolver, Origin checks and CSRF validation.
Queries and note references stay out of URLs. The initial map returns the session's tenant binding.
Later reads carry that binding as a consistency check; the session remains the authorization source.
Reject a changed binding before minting a token or calling the cell. Clear cached content on authorization or account changes.

The map requests the protocol's 200-node and 400-edge drawing limits.
Search uses ordinary assistant retrieval with bounded results, without a deep or graph-enriched request.
FastMCP places the search list or envelope under `result`. Semantic-unit matches open their source-provided parent note.
The browser follows opaque continuation pages and preserves partial-search markers. It never reports a warming search as a complete empty result.
Read uses the existing governed note operation. Preserve canonical memory references and source paths without title-based resolution.
Selecting a note reads its actual preview through that same owner-bound route. Opening the reader makes a fresh authorization check.
Use the existing five-second timeout. Viewer answers have a one-mebibyte transport ceiling; Home keeps its existing ceiling.
A false size refusal costs an unavailable browser view and prevents an unbounded response from exhausting the web process.

## Honest data

Keep source coverage, observed counts, exact nullable totals and drawing limits separate.
Preserve relation instance and definition identities. Do not infer a relation's meaning from its spelling.
Build chips from the returned vocabulary. Reconcile any missing presentation metadata before implementing semantic line patterns.
Unknown review counts and dates remain unknown. The map cannot manufacture review state or claim that omitted nodes have known positions.

## Supplied components

Reuse the shared phone sheet for the peeking and expanded panels, with the same content in the desktop panel.
Use D3 for layout and drag, wheel and touch-pinch gestures. The supplied motion engine continues to animate the graph.
Keep edge labels inside the map and trim connections at solid node boundaries. Pausing motion does not mark a reachable view unavailable.

## Release

Use `EXOMEM_CLOUD_VIEWER_ENABLED` to expose the new viewer after the required cell capability is available.
An off flag hides only this unfinished capability; a false off delays access to the viewer.
Existing Home, signup and admission continue under their own controls.
Source publication and cell rollout retain their existing owners. Do not infer capability from source merge or package publication.
