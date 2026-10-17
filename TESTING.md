# Test checklist

1. Confirm the manifest JSON parses.
2. Confirm `providers/moviebox-multisource.js` is accessible at the path declared by the manifest.
3. In Nuvio, enable the provider and test one movie and one TV episode.
4. Check the provider log for `Resolving`, `Searching`, and `Winner` messages.
5. If it returns no streams, record only the source ID, response status, and error message; do not share signed URLs, cookies, or tokens.
6. If a stream appears, verify playback in the actual Nuvio app/player; JSON presence alone does not prove playability.
