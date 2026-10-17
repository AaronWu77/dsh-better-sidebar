/** Explicitly authenticated browser admission for tests unrelated to login behavior. */
export function authenticatedHostService(key: string): { requestRejection(): undefined } | undefined {
  return key === 'connection' ? { requestRejection: () => undefined } : undefined
}
