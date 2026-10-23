'use strict';

class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
    this.details = details;
  }
}
const badRequest = (msg, code, details) => new AppError(400, msg, code || 'VALIDATION', details);
const notFound = (msg, code) => new AppError(404, msg, code || 'NOT_FOUND');
const conflict = (msg, code, details) => new AppError(409, msg, code || 'CONFLICT', details);
const forbidden = (msg) => new AppError(403, msg || 'You do not have permission to do this.', 'FORBIDDEN');

const ROLES = ['ADMIN', 'OPERATOR', 'DISPLAY'];

const EVENT_STATUSES = ['DRAFT', 'REGISTRATION_OPEN', 'MATCHING_OPEN', 'ACTIVE', 'COMPLETED', 'ARCHIVED'];
const EVENT_TRANSITIONS = {
  DRAFT: ['REGISTRATION_OPEN'],
  REGISTRATION_OPEN: ['DRAFT', 'MATCHING_OPEN'],
  MATCHING_OPEN: ['REGISTRATION_OPEN', 'ACTIVE'],
  ACTIVE: ['MATCHING_OPEN', 'COMPLETED'],
  COMPLETED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['COMPLETED'],
};
const CAN_REGISTER = ['REGISTRATION_OPEN', 'MATCHING_OPEN', 'ACTIVE'];
const CAN_MATCH = ['MATCHING_OPEN', 'ACTIVE'];
const CAN_RUN_FIGHTS = ['MATCHING_OPEN', 'ACTIVE'];

/**
 * Legband lifecycle
 *   AVAILABLE --confirm match--> MATCHED            (stays MATCHED after the fight: no rematches)
 *   AVAILABLE --withdraw-------> WITHDRAWN
 *   MATCHED   --match cancelled-> INACTIVE          (cancelled legbands can never be used again)
 *   MATCHED   --corrected out of a match (wrong number typed)--> AVAILABLE
 * RESERVED is reserved for a future provisional-match workflow.
 */
const LEGBAND_STATUSES = ['AVAILABLE', 'RESERVED', 'MATCHED', 'WITHDRAWN', 'INACTIVE'];

/**
 * Match lifecycle
 *   (DRAFT, future) -> CONFIRMED -> COMPLETED (result 1-0, 0-1, 1/2-1/2)
 *                      CONFIRMED -> CANCELLED (legbands become INACTIVE; fight number never reused)
 *                      CONFIRMED -> unmatched (human error): the match is removed, both legbands
 *                        return to AVAILABLE, and the fight number can be used again
 */
const MATCH_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
const RESULTS = { RED: { red: 1, blue: 0 }, BLUE: { red: 0, blue: 1 }, DRAW: { red: 0.5, blue: 0.5 } };

const now = () => new Date().toISOString();
const pad = (n, width = 3) => String(n).padStart(width, '0');
const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanText = (s, max = 120) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, max);
const points = (p) => (p === 0.5 ? '½' : p == null ? '' : String(p));

/** Turn user input like "7", "07", " 007 " into "007". Returns null if not a number. */
function normalizeLegband(input, width = 3) {
  const s = String(input == null ? '' : input).trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (n <= 0) return null;
  return pad(n, width);
}

module.exports = {
  AppError, badRequest, notFound, conflict, forbidden,
  ROLES, EVENT_STATUSES, EVENT_TRANSITIONS, CAN_REGISTER, CAN_MATCH, CAN_RUN_FIGHTS,
  LEGBAND_STATUSES, MATCH_STATUSES, RESULTS,
  now, pad, nameKey, cleanText, points, normalizeLegband,
};
