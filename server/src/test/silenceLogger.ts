// pino-pretty runs in a worker thread that Jest would report as an open handle.
jest.mock('../logger', () => {
  const noop = () => undefined;
  return { logger: { error: noop, warn: noop, info: noop, debug: noop } };
});
