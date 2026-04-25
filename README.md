# `@powersync/common`: queued control commands after `CloseSyncStream`

This repo contains a minimal Node repro for a sync iteration lifecycle issue in `@powersync/common@1.52.0`.

In `AbstractStreamingSyncImplementation.rustSyncIteration()`, `CloseSyncStream` closes the current iteration, but the JavaScript side can still process already-queued injected `controlInvocations`. Those commands may then be forwarded to `powersync_control(...)` after the iteration is no longer active.

The repro calls the real exported `AbstractStreamingSyncImplementation` class and invokes its runtime `rustSyncIteration()` method with a minimal fake adapter and remote.

## Reproduce

```sh
npm install
npm test
```

Expected output:

```text
control calls: [ 'start', 'line_text', 'update_subscriptions', 'stop' ]
error: powersync_control: invalid state: No iteration is active; command=update_subscriptions
reproduced with the real @powersync/common AbstractStreamingSyncImplementation.rustSyncIteration()
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
