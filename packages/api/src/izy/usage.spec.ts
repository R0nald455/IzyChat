import { configureIzyUsageReporter, reportAgentUsage, resetIzyUsageReporter } from './usage';

type FetchCall = { url: string; init: RequestInit };

/** Deja correr la microtarea que dispara `reportAgentUsage` antes de aseverar. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('reportAgentUsage', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.IZYTESTING_USAGE_URL;
  const originalKey = process.env.IZYTESTING_USAGE_KEY;
  let calls: FetchCall[] = [];

  const stubFetch = (response: Partial<Response> = { ok: true }): void => {
    global.fetch = jest.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', ...response } as Response);
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    calls = [];
    resetIzyUsageReporter();
    process.env.IZYTESTING_USAGE_URL = 'http://izytesting/agent_usage/ingest/';
    process.env.IZYTESTING_USAGE_KEY = 'clave-de-servicio';
    stubFetch();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env.IZYTESTING_USAGE_URL = originalUrl;
    process.env.IZYTESTING_USAGE_KEY = originalKey;
    resetIzyUsageReporter();
  });

  const configure = (email: string | null = 'ana@izytesting.com'): jest.Mock => {
    const getUserById = jest.fn().mockResolvedValue(email ? { email } : null);
    configureIzyUsageReporter({ getUserById });
    return getUserById;
  };

  it('manda el consumo con el email del usuario y la clave de servicio', async () => {
    configure();

    reportAgentUsage({
      user: 'user-1',
      inputTokens: 1200,
      outputTokens: 300,
      credits: 2700,
      model: 'claude-haiku-4-5',
      conversationId: 'conv-1',
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://izytesting/agent_usage/ingest/');
    expect((calls[0].init.headers as Record<string, string>)['X-Izy-Usage-Key']).toBe(
      'clave-de-servicio',
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      email: 'ana@izytesting.com',
      input_tokens: 1200,
      output_tokens: 300,
      credits: 2700,
      model: 'claude-haiku-4-5',
      conversation_id: 'conv-1',
    });
  });

  it('reutiliza el email cacheado en corridas siguientes del mismo usuario', async () => {
    const getUserById = configure();

    reportAgentUsage({ user: 'user-1', inputTokens: 10, outputTokens: 5 });
    await flush();
    reportAgentUsage({ user: 'user-1', inputTokens: 10, outputTokens: 5 });
    await flush();

    expect(calls).toHaveLength(2);
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it('omite `credits` cuando el costo no se pudo calcular por completo', async () => {
    configure();

    reportAgentUsage({ user: 'user-1', inputTokens: 10, outputTokens: 5 });
    await flush();

    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('credits');
  });

  it('no manda nada sin configuracion de entorno', async () => {
    configure();
    delete process.env.IZYTESTING_USAGE_URL;

    reportAgentUsage({ user: 'user-1', inputTokens: 10, outputTokens: 5 });
    await flush();

    expect(calls).toHaveLength(0);
  });

  it('no manda nada si el usuario no tiene email en IzyTesting', async () => {
    configure(null);

    reportAgentUsage({ user: 'user-1', inputTokens: 10, outputTokens: 5 });
    await flush();

    expect(calls).toHaveLength(0);
  });

  it('no manda nada cuando la corrida no consumio tokens', async () => {
    configure();

    reportAgentUsage({ user: 'user-1', inputTokens: 0, outputTokens: 0 });
    await flush();

    expect(calls).toHaveLength(0);
  });

  it('un fallo de red no propaga la excepcion', async () => {
    configure();
    global.fetch = jest.fn(() => Promise.reject(new Error('sin red'))) as unknown as typeof fetch;

    expect(() =>
      reportAgentUsage({ user: 'user-1', inputTokens: 10, outputTokens: 5 }),
    ).not.toThrow();
    await flush();
  });
});
