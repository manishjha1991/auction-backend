/** Official stadiums an admin can assign as a team home ground. */
const CPL_ALLOWED_VENUES = [
  'Adelaide Oval',
  'The Gabba',
  'Melbourne Cricket Ground (MCG)',
  'Perth Stadium',
  'Sydney Cricket Ground (SCG)',
  'Docklands Stadium',
  'GMHBA Stadium',
  'Sydney Showground Stadium',
  'The WACA',
  'Edgbaston',
  'Emirates Old Trafford',
  'Headingley',
  'Kia Oval',
  "Lord's",
  'Utilita Bowl, Southampton',
  'Trent Bridge',
  'Narendra Modi Stadium',
  'Ekana Cricket Stadium',
  'Johannesburg Stadium',
];

function isAllowedCplVenue(name) {
  return CPL_ALLOWED_VENUES.includes(String(name || '').trim());
}

module.exports = { CPL_ALLOWED_VENUES, isAllowedCplVenue };
