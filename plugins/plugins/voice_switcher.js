(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.Lampa || root.lampac_voice_switcher) return;
  root.lampac_voice_switcher = true;
  function init() {
    if (!root.lampac_voice_switcher_controller) root.lampac_voice_switcher_controller = api.install(root);
  }
  if (root.appready) init();
  else root.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') init(); });
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  function number(value) {
    var n = parseInt(value, 10);
    return isFinite(n) ? n : 0;
  }
  function normalize(raw) {
    var item = Object.assign({}, raw);
    item.season = number(raw.season || raw.s);
    item.episode = number(raw.episode || raw.e);
    return item;
  }
  function parseItems(response, $) {
    var payload = response;
    if (typeof payload === 'string' && /^\s*[\[{]/.test(payload)) {
      try { payload = JSON.parse(payload); } catch (e) { return []; }
    }
    if (payload && typeof payload === 'object') {
      return (Array.isArray(payload) ? payload : payload.data || []).filter(function (item) {
        return item.method === 'play' || item.method === 'call';
      }).map(normalize);
    }
    var items = [];
    var html = $('<div>').append($.parseHTML(response, null, false));
    html.find('.videos__item').each(function () {
      var row = $(this);
      try {
        var item = JSON.parse(row.attr('data-json'));
        item.season = item.s || row.attr('s');
        item.episode = item.e || row.attr('e');
        if (item.method === 'play' || item.method === 'call') items.push(normalize(item));
      } catch (e) {}
    });
    return items;
  }
  function findEpisode(items, season, episode) {
    return items.find(function (item) {
      return number(item.season || item.s) === number(season) &&
        number(item.episode || item.e) === number(episode);
    });
  }
  function firstURL(value) {
    return typeof value === 'string' ? value.split(' or ')[0] : value && firstURL(value.url) || '';
  }
  function qualities(item) {
    var map = item.qualitys || item.quality;
    if (map && typeof map === 'object' && !Array.isArray(map)) return map;
    map = {};
    (item.streamquality || []).forEach(function (row) { if (row.quality) map[row.quality] = row.url; });
    return map;
  }
  function chooseStream(item, preferred) {
    var map = qualities(item);
    var keys = Object.keys(map).filter(function (key) { return firstURL(map[key]); });
    keys.sort(function (a, b) { return number(b) - number(a); });
    var key = keys[0];
    var height = number(preferred);
    if (height && keys.length) {
      key = keys.find(function (q) { return number(q) <= height; }) || keys[keys.length - 1];
    }
    var clean = {};
    keys.forEach(function (q) { clean[q] = firstURL(map[q]); });
    return { url: key ? clean[key] : firstURL(item.url || item.stream), quality: clean, name: key || '' };
  }

  function install(env) {
    var L = env.Lampa, $ = env.jQuery || env.$;
    var context = null, epoch = 0, pending = null, button = null, cleanupSeek = null;
    var server = '{localhost}';
    if (server.charAt(0) === '{') server = env.location.href;
    var serverOrigin = new env.URL(server, env.location.href).origin;

    function back() {
      if (L.PlayerPanel.toPlayer) L.PlayerPanel.toPlayer();
      else L.Controller.toggle('player');
    }
    function notice(text) { L.Noty.show(text); }
    function cancel() {
      epoch++;
      if (pending) { pending.abort(); pending = null; }
      if (cleanupSeek) { cleanupSeek(); cleanupSeek = null; }
    }
    function authURL(url) {
      var parsed = new env.URL(url, server);
      if (parsed.origin !== serverOrigin || !/^https?:$/.test(parsed.protocol)) throw new Error('Foreign source URL');
      ['account_email', 'lampac_unic_id'].forEach(function (name) {
        var key = name === 'lampac_unic_id' ? 'uid' : name;
        var value = L.Storage.get(name, '');
        if (value && !parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
      });
      return parsed.href;
    }
    function headers() {
      var result = { 'X-Kit-AesGcm': L.Storage.get('aesgcmkey', '') };
      var token = L.Storage.get('alpac_token', '') || L.Storage.get('lampac_token', '') ||
        L.Storage.get('lampac_auth_token', '');
      if (!token) {
        try { token = env.localStorage.getItem('lampac_auth_token') || ''; } catch (e) {}
      }
      if (!token) {
        var match = env.document.cookie.match(/(?:^|;\s*)(?:alpac_token|lampac_token)=([^;]*)/);
        if (match) { try { token = decodeURIComponent(match[1]); } catch (e) {} }
      }
      if (token) { result['X-Lampac-Token'] = token; result['X-Alpac-Token'] = token; }
      return result;
    }
    function request(url, ticket, done, failed) {
      var target;
      try { target = authURL(url); } catch (e) {
        notice('Недопустимый адрес озвучки'); back(); if (failed) failed(); return;
      }
      pending = $.ajax({
        url: target, type: 'GET', dataType: 'text', timeout: 15000, headers: headers(),
        success: function (body) { if (ticket === epoch && context) { pending = null; done(body); } },
        error: function (_, status) {
          if (ticket === epoch && context && status !== 'abort') {
            pending = null; notice('Не удалось загрузить озвучку'); back();
            if (failed) failed();
          }
        }
      });
    }
    function attach(data, voices, index, notify) {
      data.voices = voices;
      data.voice_index = index;
      if (notify) data.onvoicechange = notify;
    }
    function renderButton() {
      if (!L.PlayerPanel.render) return;
      var panel = L.PlayerPanel.render();
      if (!panel || !panel.find) return;
      button = panel.find('.player-panel__voices');
      if (!button.length && context && context.voices.length > 1) {
        button = $('<div class="player-panel__voices button selector" title="Озвучка"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm-5 9H5v1a7 7 0 0 0 6 6.93V22h2v-3.07A7 7 0 0 0 19 12v-1h-2v1a5 5 0 0 1-10 0Z"/></svg><div class="tooltip">Озвучка</div></div>');
        panel.find('.player-panel__tracks').before(button);
        button.on('hover:enter', show);
      }
      button.toggleClass('hide', !context || context.voices.length < 2);
    }
    function start(data) {
      cancel();
      context = null;
      if (data && data.season && data.episode && data.voices && data.voices.length > 1) {
        var voices = data.voices.map(function (voice, index) {
          return { title: voice.title || voice.name || 'Озвучка ' + (index + 1),
            name: voice.title || voice.name || 'Озвучка ' + (index + 1), url: voice.url, index: index };
        });
        context = { data: data, voices: voices, index: number(data.voice_index),
          season: number(data.season), episode: number(data.episode) };
        attach(data, voices, context.index, data.onvoicechange);
        (data.playlist || []).forEach(function (item) { attach(item, voices, context.index, data.onvoicechange); });
      }
      renderButton();
    }
    function show() {
      if (!context || context.voices.length < 2) return;
      L.Select.show({
        title: 'Озвучка',
        items: context.voices.map(function (voice, index) {
          return { title: voice.title, selected: index === context.index, voice_index: index };
        }),
        onSelect: function (item) { switchVoice(item.voice_index); },
        onBack: back
      });
    }
    function switchVoice(index) {
      if (!context || !context.voices[index]) return;
      if (index === context.index) { back(); return; }
      cancel();
      var ticket = epoch, selected = context, voice = context.voices[index];
      notice('Загрузка озвучки…');
      request(voice.url, ticket, function (body) {
        var items;
        try { items = parseItems(body, $); } catch (e) { items = []; }
        var match = findEpisode(items, selected.season, selected.episode);
        if (!match) { notice('Этой серии нет в выбранной озвучке'); back(); return; }
        function ready(resolved) {
          if (ticket !== epoch || context !== selected) return;
          var source = Object.assign({}, match, resolved);
          var video = L.PlayerVideo.video();
          var time = video && isFinite(video.currentTime) ? video.currentTime : 0;
          var paused = video && video.paused;
          var preferred = selected.data.quality_switched;
          if (selected.data.voice_quality_preference !== undefined && preferred === selected.data.voice_quality_current) {
            preferred = selected.data.voice_quality_preference;
          }
          if (!preferred) {
            // An automatic/default selection is an intent, not the old file's
            // actual resolution. In auto mode choose the new voice's maximum.
            preferred = L.Storage.field ? number(L.Storage.field('video_quality_default')) : 0;
          }
          var stream = chooseStream(source, preferred);
          if (!stream.url) { notice('Не удалось получить ссылку на видео'); back(); return; }
          var previous = selected.data.playlist || (L.PlayerPlaylist && L.PlayerPlaylist.get()) || [];
          var list = items.map(function (item) {
            var old = findEpisode(previous, item.season, item.episode) || {};
            var next = Object.assign({}, old, {
              title: old.title || item.title || item.name, season: item.season, episode: item.episode,
              voice_name: voice.title, subtitles: item.subtitles, fxdirect: item.fxdirect
            });
            var nextStream = chooseStream(item, preferred);
            if (item.method === 'call') {
              next.url = function (done) {
                var nextTicket = epoch;
                request(item.url, nextTicket, function (result) {
                  try {
                    var actual = chooseStream(JSON.parse(result), preferred);
                    next.url = actual.url; next.quality = actual.quality;
                  } catch (e) { next.url = ''; }
                  done();
                }, function () { next.url = ''; done(); });
              };
            } else { next.url = nextStream.url; next.quality = nextStream.quality; }
            attach(next, selected.voices, index, selected.data.onvoicechange);
            return next;
          });
          var current = findEpisode(list, selected.season, selected.episode);
          current.url = stream.url; current.quality = stream.quality;
          selected.index = index;
          Object.assign(selected.data, current, { playlist: list, quality_switched: stream.name,
            voice_quality_preference: preferred, voice_quality_current: stream.name });
          if (selected.data.onvoicechange) selected.data.onvoicechange(index);
          // Reuse Lampa's quality-change path: it tears down the old HLS/native
          // engine correctly, while keeping the current episode and timeline.
          L.PlayerPanel.listener.send('quality', { name: stream.name, url: stream.url });
          L.PlayerPanel.quality(stream.quality, stream.url);
          L.Player.playlist(list);
          var fresh = L.PlayerVideo.video();
          if (fresh && fresh.addEventListener) {
            var timer;
            function cleanup() {
              fresh.removeEventListener('loadedmetadata', restore);
              fresh.removeEventListener('canplay', restore);
              env.clearTimeout(timer);
            }
            function restore() {
              if (ticket !== epoch || context !== selected || L.PlayerVideo.video() !== fresh) { cleanup(); return; }
              if (!isFinite(fresh.duration) || fresh.duration <= 0) return;
              cleanup();
              fresh.currentTime = Math.min(time, Math.max(0, fresh.duration - 1));
              if (paused) fresh.pause();
              else { var playing = fresh.play(); if (playing && playing.catch) playing.catch(function () {}); }
            }
            fresh.addEventListener('loadedmetadata', restore);
            fresh.addEventListener('canplay', restore);
            timer = env.setTimeout(cleanup, 20000);
            cleanupSeek = cleanup;
          }
          notice('Озвучка: ' + voice.title);
          back();
        }
        if (match.method === 'call') {
          request(match.url, ticket, function (result) {
            try { ready(JSON.parse(result)); } catch (e) { notice('Не удалось получить ссылку на видео'); back(); }
          });
        } else ready({});
      });
    }

    L.Player.listener.follow('start', start);
    L.Player.listener.follow('destroy', function () { cancel(); context = null; renderButton(); });
    L.PlayerPanel.listener.follow('visible', renderButton);
    L.PlayerPanel.listener.follow('voice', function (event) { switchVoice(event.index); });
    env.document.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      if (event.keyCode === 86 && !event.ctrlKey && !event.altKey && !event.metaKey &&
          !event.shiftKey && tag !== 'input' && tag !== 'textarea' && context) {
        event.preventDefault(); event.stopPropagation(); show();
      }
    }, true);
    return { start: start, show: show, switchVoice: switchVoice };
  }
  return { parseItems: parseItems, findEpisode: findEpisode, chooseStream: chooseStream, install: install };
});
