import {
  ForbiddenError,
  systemActor,
  type Actor,
  type Repositories,
  type VerificationStatus,
} from '@medcourse/db';
import { t } from '@medcourse/i18n';
import type { TelegramApi } from '../telegram/types';

/**
 * The server's own command line for the few things no chat may do: making someone an
 * administrator and deciding who counts as a doctor. Runs against the same database as the bot.
 * The core is a function, so it can be tested without a terminal.
 */

export const USAGE = [
  'Usage: pnpm admin <command> [options]',
  '',
  'Commands:',
  '  grant-admin <telegram-id>',
  '      Make an existing account (someone who has started the bot) an administrator.',
  '  list-doctors --by <telegram-id> [--status PENDING|VERIFIED|REVOKED]',
  '      Show doctors in a state (default PENDING), oldest first, with what they wrote.',
  '  verify-doctor <user-id> --by <telegram-id> --reference "<what you checked>"',
  '      Accept a doctor and tell them in the bot.',
  '  revoke-doctor <user-id> --by <telegram-id> [--reference "<why>"]',
  '      Withdraw a doctor’s standing. Their access ends at once.',
  '  list-clinics --by <telegram-id>',
  '      Show every clinic with its staff (the people who may open the panel for it).',
  '  add-staff <clinic-id> <telegram-id> --role RECEPTION|CLINIC_ADMIN --by <telegram-id>',
  '      Make someone who has started the bot a member of a clinic’s staff (or change their role).',
  '  revoke-staff <staff-id> --by <telegram-id>',
  '      End a staff membership. Their panel sessions stop working at once.',
  '',
  '--by is the Telegram id of an administrator. Ids are shown by list-doctors and list-clinics.',
].join('\n');

export interface AdminDeps {
  readonly repos: Repositories;
  /** Null when no Telegram token is configured: nobody is told, and the output says so. */
  readonly api: Pick<TelegramApi, 'sendMessage'> | null;
  readonly out: (line: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES: readonly VerificationStatus[] = ['PENDING', 'VERIFIED', 'REVOKED'];
const system = systemActor('admin command line');

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string>;
}

/** `--name value` pairs and bare words. Anything else, or a flag without a value, is an error. */
function parse(argv: readonly string[]): Parsed | string {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? '';
    if (!word.startsWith('--')) {
      positional.push(word);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return `${word} needs a value`;
    }
    if (flags.has(word)) {
      return `${word} was given twice`;
    }
    flags.set(word, value);
    index += 1;
  }
  return { positional, flags };
}

function telegramIdOf(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,14}$/.test(value)) {
    return null;
  }
  return Number(value);
}

