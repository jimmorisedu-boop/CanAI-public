# CanAI agent package protocol

This page is the public entry point for the CanAI agent package contract. It is
kept alongside the machine-readable files under `docs/agents/` in a public
release. The contract describes how a package communicates with the local CanAI
Host; it does not promise that every target feature is available in this
release.

## What an integration contains

An integration has three parts: an agent package, the CanAI Host, and the agent
panel. The package supplies its own code, instructions, schemas, and protocol
adapter. The Host installs and verifies the package, starts its process, stores
task state, brokers approved operations, and delivers results. The panel shows
progress, materials, and review requests. A repository, prompt collection, or
command-line program needs an adapter before it is a CanAI package.

The required entry point is `canai.agent.json` at the package root (or the
selected package subdirectory). Paths in the manifest are relative POSIX paths;
the Host checks that they exist and stay inside the package. The manifest uses
schema version `1` and protocol version `1.0`, and declares the runtime,
task types, permissions, connections, and pause/resume/cancel behavior.

Read the [manifest schema](../agents/canai.agent.schema.json),
[protocol schema](../agents/protocol.schema.json),
[example manifest](../agents/canai.agent.example.json), and
[example input schema](../agents/advertising-video.input.schema.json) together.
The examples are fixtures for the contract, not claims that those packages or
tasks are bundled or enabled.

## Runtime and trust boundaries

The protocol uses newline-delimited JSON (NDJSON) over `stdio`. A package may
declare Node or Python, but the current installer subset runs a pinned bundled
Node package and a verified Windows x64 embeddable Python runtime with only its
standard library. External dependencies and lockfile installation are outside
that subset. Agents run on the operator's computer through the local server.
This local edition contains no CanAI Cloud agent transport.

Before installation, the Host resolves an immutable source revision, checks the
manifest and paths, and performs static validation without running repository
code, hooks, or install scripts. The user then confirms the package and its
declared permissions before runtime preparation. The protocol is a trust
boundary for Host operations, not a full operating-system sandbox; use packages
you trust.

## Message lifecycle

Every message has protocol version `1.0`, a message ID, task and execution IDs,
a type, and a typed payload. The adapter starts with `hello` and receives an
`ack`. The Host sends `task.start` (or `task.resume`) with the task instruction,
selected inputs, project reference, connections, and grants. The adapter emits
progress and checkpoints, requests approved tools, and can ask for a review.
The Host returns tool results and review decisions. A task ends with
`task.finished`, `task.paused`, or a structured error. Heartbeats keep a live
session detectable. Pause, cancel, checkpoints, and resume are explicit
capabilities; recovery must not repeat a completed operation.

The protocol keeps the target project explicit as `projectRef` and captures
selected inputs with IDs, revisions, and checksums. A package must not infer the
target from the currently open board or silently change it when the selection
changes. Generated or derived artifacts are published through Host operations,
which return receipts and revisions for later updates.

## Tools, approvals, and costs

The manifest lists only the permissions a task needs. Host tools include reading
selected canvas items, reading or rendering media, publishing artifacts,
creating or updating the package's own canvas results, and requesting language
model or media-generation work. Tool calls carry operation IDs and are paired
with receipts. The Host validates direction, permissions, revisions, paths, and
availability independently of the package.

Model and generation calls are explicit and may require a user grant. The grant
fixes the connection, allowed artifacts, model/catalog revision, call limit, and
USD budget; the Host quotes and records actual charges. An unavailable required
connection pauses the relevant stage instead of fabricating a result.

## Public fixtures

The [happy-path NDJSON fixture](../agents/examples/happy-path.jsonl) shows a
checkpoint, publication, review, and canvas placement. The
[recovery fixture](../agents/examples/recovery.jsonl) shows resume without
repeating a completed operation. [Schema cases](../agents/examples/schema-cases.json)
and the [plan fixture](../agents/examples/plan.txt) provide small validation
inputs. Keep IDs, checksums, and protocol fields intact when using these files
as test fixtures.

For changes to the contract, update the schemas and fixtures together, preserve
backward-compatible IDs and protocol versions, and document any new capability
or Host requirement in the public release notes.
