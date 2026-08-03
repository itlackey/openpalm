import {
  AutomationRuntimeError,
  createLogger,
  type AutomationRuntimeErrorCode,
} from '@openpalm/lib';
import { errorResponse } from './helpers.js';

const logger = createLogger('admin.automations');

const AUTOMATION_ERROR_STATUS: Record<AutomationRuntimeErrorCode, number> = {
  busy: 503,
  conflict: 409,
  invalid_name: 400,
  invalid_request: 400,
  invalid_response: 502,
  invalid_task_id: 400,
  io_error: 503,
  not_found: 404,
  too_large: 413,
  unavailable: 503,
  unsafe_file: 500,
};

const AUTOMATION_AUDIT_ERROR_MESSAGE: Record<AutomationRuntimeErrorCode, string> = {
  busy: 'Automation runtime is busy',
  conflict: 'Automation task revision conflict',
  invalid_name: 'Automation task filename is invalid',
  invalid_request: 'Automation runtime request is invalid',
  invalid_response: 'Automation runtime returned an invalid response',
  invalid_task_id: 'Automation task ID is invalid',
  io_error: 'Automation runtime I/O failed',
  not_found: 'Automation task was not found',
  too_large: 'Automation runtime payload is too large',
  unavailable: 'Automation runtime is unavailable',
  unsafe_file: 'Automation task state is unsafe',
};

export type AutomationAuditContext = {
  fileName: string;
  operation: 'create' | 'update' | 'delete' | 'manual-run';
};

type AutomationAuditOutcome =
  | {
      outcome: 'success';
      newRevision?: string;
      runStatus?: string;
    }
  | {
      outcome: 'failure';
      errorCode: string;
      errorMessage: string;
      runStatus?: string;
    };

export function auditAutomationOperation(
  requestId: string,
  context: AutomationAuditContext,
  outcome: AutomationAuditOutcome,
): void {
  const details = { requestId, ...context, ...outcome };
  if (outcome.outcome === 'success') {
    logger.info('automation operation', details);
  } else {
    logger.warn('automation operation', details);
  }
}

export function automationRuntimeErrorResponse(
  error: unknown,
  requestId: string,
  auditContext?: AutomationAuditContext,
): Response {
  let status = 500;
  let code = 'internal_error';
  let message = 'Automation operation failed';
  let auditCode = code;
  let auditMessage = message;

  if (error instanceof AutomationRuntimeError) {
    auditCode = error.code;
    auditMessage = AUTOMATION_AUDIT_ERROR_MESSAGE[error.code];
    if (error.code !== 'unsafe_file') {
      status = AUTOMATION_ERROR_STATUS[error.code];
      code = error.code;
      message = ['conflict', 'invalid_name', 'invalid_request', 'invalid_task_id', 'not_found', 'too_large']
        .includes(error.code)
        ? error.message
        : AUTOMATION_AUDIT_ERROR_MESSAGE[error.code];
    }
  }

  if (auditContext) {
    auditAutomationOperation(requestId, auditContext, {
      outcome: 'failure',
      errorCode: auditCode,
      errorMessage: auditMessage,
    });
  }

  return errorResponse(status, code, message, {}, requestId);
}
