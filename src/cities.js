// Cities offered in the city picker. Any other place on Earth can still be
// chosen: the client geocodes it and the API filters by radius around the
// coordinates, so this list only controls what is one tap away.
// [name, country code, lat, lng, IANA time zone, RA area id or null]
const CITIES = [
  ['Belgrade', 'RS', 44.8125, 20.4612, 'Europe/Belgrade', 562],
  ['Novi Sad', 'RS', 45.2551, 19.8452, 'Europe/Belgrade', null],
  ['Niš', 'RS', 43.3209, 21.8958, 'Europe/Belgrade', null],
  ['Kragujevac', 'RS', 44.0128, 20.9114, 'Europe/Belgrade', null],
  ['Subotica', 'RS', 46.1003, 19.6658, 'Europe/Belgrade', null],
  ['Zagreb', 'HR', 45.8150, 15.9819, 'Europe/Zagreb', 559],
  ['Split', 'HR', 43.5081, 16.4402, 'Europe/Zagreb', null],
  ['Ljubljana', 'SI', 46.0569, 14.5058, 'Europe/Ljubljana', null],
  ['Sarajevo', 'BA', 43.8563, 18.4131, 'Europe/Sarajevo', null],
  ['Podgorica', 'ME', 42.4304, 19.2594, 'Europe/Podgorica', null],
  ['Skopje', 'MK', 41.9981, 21.4254, 'Europe/Skopje', null],
  ['Budapest', 'HU', 47.4979, 19.0402, 'Europe/Budapest', 449],
  ['Vienna', 'AT', 48.2082, 16.3738, 'Europe/Vienna', 450],
  ['Bucharest', 'RO', 44.4268, 26.1025, 'Europe/Bucharest', null],
  ['Sofia', 'BG', 42.6977, 23.3219, 'Europe/Sofia', null],
  ['Athens', 'GR', 37.9838, 23.7275, 'Europe/Athens', null],
  ['Thessaloniki', 'GR', 40.6401, 22.9444, 'Europe/Athens', null],
  ['Istanbul', 'TR', 41.0082, 28.9784, 'Europe/Istanbul', null],
  ['Berlin', 'DE', 52.5200, 13.4050, 'Europe/Berlin', 34],
  ['Hamburg', 'DE', 53.5511, 9.9937, 'Europe/Berlin', null],
  ['Munich', 'DE', 48.1351, 11.5820, 'Europe/Berlin', null],
  ['Prague', 'CZ', 50.0755, 14.4378, 'Europe/Prague', null],
  ['Warsaw', 'PL', 52.2297, 21.0122, 'Europe/Warsaw', null],
  ['Kraków', 'PL', 50.0647, 19.9450, 'Europe/Warsaw', null],
  ['London', 'GB', 51.5072, -0.1276, 'Europe/London', 13],
  ['Manchester', 'GB', 53.4808, -2.2426, 'Europe/London', null],
  ['Dublin', 'IE', 53.3498, -6.2603, 'Europe/Dublin', null],
  ['Paris', 'FR', 48.8566, 2.3522, 'Europe/Paris', 44],
  ['Amsterdam', 'NL', 52.3676, 4.9041, 'Europe/Amsterdam', 29],
  ['Brussels', 'BE', 50.8503, 4.3517, 'Europe/Brussels', null],
  ['Copenhagen', 'DK', 55.6761, 12.5683, 'Europe/Copenhagen', null],
  ['Stockholm', 'SE', 59.3293, 18.0686, 'Europe/Stockholm', null],
  ['Oslo', 'NO', 59.9139, 10.7522, 'Europe/Oslo', null],
  ['Zurich', 'CH', 47.3769, 8.5417, 'Europe/Zurich', null],
  ['Milan', 'IT', 45.4642, 9.1900, 'Europe/Rome', null],
  ['Rome', 'IT', 41.9028, 12.4964, 'Europe/Rome', null],
  ['Barcelona', 'ES', 41.3874, 2.1686, 'Europe/Madrid', 20],
  ['Madrid', 'ES', 40.4168, -3.7038, 'Europe/Madrid', null],
  ['Ibiza', 'ES', 38.9067, 1.4206, 'Europe/Madrid', null],
  ['Lisbon', 'PT', 38.7223, -9.1393, 'Europe/Lisbon', null],
  ['Tbilisi', 'GE', 41.7151, 44.8271, 'Asia/Tbilisi', null],
  ['Tel Aviv', 'IL', 32.0853, 34.7818, 'Asia/Jerusalem', null],
  ['Dubai', 'AE', 25.2048, 55.2708, 'Asia/Dubai', null],
  ['New York', 'US', 40.7128, -74.0060, 'America/New_York', 8],
  ['Los Angeles', 'US', 34.0522, -118.2437, 'America/Los_Angeles', null],
  ['Miami', 'US', 25.7617, -80.1918, 'America/New_York', null],
  ['Chicago', 'US', 41.8781, -87.6298, 'America/Chicago', null],
  ['Detroit', 'US', 42.3314, -83.0458, 'America/Detroit', null],
  ['Toronto', 'CA', 43.6532, -79.3832, 'America/Toronto', null],
  ['Montreal', 'CA', 45.5019, -73.5674, 'America/Toronto', null],
  ['Mexico City', 'MX', 19.4326, -99.1332, 'America/Mexico_City', null],
  ['São Paulo', 'BR', -23.5558, -46.6396, 'America/Sao_Paulo', null],
  ['Buenos Aires', 'AR', -34.6037, -58.3816, 'America/Argentina/Buenos_Aires', null],
  ['Bogotá', 'CO', 4.7110, -74.0721, 'America/Bogota', null],
  ['Tokyo', 'JP', 35.6762, 139.6503, 'Asia/Tokyo', null],
  ['Seoul', 'KR', 37.5665, 126.9780, 'Asia/Seoul', null],
  ['Bangkok', 'TH', 13.7563, 100.5018, 'Asia/Bangkok', null],
  ['Singapore', 'SG', 1.3521, 103.8198, 'Asia/Singapore', null],
  ['Sydney', 'AU', -33.8688, 151.2093, 'Australia/Sydney', null],
  ['Melbourne', 'AU', -37.8136, 144.9631, 'Australia/Melbourne', null],
  ['Cape Town', 'ZA', -33.9249, 18.4241, 'Africa/Johannesburg', null],
  ['Lagos', 'NG', 6.5244, 3.3792, 'Africa/Lagos', null],
].map(([name, country, lat, lng, tz, raArea]) => ({ name, country, lat, lng, tz, raArea }));

const byName = new Map(CITIES.map(c => [c.name.toLowerCase(), c]));
// Local spellings people type into the picker.
for (const [alias, name] of [['beograd', 'Belgrade'], ['београд', 'Belgrade'], ['нови сад', 'Novi Sad'], ['wien', 'Vienna'],
  ['münchen', 'Munich'], ['praha', 'Prague'], ['warszawa', 'Warsaw'], ['roma', 'Rome'], ['milano', 'Milan'], ['lisboa', 'Lisbon'],
  ['nyc', 'New York'], ['new york city', 'New York'], ['la', 'Los Angeles'], ['sao paulo', 'São Paulo'], ['bogota', 'Bogotá']]) {
  byName.set(alias, byName.get(name.toLowerCase()));
}

const findCity = name => byName.get(String(name || '').trim().toLowerCase()) || null;

module.exports = { CITIES, findCity };
