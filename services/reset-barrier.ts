/**
 * PLAN-krug К20: a reset keeps the gateway's session id, so the old and the new conversation share one
 * Viking session, and the gateway fires before_reset without waiting for it. The reset holds the session
 * from its first, synchronous step until the server has archived the old conversation (phase 1); the
 * engine's own steps for that session -- assemble, the turn's writes, compaction -- wait for it first, or
 * the new conversation's first rows would go into the old one's archive and its first window would show
 * the old conversation. One per plugin registration, as the «догнать» memory: the gateway builds an
 * engine for each logical turn.
 */
export function createResetBarrier() {
  const held = new Map<string, Promise<void>>();
  return {
    /** Holds the session until the returned release is called (more than once is fine). */
    hold(ovSessionId: string): () => void {
      let release!: () => void;
      const own = new Promise<void>((resolve) => {
        release = resolve;
      });
      const until = (held.get(ovSessionId) ?? Promise.resolve()).then(() => own);
      held.set(ovSessionId, until);
      void until.then(() => {
        if (held.get(ovSessionId) === until) {
          held.delete(ovSessionId);
        }
      });
      return release;
    },
    /** Resolves once no reset holds the session. */
    async passed(ovSessionId: string): Promise<void> {
      await held.get(ovSessionId);
    },
  };
}

export type ResetBarrier = ReturnType<typeof createResetBarrier>;
