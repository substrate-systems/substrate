# Design

The website MUST expose only the two current paid paths: Supporter recognition
and Hosted Backup. The generic Paddle client therefore has no default Endstate
purchase action; callers provide an explicit checkout action.

The existing Supporter Paddle destination remains at `/api/license/webhook` to
avoid an unnecessary dashboard migration. It verifies signatures and handles
the configured Supporter price. Every other `transaction.completed` item is
acknowledged and ignored. It MUST NOT mint a license key.

Because no lifetime licenses were sold, there is no compatibility obligation
for activation or deactivation. Those endpoints and their private-key, database,
email-template, schema-bootstrap, and manual-test support are removed rather than
left dormant.
