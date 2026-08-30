// Description:
//   Shows current weather for a city.
//
// Commands:
//   hubot weather <city> - Shows current temperature and conditions for <city>.
//

import type { Robot } from 'hubot'

import { required } from './lib/match.ts'

interface GeocodingResult {
  results?: { name: string; country: string; latitude: number; longitude: number }[]
}

interface ForecastResult {
  current: { temperature_2m: number; weather_code: number }
}

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail'
}

export default async (robot: Robot) => {
  robot.respond(/(?:weather|forecast)(?: (?:in|for|at))? (.+)$/i, async res => {
    const city = required(res.match, 1).trim()

    const geoResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)
    const geoData: GeocodingResult = await geoResponse.json()
    const place = geoData.results && geoData.results[0]

    if (!place) {
      await res.send(`Couldn't find a place named ${city}.`)
      return
    }

    const forecastResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code`)
    const forecastData: ForecastResult = await forecastResponse.json()
    const current = forecastData.current
    const description = WMO_DESCRIPTIONS[current.weather_code] || 'Unknown conditions'

    await res.send(`${place.name}, ${place.country}: ${current.temperature_2m}°C, ${description}`)
  })
}
