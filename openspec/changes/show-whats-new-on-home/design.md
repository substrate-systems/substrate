# Design

## Load target and latency

The project's load target is 10,000 tenants. Home already makes stateless gateway calls to the owner's own cell for levels and activity. The notes read is one more call of the same kind, issued in parallel with them, so it adds no serial latency to the Home live request. The cell answers it from memory with at most 20 releases. The dismissal is one indexed single-row update by tenant id. Nothing polls the notes.

## Decisions

### The cell is the source, Substrate keeps only the dismissal

Notes come from the image that runs, so Home never names a release the cell does not run. Substrate stores the version at which the owner pressed "Got it", nothing else.

### Which releases Home shows

Home shows each release whose version is newer than the dismissed version and not newer than the running version. Before any dismissal, it shows releases dated after the day the cell was created. Version order is semantic-version order of the release strings.

### The dismissal records the version the owner saw

"Got it" posts the running version that Home rendered, not the time. A release that arrives after the page loaded stays new. The route refuses a version that is not a release version string and keeps the higher of the stored and posted versions, so a stale tab cannot bring old notes back.
