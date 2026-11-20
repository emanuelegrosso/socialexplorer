export type ShutdownTask = () => void | Promise<void>;

export interface ShutdownReport {
  readonly completed: string[];
  readonly failed: { readonly name: string; readonly error: unknown }[];
}

/** Runs registered cleanup tasks once, in reverse registration order, never short-circuiting on failure. */
export class ShutdownRegistry {
  private readonly tasks: { name: string; task: ShutdownTask }[] = [];
  private pending: Promise<ShutdownReport> | undefined;

  register(name: string, task: ShutdownTask): void {
    this.tasks.push({ name, task });
  }

  get isShuttingDown(): boolean {
    return this.pending !== undefined;
  }

  run(): Promise<ShutdownReport> {
    this.pending ??= this.execute();
    return this.pending;
  }

  private async execute(): Promise<ShutdownReport> {
    const completed: string[] = [];
    const failed: { name: string; error: unknown }[] = [];
    for (const { name, task } of [...this.tasks].reverse()) {
      try {
        await task();
        completed.push(name);
      } catch (error) {
        failed.push({ name, error });
      }
    }
    return { completed, failed };
  }
}
