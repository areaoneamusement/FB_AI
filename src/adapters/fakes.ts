import type {
  ModelAGenerationPort,
  ModelAGenerationRequest,
  ModelAGenerationResponse,
  ModelBCritiquePort,
  ModelBCritiqueRequest,
  ModelBCritiqueResponse,
  ModelCallControl,
  SourceFetcher,
} from "./ports.js";
import type {
  FetchPage,
  SourceConfig,
  SourceCursor,
  SourcePermission,
} from "../domain/source.js";

export interface FakeSourceFetcherOptions {
  readonly fetch?: (
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ) => FetchPage | Promise<FetchPage>;
  readonly isAllowed?: (
    source: SourceConfig,
  ) => SourcePermission | Promise<SourcePermission>;
}

export interface SourceFetchCall {
  readonly source: SourceConfig;
  readonly cursor: SourceCursor | undefined;
  readonly signal: AbortSignal;
}

const DEFAULT_PERMISSION: SourcePermission = {
  allowed: true,
  termsVersion: "fake-terms-v1",
  robotsCapturedAt: "1970-01-01T00:00:00.000Z",
};

function abortError(message = "Operation aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class FakeSourceFetcher implements SourceFetcher {
  readonly fetchCalls: SourceFetchCall[] = [];
  readonly permissionCalls: SourceConfig[] = [];

  constructor(private readonly options: FakeSourceFetcherOptions = {}) {}

  async fetch(
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage> {
    this.fetchCalls.push({ source, cursor, signal });
    const operation = Promise.resolve(
      this.options.fetch?.(source, cursor, signal) ?? { items: [] },
    );
    return await withAbort(operation, signal);
  }

  async isAllowed(source: SourceConfig): Promise<SourcePermission> {
    this.permissionCalls.push(source);
    return await Promise.resolve(
      this.options.isAllowed?.(source) ?? DEFAULT_PERMISSION,
    );
  }
}

export type ModelAGenerationHandler = (
  request: ModelAGenerationRequest,
  control: ModelCallControl,
) => ModelAGenerationResponse | Promise<ModelAGenerationResponse>;

export type ModelBCritiqueHandler = (
  request: ModelBCritiqueRequest,
  control: ModelCallControl,
) => ModelBCritiqueResponse | Promise<ModelBCritiqueResponse>;

export interface ModelAGenerationCall {
  readonly request: ModelAGenerationRequest;
  readonly control: ModelCallControl;
}

export interface ModelBCritiqueCall {
  readonly request: ModelBCritiqueRequest;
  readonly control: ModelCallControl;
}
async function withModelControl<T>(
  operation: () => Promise<T>,
  control: ModelCallControl,
  now: () => number,
): Promise<T> {
  const deadline = Date.parse(control.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error("Invalid model deadline");
  if (control.signal.aborted) throw abortError("Model call aborted");
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Model call deadline exceeded");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Model call deadline exceeded")),
      Math.min(remaining, 2_147_483_647),
    );
  });
  try {
    return await withAbort(
      Promise.race([operation(), deadlinePromise]),
      control.signal,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class FakeModelAGenerationClient implements ModelAGenerationPort {
  readonly calls: ModelAGenerationCall[] = [];

  constructor(
    private readonly handler: ModelAGenerationHandler,
    private readonly now: () => number = Date.now,
  ) {}

  async generate(
    request: ModelAGenerationRequest,
    control: ModelCallControl,
  ): Promise<ModelAGenerationResponse> {
    this.calls.push({ request, control });
    return await withModelControl(
      () => Promise.resolve(this.handler(request, control)),
      control,
      this.now,
    );
  }
}

export class FakeModelBCritiqueClient implements ModelBCritiquePort {
  readonly calls: ModelBCritiqueCall[] = [];

  constructor(
    private readonly handler: ModelBCritiqueHandler,
    private readonly now: () => number = Date.now,
  ) {}

  async critique(
    request: ModelBCritiqueRequest,
    control: ModelCallControl,
  ): Promise<ModelBCritiqueResponse> {
    this.calls.push({ request, control });
    return await withModelControl(
      () => Promise.resolve(this.handler(request, control)),
      control,
      this.now,
    );
  }
}
