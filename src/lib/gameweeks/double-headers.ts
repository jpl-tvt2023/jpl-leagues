/**
 * Continental Championship gameweeks that carry a cup fixture alongside the league one.
 *
 * Single source of truth. This list existed twice — once in the dashboard API route and
 * once in the dashboard page — with no link between them, so a fixture-calendar change
 * had to be made in two places or the server and the client would disagree about which
 * gameweeks are double headers.
 */
export const DOUBLE_HEADER_GWS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 29, 33, 35, 38];