/** Returns the process exit code: 0 on success, 1 on a refusal, 2 on a usage mistake. */
export async function runAdminCommand(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { repos, out } = deps;
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help') {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const parsed = parse(rest);
  if (typeof parsed === 'string') {
    out(`${parsed}\n\n${USAGE}`);
    return 2;
  }
  const { positional, flags } = parsed;
  const unknown = [...flags.keys()].filter(
    (flag) => !['--by', '--reference', '--status', '--role'].includes(flag),
  );
  if (unknown.length > 0) {
    out(`unknown option ${unknown.join(', ')}\n\n${USAGE}`);
    return 2;
  }

  /** The administrator named by --by, as the actor the repositories check. */
  const administrator = async (): Promise<Actor | number> => {
    const telegramId = telegramIdOf(flags.get('--by'));
    if (telegramId === null) {
      out('--by must be the Telegram id of an administrator (digits only)');
      return 2;
    }
    const account = await repos.users.findByTelegramId(system, telegramId);
    if (account?.status !== 'ACTIVE') {
      out('no active account has that Telegram id: the person must start the bot first');
      return 1;
    }
    return { kind: 'TECH_ADMIN', userId: account.id };
  };

  try {
    switch (command) {
      case 'grant-admin': {
        const telegramId = telegramIdOf(positional[0]);
        if (telegramId === null || positional.length !== 1 || flags.size > 0) {
          out(`grant-admin takes one Telegram id\n\n${USAGE}`);
          return 2;
        }
        const account = await repos.users.findByTelegramId(system, telegramId);
        if (account === null || !(await repos.platform.grantTechAdmin(system, account.id))) {
          out('no active account has that Telegram id: the person must start the bot first');
          return 1;
        }
        out(`account ${account.id} is now an administrator`);
        return 0;
      }

      case 'list-doctors': {
        const status = (flags.get('--status') ?? 'PENDING').toUpperCase();
        if (!STATUSES.includes(status as VerificationStatus) || positional.length > 0) {
          out(`--status must be one of ${STATUSES.join(', ')}\n\n${USAGE}`);
          return 2;
        }
        const actor = await administrator();
        if (typeof actor === 'number') {
          return actor;
        }
        const doctors = await repos.clinicians.listByStatus(actor, status as VerificationStatus);
        if (doctors.length === 0) {
          out(`no doctors with status ${status}`);
          return 0;
        }
        for (const doctor of doctors) {
          out(
            `${doctor.userId}  ${doctor.lastName} ${doctor.firstName}  telegram:${String(doctor.telegramUserId)}  applied:${doctor.appliedAt.toISOString()}  ${doctor.verificationStatus}`,
          );
          if (doctor.note !== null) {
            out(`    wrote: ${doctor.note}`);
          }
          if (doctor.verificationReference !== null) {
            out(`    checked: ${doctor.verificationReference}`);
          }
        }
        return 0;
      }

      case 'verify-doctor':
      case 'revoke-doctor': {
        const userId = positional[0];
        if (userId === undefined || !UUID.test(userId) || positional.length !== 1) {
          out(`${command} takes one user id (as shown by list-doctors)\n\n${USAGE}`);
          return 2;
        }
        const reference = flags.get('--reference');
        if (command === 'verify-doctor' && reference === undefined) {
          out(`verify-doctor needs --reference: say what you checked\n\n${USAGE}`);
          return 2;
        }
        const actor = await administrator();
        if (typeof actor === 'number') {
          return actor;
        }

        const outcome =
          command === 'verify-doctor'
            ? await repos.clinicians.verify(actor, {
                clinicianId: userId,
                reference: reference ?? '',
              })
            : await repos.clinicians.revoke(actor, {
                clinicianId: userId,
                ...(reference === undefined ? {} : { reference }),
              });
        if (outcome === null) {
          out('no doctor has that user id');
          return 1;
        }
        const verb = command === 'verify-doctor' ? 'verified' : 'revoked';
        out(
          outcome.changed
            ? `${outcome.clinician.lastName} ${outcome.clinician.firstName} is now ${verb}`
            : `${outcome.clinician.lastName} ${outcome.clinician.firstName} was already ${verb}: nothing changed`,
        );

        if (command === 'verify-doctor' && outcome.changed) {
          if (deps.api === null) {
            out('the doctor was not told: no TELEGRAM_BOT_TOKEN is configured here');
          } else {
            try {
              await deps.api.sendMessage(
                outcome.telegramUserId,
                t(outcome.locale, 'doctor.verified'),
              );
              out('the doctor was told in the bot');
            } catch {
              // The reason is not printed: an HTTP error can carry the request address.
              out(
                'the doctor could not be told (they will see it the next time they open the menu)',
              );
            }
          }
        }
        return 0;
      }

      case 'list-clinics': {
        if (positional.length > 0) {
          out(`list-clinics takes no arguments\n\n${USAGE}`);
          return 2;
        }
        const actor = await administrator();
        if (typeof actor === 'number') {
          return actor;
        }
        const clinics = await repos.panel.clinics(actor);
        if (clinics.length === 0) {
          out('no clinics yet: one appears when a doctor applies');
          return 0;
        }
        for (const clinic of clinics) {
          out(`${clinic.clinicId}  ${clinic.name}  ${clinic.status}`);
          for (const member of clinic.staff) {
            out(
              `    staff:${member.staffId}  ${member.lastName} ${member.firstName}  ${member.role}  ${member.status}`,
            );
          }
        }
        return 0;
      }

      case 'add-staff': {
        const [clinicId, person] = positional;
        const telegramId = telegramIdOf(person);
        const role = (flags.get('--role') ?? '').toUpperCase();
        if (
          clinicId === undefined ||
          !UUID.test(clinicId) ||
          telegramId === null ||
          positional.length !== 2 ||
          (role !== 'RECEPTION' && role !== 'CLINIC_ADMIN')
        ) {
          out(
            `add-staff takes a clinic id, a Telegram id and --role RECEPTION or CLINIC_ADMIN\n\n${USAGE}`,
          );
          return 2;
        }
        const actor = await administrator();
        if (typeof actor === 'number') {
          return actor;
        }
        const added = await repos.panel.addClinicStaff(actor, {
          clinicId,
          telegramUserId: telegramId,
          role,
        });
        if (added.status === 'NOT_FOUND') {
          out('no such clinic, or the person has not registered in the bot yet');
          return 1;
        }
        out(
          added.status === 'ADDED'
            ? `added as ${role}: they can now send /panel to the bot`
            : `already on the staff: the role is now ${role}`,
        );
        return 0;
      }

      case 'revoke-staff': {
        const staffId = positional[0];
        if (staffId === undefined || !UUID.test(staffId) || positional.length !== 1) {
          out(`revoke-staff takes one staff id (as shown by list-clinics)\n\n${USAGE}`);
          return 2;
        }
        const actor = await administrator();
        if (typeof actor === 'number') {
          return actor;
        }
        if (!(await repos.panel.revokeClinicStaff(actor, staffId))) {
          out('no active staff membership has that id');
          return 1;
        }
        out('the staff membership is revoked');
        return 0;
      }

      default:
        out(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ForbiddenError) {
      out(`refused: ${error.message}. Make the account an administrator with grant-admin first.`);
      return 1;
    }
    if (error instanceof RangeError) {
      out(`refused: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
