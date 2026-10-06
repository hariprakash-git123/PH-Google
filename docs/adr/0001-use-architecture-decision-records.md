# 0001. Use architecture decision records

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

The project already carries several decisions whose reasoning exists nowhere in
the repository. Why OpenSearch replaced a working MongoDB inverted index; why
freshness is a bounded bucket rather than a decay curve; why images and videos
stayed in MongoDB when web search moved. Each was reasoned through carefully,
and each looks arbitrary to anyone reading the code afterwards.

Code comments explain how something works. They are a poor place for why an
alternative was rejected, because the alternative is not in the file.

## Decision

Record significant decisions as short numbered Markdown files in `docs/adr/`,
using the template in `0000-template.md`. Each states the context, the choice,
the alternatives, and the consequences.

Records are immutable. Overturning a decision means adding a new record and
marking the old one superseded, so the history stays legible.

## Alternatives considered

**A wiki or shared documents.** Separated from the code, so it goes stale
invisibly and is not reviewed alongside the change it describes.

**Commit messages.** The reasoning exists but is unfindable months later, and
`git log` is a poor index.

**Nothing, as now.** Cheapest today. The cost lands on whoever inherits the
code and re-argues a settled question — which for this project is the team
taking it over.

## Consequences

Each significant change carries a small writing cost, and a record that nobody
writes is worse than none because the index implies completeness.

The discipline is to write them for decisions, not for changes. Three good
records beat thirty that restate what the diff already says.
