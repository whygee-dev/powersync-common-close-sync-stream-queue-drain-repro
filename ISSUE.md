# `@powersync/common`: queued control commands can be sent after `CloseSyncStream`

## Package

- `@powersync/common@1.52.0` (`latest` on npm as of 2026-05-05)

## Disclosure

This report is distilled from failures reproduced in production environments. Product-specific data, names, and identifiers were redacted and the public repro/draft was edited with AI assistance. The repro and issue text were reviewed and validated by a human before submission.

## Summary

`AbstractStreamingSyncImplementation.rustSyncIteration()` can keep draining already-queued JavaScript-side control commands after the core has emitted `CloseSyncStream` for the current iteration.

In that state the queued JavaScript event is real, but the core iteration is already closed. Forwarding another command to the same iteration can surface as:

```text
powersync_control: invalid state: No iteration is active
```

## Minimal reproduction

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

The repro uses `AbstractStreamingSyncImplementation` directly with a minimal adapter and remote:

1. `START` asks JS to establish an HTTP sync stream.
2. The first stream line is sent to the core as `line_text`.
3. While handling that line, the app calls `updateSubscriptions()`, which injects `update_subscriptions` into the current control queue.
4. The mocked core response to the line is `CloseSyncStream`.
5. The current queue is still drained, so `update_subscriptions` is sent after close and the mocked core throws the same invalid-state error we saw.

## Expected behavior

Once `CloseSyncStream` is received for an iteration, JS should stop forwarding queued commands into that closed iteration.

Queued app-side events can be ignored, deferred to the next iteration, or handled some other way, but they should not be sent to a core iteration that has already been closed.

## Actual behavior

`CloseSyncStream` aborts the stream controller, but the queue-drain loop does not stop immediately after the `await control(...)` call that handled the close instruction. If entries are already queued on the current `controlInvocations` iterator, commands such as `update_subscriptions`, `completed_upload`, or binary/text line events can still be forwarded to `powersync_control(...)`.

Relevant code shape in `AbstractStreamingSyncImplementation.ts`:

```ts
await control(line.command, line.payload);
```

and later:

```ts
} else if ('CloseSyncStream' in instruction) {
  controller.abort();
  hideDisconnectOnRestart = instruction.CloseSyncStream.hide_disconnect;
}
```

## Suggested fix direction

Treat `CloseSyncStream` as terminal for the current queue drain. For example, set an iteration-close flag when handling `CloseSyncStream`, clear or stop the current `controlInvocations`, and break the queue loop after any `control(...)` call that closed or aborted the iteration.

## Impact

Applications can legitimately enqueue subscription updates or upload notifications near the end of a sync iteration. Today, those queued events can be forwarded to a closed core iteration and turn a normal stream close/restart into an invalid-state error.
