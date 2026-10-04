import { and, eq } from 'drizzle-orm';
import type { Executor } from '../orm';
import {
  caregiverRelationships,
  clinicStaff,
  clinicianProfiles,
  patientProfiles,
  platformStaff,
  users,
  type ActorKind,
} from '../schema';

/**
 * Who is asking. A repository never takes a bare user id: it takes the capacity the user acts
 * in, because one person can be a patient and a clinician at once. `kind` is a hint about the
 * capacity only; what the actor may actually see is re-checked in SQL on every query
 * (see scopes.ts), so a revoked clinician or a closed relationship loses access immediately
 * even if an old Actor value is still around.
 */
export type Actor =
  | { readonly kind: 'PATIENT'; readonly userId: string }
  | { readonly kind: 'CLINICIAN'; readonly userId: string }
  | { readonly kind: 'CAREGIVER'; readonly userId: string }
  | {
      readonly kind: 'CLINIC_STAFF';
      readonly userId: string;
      readonly clinicId: string;
      readonly role: 'RECEPTION' | 'CLINIC_ADMIN';
    }
  | { readonly kind: 'TECH_ADMIN'; readonly userId: string }
  /** Workers and sweepers. Always carries the reason it is acting. */
  | { readonly kind: 'SYSTEM'; readonly reason: string };

export type HumanActor = Exclude<Actor, { kind: 'SYSTEM' }>;

export function isHuman(actor: Actor): actor is HumanActor {
  return actor.kind !== 'SYSTEM';
}

export function actorUserId(actor: Actor): string | null {
  return isHuman(actor) ? actor.userId : null;
}

export function actorKind(actor: Actor): ActorKind {
  return actor.kind;
}

export function systemActor(reason: string): Actor {
  return { kind: 'SYSTEM', reason };
}

/**
 * Every capacity a user can act in right now. A user whose status is not ACTIVE (blocked or
 * deleted) has none. A clinician profile counts even while unverified: whether that
 * clinician may see anything is decided per query, not here.
 */
export async function resolveActors(db: Executor, userId: string): Promise<Actor[]> {
  const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  if (user?.status !== 'ACTIVE') {
    return [];
  }

  const [patient, clinician, staff, platform, caregiver] = await Promise.all([
    db
      .select({ id: patientProfiles.userId })
      .from(patientProfiles)
      .where(eq(patientProfiles.userId, userId)),
    db
      .select({ id: clinicianProfiles.userId })
      .from(clinicianProfiles)
      .where(eq(clinicianProfiles.userId, userId)),
    db
      .select({ clinicId: clinicStaff.clinicId, role: clinicStaff.role })
      .from(clinicStaff)
      .where(and(eq(clinicStaff.userId, userId), eq(clinicStaff.status, 'ACTIVE'))),
    db
      .select({ id: platformStaff.userId })
      .from(platformStaff)
      .where(and(eq(platformStaff.userId, userId), eq(platformStaff.status, 'ACTIVE'))),
    db
      .select({ id: caregiverRelationships.id })
      .from(caregiverRelationships)
      .where(
        and(
          eq(caregiverRelationships.caregiverUserId, userId),
          eq(caregiverRelationships.status, 'ACTIVE'),
        ),
      )
      .limit(1),
  ]);

  const actors: Actor[] = [];
  if (patient.length > 0) {
    actors.push({ kind: 'PATIENT', userId });
  }
  if (clinician.length > 0) {
    actors.push({ kind: 'CLINICIAN', userId });
  }
  for (const row of staff) {
    actors.push({ kind: 'CLINIC_STAFF', userId, clinicId: row.clinicId, role: row.role });
  }
  if (platform.length > 0) {
    actors.push({ kind: 'TECH_ADMIN', userId });
  }
  if (caregiver.length > 0) {
    actors.push({ kind: 'CAREGIVER', userId });
  }
  return actors;
}
