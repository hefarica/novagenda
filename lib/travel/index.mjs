/**
 * Punto de entrada del módulo de agenda física (t15).
 *
 * Uso:
 *   import { resolvePlace, planTravel, estimateTravel, ensureMeetLink, createTask } from './lib/travel/index.mjs';
 */

export {
  TravelError, PLACE_CATEGORIES, DEFAULT_PLACES, cloneDefaultPlaces, placesOf, ensureTravelState,
  isOnlineLocation, parseCoordinatePair, resolvePlace, resolvePlaceOrThrow, validatePlaceInput,
  createPlace, updatePlace, deletePlace, getPlace, listPlaces, placeLabel
} from './places.mjs';

export {
  TRAVEL_MODES, DEFAULT_TRAVEL_SETTINGS, travelSettings, haversineKm, inferTravelMode,
  rushInfoAt, estimateTravel, formatTravelSummary, setEtaTransport, resetEtaTransport,
  clearEtaCache
} from './eta.mjs';

export {
  planTravel, computeEventTravel, parseInstant, buildAlternatives
} from './plan.mjs';

export {
  jitsiRoomCode, jitsiRoomLink, ensureMeetLink, meetForEvent, setMeetTransport,
  resetMeetTransport
} from './meet.mjs';

export {
  TASK_STATUSES, TASK_ORIGINS, TASK_PRIORITIES, parseTaskText, validateTaskInput, tasksOf,
  ensureTasks, createTask, getTask, updateTask, closeTask, reopenTask, deleteTask, listTasks,
  taskSummary
} from './tasks.mjs';

