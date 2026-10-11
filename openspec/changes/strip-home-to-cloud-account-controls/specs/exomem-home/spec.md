## REMOVED Requirements

### Requirement: First use teaches capture through immediate recall

**Reason**: Every tenant runs on Exomem Cloud, and this control called a route that reaches only the retired Hosted cells, so it failed for every tenant.

**Migration**: Use the assistant connected through the Cloud connector. The redesigned Home brings these controls back through the tenant's cell.

### Requirement: Capture is simple but governed

**Reason**: Every tenant runs on Exomem Cloud, and this control called a route that reaches only the retired Hosted cells, so it failed for every tenant.

**Migration**: Use the assistant connected through the Cloud connector. The redesigned Home brings these controls back through the tenant's cell.

### Requirement: Recall exposes useful results without infrastructure jargon

**Reason**: Every tenant runs on Exomem Cloud, and this control called a route that reaches only the retired Hosted cells, so it failed for every tenant.

**Migration**: Use the assistant connected through the Cloud connector. The redesigned Home brings these controls back through the tenant's cell.

### Requirement: Recent memory and review are secondary progressive disclosures

**Reason**: Every tenant runs on Exomem Cloud, and this control called a route that reaches only the retired Hosted cells, so it failed for every tenant.

**Migration**: Use the assistant connected through the Cloud connector. The redesigned Home brings these controls back through the tenant's cell.

### Requirement: Upload and download remain tenant scoped

**Reason**: Every tenant runs on Exomem Cloud, and this control called a route that reaches only the retired Hosted cells, so it failed for every tenant.

**Migration**: Use the assistant connected through the Cloud connector. The redesigned Home brings these controls back through the tenant's cell.

## MODIFIED Requirements

### Requirement: Portability and account controls are understandable and safe

Home SHALL provide service status, billing source/status, sign-out, and product-scoped deletion. A tenant SHALL get a portable export by asking support. Home SHALL NOT offer a control whose route cannot reach the tenant's cell. Destructive deletion MUST use a fresh single-use confirmation and distinguish queued work from completed destruction.

#### Scenario: Home offers no control that cannot reach the tenant's cell

- **WHEN** a ready Cloud tenant opens Home and uses every control on it
- **THEN** no request goes to a route that reaches only Hosted cells

#### Scenario: Owner requests export

- **WHEN** an owner wants a portable export
- **THEN** they ask support, as the privacy page says, and receive an export encrypted to a key only they hold

#### Scenario: Owner starts deletion

- **WHEN** an owner initiates deletion
- **THEN** Home explains that Exomem data will be removed while unrelated products remain, sends a fresh confirmation, and does not delete on the first click

#### Scenario: Deletion is still destroying storage

- **WHEN** the cell is sealed but external destruction is pending
- **THEN** Home says deletion is in progress and offers no capture/recall surface
