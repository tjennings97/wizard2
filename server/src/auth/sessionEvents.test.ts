import type { Knex } from 'knex';
import { emitSessionsInvalidated, sessionEvents } from './sessionEvents';

describe('emitSessionsInvalidated', () => {
  let received: string[][];
  const listener = (ids: string[]) => received.push(ids);
  beforeEach(() => {
    received = [];
    sessionEvents.on('invalidated', listener);
  });
  afterEach(() => {
    sessionEvents.off('invalidated', listener);
  });

  const fakeTrx = (outcome: Promise<unknown>) =>
    ({ isTransaction: true, executionPromise: outcome }) as unknown as Knex.Transaction;
  const flush = () => new Promise((r) => setImmediate(r));

  it('emits straight away outside a transaction', () => {
    emitSessionsInvalidated({ isTransaction: false } as unknown as Knex, ['a']);
    expect(received).toEqual([['a']]);
  });

  it('waits for the transaction to commit', async () => {
    let commit!: () => void;
    const trx = fakeTrx(new Promise<void>((r) => (commit = r)));
    emitSessionsInvalidated(trx, ['a', 'b']);
    await flush();
    expect(received).toEqual([]);
    commit();
    await flush();
    expect(received).toEqual([['a', 'b']]);
  });

  it('never emits if the transaction rolls back', async () => {
    emitSessionsInvalidated(fakeTrx(Promise.reject(new Error('rollback'))), ['a']);
    await flush();
    expect(received).toEqual([]);
  });

  it('emits nothing for an empty list', () => {
    emitSessionsInvalidated({ isTransaction: false } as unknown as Knex, []);
    expect(received).toEqual([]);
  });
});
