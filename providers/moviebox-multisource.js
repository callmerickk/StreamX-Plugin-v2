/*
 * MovieBox Multi-Source provider for Nuvio.
 *
 * Design goals:
 * - Probe the configured MovieBox web origins concurrently.
 * - Share one metadata/search-suggest lookup where possible.
 * - Return streams from the first source that yields a plausible direct media URL.
 * - Abort sibling work after a winner, when the runtime supports AbortController.
 * - Reject obvious placeholder/decoy URLs such as /other/*.mp4 and VIP-locked entries.
 *
 * This intentionally does not implement hidden mobile-API signing, app spoofing,
 * or anti-decoy bypasses. Only directly exposed H5 stream entries are considered.
 */

var PROVIDER_NAME = 'MovieBox Multi-Source';
var API = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var REQUEST_TIMEOUT_MS = 2200;
var SOURCE_DEADLINE_MS = 7200;
var META_TTL_MS = 6 * 60 * 60 * 1000;
var STREAM_TTL_MS = 90 * 1000;
var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Ordered only for deterministic labels/logs. All sources are queried concurrently.
var SOURCES = [
  { id: 'movibox.net', site: 'https://movibox.net', searchPaths: ['/searchResult?keyword=', '/search?keyword='] },
  { id: 'moviebox.ph', site: 'https://moviebox.ph', searchPaths: ['/searchResult?keyword=', '/search?keyword=', '/web/search?keyword='] },
  { id: 'movieboxhd.net', site: 'https://movieboxhd.net', searchPaths: ['/searchResult?keyword=', '/search?keyword=', '/web/search?keyword='] },
  { id: 'movie-box.co', site: 'https://movie-box.co', searchPaths: ['/web/search?keyword=', '/search?keyword=', '/searchResult?keyword='] }
];

var metadataCache = {};
var streamCache = {};

function now() { return Date.now ? Date.now() : new Date().getTime(); }

function makeAbortController() {
  try {
    if (typeof AbortController !== 'undefined') return new AbortController();
  } catch (_) {}
  return { signal: null, abort: function () {} };
}

function abortQuietly(controller) {
  try { if (controller && typeof controller.abort === 'function') controller.abort(); } catch (_) {}
}

function decodeBase64Utf8(input) {
  var s = String(input || '').replace(/\s/g, '');
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1) return input;
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < s.length; i++) {
    if (s.charAt(i) === '=') break;
    var v = BASE64.indexOf(s.charAt(i));
    if (v < 0) return input;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  var encoded = '';
  for (var j = 0; j < bytes.length; j++) encoded += '%' + ('0' + bytes[j].toString(16)).slice(-2);
  try { return decodeURIComponent(encoded); }
  catch (_) { return bytes.map(function (b) { return String.fromCharCode(b); }).join(''); }
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  var raw = value.trim();
  try { return JSON.parse(raw); } catch (_) {}
  var decoded = decodeBase64Utf8(raw);
  if (typeof decoded === 'string' && decoded !== raw) {
    try { return JSON.parse(decoded); } catch (_) {}
  }
  return null;
}

