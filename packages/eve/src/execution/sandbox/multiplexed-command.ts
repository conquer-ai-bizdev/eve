import type { SandboxProcess } from "#shared/sandbox-session.js";

type OutputName = "stderr" | "stdout";

interface MultiplexedCommand<Log extends { readonly data: string }> {
  kill(): PromiseLike<void>;
  logs(): AsyncIterable<Log> & { close?(): void };
  wait(): PromiseLike<{ readonly exitCode: number }>;
}

interface OutputChannel {
  readonly stream: ReadableStream<Uint8Array>;
  close(): void;
  enqueue(chunk: Uint8Array): void;
  error(cause: unknown): void;
}

function createOutputChannel(): OutputChannel {
  let canceled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
    start(value) {
      controller = value;
    },
  });

  return {
    stream,
    close() {
      if (!canceled) {
        controller.close();
      }
    },
    enqueue(chunk) {
      if (!canceled) {
        controller.enqueue(chunk);
      }
    },
    error(cause) {
      if (!canceled) {
        controller.error(cause);
      }
    },
  };
}

/**
 * Adapts a detached command with one tagged log iterator to a sandbox process
 * with independent stdout and stderr streams.
 */
export function adaptMultiplexedCommandToSandboxProcess<
  Log extends { readonly data: string },
>(input: {
  readonly abortSignal?: AbortSignal;
  readonly command: MultiplexedCommand<Log>;
  readonly getOutput: (log: Log) => OutputName;
}): SandboxProcess {
  const encoder = new TextEncoder();
  const stdout = createOutputChannel();
  const stderr = createOutputChannel();
  const outputs: Record<OutputName, OutputChannel> = { stderr, stdout };

  const commandLogs = input.command.logs();
  const logsDone = (async () => {
    try {
      for await (const log of commandLogs) {
        outputs[input.getOutput(log)].enqueue(encoder.encode(log.data));
      }
      stdout.close();
      stderr.close();
    } catch (error) {
      stdout.error(error);
      stderr.error(error);
      throw error;
    }
  })();
  // The streams surface log failures immediately; retain the rejection for wait().
  void logsDone.catch(() => undefined);

  let waitPromise: Promise<{ exitCode: number }> | undefined;
  let killPromise: Promise<void> | undefined;
  const abortResult = Promise.withResolvers<never>();
  void abortResult.promise.catch(() => undefined);
  const kill = (): Promise<void> =>
    (killPromise ??= Promise.resolve().then(() => input.command.kill()));
  const onAbort = () => {
    void kill().then(
      () => {
        commandLogs.close?.();
        abortResult.reject(input.abortSignal?.reason ?? new Error("Sandbox command aborted"));
      },
      (error) => abortResult.reject(error),
    );
  };
  if (input.abortSignal?.aborted === true) {
    onAbort();
  } else {
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    stderr: stderr.stream,
    stdout: stdout.stream,
    wait() {
      return (waitPromise ??= Promise.race([
        Promise.resolve().then(async () => {
          const finished = await input.command.wait();
          await logsDone;
          return { exitCode: finished.exitCode };
        }),
        abortResult.promise,
      ]));
    },
    kill() {
      return kill();
    },
  };
}
