# `@powersync/common`: `rustSyncIteration()` can process queued control commands after `CloseSyncStream`

## Package

- `@powersync/common@1.52.0`

## Summary

`AbstractStreamingSyncImplementation.rustSyncIteration()` can continue processing already-queued injected `controlInvocations` after the core emits `CloseSyncStream`.

`CloseSyncStream` makes the current iteration terminal. Any queued command forwarded after that point is valid as a queued JavaScript event, but invalid for the closed PowerSync core iteration. This can surface as:

```text
powersync_control: invalid state: No iteration is active
```

## Reproduction

Minimal repro repo:

```sh
git clone https://github.com/whygee-dev/powersync-common-close-sync-stream-queue-drain-repro.git
cd powersync-common-close-sync-stream-queue-drain-repro
npm install
npm test
```

Observed output:

```text
control calls: [ 'start', 'line_text', 'update_subscriptions', 'stop' ]
error: powersync_control: invalid state: No iteration is active; command=update_subscriptions
reproduced: queued subscription update processed after CloseSyncStream
```

The repro uses `AbstractStreamingSyncImplementation` with a minimal adapter and remote. The adapter queues a subscription update through `updateSubscriptions()` while handling the first sync line, then returns `CloseSyncStream`.

## Expected behavior

After `CloseSyncStream` is received for the current iteration, JavaScript should stop forwarding queued control commands into that iteration.

## Actual behavior

The stream controller is aborted, but the current `connect()` loop does not check for close or abort immediately after `await control(...)`. If injected entries are already queued on the existing `controlInvocations` iterator, commands such as `update_subscriptions`, `completed_upload`, or `line_binary` may then be sent to `powersync_control(...)` after the iteration has already closed.

## Suggested fix shape

Treat `CloseSyncStream` as terminal for the current queue drain.

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

## Impact

Applications can legitimately enqueue subscription updates or upload notifications near the end of a sync iteration. The SDK should drop or stop processing those queued commands once the iteration is closed, rather than forwarding them to a dead core iteration and surfacing an invalid-state error.
