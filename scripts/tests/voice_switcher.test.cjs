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
function fixture() {
  const requests = [], changes = [], messages = [];
  let current = video(87), playlist;
  const Lampa = {
    Storage: { get(key, fallback) { return ({lampac_auth_token: 'test-auth', lampac_unic_id: 'test-device'})[key] || fallback; } },
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
    setTimeout() { return 1; }, clearTimeout() {}
  };
  const controller = api.install(env);
  const voices = [{title: 'Amedia', url: 'https://server.test/lite/filmix?s=1&t=0'},
    {title: 'HDRezka 4K', url: 'https://server.test/lite/filmix?s=1&t=1'}];
  const data = {season: 1, episode: 3, title: 'Episode three', url: 'old-2160',
    quality: {'2160p': 'old-2160'}, voices, voice_index: 0,
    playlist: [2, 3, 4].map(episode => ({season: 1, episode, title: `Episode ${episode}`, url: `old-${episode}`}))};
  controller.start(data);
  return {controller, Lampa, data, requests, changes, messages, current: () => current, playlist: () => playlist};
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
