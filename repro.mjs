import assert from 'node:assert/strict';
import {
  AbstractStreamingSyncImplementation,
  PowerSyncControlCommand,
  SyncStreamConnectionMethod
} from '@powersync/common';

let sync;
let iterationActive = true;

const controlCalls = [];

const logger = {
  warn() {},
  debug() {},
  info() {},
  error() {},
  trace() {}
};

const adapter = {
  registerListener() {
    return () => {};
  },

  async control(command, payload) {
    controlCalls.push(command);

    if (command === PowerSyncControlCommand.STOP) {
      return JSON.stringify([]);
    }

    if (!iterationActive) {
      throw new Error(`powersync_control: invalid state: No iteration is active; command=${command}`);
    }

    if (command === PowerSyncControlCommand.START) {
      return JSON.stringify([
        {
          EstablishSyncStream: {
            request: {
              path: '/sync/stream',
              payload
            }
          }
        }
      ]);
    }

    if (command === PowerSyncControlCommand.PROCESS_TEXT_LINE) {
      // Queue an app-side subscription change before the core closes this
      // iteration. updateSubscriptions() injects UPDATE_SUBSCRIPTIONS into
      // rustSyncIteration's control queue.
      sync.updateSubscriptions([{ name: 'queued_after_close', params: null }]);
      iterationActive = false;

      return JSON.stringify([{ CloseSyncStream: { hide_disconnect: false } }]);
    }

    return JSON.stringify([]);
  }
};

const remote = {
  async fetchStream() {
    let emittedFirstLine = false;

    return {
      async next() {
        if (emittedFirstLine) {
          return { done: true };
        }

        emittedFirstLine = true;
        return { done: false, value: 'first sync line' };
      }
    };
  },
  invalidateCredentials() {},
  async fetchCredentials() {
    return {};
  }
};

sync = new AbstractStreamingSyncImplementation({
  adapter,
  remote,
  logger,
  subscriptions: [],
  crudUploadThrottleMs: 60_000
});

sync.triggerCrudUpload = () => {};

let error;
try {
  await sync.rustSyncIteration(new AbortController().signal, {
    connectionMethod: SyncStreamConnectionMethod.HTTP,
    includeDefaultStreams: true,
    params: null,
    appMetadata: null
  });
} catch (caught) {
  error = caught;
}

console.log('control calls:', controlCalls);
console.log('error:', error?.message);

assert.match(
  error?.message ?? '',
  /powersync_control: invalid state: No iteration is active/,
  'real rustSyncIteration() forwarded a queued UPDATE_SUBSCRIPTIONS command after CloseSyncStream'
);
assert.deepEqual(controlCalls, [
  PowerSyncControlCommand.START,
  PowerSyncControlCommand.PROCESS_TEXT_LINE,
  PowerSyncControlCommand.UPDATE_SUBSCRIPTIONS,
  PowerSyncControlCommand.STOP
]);

console.log('reproduced: queued subscription update processed after CloseSyncStream');
