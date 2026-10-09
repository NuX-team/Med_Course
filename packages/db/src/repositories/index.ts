import type { Executor } from '../orm';
import type { RepositoryDeps } from './context';
import { createAlertRepository } from './alerts';
import { createAppAuthRepository } from './app-auth';
import { createAnswerRepository } from './answers';
import { createCareRepository } from './care';
import { createCaregiverRepository } from './caregivers';
import { createChangeRepository } from './changes';
import { createClinicianRepository } from './clinicians';
import { createConsentRepository } from './consents';
import { createCourseRepository } from './courses';
import { createDoseRepository } from './doses';
import { createHistoryRepository } from './history';
import { createIncidentRepository } from './incidents';
import { createInvitationRepository } from './invitations';
import { createLifecycleRepository } from './lifecycle';
import { createMetricsRepository } from './metrics';
import { createOutboxRepository } from './outbox';
import { createPanelRepository } from './panel';
import { createPatientRepository } from './patients';
import { createPlanRepository } from './plans';
import { createPlatformRepository } from './platform';
import { createPrivacyRepository } from './privacy';
import { createPrnRepository } from './as-needed';
import { createRunRepository } from './runs';
import { createTelegramRepository } from './telegram';
import { createUserRepository } from './users';

export {
  RUN_REPORT_LIMIT,
  createAlertRepository,
  type AlertDose,
  type AlertRepository,
  type DoctorAlertKind,
  type DueAlert,
  type PauseRequestResult,
} from './alerts';
export * from './answers';
export * from './app-auth';
export * from './care';
export * from './caregivers';
export * from './changes';
export * from './clinicians';
export * from './consents';
export * from './context';
export * from './courses';
export * from './doses';
export * from './history';
export * from './incidents';
export * from './invitations';
export type { Recipient } from './layout';
export * from './lifecycle';
export * from './metrics';
export type { OpenIncidents, QueueStats, TechStats } from './stats';
export * from './outbox';
export * from './panel';
export * from './patients';
export * from './plans';
export * from './platform';
export * from './privacy';
export * from './as-needed';
export * from './runs';
export * from './telegram';
export * from './users';

/**
 * Repositories bound to one executor. For a transaction, open it on the root executor and
 * build a fresh set from the transaction handle, so every call inside shares it:
 *
 *   await db.transaction((tx) => doSomething(createRepositories(tx, deps)));
 */
export function createRepositories(db: Executor, deps: RepositoryDeps) {
  return {
    users: createUserRepository(db, deps),
    appAuth: createAppAuthRepository(db, deps),
    consents: createConsentRepository(db),
    patients: createPatientRepository(db, deps),
    clinicians: createClinicianRepository(db, deps),
    care: createCareRepository(db, deps),
    caregivers: createCaregiverRepository(db, deps),
    invitations: createInvitationRepository(db, deps),
    platform: createPlatformRepository(db, deps),
    courses: createCourseRepository(db, deps),
    plans: createPlanRepository(db, deps),
    runs: createRunRepository(db, deps),
    lifecycle: createLifecycleRepository(db, deps),
    changes: createChangeRepository(db, deps),
    outbox: createOutboxRepository(db, deps),
    answers: createAnswerRepository(db, deps),
    alerts: createAlertRepository(db),
    doses: createDoseRepository(db, deps),
    history: createHistoryRepository(db, deps),
    incidents: createIncidentRepository(db, deps),
    panel: createPanelRepository(db, deps),
    metrics: createMetricsRepository(db),
    privacy: createPrivacyRepository(db, deps),
    prn: createPrnRepository(db),
    telegram: createTelegramRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
