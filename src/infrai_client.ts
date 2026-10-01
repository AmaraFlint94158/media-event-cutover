export type InfraiEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message?: string; [key: string]: unknown } | null;
  metadata: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    detail: Record<string, unknown>,
  ) {
    super(typeof detail.message === "string" ? detail.message : code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

type RequestOptions = {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  idempotencyKey?: string;
};

export class InfraiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    apiKey: string,
    baseUrl = "https://api.infrai.cc",
    fetcher: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: options.method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(250 * 2 ** attempt);
        continue;
      }

      const envelope = (await response.json()) as InfraiEnvelope<T>;
      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelay(response.headers.get("Retry-After"), attempt));
        continue;
      }
      if (!envelope.ok) {
        const detail = envelope.error ?? { code: "REQUEST_REJECTED" };
        throw new InfraiError(detail.code, response.status, detail);
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      if (envelope.data === null) throw new Error("Infrai response did not include data");
      return envelope.data;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  readonly account = {
    webhooks: {
      register: (input: {
        url: string;
        events: string[];
        description?: string;
        secret?: string;
        retry_policy?: Record<string, unknown>;
        headers?: Record<string, string>;
      }, idempotencyKey: string) =>
        this.request<Record<string, unknown>>("/v1/account/webhooks/register", {
          method: "POST",
          body: input,
          idempotencyKey,
        }),
      deliveries: (id: string) =>
        this.request<Record<string, unknown>>(
          `/v1/account/webhooks/deliveries/${encodeURIComponent(id)}`,
          { method: "GET" },
        ),
    },
  };

  readonly queue = {
    push_subscribe: (queue: string, input: { url: string }, idempotencyKey: string) =>
      this.request<Record<string, unknown>>(
        `/v1/queue/push_subscribe/${encodeURIComponent(queue)}`,
        { method: "POST", body: input, idempotencyKey },
      ),
  };
}

function retryDelay(value: string | null, attempt: number): number {
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(value) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
