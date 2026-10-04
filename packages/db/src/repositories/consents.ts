import { and, desc, eq, sql } from 'drizzle-orm';
import { isHuman, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import type { Executor } from '../orm';
import { consentRecords } from '../schema';

export type ConsentRecord = typeof consentRecords.$inferSelect;
export type ConsentKind = ConsentRecord['kind'];

export interface RecordConsentInput {
  readonly userId: string;
  readonly kind: ConsentKind;
  /** Which text the person saw. A new text is a new version and needs a new decision. */
  readonly version: string;
  readonly decision: ConsentRecord['decision'];
  readonly locale: ConsentRecord['locale'];
  readonly context: ConsentRecord['context'];
}

function mayActFor(actor: Actor, userId: string): boolean {
  return actor.kind === 'SYSTEM' || (isHuman(actor) && actor.userId === userId);
}

export function createConsentRepository(db: Executor) {
  const latestOf = async (
    executor: Executor,
    userId: string,
    kind: ConsentKind,
  ): Promise<ConsentRecord | null> => {
    const [row] = await executor
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.kind, kind)))
      .orderBy(desc(consentRecords.at), desc(consentRecords.id))
      .limit(1);
    return row ?? null;
  };

  return {
    /**
     * Adds a decision to the history. Repeating the decision that already stands for this
     * version (a double tap, a redelivered update) adds nothing and returns `created: false`.
     */
    async record(
      actor: Actor,
      input: RecordConsentInput,
    ): Promise<{ record: ConsentRecord; created: boolean }> {
      if (!mayActFor(actor, input.userId)) {
        throw new ForbiddenError('consent can only be given by the person it concerns');
      }
      return db.transaction(async (tx) => {
        // Serialise concurrent taps by one person; otherwise both could see "nothing yet".
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`consent:${input.userId}:${input.kind}`}))`,
        );
        const latest = await latestOf(tx, input.userId, input.kind);
        if (latest?.decision === input.decision && latest.version === input.version) {
          return { record: latest, created: false };
        }
        const [record] = await tx.insert(consentRecords).values(input).returning();
        if (record === undefined) {
          throw new Error('consent insert returned no row');
        }
        return { record, created: true };
      });
    },

    async latest(actor: Actor, userId: string, kind: ConsentKind): Promise<ConsentRecord | null> {
      return mayActFor(actor, userId) ? latestOf(db, userId, kind) : null;
    },

    /** True only if the latest decision is GRANTED and is for exactly this version of the text. */
    async isGranted(
      actor: Actor,
      userId: string,
      kind: ConsentKind,
      version: string,
    ): Promise<boolean> {
      const latest = mayActFor(actor, userId) ? await latestOf(db, userId, kind) : null;
      return latest?.decision === 'GRANTED' && latest.version === version;
    },
  };
}

export type ConsentRepository = ReturnType<typeof createConsentRepository>;
