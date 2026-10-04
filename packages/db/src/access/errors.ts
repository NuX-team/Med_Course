/**
 * What a repository says when it refuses. Reading something the actor may not see is
 * indistinguishable from reading something that does not exist (`null` / NotFoundError), so a
 * guessed id reveals nothing. ForbiddenError is for actions the actor's role can never take.
 */
export class RepositoryError extends Error {
  readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT';

  constructor(code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT', message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends RepositoryError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
  }
}

export class ForbiddenError extends RepositoryError {
  constructor(message: string) {
    super('FORBIDDEN', message);
  }
}

export class ConflictError extends RepositoryError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}
