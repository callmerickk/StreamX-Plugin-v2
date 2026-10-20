/*
 * MovieBox Multi-Source provider for Nuvio (v0.3.0 mobile API + H5 fallback).
 *
 * Design goals:
 * - Probe the configured MovieBox web origins concurrently.
 * - Share one metadata/search-suggest lookup where possible.
 * - Return streams from the first source that yields a plausible direct media URL.
 * - Abort sibling work after a winner, when the runtime supports AbortController.
 * - Reject obvious placeholder/decoy URLs such as /other/*.mp4 and VIP-locked entries.
 *
 * Uses the community-documented MovieBox mobile API request flow first, then falls back
 * to public H5 web endpoints. It rejects obvious
 * placeholder/decoy responses rather than returning the short update-video clip.
 */

var PROVIDER_NAME = 'MovieBox Multi-Source';
var API = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var REQUEST_TIMEOUT_MS = 6500;
var MOBILE_API_HOSTS = ['https://api3.aoneroom.com', 'https://api6.aoneroom.com', 'https://api5.aoneroom.com', 'https://api4.aoneroom.com', 'https://api4sg.aoneroom.com'];
var MOBILE_SECRET_B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';
var MOBILE_ALT_SECRET_B64 = 'WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==';
var MOBILE_TOKEN_URL = 'https://apig.inmoviebox.com/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1';
var MOBILE_PACKAGE = { package_name: 'com.community.mbox.in', version_name: '4.0.03.0920.03', version_code: 50020130 };
var MOBILE_DEVICE_ID = randomHex(16);
var MOBILE_GAID = '1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d';
var MOBILE_BRANDS = { Samsung: ['SM-S918B', 'SM-A528B', 'SM-M336B'], Xiaomi: ['2201117TI', 'M2012K11AI', 'Redmi Note 11'], OnePlus: ['LE2111', 'CPH2449', 'IN2023'], Google: ['Pixel 6', 'Pixel 7', 'Pixel 8'], Realme: ['RMX3085', 'RMX3360', 'RMX3551'] };
var MOBILE_BRAND = 'Google';
var MOBILE_MODEL = 'Pixel 7';
var MOBILE_TOKEN = null;
var MOBILE_TOKEN_FETCH = null;
var MOBILE_PLAYER_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
var SOURCE_DEADLINE_MS = 18000;
var META_TTL_MS = 6 * 60 * 60 * 1000;
var STREAM_TTL_MS = 90 * 1000;
var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var metadataCache = {};
var streamCache = {};
var SOURCES = [
  { id: 'movibox.net', site: 'https://movibox.net', searchPaths: ['/searchResult?keyword=', '/search?keyword='] },
  { id: 'moviebox.ph', site: 'https://moviebox.ph', searchPaths: ['/searchResult?keyword=', '/search?keyword=', '/web/search?keyword='] },
  { id: 'movieboxhd.net', site: 'https://movieboxhd.net', searchPaths: ['/searchResult?keyword=', '/search?keyword=', '/web/search?keyword='] },
  { id: 'movie-box.co', site: 'https://movie-box.co', searchPaths: ['/web/search?keyword=', '/search?keyword=', '/searchResult?keyword='] }
];

function now() { return Date.now ? Date.now() : new Date().getTime(); }
function makeAbortController() {
  try { if (typeof AbortController !== 'undefined') return new AbortController(); } catch (_) {}
  return { signal: null, abort: function () {} };
}
function abortQuietly(controller) {
  try { if (controller && typeof controller.abort === 'function') controller.abort(); } catch (_) {}
}

