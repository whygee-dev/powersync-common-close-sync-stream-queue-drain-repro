import assert from 'node:assert/strict';

class InjectableIterator {
  #items;

  constructor(items) {
    this.#items = [...items];
  }

  inject(item) {
    this.#items.push(item);
  }

  async next() {
    await Promise.resolve();

    if (this.#items.length === 0) {
      return { done: true };
    }

    return { done: false, value: this.#items.shift() };
  }
}

function createAdapter() {
  let iterationActive = true;
  const calls = [];

  return {
    calls,
    async control(command, payload = null) {
      calls.push(command);

      if (!iterationActive) {
        throw new Error(`powersync_control: invalid state: No iteration is active; command=${command}`);
      }

      if (command === 'line_binary:first_line') {
        iterationActive = false;
        return JSON.stringify([{ CloseSyncStream: { hide_disconnect: false } }]);
      }

      return JSON.stringify([]);
    }
  };
}

async function runBrokenQueueDrain() {
  const adapter = createAdapter();
  const controller = new AbortController();
  let controlInvocations = new InjectableIterator([
    { command: 'line_binary:first_line' },
    { command: 'update_subscriptions' },
    { command: 'completed_upload' }
  ]);

  async function control(command, payload) {
    const rawResponse = await adapter.control(command, payload);
    const instructions = JSON.parse(rawResponse);

    for (const instruction of instructions) {
      if ('CloseSyncStream' in instruction) {
        // This matches the problematic lifecycle: the iteration is aborted,
        // but the already-created iterator is still drained by the loop.
        controller.abort();
      }
    }
  }

  while (true) {
    const event = await controlInvocations.next();
    if (event.done) {
      break;
    }

    await control(event.value.command, event.value.payload);
  }

  return adapter.calls;
}

async function runFixedQueueDrain() {
  const adapter = createAdapter();
  const controller = new AbortController();
  let closeRequested = false;
  let controlInvocations = new InjectableIterator([
    { command: 'line_binary:first_line' },
    { command: 'update_subscriptions' },
    { command: 'completed_upload' }
  ]);

  async function control(command, payload) {
    const rawResponse = await adapter.control(command, payload);
    const instructions = JSON.parse(rawResponse);

    for (const instruction of instructions) {
      if ('CloseSyncStream' in instruction) {
        closeRequested = true;
        controlInvocations = null;
        controller.abort();
      }
    }
  }

  while (controlInvocations != null) {
    const event = await controlInvocations.next();
    if (event.done) {
      break;
    }

    await control(event.value.command, event.value.payload);

    if (closeRequested || controller.signal.aborted) {
      break;
    }
  }

  return adapter.calls;
}

let brokenError;
try {
  await runBrokenQueueDrain();
} catch (error) {
  brokenError = error;
}

const fixedCalls = await runFixedQueueDrain();

console.log('broken error:', brokenError?.message);
console.log('fixed control calls:', fixedCalls);

assert.match(
  brokenError?.message ?? '',
  /powersync_control: invalid state: No iteration is active/,
  'broken loop forwards a queued command after CloseSyncStream'
);
assert.deepEqual(
  fixedCalls,
  ['line_binary:first_line'],
  'fixed loop stops after CloseSyncStream and does not drain stale queued commands'
);

console.log('reproduced: queued commands are invalid once CloseSyncStream has closed the iteration');
