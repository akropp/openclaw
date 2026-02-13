---
name: weather
description: |
  Get current weather and forecasts using free services (wttr.in primary, Open-Meteo fallback).

  USE WHEN:
  - User asks about current weather or forecast
  - Checking conditions for outdoor plans (temperature, rain, wind)
  - Travel planning (weather at destination)
  - Quick weather check before commute or activities

  DO NOT USE WHEN:
  - User wants historical weather data (not available via wttr.in)
  - Need extreme precision (these are free services, not professional-grade)
  - User asks about "climate" in a long-term sense (use web search for climate data)

  OUTPUTS:
  - Current conditions (temperature, condition emoji, humidity, wind)
  - 1-3 day forecast (wttr.in default)
  - Location name confirmation
  - Optional: PNG image for visual forecast

  EDGE CASES:
  - Ambiguous city names — wttr.in picks "best match" (may not be what user expects)
  - Use airport codes (JFK, LHR) for unambiguous location lookup
  - URL-encode spaces in city names (New+York, San+Francisco)
  - Default units are metric; add ?u for USCS (Fahrenheit)
  - Open-Meteo requires lat/lon (use wttr.in for city names unless precision matters)
homepage: https://wttr.in/:help
metadata: { "openclaw": { "emoji": "🌤️", "requires": { "bins": ["curl"] } } }
---

# Weather

Two free services, no API keys needed.

## wttr.in (primary)

Quick one-liner:

```bash
curl -s "wttr.in/London?format=3"
# Output: London: ⛅️ +8°C
```

Compact format:

```bash
curl -s "wttr.in/London?format=%l:+%c+%t+%h+%w"
# Output: London: ⛅️ +8°C 71% ↙5km/h
```

Full forecast:

```bash
curl -s "wttr.in/London?T"
```

Format codes: `%c` condition · `%t` temp · `%h` humidity · `%w` wind · `%l` location · `%m` moon

Tips:

- URL-encode spaces: `wttr.in/New+York`
- Airport codes: `wttr.in/JFK`
- Units: `?m` (metric) `?u` (USCS)
- Today only: `?1` · Current only: `?0`
- PNG: `curl -s "wttr.in/Berlin.png" -o /tmp/weather.png`

## Open-Meteo (fallback, JSON)

Free, no key, good for programmatic use:

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
```

Find coordinates for a city, then query. Returns JSON with temp, windspeed, weathercode.

Docs: https://open-meteo.com/en/docs
