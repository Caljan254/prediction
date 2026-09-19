const stadiums = require('../config/stadiums.json');
const apiAggregator = require('./apiAggregator');
const { normalizeTeamName } = require('./leagueConfig');
const { normalizeOpenMeteoHour, normalizeWeatherApiDay } = require('./dataNormalizer');

function getStadiumInfo(homeTeamName) {
  const canonical = normalizeTeamName(homeTeamName);
  return stadiums[canonical] || null;
}

// Pulls weather for the exact kickoff hour at the home team's stadium.
// Primary: Open-Meteo (free, no key, hour-exact). Fallback: WeatherAPI.com (day-level average).
async function getMatchWeather({ homeTeam, kickoffUtc }) {
  const stadium = getStadiumInfo(homeTeam);
  if (!stadium || !kickoffUtc) {
    return { dataAvailable: false, reason: !stadium ? 'Stadium coordinates not found' : 'No kickoff time', stadium: stadium || null };
  }

  const dateStr = kickoffUtc.slice(0, 10);

  const meteoResult = await apiAggregator.fetchOpenMeteo(stadium.lat, stadium.lon, dateStr);
  if (meteoResult.success) {
    const hourData = normalizeOpenMeteoHour(meteoResult.data, kickoffUtc);
    if (hourData) {
      return {
        dataAvailable: true,
        source: 'openMeteo',
        exact: true,
        stadium,
        ...hourData,
        ...computePitchImpact(hourData)
      };
    }
  }

  const weatherApiResult = await apiAggregator.fetchWeatherApi(`${stadium.lat},${stadium.lon}`, dateStr);
  if (weatherApiResult.success) {
    const dayData = normalizeWeatherApiDay(weatherApiResult.data);
    if (dayData) {
      return {
        dataAvailable: true,
        source: 'weatherApi',
        exact: false,
        stadium,
        ...dayData,
        ...computePitchImpact(dayData)
      };
    }
  }

  return { dataAvailable: false, reason: 'Both weather sources unavailable', stadium };
}

// Converts raw conditions into a signed impact score (-1 suppresses goals/technical play, +1 neutral/favorable)
// plus a human-readable note, used both as the Weather factor lean and as a Poisson lambda dampener.
function computePitchImpact({ temperatureC, precipitationMm, windKph }) {
  let impact = 0;
  const notes = [];

  if (typeof precipitationMm === 'number') {
    if (precipitationMm >= 4) { impact -= 0.4; notes.push('Heavy rain — expect a slower, more error-prone game'); }
    else if (precipitationMm >= 1) { impact -= 0.15; notes.push('Light rain'); }
  }

  if (typeof windKph === 'number') {
    if (windKph >= 35) { impact -= 0.35; notes.push('Strong wind — affects long balls, crossing and set pieces'); }
    else if (windKph >= 20) { impact -= 0.1; notes.push('Breezy conditions'); }
  }

  if (typeof temperatureC === 'number') {
    if (temperatureC >= 32) { impact -= 0.2; notes.push('High heat — fatigue factor in second half'); }
    else if (temperatureC <= 2) { impact -= 0.15; notes.push('Freezing conditions'); }
  }

  return {
    impactScore: Math.max(-1, Math.min(1, impact)),
    notes: notes.length ? notes.join('; ') : 'No significant weather impact expected'
  };
}

module.exports = { getStadiumInfo, getMatchWeather, computePitchImpact };