function requestText(url, source, options) {
  options = options || {};
  var headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json, text/plain, */*'
  };
  if (source && source.site) {
    headers.Origin = source.site;
    headers.Referer = source.site + '/';
  }
  Object.keys(options.headers || {}).forEach(function (key) { headers[key] = options.headers[key]; });

  var localController = makeAbortController();
  var parentSignal = options.signal || null;
  var parentAbort = null;
  if (parentSignal && typeof parentSignal.addEventListener === 'function') {
    parentAbort = function () { abortQuietly(localController); };
    if (parentSignal.aborted) parentAbort();
    else parentSignal.addEventListener('abort', parentAbort);
  }

  var timer = setTimeout(function () { abortQuietly(localController); }, REQUEST_TIMEOUT_MS);
  var fetchOptions = { method: options.method || 'GET', headers: headers };
  if (options.body != null) fetchOptions.body = options.body;
  if (localController.signal) fetchOptions.signal = localController.signal;

  function cleanup() {
    clearTimeout(timer);
    if (parentSignal && parentAbort && typeof parentSignal.removeEventListener === 'function') {
      try { parentSignal.removeEventListener('abort', parentAbort); } catch (_) {}
    }
  }

  return fetch(url, fetchOptions).then(function (response) {
    if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 'no response'));
    return response.text();
  }).then(function (body) {
    cleanup();
    return body;
  }, function (error) {
    cleanup();
    throw error;
  });
}

function requestJson(url, source, options) {
  return requestText(url, source, options).then(function (body) {
    var parsed = parseMaybeJson(body);
    if (!parsed) throw new Error('Invalid JSON response from ' + url);
    return parsed;
  });
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value) {
  return cleanText(value).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function getYear(value) {
  var match = String(value || '').match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function getTmdbMetadata(tmdbId, mediaType) {
  var kind = String(mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
  var key = kind + ':' + String(tmdbId);
  var cached = metadataCache[key];
  if (cached && cached.expires > now()) return Promise.resolve(cached.value);

  var url = 'https://www.themoviedb.org/' + kind + '/' + encodeURIComponent(String(tmdbId));
  return requestText(url, null, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' }
  }).then(function (html) {
    var title = '';
    var year = null;
    var og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    var titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (og) title = cleanText(og[1]);
    if (!title && titleTag) title = cleanText(titleTag[1]);
    title = title.replace(/\s*[|–-]\s*(The Movie Database|TMDB).*$/i, '').trim();
    var dateMatch = html.match(/(?:release_date|first_air_date|releaseDate|firstAirDate)["'\s:=]+["']((?:19|20)\d{2})-\d{2}-\d{2}/i);
    if (dateMatch) year = Number(dateMatch[1]);
    if (!year) year = getYear(title);
    title = title.replace(/\s*\(((?:19|20)\d{2})\)\s*$/, '').trim();
    if (!title) throw new Error('TMDB page did not expose a title');
    var result = { title: title, year: year, mediaType: kind };
    metadataCache[key] = { value: result, expires: now() + META_TTL_MS };
    return result;
  });
}

function parseCandidateFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  var title = obj.title || obj.name || obj.subjectTitle || obj.subjectName || obj.originalTitle || obj.original_title || obj.displayName;
  if (!title || typeof title !== 'string') return null;

  var path = obj.detailPath || obj.detail_path || obj.path || obj.slug || obj.subjectPath || obj.detailUrl || obj.detailURL || obj.url || obj.href || '';
  var subjectId = obj.subjectId || obj.subjectID || obj.subject_id || obj.id || obj.sid || '';
  var detailPath = String(path || '');
  var idMatch = detailPath.match(/[?&]id=([^&#]+)/i);
  if (idMatch && !subjectId) subjectId = decodeURIComponent(idMatch[1]);
  var pathMatch = detailPath.match(/\/(?:detail|movies|movie|tv|series)\/([^?&#/]+)/i);
  if (pathMatch) detailPath = decodeURIComponent(pathMatch[1]);
  if (/^https?:\/\//i.test(detailPath)) {
    var fullPathMatch = detailPath.match(/\/(?:detail|movies|movie|tv|series)\/([^?&#/]+)/i);
    if (fullPathMatch) detailPath = decodeURIComponent(fullPathMatch[1]);
  }
  var release = obj.releaseDate || obj.release_date || obj.firstAirDate || obj.first_air_date || obj.year || obj.releaseYear || obj.release_year || '';
  var year = getYear(release);
  var cover = obj.cover || obj.poster || obj.image || obj.posterUrl || obj.coverUrl || '';
  if (cover && typeof cover === 'object') cover = cover.url || cover.src || '';
  return {
    title: cleanText(title), year: year, detailPath: String(detailPath || ''),
    subjectId: String(subjectId || ''), cover: String(cover || ''), raw: obj
  };
}

function collectCandidates(data) {
  var found = [];
  var seen = {};
  function walk(node, depth) {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach(function (item) { walk(item, depth + 1); });
      return;
    }
    if (typeof node !== 'object') return;
    var candidate = parseCandidateFromObject(node);
    if (candidate && (candidate.detailPath || candidate.subjectId)) {
      var key = candidate.title + '|' + candidate.year + '|' + candidate.detailPath + '|' + candidate.subjectId;
      if (!seen[key]) { seen[key] = true; found.push(candidate); }
    }
    Object.keys(node).forEach(function (key) { walk(node[key], depth + 1); });
  }
  walk(data, 0);
  return found;
}

function parseSearchHtml(html) {
  var results = [];
  var seen = {};
  var re = /<a\b[^>]*href=["']([^"']*(?:\/detail\/|\/movies\/|\/movie\/|\/tv\/|\/series\/)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var href = match[1].replace(/&amp;/g, '&');
    var slugMatch = href.match(/\/(?:detail|movies|movie|tv|series)\/([^?&#/]+)/i);
    if (!slugMatch) continue;
    var idMatch = href.match(/[?&]id=([^&#]+)/i);
    var nearby = html.slice(Math.max(0, match.index - 900), Math.min(html.length, re.lastIndex + 900));
    var titleAttr = match[0].match(/(?:title|aria-label)=["']([^"']+)["']/i);
    var imgAlt = match[2].match(/<img[^>]+alt=["']([^"']+)["']/i);
    var title = titleAttr ? titleAttr[1] : (imgAlt ? imgAlt[1] : cleanText(match[2]));
    var year = getYear(nearby);
    var candidate = {
      title: cleanText(title), year: year,
      detailPath: decodeURIComponent(slugMatch[1]),
      subjectId: idMatch ? decodeURIComponent(idMatch[1]) : '', cover: '', raw: {}
    };
    var key = candidate.detailPath + '|' + candidate.subjectId;
    if (candidate.title && !seen[key]) { seen[key] = true; results.push(candidate); }
  }
  return results;
}

function titleScore(wanted, candidate) {
  var a = normalizeTitle(wanted.title);
  var b = normalizeTitle(candidate.title);
  if (!a || !b) return 0;
  var score = 0;
  if (a === b) score = 100;
  else if (b.indexOf(a) >= 0 || a.indexOf(b) >= 0) score = 72;
  else {
    var aa = a.split(' '), bb = b.split(' '), common = 0;
    aa.forEach(function (word) { if (bb.indexOf(word) >= 0) common++; });
    score = Math.round((common / Math.max(aa.length, bb.length)) * 65);
  }
  if (wanted.year && candidate.year) score += wanted.year === candidate.year ? 35 : -45;
  if (wanted.year && !candidate.year) score -= 3;
  return score;
}

function requestCandidates(title, sources, controllers) {
  var suggestSource = { id: 'shared-api', site: SOURCES[0].site };
  var suggestions = requestJson(API + '/subject/search-suggest', suggestSource, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: title, perPage: 10 })
  }).then(collectCandidates).catch(function (error) {
    console.log('[MovieBox Multi-Source] search-suggest failed: ' + (error && error.message ? error.message : String(error)));
    return [];
  });

  var pagePromises = sources.map(function (source, index) {
    var paths = source.searchPaths || ['/searchResult?keyword='];
    var pathPromises = paths.map(function (path) {
      var url = source.site + path + encodeURIComponent(title);
      return requestText(url, source, { signal: controllers[index].signal, headers: { 'Accept': 'text/html,application/xhtml+xml' } })
        .then(parseSearchHtml)
        .catch(function (error) {
          console.log('[MovieBox Multi-Source] ' + source.id + ' search path failed: ' + (error && error.message ? error.message : String(error)));
          return [];
        });
    });
    return Promise.all(pathPromises).then(function (sets) {
      var merged = [];
      sets.forEach(function (set) { merged = merged.concat(set || []); });
      return merged;
    });
  });

  return Promise.all([suggestions].concat(pagePromises)).then(function (sets) {
    var shared = sets[0] || [];
    var bySource = [];
    for (var i = 0; i < sources.length; i++) {
      var combined = [];
      var seen = {};
      (shared.concat(sets[i + 1] || [])).forEach(function (candidate) {
        var key = String(candidate.detailPath || '') + '|' + String(candidate.subjectId || '') + '|' + normalizeTitle(candidate.title);
        if (!seen[key]) { seen[key] = true; combined.push(candidate); }
      });
      combined.sort(function (a, b) { return titleScore({ title: title, year: null }, b) - titleScore({ title: title, year: null }, a); });
      bySource.push(combined);
    }
    return bySource;
  });
}

function getDetails(candidate, source, signal) {
  if (!candidate || !candidate.detailPath) return Promise.reject(new Error('Missing detail path'));
  var query = '?detailPath=' + encodeURIComponent(candidate.detailPath);
  var urls = [API + '/detail' + query, source.site + '/wefeed-h5api-bff/detail' + query];
  function normalizeDetail(response) {
    if (!response) return null;
    var root = response && response.data ? response.data : response;
    var subject = root && (root.subject || (root.detail && root.detail.subject) || root);
    if (!subject || typeof subject !== 'object') return null;
    var cover = subject.cover || subject.poster || {};
    var detail = {
      subjectId: String(subject.subjectId || subject.id || candidate.subjectId || ''),
      title: cleanText(subject.title || subject.name || candidate.title),
      releaseDate: subject.releaseDate || subject.firstAirDate || subject.release_date || '',
      year: getYear(subject.releaseDate || subject.firstAirDate || subject.release_date || '') || candidate.year,
      cover: typeof cover === 'string' ? cover : (cover.url || ''),
      detailPath: candidate.detailPath,
      raw: subject
    };
    return detail.subjectId ? detail : null;
  }
  // Some mirrors use the shared H5 API, while others proxy detail through their own origin.
  return new Promise(function (resolve, reject) {
    var remaining = urls.length;
    var settled = false;
    urls.forEach(function (url) {
      requestJson(url, source, { signal: signal }).then(normalizeDetail).then(function (detail) {
        if (settled) return;
        if (detail) {
          settled = true;
          resolve(detail);
          return;
        }
        remaining -= 1;
        if (remaining <= 0 && !settled) reject(new Error('No usable detail response from shared API or mirror'));
      }).catch(function () {
        if (settled) return;
        remaining -= 1;
        if (remaining <= 0 && !settled) reject(new Error('No usable detail response from shared API or mirror'));
      });
    });
  });
}

function qualityLabel(resolution) {
  var raw = String(resolution || '').split(',')[0];
  var n = parseInt(raw, 10);
  if (!n) {
    var match = raw.match(/(2160|1440|1080|720|576|480|360)p?/i);
    n = match ? parseInt(match[1], 10) : 0;
  }
  if (n >= 2160) return '4K';
  return n ? n + 'p' : (raw || 'Unknown');
}

function looksLikePlaceholder(source, url) {
  var lowerUrl = String(url || '').toLowerCase();
  var label = [source && source.title, source && source.name, source && source.format, source && source.codecName]
    .join(' ').toLowerCase();
  if (source && (source.vipLocked || source.isVip || source.requiresVip || source.locked)) return true;
  if (source && source.behaviorHints && source.behaviorHints.notWebReady === true) return true;
  if (source && source.notWebReady === true) return true;
  if (/\/other\//i.test(lowerUrl)) return true;
  if (/(please\s*)?update.{0,24}(app|application)|new application|install the app/i.test(label)) return true;
  return false;
}

function toStreams(playResponse, source) {
  var data = playResponse && playResponse.data ? playResponse.data : playResponse;
  if (typeof data === 'string') data = parseMaybeJson(data);
  if (!data || typeof data !== 'object') return [];
  var all = [];
  var arrayKeys = ['streams', 'hls', 'dash'];
  arrayKeys.forEach(function (key) {
    (Array.isArray(data[key]) ? data[key] : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var url = String(item.url || item.playUrl || item.play_url || item.link || '').trim();
      if (!/^https?:\/\//i.test(url) || looksLikePlaceholder(item, url)) return;
      var quality = qualityLabel(item.resolutions || item.resolution || item.quality || item.height);
      var headers = { 'Referer': source.site + '/' };
      if (item.signHeaderKey && item.signCookie) headers[item.signHeaderKey] = item.signCookie;
      var titleParts = [quality, item.format || key.toUpperCase()];
      if (item.codecName) titleParts.push(item.codecName);
      all.push({
        name: PROVIDER_NAME + ' · ' + source.id,
        title: titleParts.join(' · '),
        url: url,
        quality: quality,
        size: item.size != null && !isNaN(Number(item.size)) ? Number(item.size) : undefined,
        headers: headers
      });
    });
  });

  var seen = {};
  return all.filter(function (stream) {
    if (!stream.url || seen[stream.url]) return false;
    seen[stream.url] = true;
    return true;
  }).sort(function (a, b) {
    function qualityRank(stream) {
      if (stream.quality === '4K') return 2160;
      return parseInt(stream.quality, 10) || 0;
    }
    return qualityRank(b) - qualityRank(a);
  });
}

function getPlayback(detail, source, mediaType, season, episode, signal) {
  var isTv = String(mediaType || '').toLowerCase() === 'tv';
  var se = isTv ? Math.max(1, Number(season) || 1) : 0;
  var ep = isTv ? Math.max(1, Number(episode) || 1) : 0;
  var playUrl = source.site + '/wefeed-h5api-bff/subject/play?subjectId=' + encodeURIComponent(detail.subjectId) +
    '&se=' + encodeURIComponent(se) + '&ep=' + encodeURIComponent(ep) +
    '&detailPath=' + encodeURIComponent(detail.detailPath) + '&streamSignType=1';
  return requestJson(playUrl, source, { signal: signal }).then(function (response) {
    return toStreams(response, source);
  });
}

function runSource(source, candidates, meta, mediaType, season, episode, controller) {
  var shortlist = (candidates || []).filter(function (candidate) {
    return titleScore(meta, candidate) >= 45 && (candidate.detailPath || candidate.subjectId);
  }).sort(function (a, b) { return titleScore(meta, b) - titleScore(meta, a); }).slice(0, 3);
  if (!shortlist.length) return Promise.resolve([]);

  // Resolve a few high-scoring candidates concurrently to avoid sequential title-matching delays.
  var detailPromises = shortlist.map(function (candidate) {
    return getDetails(candidate, source, controller.signal).then(function (detail) {
      var score = titleScore(meta, detail);
      if (score < 45) throw new Error('Detail title/year did not match');
      return { detail: detail, score: score };
    }).catch(function () { return null; });
  });

  return Promise.all(detailPromises).then(function (resolved) {
    var details = resolved.filter(Boolean).sort(function (a, b) { return b.score - a.score; });
    if (!details.length) return [];
    // Try the strongest exact/close title match first; only one playback request per source.
    return getPlayback(details[0].detail, source, mediaType, season, episode, controller.signal).then(function (streams) {
      return streams;
    }).catch(function (error) {
      console.log('[MovieBox Multi-Source] ' + source.id + ' playback failed: ' + (error && error.message ? error.message : String(error)));
      return [];
    });
  });
}

function raceSources(sourceCandidates, meta, mediaType, season, episode, controllers) {
  return new Promise(function (resolve) {
    var remaining = SOURCES.length;
    var settled = false;
    function completeEmpty() {
      remaining -= 1;
      if (!settled && remaining <= 0) {
        settled = true;
        resolve([]);
      }
    }
    SOURCES.forEach(function (source, index) {
      runSource(source, sourceCandidates[index], meta, mediaType, season, episode, controllers[index]).then(function (streams) {
        if (settled) return;
        if (streams && streams.length) {
          settled = true;
          console.log('[MovieBox Multi-Source] Winner: ' + source.id + ' (' + streams.length + ' direct streams)');
          controllers.forEach(function (controller, otherIndex) {
            if (otherIndex !== index) abortQuietly(controller);
          });
          resolve(streams);
        } else {
          completeEmpty();
        }
      }).catch(function (error) {
        console.log('[MovieBox Multi-Source] ' + source.id + ' failed: ' + (error && error.message ? error.message : String(error)));
        if (!settled) completeEmpty();
      });
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (!tmdbId) return Promise.resolve([]);
  var kind = String(mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
  var streamKey = [tmdbId, kind, Number(season) || 0, Number(episode) || 0].join(':');
  var cached = streamCache[streamKey];
  if (cached && cached.expires > now()) return Promise.resolve(cached.value.slice());

  var controllers = SOURCES.map(function () { return makeAbortController(); });
  var sourceTimers = [];
  function clearSourceTimers() {
    sourceTimers.forEach(function (timer) { clearTimeout(timer); });
    sourceTimers = [];
  }

  console.log('[MovieBox Multi-Source] Resolving ' + kind + ' TMDB ID ' + tmdbId + ' across ' + SOURCES.length + ' origins');
  return getTmdbMetadata(tmdbId, kind).then(function (meta) {
    // Start the source deadline after metadata lookup so a cold TMDB request does not
    // consume the whole race window before mirror requests even begin.
    sourceTimers = controllers.map(function (controller, index) {
      return setTimeout(function () {
        abortQuietly(controller);
        console.log('[MovieBox Multi-Source] ' + SOURCES[index].id + ' reached source timeout');
      }, SOURCE_DEADLINE_MS);
    });
    console.log('[MovieBox Multi-Source] Searching ' + meta.title + (meta.year ? ' (' + meta.year + ')' : ''));
    return requestCandidates(meta.title, SOURCES, controllers).then(function (candidateSets) {
      return raceSources(candidateSets, meta, kind, season, episode, controllers);
    });
  }).then(function (streams) {
    if (streams && streams.length) streamCache[streamKey] = { value: streams.slice(), expires: now() + STREAM_TTL_MS };
    return streams || [];
  }).catch(function (error) {
    console.log('[MovieBox Multi-Source] Provider error: ' + (error && error.message ? error.message : String(error)));
    return [];
  }).then(function (streams) {
    clearSourceTimers();
    return streams || [];
  }, function (error) {
    clearSourceTimers();
    throw error;
  });
}

module.exports = { getStreams: getStreams };
