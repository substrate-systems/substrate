## ADDED Requirements

### Requirement: Home shows what changed since the owner last looked

When the owner's cell serves release notes, Home SHALL show a "What's new" line under its status. The line SHALL open the notes of each release newer than the dismissed version and not newer than the running version, by release day, newest first. Before the owner's first dismissal, Home SHALL show only releases dated after the day the cell was created. Home SHALL show no line when no release qualifies, when the cell image serves no notes, or when the cell cannot be reached.

#### Scenario: A new release carries a note

- **WHEN** the cell moved from 1.2.0 to 1.3.0, 1.3.0 has a note, and the owner dismissed at 1.2.0
- **THEN** Home shows the What's new line, and opening it shows the 1.3.0 note

#### Scenario: New owner

- **WHEN** an owner whose cell was created today opens Home for the first time
- **THEN** Home shows no notes from releases before today

#### Scenario: Older cell image

- **WHEN** the cell does not serve the `whats_new` section
- **THEN** Home shows no What's new line and no error

### Requirement: The owner dismisses What's new

The line and its opened notes SHALL offer "Got it", which records the version Home rendered for the owner's tenant. The record SHALL keep the higher of the stored and posted versions and SHALL refuse a value that is not a release version. After a dismissal, a reload SHALL show no notes up to that version.

#### Scenario: Owner presses Got it

- **WHEN** the owner presses "Got it" on notes up to 1.3.0 and reloads Home
- **THEN** Home shows no What's new line until a newer release with a note arrives

#### Scenario: Stale tab

- **WHEN** a tab still showing 1.2.0 posts a dismissal after another tab dismissed at 1.3.0
- **THEN** the stored version stays 1.3.0
