# Build your exo-brain

A fleet running for two weeks captured 327 sessions and 91 commits on its own, and linked exactly
zero of its decisions to the reasoning behind them. That gap is the difference between a log and an
exo-brain, and closing it takes one command.

Wire the hooks (see [GETTING_STARTED](GETTING_STARTED.md)) and half the graph fills itself: every
session, every commit, every project, no effort from you. The other half you record on purpose, and
most people skip it: the decisions you make and the concepts behind them. This guide
covers the six node types, what a good one looks like, and the one edge that turns recorded activity
into memory you can query later.

The examples use `focus` as shorthand for `bun ~/dev/focus-timer-tools/cli/src/index.ts`. Alias it in
your shell.

## A real graph, two weeks in

Here is an actual fleet after two weeks of daily use:

- 327 agent sessions across 7 projects
- 91 commits, captured hands-free
- 7 decisions, 6 knowledge concepts
- 0 links between them

The automatic layer is full. The deliberate layer is thin, and nothing connects a decision to the
knowledge behind it, so the graph knows what happened but not why. And 302 of those 327 sessions
landed in a single project bucket, because the agents ran from a home directory instead of a named
repo. Name your projects and that doesn't happen to you.

## The six node types

Two of these fill themselves. Four you shape.

### Project
The workstream a session belongs to. Set it per repo or per initiative. Let it default to wherever
an agent happens to run and every session piles into one bucket, at which point the graph stops
telling you anything about where the work went.

### Agent / session
One run of one agent. Created automatically, with a live status of working, needs-you, or done. When
you run several at once, give them stable ids so you can tell them apart later.

### Task
Groups two or more sessions working the same thing. It appears the moment a report carries a `task`.
Use it whenever you fan out parallel agents on one goal. Without it, coordinated work shows up as
scattered and unrelated. In the graph above there are zero tasks, so every parallel push reads as solo.

### Commit / output
What actually shipped. The commit hook captures each one from git, along with the files it touched.
This is the concrete artifact a decision produced.

### Decision
A fork you took, and the road you didn't. You record it with `focus decide`. A good decision names
the alternative and the reason you passed on it. Real ones from the graph above:

- Chose full auth over shipping the cleartext-userId version
- Inject the key through launchd, not settings.json, so no secret lands on disk
- Made the agent functions internal behind a Bearer layer

Each states the choice and what it beat. That is the shape. A decision with no citation still gets
recorded, but the system marks it a knowledge-gap: kept, not connected.

### Knowledge
A reusable lesson, addressable by slug. Not a status update, but a concept you would cite again from
a different project. Record it with `focus learn`. Examples from the same graph:

- `launchagent-key-injection-for-gui-apps`
- `hybrid-provenance-capture`
- `full-auth-over-cleartext-userid`

Search before you write one, so you cite the concept that already exists instead of minting a
near-duplicate.

## The one edge that matters

Everything except decisions and knowledge fills itself. The single link you draw by hand is a
decision pointing at the knowledge behind it:

```bash
focus recall "how did we handle auth"                       # find the concept
focus learn  "Full auth over cleartext userId" body="…"     # only if it's new
focus decide "chose full auth over cleartext" cites=knowledge:full-auth-over-cleartext-userid
```

That `cites=` writes the decision-to-knowledge link. Months later you can ask why something is built
the way it is and get the concept, the decision that applied it, and the commits that followed, as
one connected thread. The hooks cannot infer this for you, because only you know what you were
choosing between.

In the example graph that edge is drawn zero times out of seven decisions. The concepts exist. The
decisions exist. The wire between them is missing. Cite as you go and yours won't be.

## Conventions that keep it legible

- Name projects per repo or initiative. Never let them default to a home directory.
- Give parallel agents stable ids and a shared `task`.
- Decide at real forks, not per commit. A decision per commit is noise; a decision per architecture
  call is signal.
- Recall before you learn.

## About Neo4j

You do not need a database for any of this. The [explorer](https://fleet-explorer.jasonv.app)
rebuilds the whole graph live from your key. Neo4j and Aura are an optional power-user layer: if you
want Cypher queries or Bloom visualizations, run your own Aura instance and point the projector
(`scripts/graph.ts`) at it. The explorer covers the everyday view on its own.
