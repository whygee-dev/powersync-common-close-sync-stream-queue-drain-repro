# `@powersync/common`: queued control commands after `CloseSyncStream`

This repo contains a minimal Node repro for a sync iteration lifecycle issue in `@powersync/common@1.52.0`.

In `AbstractStreamingSyncImplementation.rustSyncIteration()`, `CloseSyncStream` closes the current iteration, but the JavaScript side can still process already-queued injected `controlInvocations`. Those commands may then be forwarded to `powersync_control(...)` after the iteration is no longer active.

`rustSyncIteration()` is private and depends on the PowerSync core adapter, so this repro isolates the relevant queue-drain behavior.

## Reproduce

```sh
npm test
```

The script runs two variants:

- broken: aborts on `CloseSyncStream` but can keep processing the existing queue
- fixed: marks close as terminal and breaks the queue drain

Expected output:

```text
broken error: powersync_control: invalid state: No iteration is active; command=update_subscriptions
fixed control calls: [ 'line_binary:first_line' ]
reproduced: queued commands are invalid once CloseSyncStream has closed the iteration
```

## Expected

After `CloseSyncStream` is received for an iteration, queued control commands for that iteration should not be forwarded to `powersync_control(...)`.

## Actual

The current loop can process commands already queued before close, such as `update_subscriptions`, `completed_upload`, or `line_binary`, after the iteration was closed. That can produce:

```text
powersync_control: invalid state: No iteration is active
```

## Suggested fix shape

When handling `CloseSyncStream`:

```ts
closeRequested = true;
controlInvocations = null;
controller.abort();
```

After each awaited control call in the queue loop:

```ts
await control(line.command, line.payload);

if (closeRequested || controller.signal.aborted || signal.aborted) {
  break;
}
```

See [ISSUE.md](./ISSUE.md) for a standalone upstream issue report.
