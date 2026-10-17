// Cost and expediting assumptions for the prototype (placeholders until real rates exist).

import { distanceKm } from './util.mjs';

export const RUSH_PREMIUM = 0.15;        // rush parts orders, rush freight and rush hauls cost 15% more
export const RUSH_LEAD_FACTOR = 0.5;     // a rush parts order is quoted at half the normal lead time...
export const RUSH_SLIP_FACTOR = 0.3;     // ...and slips far less than the supplier's usual delay
export const FREIGHT_PER_MILE = 3.25;    // flatbed truckload rate
export const FREIGHT_PER_TRACTOR = 150;  // loading / tie-down per tractor
export const HAUL_HANDLING = 250;        // per pickup or return leg for a service job
export const REPAIR_LABOR_RATE = 95;     // $/hour at the plant
export const CARRYING_COST_RATE = 0.20;  // annual cost of holding inventory (capital, storage, obsolescence)

// Repair labour hours by part category.
export const REPAIR_HOURS = {
  engine: 14, transmission: 12, axle: 6, hydraulics: 4, lift: 4, cab: 10, frame: 6, door: 1.5,
  'door handle': 0.5, electronics: 2, electrical: 3, tire: 1, seat: 1, filters: 0.5, screws: 1,
};

export const miles = (lat1, lng1, lat2, lng2) => distanceKm(lat1, lng1, lat2, lng2) * 0.621371;

export const rushLeadDays = (quotedLeadDays) => Math.max(5, Math.ceil(quotedLeadDays * RUSH_LEAD_FACTOR));

/** Outbound truckload of tractors from the plant to a customer. */
export function tractorFreight(fromLat, fromLng, toLat, toLng, tractors, rush = false) {
  const base = miles(fromLat, fromLng, toLat, toLng) * FREIGHT_PER_MILE + tractors * FREIGHT_PER_TRACTOR;
  return Math.round(base * (rush ? 1 + RUSH_PREMIUM : 1) * 100) / 100;
}

/** One leg of a service haul (customer site <-> plant). */
export function haulLeg(fromLat, fromLng, toLat, toLng, rush = false) {
  const base = miles(fromLat, fromLng, toLat, toLng) * FREIGHT_PER_MILE + HAUL_HANDLING;
  return Math.round(base * (rush ? 1 + RUSH_PREMIUM : 1) * 100) / 100;
}

export const repairLabor = (category) => Math.round((REPAIR_HOURS[category] ?? 3) * REPAIR_LABOR_RATE * 100) / 100;
