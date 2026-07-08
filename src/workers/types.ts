/** Shared worker dependency: a way to push a message to a user via the bot. */
export interface WorkerDeps {
  notify: (telegramId: number, text: string) => Promise<void>;
}
