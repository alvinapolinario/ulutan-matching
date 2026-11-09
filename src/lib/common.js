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
 * Birds (legbands / score boxes) per entry. Set per event; events made before the setting existed use 2.
 * A derby needs at least DERBY_MIN_PER_ENTRY.
 */
const MIN_PER_ENTRY = 2;
const MAX_PER_ENTRY = 5;
const DERBY_MIN_PER_ENTRY = 3;
const perEntry = (ev) => {
  const n = Number(ev && ev.cocksPerEntry);
  const min = ev && ev.eventType === 'DERBY' ? DERBY_MIN_PER_ENTRY : MIN_PER_ENTRY;
  return Number.isInteger(n) && n >= min && n <= MAX_PER_ENTRY ? n : min;
};

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

/**
 * Birds. Every bird has a type and a legband (the number used for matching; it may be put on after
 * registration). Stags and bullstags also carry a wingband; a cock has none and is matched by weight.
 * Records made before types existed have no `type` and are cocks.
 */
const BIRD_TYPES = ['COCK', 'STAG', 'BULLSTAG'];
const BIRD_LABEL = { COCK: 'Cock', STAG: 'Stag', BULLSTAG: 'Bullstag' };
const birdType = (lb) => (lb && BIRD_TYPES.includes(lb.type) ? lb.type : 'COCK');
const needsWingband = (type) => type === 'STAG' || type === 'BULLSTAG';
/** Bird types an event accepts (set when the event is made; events from before the setting take all three). */
const allowedTypes = (ev) => {
  const list = ev && Array.isArray(ev.allowedTypes) ? BIRD_TYPES.filter((t) => ev.allowedTypes.includes(t)) : [];
  return list.length ? list : [...BIRD_TYPES];
};
/**
 * Weight rules for cocks, or null when the event does not use them. When on: `tolerance` is the largest
 * difference allowed between two cocks; `min` / `max` (optional) limit a cock's weight.
 * Events from before the on/off switch use the rules when a tolerance was set.
 */
const weightRules = (ev) => {
  if (!ev) return null;
  const on = ev.weightEnabled === undefined ? ev.weightTolerance != null : !!ev.weightEnabled;
  if (!on) return null;
  return { tolerance: ev.weightTolerance == null ? null : ev.weightTolerance, min: ev.minWeight == null ? null : ev.minWeight, max: ev.maxWeight == null ? null : ev.maxWeight };
};
/** The legband number ('' while the legband has not been put on yet). */
const bandLabel = (lb) => (lb && lb.number) || '';

/** Event kinds. A DERBY entry has at least 3 birds; a HACKFIGHT keeps the original rules (2 by default). */
const EVENT_TYPES = ['DERBY', 'HACKFIGHT'];
const eventType = (ev) => (ev && ev.eventType === 'DERBY' ? 'DERBY' : 'HACKFIGHT');

/**
 * Parse what an operator typed to find a bird: "7" / "L7" / "LB 007" = legband 007, "W7" / "WB-007" = wingband 007.
 * Returns { by: 'LEG'|'WING', number: '007' } or null.
 */
function parseBand(input, width = 3) {
  const s = String(input == null ? '' : input).trim().toUpperCase();
  const m = /^(?:(LB|L|WB|W)[\s-]*)?(\d{1,6})$/.exec(s);
  if (!m) return null;
  const number = normalizeLegband(m[2], width);
  if (!number) return null;
  return { by: m[1] && m[1].startsWith('W') ? 'WING' : 'LEG', number };
}

/** Weight in grams from "2105", "2,105", "2105g" or kilograms "2.105" / "2.1kg". null when blank; NaN when invalid. */
function parseWeight(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = /^(\d{1,2}(?:\.\d{1,3})?)kg$|^(\d{1,2}\.\d{1,3})$|^(\d{1,3}(?:,\d{3})|\d{1,5})g?$/.exec(s);
  if (!m) return NaN;
  const g = m[1] || m[2] ? Math.round(parseFloat(m[1] || m[2]) * 1000) : parseInt(m[3].replace(',', ''), 10);
  return g >= 1 && g <= 20000 ? g : NaN;
}

module.exports = {
  BIRD_TYPES, BIRD_LABEL, birdType, needsWingband, allowedTypes, weightRules, bandLabel, EVENT_TYPES, eventType, parseBand, parseWeight,
  AppError, badRequest, notFound, conflict, forbidden,
  ROLES, EVENT_STATUSES, EVENT_TRANSITIONS, CAN_REGISTER, CAN_MATCH, CAN_RUN_FIGHTS,
  LEGBAND_STATUSES, MATCH_STATUSES, RESULTS,
  now, pad, nameKey, cleanText, points, normalizeLegband,
  MIN_PER_ENTRY, MAX_PER_ENTRY, DERBY_MIN_PER_ENTRY, perEntry,
};