function randomHex(byteCount) {
  var out = '';
  for (var i = 0; i < byteCount; i++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
  return out;
}
function randomUuid() {
  var h = randomHex(16).split('');
  h[12] = '4'; h[16] = '8';
  return h.join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}
function utf8Bytes(value) {
  var encoded = unescape(encodeURIComponent(String(value == null ? '' : value)));
  var out = [];
  for (var i = 0; i < encoded.length; i++) out.push(encoded.charCodeAt(i));
  return out;
}
function md5Bytes(value) {
  var bytes = Array.isArray(value) ? value.slice() : utf8Bytes(value);
  var bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var low = bitLength >>> 0, high = Math.floor(bitLength / 4294967296) >>> 0;
  for (var k = 0; k < 4; k++) bytes.push((low >>> (8 * k)) & 255);
  for (var h = 0; h < 4; h++) bytes.push((high >>> (8 * h)) & 255);
  var shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  var K = [];
  for (var ki = 0; ki < 64; ki++) K[ki] = Math.floor(Math.abs(Math.sin(ki + 1)) * 4294967296) >>> 0;
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  function add(x, y) { return (x + y) >>> 0; }
  function rol(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  for (var off = 0; off < bytes.length; off += 64) {
    var M = [];
    for (var j = 0; j < 16; j++) M[j] = (bytes[off+j*4] | (bytes[off+j*4+1]<<8) | (bytes[off+j*4+2]<<16) | (bytes[off+j*4+3]<<24)) >>> 0;
    var A = a0, B = b0, C = c0, D = d0;
    for (var i = 0; i < 64; i++) {
      var F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5*i+1)%16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i+5)%16; }
      else { F = C ^ (B | ~D); g = (7*i)%16; }
      var nextD = D;
      D = C; C = B;
      B = add(B, rol(add(add(A, F >>> 0), add(K[i], M[g])), shifts[i]));
      A = nextD;
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  var out = [];
  [a0,b0,c0,d0].forEach(function (word) { for (var n=0;n<4;n++) out.push((word >>> (8*n)) & 255); });
  return out;
}
function bytesToHex(bytes) { return bytes.map(function (b) { return ('0'+(b&255).toString(16)).slice(-2); }).join(''); }
function md5(value) { return bytesToHex(md5Bytes(value)); }
function base64Bytes(bytes) {
  var out = '';
  for (var i=0; i<bytes.length; i+=3) {
    var a=bytes[i]&255, hasB=i+1<bytes.length, hasC=i+2<bytes.length, b=hasB?(bytes[i+1]&255):0, c=hasC?(bytes[i+2]&255):0;
    out += BASE64.charAt(a>>2) + BASE64.charAt(((a&3)<<4)|(b>>4)) + (hasB?BASE64.charAt(((b&15)<<2)|(c>>6)):'=') + (hasC?BASE64.charAt(c&63):'=');
  }
  return out;
}
function base64ToBytes(value) {
  var s=String(value||'').replace(/\s/g,'').replace(/=+$/,''); var out=[], buffer=0, bits=0;
  for (var i=0;i<s.length;i++) { var v=BASE64.indexOf(s.charAt(i)); if(v<0) continue; buffer=(buffer<<6)|v; bits+=6; if(bits>=8){bits-=8;out.push((buffer>>bits)&255);} }
  return out;
}
function hmacMd5(keyBytes, message) {
  var key=keyBytes.slice(); if(key.length>64) key=md5Bytes(key); while(key.length<64) key.push(0);
  var inner=[], outer=[]; for(var i=0;i<64;i++){inner.push(key[i]^0x36);outer.push(key[i]^0x5c);}
  return md5Bytes(outer.concat(md5Bytes(inner.concat(utf8Bytes(message)))));
}
function canonicalMobileUrl(url) {
  var raw=String(url).replace(/^https?:\/\/[^/]+/i,''); var q=raw.indexOf('?');
  if(q<0) return raw;
  var path=raw.slice(0,q), pairs=raw.slice(q+1).split('&').filter(Boolean).map(function(part){
    var at=part.indexOf('='); var k=at<0?part:part.slice(0,at), v=at<0?'':part.slice(at+1);
    try{k=decodeURIComponent(k.replace(/\+/g,' '));}catch(_){} try{v=decodeURIComponent(v.replace(/\+/g,' '));}catch(_){}
    return {k:k,v:v};
  });
  pairs.sort(function(a,b){return a.k<b.k?-1:a.k>b.k?1:0;});
  return path + '?' + pairs.map(function(p){return p.k+'='+p.v;}).join('&');
}
function mobileSignature(method, url, body, altKey, timestamp) {
  timestamp = timestamp || now();
  var bodyBytes = body == null ? null : utf8Bytes(body);
  if (bodyBytes && bodyBytes.length > 102400) bodyBytes = bodyBytes.slice(0, 102400);
  var bodyHash = bodyBytes ? bytesToHex(md5Bytes(bodyBytes)) : '';
  var contentType = body == null ? 'application/json' : 'application/json; charset=utf-8';
  var bodyLength = body == null ? '' : String(utf8Bytes(body).length);
  var canonical = String(method).toUpperCase() + '\napplication/json\n' + contentType + '\n' + bodyLength + '\n' + timestamp + '\n' + bodyHash + '\n' + canonicalMobileUrl(url);
  var secret = base64ToBytes(altKey ? MOBILE_ALT_SECRET_B64 : MOBILE_SECRET_B64);
  return timestamp + '|2|' + base64Bytes(hmacMd5(secret, canonical));
}
function mobileHeaders(method, url, body, altKey, timestamp) {
  timestamp = timestamp || now();
  var modelList = MOBILE_BRANDS[MOBILE_BRAND] || ['Pixel 7'];
  var clientInfo = {
    package_name: MOBILE_PACKAGE.package_name, version_name: MOBILE_PACKAGE.version_name, version_code: MOBILE_PACKAGE.version_code,
    os: 'android', os_version: '14', device_id: MOBILE_DEVICE_ID, install_store: 'official', gaid: MOBILE_GAID,
    brand: MOBILE_BRAND.toLowerCase(), model: MOBILE_MODEL || modelList[0], system_language: 'en', net: 'NETWORK_WIFI', region: 'IN', timezone: 'Asia/Calcutta', sp_code: ''
  };
  return {
    'Accept': 'application/json',
    'Content-Type': body == null ? 'application/json' : 'application/json; charset=utf-8',
    'x-client-token': String(timestamp) + ',' + md5(String(timestamp).split('').reverse().join('')),
    'x-tr-signature': mobileSignature(method, url, body, !!altKey, timestamp),
    'User-Agent': MOBILE_PACKAGE.package_name + '/' + MOBILE_PACKAGE.version_code + ' (Linux; U; Android 14; en_IN; ' + MOBILE_MODEL + '; Build/UD1A.230803.041; Cronet/145.0.7582.0)',
    'x-client-info': JSON.stringify(clientInfo),
    'x-client-status': '0'
  };
}
function mobileTokenExpiry(token) {
  try {
    var parts = String(token || '').split('.');
    if (parts.length < 2) return 0;
    var raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (raw.length % 4) raw += '=';
    var payload = JSON.parse(decodeBase64Utf8(raw));
    return Number(payload.exp) || 0;
  } catch (_) { return 0; }
}
function mobileCacheTokenFromHeaders(headers) {
  try {
    var xUser = headers && typeof headers.get === 'function' ? headers.get('x-user') : null;
    if (!xUser) return;
    var parsed = JSON.parse(xUser);
    var token = parsed && parsed.token;
    if (token && mobileTokenExpiry(token) > now() / 1000 + 3600) MOBILE_TOKEN = token;
  } catch (_) {}
}
function mobileFetchUrl(url, method, body, isTokenFetch, altKey, attempt, customHeaders) {
  attempt = attempt || 0;
  var host = String(url).match(/^https?:\/\/([^/]+)/i);
  var originalHost = host ? host[1] : '';
  var hostNames = MOBILE_API_HOSTS.map(function (h) { return h.replace(/^https?:\/\//i, '').replace(/\/$/, ''); });
  var isApiHost = hostNames.indexOf(originalHost) >= 0;
  var tries = isApiHost ? [originalHost].concat(hostNames.filter(function (h) { return h !== originalHost; })).slice(0, 3) : [originalHost];
  var chosenHost = tries[Math.min(attempt, tries.length - 1)];
  var requestUrl = chosenHost && originalHost ? String(url).replace(/^https?:\/\/[^/]+/i, 'https://' + chosenHost) : url;
  var timestamp = now();
  var bodyText = body == null ? null : String(body);
  var headers = mobileHeaders(method || 'GET', requestUrl, bodyText, !!altKey, timestamp);
  if (!isTokenFetch && MOBILE_TOKEN && mobileTokenExpiry(MOBILE_TOKEN) > now() / 1000 + 60) headers.Authorization = 'Bearer ' + MOBILE_TOKEN;
  if (customHeaders && typeof customHeaders === 'object') Object.keys(customHeaders).forEach(function (key) { headers[key] = customHeaders[key]; });
  var options = { method: method || 'GET', headers: headers };
  if (bodyText != null) options.body = bodyText;
  var timerController = makeAbortController();
  var timer = setTimeout(function () { abortQuietly(timerController); }, REQUEST_TIMEOUT_MS);
  if (timerController.signal) options.signal = timerController.signal;
  return fetch(requestUrl, options).then(function (response) {
    clearTimeout(timer);
    mobileCacheTokenFromHeaders(response && response.headers);
    return response.text().then(function (text) {
      var parsed = parseMaybeJson(text);
      if (!response.ok) throw new Error('HTTP ' + response.status + ' from MovieBox API');
      if (parsed && (Number(parsed.code) === 441 || String(parsed.reason || '').toUpperCase() === 'UNAUTHORIZED')) throw new Error('MovieBox API unauthorized / missing token');
      if (!parsed) throw new Error('Invalid MovieBox API JSON');
      return parsed;
    });
  }).catch(function (error) {
    clearTimeout(timer);
    if (attempt + 1 < tries.length) return mobileFetchUrl(url, method, body, isTokenFetch, altKey, attempt + 1, customHeaders);
    if (!altKey && !isTokenFetch) return mobileFetchUrl(url, method, body, isTokenFetch, true, 0, customHeaders);
    throw error;
  });
}
function getMobileToken() {
  if (MOBILE_TOKEN && mobileTokenExpiry(MOBILE_TOKEN) > now() / 1000 + 3600) return Promise.resolve(MOBILE_TOKEN);
  if (MOBILE_TOKEN_FETCH) return MOBILE_TOKEN_FETCH;
  MOBILE_TOKEN_FETCH = mobileFetchUrl(MOBILE_TOKEN_URL, 'GET', null, true, false, 0, null).then(function () {
    return MOBILE_TOKEN || '';
  }).catch(function (error) {
    console.log('[MovieBox Multi-Source] anonymous token bootstrap failed: ' + (error && error.message ? error.message : String(error)));
    return '';
  }).then(function (token) {
    MOBILE_TOKEN_FETCH = null;
    return token;
  }, function (error) {
    MOBILE_TOKEN_FETCH = null;
    throw error;
  });
  return MOBILE_TOKEN_FETCH;
}
function mobileRequest(path, method, body, hostIndex, altKey, customHeaders) {
  var base = MOBILE_API_HOSTS[0];
  var url = /^https?:\/\//i.test(path) ? path : base + path;
  var bodyText = body == null ? null : JSON.stringify(body);
  return getMobileToken().then(function () {
    return mobileFetchUrl(url, method || 'GET', bodyText, false, !!altKey, 0, customHeaders || null);
  });
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
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
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
  if (typeof decoded === 'string' && decoded !== raw) { try { return JSON.parse(decoded); } catch (_) {} }
  return null;
}
function requestText(url, source, options) {
  options = options || {};
  var headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' };
  if (source && source.site) {
    if (!options.omitOrigin) headers.Origin = source.site;
    headers.Referer = options.referer || source.site + '/';
    if (options.apiRequest) headers['x-client-info'] = '{"timezone":"Asia/Calcutta"}';
    if (options.includeRequestLang) headers['x-request-lang'] = 'en';
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
    if (parentSignal && parentAbort && typeof parentSignal.removeEventListener === 'function') { try { parentSignal.removeEventListener('abort', parentAbort); } catch (_) {} }
  }
  return fetch(url, fetchOptions).then(function (response) {
    if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 'no response'));
    return response.text();
  }).then(function (body) { cleanup(); return body; }, function (error) { cleanup(); throw error; });
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
    apiRequest: true,
    includeRequestLang: true,
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
      console.log('[MovieBox Multi-Source] ' + sources[i].id + ' candidates=' + combined.length);
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
      requestJson(url, source, { signal: signal, apiRequest: true }).then(normalizeDetail).then(function (detail) {
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

function getFormatType(url) {
  var value = String(url || '').toLowerCase();
  if (value.indexOf('.mpd') >= 0) return 'DASH';
  if (value.indexOf('.m3u8') >= 0) return 'HLS';
  if (value.indexOf('.mp4') >= 0) return 'MP4';
  if (value.indexOf('.mkv') >= 0) return 'MKV';
  return 'VIDEO';
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
  var buckets = [];
  var recognized = { streams: true, hls: true, dash: true, playList: true, resourceDetectors: true, resources: true };
  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) return;
    Object.keys(node).forEach(function (key) {
      var value = node[key];
      if (recognized[key] && Array.isArray(value)) buckets = buckets.concat(value);
      else if (value && typeof value === 'object') walk(value, depth + 1);
    });
  }
  walk(playResponse, 0);
  var all = [];
  buckets.forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    var rawUrl = String(item.url || item.playUrl || item.play_url || item.link || item.resourceUrl || item.resourceLink || item.streamUrl || '').trim();
    var signCookie = item.signCookie || item.sign_cookie || null;
    var url = extractPolicyResource(signCookie) || rawUrl;
    if (!/^https?:\/\//i.test(url)) {
      var prefix = String(item.urlprefix || item.urlPrefix || item.baseUrl || '').trim();
      if (prefix && url) url = prefix.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
    }
    if (!/^https?:\/\//i.test(url) || looksLikePlaceholder(item, url)) return;
    if (url.indexOf('b164fbfb4347792950bdfbfb563d39d9') >= 0) return;
    var quality = qualityLabel(item.resolutions || item.resolution || item.quality || item.height);
    var headers = {
      'Referer': 'https://h5-api.aoneroom.com/',
      'User-Agent': 'com.community.mbox.in/50020104 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ2A.230405.003; Cronet/112.0.5615.135)'
    };
    if (item.headers && typeof item.headers === 'object') Object.keys(item.headers).forEach(function (key) { headers[key] = item.headers[key]; });
    if (item.signHeaderKey && signCookie) headers[item.signHeaderKey] = signCookie;
    else if (signCookie) headers.Cookie = signCookie;
    if (item.cookie && !headers.Cookie) headers.Cookie = item.cookie;
    if (item.referer || item.referrer) headers.Referer = item.referer || item.referrer;
    if (item.userAgent) headers['User-Agent'] = item.userAgent;
    var titleParts = [quality, item.format || item.type || 'MovieBox'];
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
  // MovieBox's own web page sends the detail page as the playback Referer.
  // The HARs show this shape, including season/episode and language parameters.
  var detailReferer = source.site + '/movies/' + encodeURIComponent(detail.detailPath) +
    '?id=' + encodeURIComponent(detail.subjectId) + '&type=/movie/detail' +
    '&detailSe=' + (isTv ? String(se) : '') + '&detailEp=' + (isTv ? String(ep) : '') + '&lang=en';
  return requestJson(playUrl, source, {
    signal: signal,
    apiRequest: true,
    omitOrigin: true,
    referer: detailReferer
  }).then(function (response) {
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

function mobileRoot(response) { return response && response.data ? response.data : response; }
function mobileItems(response) {
  var root = mobileRoot(response); if (!root) return [];
  var results = root.results || (root.data && root.data.results) || root.items || root.subjects || root.list;
  if (Array.isArray(results)) {
    if (results.length && results[0] && Array.isArray(results[0].subjects)) {
      var grouped = []; results.forEach(function (group) { if (Array.isArray(group.subjects)) grouped = grouped.concat(group.subjects); }); return grouped;
    }
    return results;
  }
  var items = root.items || root.subjects || (root.data && (root.data.items || root.data.subjects || root.data.results));
  if (Array.isArray(items)) {
    if (items.length && items[0] && Array.isArray(items[0].subjects)) { var merged=[]; items.forEach(function(g){merged=merged.concat(g.subjects||[]);}); return merged; }
    return items;
  }
  return [];
}
function mobileCandidate(item) {
  if (!item || typeof item !== 'object') return null;
  var cover = item.cover || item.poster || {};
  var id = item.subjectId || item.id;
  var title = cleanText(item.title || item.name || '');
  if (!id || !title) return null;
  return { subjectId: String(id), title: title, year: getYear(item.releaseDate || item.firstAirDate || item.year || title),
    subjectType: Number(item.subjectType) || (String(id).charAt(0).toLowerCase() === 'm' ? 1 : 2),
    detailPath: item.detailPath || item.detail_path || item.path || item.slug || '',
    cover: typeof cover === 'string' ? cover : (cover.url || ''), raw: item };
}
function mobilePlaybackPage(subjectData, subjectId) {
  var candidates = [subjectData && subjectData.detailPath, subjectData && subjectData.detail_path, subjectData && subjectData.path, subjectData && subjectData.slug];
  var detailPath = '';
  for (var i=0;i<candidates.length;i++) if(typeof candidates[i]==='string' && candidates[i].trim()){detailPath=candidates[i].trim();break;}
  var webBase = 'https://moviebox.ph';
  var domains = [subjectData && subjectData.detailDomain, subjectData && subjectData.webDomain, subjectData && subjectData.webUrl, subjectData && subjectData.detailUrl, subjectData && subjectData.shareUrl];
  for (var j=0;j<domains.length;j++) {
    if(typeof domains[j]!=='string') continue;
    try {
      var value = domains[j].indexOf('http')===0 ? domains[j] : 'https://' + domains[j];
      var origin = value.match(/^https?:\/\/[^/]+/i);
      if(origin && !/\.aoneroom\.com$/i.test(origin[0].replace(/^https?:\/\//i,''))) webBase = origin[0];
      if(!detailPath){var path=value.replace(/^https?:\/\/[^/]+/i,'').split('?')[0];if(path&&path!=='/')detailPath=path;}
      break;
    } catch (_) {}
  }
  detailPath = String(detailPath || '').replace(/^\/+/, '').replace(/^movies\//, '');
  if (!detailPath) return { webBase: webBase, detailPath: '', referer: webBase + '/' };
  var referer = webBase + '/movies/' + detailPath + '?id=' + encodeURIComponent(subjectId) + '&type=%2Fmovie%2Fdetail&detailSe=&detailEp=&lang=en';
  return { webBase: webBase, detailPath: detailPath, referer: referer };
}
function extractPolicyResource(signCookie) {
  if (!signCookie || typeof signCookie !== 'string') return null;
  var edgeMatch = signCookie.match(/Edge-Cache-Cookie=urlprefix=([^:;\s]+)/);
  if (edgeMatch) {
    try {
      var edgeB64 = edgeMatch[1].replace(/_/g, '/').replace(/-/g, '+');
      while (edgeB64.length % 4) edgeB64 += '=';
      var decodedEdge = decodeBase64Utf8(edgeB64).replace(/\/+$/, '');
      if (decodedEdge && decodedEdge !== edgeB64) return decodedEdge + '/index.mpd';
    } catch (_) {}
  }
  var cfMatch = signCookie.match(/CloudFront-Policy=([^;]+)/);
  if (cfMatch) {
    var policyRaw = cfMatch[1];
    var variants = [policyRaw.replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '='), policyRaw.replace(/-/g, '+').replace(/_/g, '/')];
    for (var i=0;i<variants.length;i++) {
      try {
        var b64=variants[i]; while(b64.length%4)b64+='=';
        var decoded=decodeBase64Utf8(b64); var root=JSON.parse(decoded);
        var resource=root && root.Statement && root.Statement[0] && root.Statement[0].Resource;
        if(resource && typeof resource==='string') {
          var trimmed=resource.replace(/[\*\/]+$/, '');
          return /\.mpd$/i.test(trimmed) ? trimmed : trimmed + '/index.mpd';
        }
      } catch (_) {}
    }
  }
  return null;
}
function collectMobileStreams(playData) {
  if (!playData || typeof playData !== 'object') return [];
  var streams = Array.isArray(playData.streams) ? playData.streams.slice() : [];
  [['netDash','DASH'],['netHls','HLS']].forEach(function(pair){
    var value = playData[pair[0]] != null ? playData[pair[0]] : (playData.data && playData.data[pair[0]]);
    var values = Array.isArray(value) ? value : (value ? [value] : []);
    values.forEach(function(item){
      if(typeof item==='string') streams.push({url:item,format:pair[1]});
      else if(item && typeof item==='object') {
        if(item.url || item.playUrl || item.resourceLink || item.streamUrl) streams.push(Object.assign({},item,{format:item.format||pair[1]}));
        else Object.keys(item).forEach(function(resolution){
          var url=item[resolution];
          if(typeof url==='string' && /^https?:\/\//i.test(url)) streams.push({url:url,resolution:resolution,format:pair[1]});
          else if(url && typeof url==='object') streams.push(Object.assign({},url,{resolution:url.resolution||resolution,format:url.format||pair[1]}));
        });
      }
    });
  });
  ['playList','resources'].forEach(function(key){ if(Array.isArray(playData[key])) streams=streams.concat(playData[key]); });
  var seen={}; return streams.filter(function(stream){
    var key=stream && (stream.url||stream.playUrl||stream.resourceLink||stream.streamUrl);
    if(!key||seen[key])return false;seen[key]=true;return true;
  });
}

function mobileFindEpisode(detail, kind, season, episode) {
  var subjectId=String(detail.subjectId || '');
  if(kind!=='tv') return subjectId;
  var root=detail.raw || detail;
  var seasons=Array.isArray(root.seasons)?root.seasons:[];
  var s=Math.max(1,Number(season)||1), e=Math.max(1,Number(episode)||1);
  for(var i=0;i<seasons.length;i++) {
    var seasonNum=Number(seasons[i].seasonNumber || seasons[i].season || seasons[i].number);
    if(seasonNum!==s) continue;
    var eps=Array.isArray(seasons[i].episodes)?seasons[i].episodes:[];
    for(var j=0;j<eps.length;j++) {
      var epNum=Number(eps[j].episodeNumber || eps[j].episode || eps[j].number);
      if(epNum===e && (eps[j].episodeId || eps[j].id)) return String(eps[j].episodeId || eps[j].id);
    }
  }
  return null;
}
function mobileStreamList(response, sourceId, subjectData, playbackHeaders, targetSeason, targetEpisode) {
  var root = mobileRoot(response); if (!root || typeof root !== 'object') return [];
  var data = root.data || root;
  var list = collectMobileStreams(data);
  var out = [];
  list.forEach(function(item){
    if(!item || typeof item!=='object') return;
    var rawUrl=String(item.url||item.playUrl||item.resourceLink||item.streamUrl||item.play_url||item.link||'').trim();
    var signCookie=item.signCookie||item.sign_cookie||null;
    var policyUrl=extractPolicyResource(signCookie);
    var url=policyUrl||rawUrl;
    if(!url && item.urlprefix) url=String(item.urlprefix).replace(/\/$/,'')+'/index.mpd';
    if(!/^https?:\/\//i.test(url) || looksLikePlaceholder(item,url)) return;
    if(url.indexOf('b164fbfb4347792950bdfbfb563d39d9')>=0) return;
    if(url===rawUrl && /\/other\/2026\/09\//i.test(rawUrl)) return;
    var label=[item.name,item.title,item.format,item.codecName,item.quality].join(' ');
    if(/update.{0,30}(app|application)|new application|install the app/i.test(label)) return;
    var quality=qualityLabel(item.resolutions||item.resolution||item.quality||item.height);
    var headers={};
    Object.keys(playbackHeaders||{}).forEach(function(k){headers[k]=playbackHeaders[k];});
    if(item.headers && typeof item.headers==='object') Object.keys(item.headers).forEach(function(k){headers[k]=item.headers[k];});
    var signHeaderKey=item.signHeaderKey||item.sign_header_key||'Cookie';
    if(signCookie) headers[signHeaderKey]=signCookie;
    if(item.cookie && !headers.Cookie) headers.Cookie=item.cookie;
    if(item.referer||item.referrer) headers.Referer=item.referer||item.referrer;
    if(item.userAgent) headers['User-Agent']=item.userAgent;
    out.push({name:PROVIDER_NAME+' · '+sourceId,title:quality+' · '+(item.format||getFormatType(url)),url:url,quality:quality,
      size:item.size!=null&&!isNaN(Number(item.size))?Number(item.size):undefined,headers:headers});
  });
  if(!out.length) {
    var detectors=data.resourceDetectors || (subjectData && subjectData.resourceDetectors);
    if(Array.isArray(detectors)) detectors.forEach(function(detector){
      if(!detector || !Array.isArray(detector.resolutionList)) return;
      detector.resolutionList.forEach(function(video){
        if(!video || !video.resourceLink) return;
        if((Number(targetSeason)||0)>0 || (Number(targetEpisode)||0)>0) { if((Number(video.se)||0)!==(Number(targetSeason)||0) || (Number(video.ep)||0)!==(Number(targetEpisode)||0)) return; }
        var url=String(video.resourceLink);
        if(!/^https?:\/\//i.test(url)||looksLikePlaceholder(video,url)) return;
        var quality=qualityLabel(video.resolution||video.quality||'Auto');
        var headers={};Object.keys(playbackHeaders||{}).forEach(function(k){headers[k]=playbackHeaders[k];});
        out.push({name:PROVIDER_NAME+' · '+sourceId,title:quality+' · MovieBox resource detector',url:url,quality:quality,headers:headers});
      });
    });
  }
  var seen={}; return out.filter(function(x){if(seen[x.url])return false;seen[x.url]=true;return true;}).sort(function(a,b){return (parseInt(b.quality,10)||0)-(parseInt(a.quality,10)||0);});
}
function getMobileStreams(meta, kind, season, episode) {
  var body={page:1,perPage:20,keyword:meta.title,restrictKid:1};
  return mobileRequest('/wefeed-mobile-bff/subject-api/search/v2','POST',body,0,false,null).then(function(response){
    var candidates=mobileItems(response).map(mobileCandidate).filter(function(c){return c && c.subjectType===(kind==='tv'?2:1);});
    candidates.sort(function(a,b){return titleScore(meta,b)-titleScore(meta,a);});
    var shortlist=candidates.filter(function(c){return titleScore(meta,c)>=40;}).slice(0,3);
    if(!shortlist.length) return [];
    var tasks=shortlist.map(function(candidate){
      return mobileRequest('/wefeed-mobile-bff/subject-api/get?subjectId='+encodeURIComponent(candidate.subjectId),'GET',null,0,false,null).then(function(rawDetail){
        var subjectData=mobileRoot(rawDetail);
        if(subjectData && subjectData.data && !subjectData.subjectId && !subjectData.title) subjectData=subjectData.data;
        if(!subjectData || typeof subjectData!=='object') return [];
        var detailTitle=cleanText(subjectData.title||subjectData.name||candidate.title);
        var detail={subjectId:String(subjectData.subjectId||candidate.subjectId),title:detailTitle,year:getYear(subjectData.releaseDate||subjectData.year||candidate.year)};
        if(titleScore(meta,detail)<40) return [];
        var playbackPage=mobilePlaybackPage(subjectData,detail.subjectId);
        var playbackHeaders={Origin:playbackPage.webBase,Referer:playbackPage.referer,'User-Agent':MOBILE_PLAYER_UA,'x-request-lang':'en','x-vip-restrict':'0','x-no-high-risk-restrict':'0'};
        var subjects=[]; var originalLang='Original';
        if(Array.isArray(subjectData.dubs)) subjectData.dubs.forEach(function(dub){if(!dub||!dub.subjectId)return;if(String(dub.subjectId)===detail.subjectId) originalLang=dub.lanName||'Original';else subjects.push({id:String(dub.subjectId),lang:dub.lanName||'Unknown'});});
        subjects.unshift({id:detail.subjectId,lang:originalLang});
        var requests=subjects.map(function(item){
          var params='subjectId='+encodeURIComponent(item.id)+'&se='+encodeURIComponent(kind==='tv'?Math.max(1,Number(season)||1):0)+'&ep='+encodeURIComponent(kind==='tv'?Math.max(1,Number(episode)||1):0)+'&streamSignType=1';
          if(playbackPage.detailPath) params+='&detailPath='+encodeURIComponent(playbackPage.detailPath);
          params+='&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1';
          return mobileRequest('/wefeed-mobile-bff/subject-api/play-info?'+params,'GET',null,0,false,playbackHeaders).then(function(play){
            var playData=mobileRoot(play);
            if(playData && playData.data && !playData.streams && !playData.netDash && !playData.netHls) playData=playData.data;
            return mobileStreamList(playData,'MovieBox '+item.lang,subjectData,playbackHeaders,kind==='tv'?Math.max(1,Number(season)||1):0,kind==='tv'?Math.max(1,Number(episode)||1):0);
          }).catch(function(error){console.log('[MovieBox Multi-Source] play-info failed for '+item.id+': '+(error&&error.message?error.message:String(error)));return [];});
        });
        return Promise.all(requests).then(function(sets){var all=[];sets.forEach(function(set){all=all.concat(set||[]);});return all;});
      }).catch(function(error){console.log('[MovieBox Multi-Source] subject detail failed: '+(error&&error.message?error.message:String(error)));return [];});
    });
    return Promise.all(tasks).then(function(sets){var all=[];sets.forEach(function(set){all=all.concat(set||[]);});var seen={};return all.filter(function(x){if(seen[x.url])return false;seen[x.url]=true;return true;}).sort(function(a,b){return (parseInt(b.quality,10)||0)-(parseInt(a.quality,10)||0);});});
  }).catch(function(error){console.log('[MovieBox Multi-Source] mobile API path failed: '+(error&&error.message?error.message:String(error)));return [];});
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
    console.log('[MovieBox Multi-Source] Resolving ' + meta.title + (meta.year ? ' (' + meta.year + ')' : '') + ' via mobile API first');
    return getMobileStreams(meta, kind, season, episode).then(function (mobileStreams) {
      if (mobileStreams && mobileStreams.length) {
        console.log('[MovieBox Multi-Source] Mobile API returned ' + mobileStreams.length + ' non-placeholder streams');
        return mobileStreams;
      }
      console.log('[MovieBox Multi-Source] Mobile API had no playable result; falling back to H5 mirrors');
      sourceTimers = controllers.map(function (controller, index) {
        return setTimeout(function () {
          abortQuietly(controller);
          console.log('[MovieBox Multi-Source] ' + SOURCES[index].id + ' reached source timeout');
        }, SOURCE_DEADLINE_MS);
      });
      return requestCandidates(meta.title, SOURCES, controllers).then(function (candidateSets) {
        return raceSources(candidateSets, meta, kind, season, episode, controllers);
      });
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
// Internal pure helpers are intentionally not exported; the provider API stays compatible.
