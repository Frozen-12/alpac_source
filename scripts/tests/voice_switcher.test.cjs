const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../plugins/plugins/voice_switcher.js');

function events() {
  const handlers = {};
  return {
    follow(name, fn) { (handlers[name] ||= []).push(fn); },
    send(name, value) { (handlers[name] || []).forEach(fn => fn(value)); }
  };
}
function video(time = 0) {
  const handlers = {};
  return {
    currentTime: time, duration: 300, paused: false, videoHeight: 2160,
    addEventListener(name, fn) { (handlers[name] ||= new Set()).add(fn); },
    removeEventListener(name, fn) { handlers[name]?.delete(fn); },
    emit(name) { [...(handlers[name] || [])].forEach(fn => fn()); },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
}
function fixture(options = {}) {
  const requests = [], changes = [], messages = [], launches = [], settings = [], timers = new Map();
  let current = video(87), playlist;
  const Lampa = {
    Storage: {
      get(key, fallback) { return ({lampac_auth_token: 'test-auth', lampac_unic_id: 'test-device',
        filmix_external_playlist: options.mode})[key] || fallback; },
      field(key) { if (key === 'playlist_next') return options.playlistNext; }
    },
    Platform: { is(name) { return name === (options.platform || 'android'); } },
    SettingsApi: { addParam(param) { settings.push(param); } },
    Android: { openPlayer(...args) { launches.push({receiver: this, args}); return 'native-result'; } },
    Noty: { show(text) { messages.push(text); } },
    Controller: { toggle() {} },
    Select: { show() {} },
    Player: { listener: events(), playlist(list) { playlist = list; } },
    PlayerPanel: { listener: events(), toPlayer() {}, quality() {} },
    PlayerVideo: { video() { return current; } },
    PlayerPlaylist: { get() { return playlist || []; } }
  };
  Lampa.PlayerPanel.listener.follow('quality', change => { changes.push(change); current = video(); });
  const env = {
    Lampa, URL, location: {href: 'https://server.test/'},
    document: {cookie: '', addEventListener() {}}, localStorage: { getItem() { return ''; } },
    $: { ajax(options) { const request = { options, aborted: false, abort() { this.aborted = true; } }; requests.push(request); return request; } },
    setTimeout(fn, ms) { const id = {}; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const controller = api.install(env);
  const voices = [{title: 'Amedia', url: 'https://server.test/lite/filmix?s=1&t=0'},
    {title: 'HDRezka 4K', url: 'https://server.test/lite/filmix?s=1&t=1'}];
  const data = {season: 1, episode: 3, title: 'Episode three', url: 'old-2160',
    quality: {'2160p': 'old-2160'}, voices, voice_index: 0,
    playlist: [2, 3, 4].map(episode => ({season: 1, episode, title: `Episode ${episode}`, url: `old-${episode}`}))};
  controller.start(data);
  return {controller, Lampa, data, requests, changes, messages, launches, settings, timers,
    current: () => current, playlist: () => playlist};
}
function response(episodes = [2, 3, 4]) {
  return JSON.stringify({type: 'episode', data: episodes.map(e => ({method: 'play', s: 1, e,
    url: `new-${e}-2160`, quality: {'2160p': `new-${e}-2160`, '1080p': `new-${e}-1080`}}))});
}

test('matches the exact episode, including gaps; never substitutes episode one', () => {
  const items = api.parseItems(response([1, 3]));
  assert.equal(api.findEpisode(items, 1, 3).episode, 3);
  assert.equal(api.findEpisode(items, 1, 2), undefined);
  assert.equal(api.findEpisode(items, 2, 3), undefined);
});

test('keeps selected quality or falls back to the closest lower available quality', () => {
  const item = {quality: {'720p': '720 or reserve', '2160p': '2160', '1080p': '1080'}};
  assert.equal(api.chooseStream(item, 2160).url, '2160');
  assert.equal(api.chooseStream(item, 1440).url, '1080');
  assert.equal(api.chooseStream(item, 480).url, '720');
  assert.equal(api.chooseStream(item).url, '2160');
  assert.deepEqual(api.chooseStream({url: 'only or reserve'}).quality, {});
});

test('switches the same episode, restores position and updates the following episodes', () => {
  const f = fixture();
  let selected;
  f.data.onvoicechange = index => { selected = index; };
  f.controller.switchVoice(1);
  assert.equal(f.requests[0].options.headers['X-Lampac-Token'], 'test-auth');
  assert.equal(new URL(f.requests[0].options.url).searchParams.get('uid'), 'test-device');
  f.requests[0].options.success(response());
  assert.equal(f.changes[0].url, 'new-3-2160');
  assert.equal(f.data.episode, 3);
  assert.equal(f.data.voice_name, 'HDRezka 4K');
  assert.equal(selected, 1);
  assert.equal(f.playlist()[2].url, 'new-4-2160');
  assert.equal(f.playlist()[2].voice_index, 1);
  f.current().emit('loadedmetadata');
  assert.equal(f.current().currentTime, 87);
  f.controller.start(f.playlist()[2]);
  f.controller.switchVoice(0);
  assert.equal(new URL(f.requests[1].options.url).searchParams.get('t'), '0');
});

test('missing translation keeps current playback and playlist', () => {
  const f = fixture();
  f.controller.switchVoice(1);
  f.requests[0].options.success(response([1, 2]));
  assert.equal(f.changes.length, 0);
  assert.equal(f.data.url, 'old-2160');
  assert.equal(f.data.voice_index, 0);
  assert.match(f.messages.at(-1), /Этой серии нет/);
});

test('returns to the requested quality after a lower-quality translation', () => {
  const f = fixture();
  f.controller.switchVoice(1);
  f.requests[0].options.success(JSON.stringify({data: [{method: 'play', s: 1, e: 3,
    quality: {'1080p': 'lower-1080'}}]}));
  assert.equal(f.changes[0].url, 'lower-1080');
  f.controller.switchVoice(0);
  f.requests[1].options.success(response());
  assert.equal(f.changes[1].url, 'new-3-2160');
});

test('an explicit quality change overrides automatic voice quality', () => {
  const f = fixture();
  f.controller.switchVoice(1);
  f.requests[0].options.success(response());
  f.data.quality_switched = '1080p';
  f.controller.switchVoice(0);
  f.requests[1].options.success(response());
  assert.equal(f.changes[1].url, 'new-3-1080');
});

test('respects the configured quality preference even if the old voice lacked it', () => {
  const f = fixture();
  f.Lampa.Storage.field = () => '2160';
  f.data.quality = {'1080p': 'old-2160'};
  f.current().videoHeight = 1080;
  f.controller.switchVoice(1);
  f.requests[0].options.success(response());
  assert.equal(f.changes[0].url, 'new-3-2160');
});

test('late response cannot change a different episode or a destroyed player', () => {
  const f = fixture();
  f.controller.switchVoice(1);
  f.controller.start({...f.data, episode: 4});
  assert.equal(f.requests[0].aborted, true);
  f.requests[0].options.success(response());
  assert.equal(f.changes.length, 0);
  f.controller.switchVoice(1);
  f.Lampa.Player.listener.send('destroy');
  f.requests[1].options.success(response());
  assert.equal(f.changes.length, 0);
});

test('refuses to send credentials to a foreign source URL', () => {
  const f = fixture();
  f.controller.start({...f.data, voices: [f.data.voices[0], {title: 'Foreign', url: 'https://other.test/lite/filmix'}]});
  f.controller.switchVoice(1);
  assert.equal(f.requests.length, 0);
  assert.match(f.messages.at(-1), /Недопустимый адрес/);
});

test('failed lazy resolution completes instead of leaving the playlist loading', () => {
  const f = fixture();
  f.controller.switchVoice(1);
  f.requests[0].options.success(JSON.stringify({data: [
    {method: 'play', s: 1, e: 3, url: 'new-three'},
    {method: 'call', s: 1, e: 4, url: 'https://server.test/resolve-four'}
  ]}));
  let completed = false;
  const next = f.playlist()[1];
  next.url(() => { completed = true; });
  f.requests[1].options.error(null, 'timeout');
  assert.equal(completed, true);
  assert.equal(next.url, '');
});

test('paused playback remains paused and position is clamped to the new duration', () => {
  const f = fixture();
  f.current().paused = true;
  f.controller.switchVoice(1);
  f.requests[0].options.success(response());
  f.current().duration = 60;
  f.current().emit('canplay');
  assert.equal(f.current().currentTime, 59);
  assert.equal(f.current().paused, true);
});

function externalFixture(options = {}) {
  const f = fixture({mode: 'voices', ...options});
  Object.assign(f.data, {url: 'https://server.test/selected-1080',
    quality: {'1080p': 'https://server.test/selected-1080', '2160p': 'https://server.test/selected-2160'},
    timeline: {hash: 'episode-1-3', time: 87, duration: 300}, position: 87,
    card: {id: 123, name: 'Series'}, subtitles: [{url: 'https://server.test/old-subs'}]});
  return f;
}
function audioResult(overrides = {}) {
  return JSON.stringify({url: 'https://server.test/proxy/filmix-audio/current.m3u8',
    tracks: 2, total: 4, episodes: {
      '3': 'https://server.test/proxy/filmix-audio/current.m3u8',
      '4': 'https://server.test/proxy/filmix-audio/next.m3u8'
    }, ...overrides});
}

test('external voice mode is opt-in and preserves native arguments and return by default', () => {
  const f = externalFixture({mode: 'episodes'});
  assert.equal(f.settings[0].param.default, 'episodes');
  assert.equal(f.Lampa.Android.openPlayer(f.data.url, f.data, 'extra'), 'native-result');
  assert.equal(f.requests.length, 0);
  assert.equal(f.launches[0].receiver, f.Lampa.Android);
  assert.deepEqual(f.launches[0].args, [f.data.url, f.data, 'extra']);
});

test('Android receives one HLS master with real audio renditions and keeps series ordering and progress', () => {
  const f = externalFixture();
  f.Lampa.Android.openPlayer(f.data.url, f.data);
  const query = new URL(f.requests[0].options.url).searchParams;
  assert.equal(query.get('audio_mux'), '1');
  assert.equal(query.get('e'), '3');
  assert.equal(query.get('s'), '1');
  assert.equal(query.get('t'), '0');
  assert.equal(f.requests[0].options.headers['X-Lampac-Token'], 'test-auth');
  assert.equal(f.launches.length, 0);
  f.requests[0].options.success(audioResult());
  const [url, data] = f.launches[0].args;
  assert.equal(new URL(url).pathname, '/proxy/filmix-audio/current.m3u8');
  assert.equal(data.position, 87);
  assert.equal(data.timeline.hash, 'episode-1-3');
  assert.equal(data.card.id, 123);
  assert.deepEqual(data.quality, {});
  assert.deepEqual(data.playlist.map(item => item.episode), [2, 3, 4]);
  assert.equal(new URL(data.playlist[2].url).pathname, '/proxy/filmix-audio/next.m3u8');
  assert.equal(data.playlist[2].timeline, f.data.playlist[2].timeline);
  assert.equal(f.data.playlist[2].url, 'old-4');
  assert.match(f.messages.at(-1), /аудиодорожек — 2/);
  assert.match(f.messages.at(-1), /длительностью исключены/);
});

test('selected voice supplies the matching season and video cut for the server composer', () => {
  const f = externalFixture();
  f.data.voice_index = 1;
  f.Lampa.Android.openPlayer(f.data.url, f.data);
  assert.equal(new URL(f.requests[0].options.url).searchParams.get('t'), '1');
  f.requests[0].options.success(audioResult());
  assert.equal(f.launches.length, 1);
});

test('disabled episode autoplay does not prevent audio selection within the current HLS', () => {
  const f = externalFixture({playlistNext: false});
  f.Lampa.Android.openPlayer(f.data.url, f.data);
  assert.equal(f.requests.length, 1);
  f.requests[0].options.success(audioResult());
  assert.equal(f.launches.length, 1);
});

test('HTTP errors and older servers fall back to the selected video once', () => {
  for (const response of [null, '', '<html>old response</html>', '{"data":[]}', '{"tracks":2}']) {
    const f = externalFixture();
    f.Lampa.Android.openPlayer(f.data.url, f.data);
    if (response === null) f.requests[0].options.error(null, 'timeout');
    else f.requests[0].options.success(response);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].args[1], f.data);
    assert.match(f.messages.at(-1), /Запуск выбранного перевода/);
  }
});

test('foreign selected API and foreign master response never receive credentials', () => {
  for (const foreignAPI of [false, true]) {
    const f = externalFixture();
    if (foreignAPI) f.data.voices[0].url = 'https://other.test/lite/filmix';
    f.Lampa.Android.openPlayer(f.data.url, f.data);
    if (!foreignAPI) f.requests[0].options.success(audioResult({url: 'https://other.test/master.m3u8'}));
    assert.equal(f.requests.length, foreignAPI ? 0 : 1);
    assert.equal(f.launches[0].args[1], f.data);
  }
});

test('only native audio master responses are accepted; foreign next-episode URLs are ignored', () => {
  const f = externalFixture();
  f.Lampa.Android.openPlayer(f.data.url, f.data);
  f.requests[0].options.success(audioResult({episodes: {'4': 'https://other.test/next.m3u8'}}));
  assert.equal(f.launches[0].args[1].playlist[2].url, 'old-4');
  const bad = externalFixture();
  bad.Lampa.Android.openPlayer(bad.data.url, bad.data);
  bad.requests[0].options.success(audioResult({url: 'https://server.test/unrelated'}));
  assert.equal(bad.launches[0].args[1], bad.data);
});

test('a new play or player destruction prevents a stale external launch', () => {
  for (const event of ['create', 'destroy']) {
    const f = externalFixture();
    f.Lampa.Android.openPlayer(f.data.url, f.data);
    f.Lampa.Player.listener.send(event, {});
    f.requests[0].options.success(audioResult());
    assert.equal(f.requests[0].aborted, true);
    assert.equal(f.launches.length, 0);
  }
});

test('movies, non-Filmix sources and non-Android platforms keep their usual launch', () => {
  for (const change of [f => { f.data.season = 0; },
    f => { f.data.voices[1].url = 'https://server.test/lite/kinopub'; },
    f => { f.Lampa.Platform.is = () => false; }]) {
    const f = externalFixture();
    change(f);
    f.Lampa.Android.openPlayer(f.data.url, f.data);
    assert.equal(f.requests.length, 0);
    assert.equal(f.launches[0].args[1], f.data);
  }
});
