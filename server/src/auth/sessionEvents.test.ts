import type { Knex } from 'knex';
import { emitSessionsInvalidated, sessionEvents, type InvalidationReason } from './sessionEvents';

describe('emitSessionsInvalidated', () => {
  let received: [string[], InvalidationReason][];
  const listener = (ids: string[], reason: InvalidationReason) => received.push([ids, reason]);
  beforeEach(() => {
    received = [];
    sessionEvents.on('invalidated', listener);
  });
  afterEach(() => {
    sessionEvents.off('invalidated', listener);
  });

  const fakeTrx = (outcome: Promise<unknown>, parentTransaction?: Knex.Transaction) =>
    ({ isTransaction: true, executionPromise: outcome, parentTransaction }) as unknown as Knex.Transaction;
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('emits straight away outside a transaction, with the reason', () => {
    emitSessionsInvalidated({ isTransaction: false } as unknown as Knex, ['a'], 'logout');
    expect(received).toEqual([[['a'], 'logout']]);
  });

  it('waits for the transaction to commit', async () => {
    const commit = deferred();
    emitSessionsInvalidated(fakeTrx(commit.promise), ['a', 'b'], 'displaced');
    await flush();
    expect(received).toEqual([]);
    commit.resolve();
    await flush();
    expect(received).toEqual([[['a', 'b'], 'displaced']]);
  });

  it('never emits if the transaction rolls back', async () => {
    const commit = deferred();
    emitSessionsInvalidated(fakeTrx(commit.promise), ['a'], 'displaced');
    commit.reject(new Error('rollback'));
    await flush();
    expect(received).toEqual([]);
  });

  it('in a nested transaction, waits for the outermost one to commit', async () => {
    const outer = deferred();
    const inner = deferred();
    emitSessionsInvalidated(fakeTrx(inner.promise, fakeTrx(outer.promise)), ['a'], 'password_reset');
    inner.resolve(); // savepoint released
    await flush();
    expect(received).toEqual([]);
    outer.resolve();
    await flush();
    expect(received).toEqual([[['a'], 'password_reset']]);
  });

  it('in a nested transaction, never emits if the outer one rolls back after the savepoint is released', async () => {
    const outer = deferred();
    const inner = deferred();
    emitSessionsInvalidated(fakeTrx(inner.promise, fakeTrx(outer.promise)), ['a'], 'displaced');
    inner.resolve();
    outer.reject(new Error('rollback'));
    await flush();
    expect(received).toEqual([]);
  });

  it('emits nothing for an empty list', () => {
    emitSessionsInvalidated({ isTransaction: false } as unknown as Knex, [], 'logout');
    expect(received).toEqual([]);
  });
});
