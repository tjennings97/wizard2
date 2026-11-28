import { readWithin } from './registry';

describe('readWithin (gauge sources)', () => {
  it('returns the value of a source that answers in time, sync or async', async () => {
    await expect(readWithin(() => 3, 100)).resolves.toBe(3);
    await expect(readWithin(async () => 4, 100)).resolves.toBe(4);
  });

  it('gives up on a source that stalls, so the scrape is not held up', async () => {
    const started = Date.now();
    await expect(readWithin(() => new Promise<number>(() => undefined), 50)).rejects.toThrow(/longer than 50 ms/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('passes on a source that throws', async () => {
    await expect(
      readWithin(() => {
        throw new Error('db down');
      }, 100),
    ).rejects.toThrow('db down');
  });
});
