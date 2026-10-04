import { eq, lt } from 'drizzle-orm';
import type { Executor } from '../orm';
import { conversationStates, tgUpdates } from '../schema';

export type ConversationFlow = (typeof conversationStates.$inferSelect)['flow'];

export interface Conversation {
  readonly flow: ConversationFlow;
  readonly step: string;
  /** Only what the next step needs. Plain JSON. */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Plumbing for the Telegram layer. Holds no medical data, takes no actor: it is how the system
 * itself remembers which updates it has seen and where a conversation stands.
 * Time is always passed in, so expiry is testable.
 */
export function createTelegramRepository(db: Executor) {
  return {
    /**
     * Marks an update as seen. True the first time, false for a redelivery, which the caller
     * must then ignore. Claimed before the update is handled, so each is handled at most once.
     */
    async claimUpdate(updateId: number): Promise<boolean> {
      const rows = await db
        .insert(tgUpdates)
        .values({ updateId })
        .onConflictDoNothing({ target: tgUpdates.updateId })
        .returning({ updateId: tgUpdates.updateId });
      return rows.length > 0;
    },

    async pruneUpdates(olderThan: Date): Promise<number> {
      const rows = await db
        .delete(tgUpdates)
        .where(lt(tgUpdates.receivedAt, olderThan))
        .returning({ updateId: tgUpdates.updateId });
      return rows.length;
    },

    /** The conversation, unless it has expired (an expired one is as good as none). */
    async getConversation(telegramUserId: number, now: Date): Promise<Conversation | null> {
      const [row] = await db
        .select()
        .from(conversationStates)
        .where(eq(conversationStates.telegramUserId, telegramUserId));
      if (row === undefined || row.expiresAt <= now) {
        return null;
      }
      return { flow: row.flow, step: row.step, data: row.data as Record<string, unknown> };
    },

    async setConversation(
      telegramUserId: number,
      conversation: Conversation,
      now: Date,
      ttlMs: number,
    ): Promise<void> {
      const expiresAt = new Date(now.getTime() + ttlMs);
      await db
        .insert(conversationStates)
        .values({ telegramUserId, ...conversation, expiresAt })
        .onConflictDoUpdate({
          target: conversationStates.telegramUserId,
          set: { ...conversation, expiresAt },
        });
    },

    async clearConversation(telegramUserId: number): Promise<void> {
      await db
        .delete(conversationStates)
        .where(eq(conversationStates.telegramUserId, telegramUserId));
    },

    async purgeExpiredConversations(now: Date): Promise<number> {
      const rows = await db
        .delete(conversationStates)
        .where(lt(conversationStates.expiresAt, now))
        .returning({ telegramUserId: conversationStates.telegramUserId });
      return rows.length;
    },
  };
}

export type TelegramRepository = ReturnType<typeof createTelegramRepository>;
