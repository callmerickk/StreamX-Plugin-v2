# MovieBox Multi-Source for Nuvio (prototype v0.2.0)

## Behavior

- Fetches TMDB title/year metadata once and caches it for 6 hours.
- Starts a shared MovieBox H5 search-suggest request and several possible search-page routes per origin concurrently.
- Tries the best-matching title candidates concurrently to reduce sequential lookup delay.
- Runs source playback requests in parallel. The first source that returns a non-empty list of plausible direct stream URLs wins; sibling requests are aborted when the JS runtime supports `AbortController`.
- Filters out entries marked VIP-locked, `notWebReady`, URLs containing `/other/`, and labels that look like app-update placeholders.
- Caches the winning stream list for 90 seconds. Signed stream links may expire sooner, so if playback fails, refresh the title.

Configured origins:
- `https://movibox.net`
- `https://moviebox.ph`
- `https://movieboxhd.net`
- `https://movie-box.co`

## Important limitations

- This is a best-effort prototype based on the existing user-supplied HAR and provider source; it has not been live-tested inside Nuvio from the user's device.
- The four domains may not share the same H5 API or page routes forever. A site can return no results or block requests from a particular network.
- The search suggest endpoint is common (`h5-api.aoneroom.com`); the per-domain race mainly tests site search pages and site playback endpoints. This does not guarantee four independent backends.
- A returned URL is only considered plausible based on the response fields and URL pattern; only an actual playback test can verify that the media is playable.
- It intentionally does not impersonate the MovieBox mobile app, generate hidden mobile-API signatures, or bypass app-update/anti-decoy responses. It accepts directly exposed H5 stream entries only.
- Use streaming sources only when you are authorized to access the content and comply with the service terms and applicable law.

## Nuvio installation

This bundle's `manifest.json` uses a repository manifest with `providers` and `scrapers` arrays. If your installed Nuvio build expects a flat per-provider manifest instead, use the provider metadata in `manifest.json` as the single-provider entry.

To use a hosted copy, place `manifest.json` and the `providers/` folder in the root of a GitHub repository and enable GitHub Pages or raw HTTPS access using a URL that keeps the relative path `providers/moviebox-multisource.js` valid. Add the hosted manifest URL in Nuvio's plugin/repository screen.
