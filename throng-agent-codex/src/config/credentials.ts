/** Sets OPENAI_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectOpenAIKey(key: string | null): void {
  if (key) process.env.OPENAI_API_KEY = key;
}
