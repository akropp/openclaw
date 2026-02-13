---
name: spotify-player
description: |
  Control Spotify playback and search via terminal (spogo preferred, spotify_player fallback).

  USE WHEN:
  - Playing/pausing/skipping Spotify tracks
  - Searching for songs, albums, artists, or playlists
  - Switching playback devices
  - Checking current playback status

  DO NOT USE WHEN:
  - User wants YouTube, Apple Music, or other streaming services
  - User asks for "music" but means local files (use mpv or file player)
  - User doesn't have Spotify Premium (Connect API requires Premium)
  - Looking for music metadata/lyrics (use web search instead)

  OUTPUTS:
  - Search results with track/artist/album info
  - Current playback status (track name, artist, playing/paused)
  - Device list with active device highlighted
  - Success/failure for playback commands

  EDGE CASES:
  - spogo requires cookie import from browser (`spogo auth import --browser chrome`)
  - spotify_player TUI must be running for some operations
  - Device names can be ambiguous — list devices first if unsure
  - Search returns multiple result types (tracks, albums, artists) — clarify if needed
homepage: https://www.spotify.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🎵",
        "requires": { "anyBins": ["spogo", "spotify_player"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "spogo",
              "tap": "steipete/tap",
              "bins": ["spogo"],
              "label": "Install spogo (brew)",
            },
            {
              "id": "brew",
              "kind": "brew",
              "formula": "spotify_player",
              "bins": ["spotify_player"],
              "label": "Install spotify_player (brew)",
            },
          ],
      },
  }
---

# spogo / spotify_player

Use `spogo` **(preferred)** for Spotify playback/search. Fall back to `spotify_player` if needed.

Requirements

- Spotify Premium account.
- Either `spogo` or `spotify_player` installed.

spogo setup

- Import cookies: `spogo auth import --browser chrome`

Common CLI commands

- Search: `spogo search track "query"`
- Playback: `spogo play|pause|next|prev`
- Devices: `spogo device list`, `spogo device set "<name|id>"`
- Status: `spogo status`

spotify_player commands (fallback)

- Search: `spotify_player search "query"`
- Playback: `spotify_player playback play|pause|next|previous`
- Connect device: `spotify_player connect`
- Like track: `spotify_player like`

Notes

- Config folder: `~/.config/spotify-player` (e.g., `app.toml`).
- For Spotify Connect integration, set a user `client_id` in config.
- TUI shortcuts are available via `?` in the app.
