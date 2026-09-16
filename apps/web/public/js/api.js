/**
 * API client.
 *
 * Every response from this API is `{ data, meta }` or `{ error, meta }`, so
 * this unwraps that once and throws an ApiError carrying the code and the
 * details. The details matter: a blocked close returns its blockers in
 * `error.details.blockers`, and the books screen renders them.
 */

let config = { api_origin: '' };
let token = localStorage.getItem('rodeo.token') ?? '';
let orgId = localStorage.getItem('rodeo.org') ?? '';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function init() {
  try {
    const res = await fetch('/config.json');
    config = await res.json();
  } catch {
    // Served from a static host with no config endpoint: same origin.
    config = { api_origin: '' };
  }
}

export function setSession(nextToken, nextOrg) {
  token = nextToken;
  orgId = nextOrg;
  localStorage.setItem('rodeo.token', nextToken);
  localStorage.setItem('rodeo.org', nextOrg);
}

export function session() {
  return { token, orgId, configured: Boolean(token && orgId) };
}

export function clearSession() {
  token = '';
  orgId = '';
  localStorage.removeItem('rodeo.token');
  localStorage.removeItem('rodeo.org');
}

async function request(method, path, body, asText = false) {
  const url = `${config.api_origin}/v1/orgs/${orgId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (asText) {
    if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR', await res.text());
    return res.text();
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = payload.error ?? {};
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? res.statusText, e.details);
  }
  return payload.data;
}

export const api = {
  options: () => request('GET', '/options'),
  associations: () => request('GET', '/associations'),

  rodeos: () => request('GET', '/rodeos'),
  rodeo: (id) => request('GET', `/rodeos/${id}`),
  createRodeo: (body) => request('POST', '/rodeos', body),

  daySheet: (id, performance) =>
    request(
      'GET',
      `/rodeos/${id}/day-sheet${performance != null ? `?performance=${performance}` : ''}`,
    ),
  daySheetText: (id, performance) =>
    request(
      'GET',
      `/rodeos/${id}/day-sheet?format=text${performance != null ? `&performance=${performance}` : ''}`,
      null,
      true,
    ),

  books: (id) => request('GET', `/rodeos/${id}/books`),
  closeBooks: (id) => request('POST', `/rodeos/${id}/books/close`, {}),
  fileBooks: (id, reference, late) =>
    request('POST', `/rodeos/${id}/books/file`, { reference, late }),
  reopenBooks: (id, reason) => request('POST', `/rodeos/${id}/books/reopen`, { reason }),

  compliance: (id) => request('GET', `/rodeos/${id}/compliance`),
  generateCompliance: (id) => request('POST', `/rodeos/${id}/compliance/generate`, {}),
  patchCompliance: (id, itemId, patch) =>
    request('PATCH', `/rodeos/${id}/compliance/${itemId}`, patch),

  // ---- Desk -------------------------------------------------------------
  people: (q) => request('GET', `/people?q=${encodeURIComponent(q)}`),
  createPerson: (body) => request('POST', '/people', body),
  mergePeople: (keep_id, merge_id, reason) =>
    request('POST', '/people/merge', { keep_id, merge_id, reason }),

  entries: (rodeoId, eventId) =>
    request('GET', `/rodeos/${rodeoId}/entries${eventId ? `?event_id=${eventId}` : ''}`),
  patchEntry: (rodeoId, entryId, patch) =>
    request('PATCH', `/rodeos/${rodeoId}/entries/${entryId}`, patch),
  entryQuote: (rodeoId, eventId, params) =>
    request('GET', `/rodeos/${rodeoId}/events/${eventId}/entry-quote?${new URLSearchParams(params)}`),
  enter: (rodeoId, eventId, body) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/entries`, body),
  turnout: (rodeoId, entryId, body) =>
    request('POST', `/rodeos/${rodeoId}/entries/${entryId}/turnout`, body),

  backNumbers: (rodeoId) => request('GET', `/rodeos/${rodeoId}/back-numbers`),
  assignBackNumbers: (rodeoId, start) =>
    request('POST', `/rodeos/${rodeoId}/back-numbers/assign`, start ? { start } : {}),
  setBackNumber: (rodeoId, contestantId, back_number) =>
    request('PUT', `/rodeos/${rodeoId}/back-numbers/${contestantId}`, { back_number }),

  sidepots: (rodeoId) => request('GET', `/rodeos/${rodeoId}/sidepots`),
  createSidepot: (rodeoId, body) => request('POST', `/rodeos/${rodeoId}/sidepots`, body),
  calculateSidepot: (rodeoId, sidepotId) =>
    request('POST', `/rodeos/${rodeoId}/sidepots/${sidepotId}/calculate`, {}),

  // ---- Draw ---------------------------------------------------------------
  generateDraw: (rodeoId, eventId, body) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/draw`, { ...body, commit: true }),
  generateStockDraw: (rodeoId, eventId, body) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/draw/stock`,
      { animal_type: 'bull', ...body, commit: true }),

  // ---- Payouts ------------------------------------------------------------
  calculatePayouts: (rodeoId, eventId) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/calculate-payouts`, {}),
  disburse: (rodeoId, eventId) =>
    request('POST', `/rodeos/${rodeoId}/payouts/disburse`, {
      rodeo_event_id: eventId,
      confirm: true,
      // Idempotent by event: pressing Disburse twice pays once.
      idempotency_key: `disburse-${eventId}`,
    }),

  createRegistryAnimal: (body) => request('POST', '/registry', body),

  submitScore: (eventId, body) => request('POST', `/events/${eventId}/scores`, body),
  finalize: (rodeoId, eventId, official) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/finalize`, { official }),

  // ---- Corrections --------------------------------------------------------
  scoreSheet: (rodeoId, eventId) =>
    request('GET', `/rodeos/${rodeoId}/events/${eventId}/score-sheet`),
  correctScore: (rodeoId, scoreId, body) =>
    request('POST', `/rodeos/${rodeoId}/scores/${scoreId}/correct`, body),
  dqScore: (rodeoId, scoreId, reason) =>
    request('POST', `/rodeos/${rodeoId}/scores/${scoreId}/dq`, { reason }),
  rerideScore: (rodeoId, scoreId, reason) =>
    request('POST', `/rodeos/${rodeoId}/scores/${scoreId}/reride`, { reason }),

  // ---- Results, stock, personnel -----------------------------------------
  results: (rodeoId) => request('GET', `/rodeos/${rodeoId}/results`),
  publishResults: (rodeoId, eventId, official = true) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/publish`, { official }),

  animals: (rodeoId) =>
    request('GET', `/animals${rodeoId ? `?rodeo_id=${rodeoId}` : ''}`),
  createAnimal: (body) => request('POST', '/animals', body),
  setAnimalHealth: (animalId, health_status) =>
    request('PATCH', `/animals/${animalId}`, { health_status }),

  personnel: (rodeoId) => request('GET', `/rodeos/${rodeoId}/personnel`),
  assignPersonnel: (rodeoId, body) => request('POST', `/rodeos/${rodeoId}/personnel`, body),
  removePersonnel: (rodeoId, id) =>
    request('DELETE', `/rodeos/${rodeoId}/personnel/${id}`),
  credentials: (userId) => request('GET', `/people/${userId}/credentials`),
  addCredential: (userId, body) => request('POST', `/people/${userId}/credentials`, body),
  verifyCredential: (credentialId) =>
    request('POST', `/credentials/${credentialId}/verify`, {}),

  career: (contestantId) => request('GET', `/contestants/${contestantId}/career`),
  registrySearch: (q, type) =>
    request('GET', `/registry?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`),

  // ---- Grounds: stalls, RV spots, arena time ------------------------------
  resources: (rodeoId) =>
    request('GET', `/resources${rodeoId ? `?rodeo_id=${rodeoId}` : ''}`),
  createResource: (body) => request('POST', '/resources', body),
  availability: (from, to, rodeoId) =>
    request('GET', `/availability?from=${from}&to=${to}${rodeoId ? `&rodeo_id=${rodeoId}` : ''}`),
  bookings: (rodeoId) =>
    request('GET', `/bookings${rodeoId ? `?rodeo_id=${rodeoId}` : ''}`),
  book: (body) => request('POST', '/bookings', body),
  confirmBooking: (id, payment_reference) =>
    request('POST', `/bookings/${id}/confirm`, { payment_reference }),
  cancelBooking: (id, reason, refund_cents) =>
    request('POST', `/bookings/${id}/cancel`, { reason, refund_cents }),
  expireHolds: () => request('POST', '/bookings/expire-holds', {}),

  // ---- Notices ------------------------------------------------------------
  notices: (rodeoId) =>
    request('GET', `/notices${rodeoId ? `?rodeo_id=${rodeoId}` : ''}`),
  notifyDrawPosted: (rodeoId) =>
    request('POST', `/rodeos/${rodeoId}/notices/draw-posted`, {}),

  // ---- Waivers ------------------------------------------------------------
  waiverTemplates: () => request('GET', '/waivers/templates'),
  signWaiver: (body) => request('POST', '/waivers/sign', body),
  verifyWaiver: (signedId) => request('GET', `/waivers/${signedId}/verify`),
  waiverShortfall: (rodeoId) =>
    request('GET', `/rodeos/${rodeoId}/waivers/shortfall`),

  // ---- Year-end -----------------------------------------------------------
  taxSummary: (year) => request('GET', `/tax-summary?year=${year}`),

  // ---- Secretary module (Phase 1) -----------------------------------------
  // Turnout log — who did not show, and what it costs them.
  turnouts: (rodeoId) => request('GET', `/rodeos/${rodeoId}/turnouts`),
  logTurnout: (rodeoId, body) =>
    request('POST', `/rodeos/${rodeoId}/turnouts`, body),

  // Trades / doctor releases — position moves, capped per go.
  trades: (rodeoId) => request('GET', `/rodeos/${rodeoId}/trades`),
  logTrade: (rodeoId, body) => request('POST', `/rodeos/${rodeoId}/trades`, body),

  // Infractions — barrier, field, conduct. Posted ones are locked.
  infractions: (rodeoId) => request('GET', `/rodeos/${rodeoId}/infractions`),
  logInfraction: (rodeoId, body) =>
    request('POST', `/rodeos/${rodeoId}/infractions`, body),
  verifyInfraction: (rodeoId, id) =>
    request('POST', `/rodeos/${rodeoId}/infractions/${id}/verify`, {}),
  postInfraction: (rodeoId, id) =>
    request('POST', `/rodeos/${rodeoId}/infractions/${id}/post`, {}),

  // Personnel sign-ins — the crew present today.
  personnelSignins: (rodeoId) =>
    request('GET', `/rodeos/${rodeoId}/personnel-signins`),
  addPersonnelSignin: (rodeoId, body) =>
    request('POST', `/rodeos/${rodeoId}/personnel-signins`, body),
  removePersonnelSignin: (rodeoId, id) =>
    request('DELETE', `/rodeos/${rodeoId}/personnel-signins/${id}`),

  // Two-timer sheet — record each watch, then reconcile to an official time.
  timerReadings: (rodeoId, eventId) =>
    request('GET',
      `/rodeos/${rodeoId}/timer-readings${eventId ? `?event_id=${eventId}` : ''}`),
  recordTimer: (rodeoId, body) =>
    request('POST', `/rodeos/${rodeoId}/timer-readings`, body),
  reconcileTimer: (rodeoId, body) =>
    request('POST', `/rodeos/${rodeoId}/timer-readings/reconcile`, body),

  // Live performance state — what is up right now.
  performanceState: (rodeoId) =>
    request('GET', `/rodeos/${rodeoId}/performance-state`),
  setPerformanceState: (rodeoId, performanceNumber, body) =>
    request('PUT', `/rodeos/${rodeoId}/performance-state/${performanceNumber}`, body),

  // Close-out cover sheet — money in, money out, expected deposit.
  remittance: (rodeoId) => request('GET', `/rodeos/${rodeoId}/remittance`),
  setRemittance: (rodeoId, category, body) =>
    request('PUT', `/rodeos/${rodeoId}/remittance/${category}`, body),

  // Association packet — the checklist and the filing deadline.
  associationUpload: (rodeoId) =>
    request('GET', `/rodeos/${rodeoId}/association-upload`),
  startAssociationUpload: (rodeoId, body) =>
    request('POST', `/rodeos/${rodeoId}/association-upload`, body),
  updateAssociationUpload: (rodeoId, id, body) =>
    request('PUT', `/rodeos/${rodeoId}/association-upload/${id}`, body),
};
