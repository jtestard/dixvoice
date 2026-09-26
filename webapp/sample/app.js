(function () {
  'use strict';

  var CDN = 'https://dp1tbjxi4bfec.cloudfront.net/audio/';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    count: $('count'),
    q: $('q'),
    emotion: $('emotion'),
    voice: $('voice'),
    sort: $('sort'),
    enabled: $('enabled'),
    deal: $('deal'),
    reset: $('reset'),
    rows: $('rows'),
    table: $('clips'),
    empty: $('empty'),
    error: $('error'),
    player: $('player'),
    toast: $('toast'),
  };

  var clips = [];
  var playingId = null;

  function cdnUrl(clip) { return CDN + clip.id + '.mp3'; }

  // ---- URL state -----------------------------------------------------------

  function readState() {
    var p = new URLSearchParams(location.search);
    els.q.value = p.get('q') || '';
    els.emotion.value = p.get('emotion') || '';
    els.voice.value = p.get('voice') || '';
    els.sort.value = p.get('sort') || '';
    els.enabled.checked = p.get('enabled') === '1';
    els.deal.checked = p.get('deal') === '1';
  }

  function writeState() {
    var p = new URLSearchParams();
    if (els.q.value) p.set('q', els.q.value);
    if (els.emotion.value) p.set('emotion', els.emotion.value);
    if (els.voice.value) p.set('voice', els.voice.value);
    if (els.sort.value) p.set('sort', els.sort.value);
    if (els.enabled.checked) p.set('enabled', '1');
    if (els.deal.checked) p.set('deal', '1');
    var qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  // ---- filters -------------------------------------------------------------

  function countBy(key) {
    var counts = {};
    clips.forEach(function (c) { counts[c[key]] = (counts[c[key]] || 0) + 1; });
    return counts;
  }

  function fillSelect(select, counts) {
    Object.keys(counts).sort().forEach(function (value) {
      var opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value + ' (' + counts[value] + ')';
      select.appendChild(opt);
    });
  }

  function visibleClips() {
    var q = els.q.value.trim().toLowerCase();
    var emotion = els.emotion.value;
    var voice = els.voice.value;
    var onlyEnabled = els.enabled.checked;
    var onlyDeal = els.deal.checked;

    var out = clips.filter(function (c) {
      if (q && c.text.toLowerCase().indexOf(q) === -1) return false;
      if (emotion && c.emotion !== emotion) return false;
      if (voice && c.voice_id !== voice) return false;
      if (onlyEnabled && !c.enabled) return false;
      if (onlyDeal && !c.deal) return false;
      return true;
    });

    var sort = els.sort.value;
    if (sort) {
      var desc = sort.charAt(0) === '-';
      var key = desc ? sort.slice(1) : sort;
      var field = key === 'duration' ? 'duration_ms' : key;
      out.sort(function (a, b) {
        var r = typeof a[field] === 'number'
          ? a[field] - b[field]
          : a[field].localeCompare(b[field], undefined, { sensitivity: 'base' });
        return desc ? -r : r;
      });
    }
    return out;
  }

  // ---- rendering -----------------------------------------------------------

  function flag(name, on) {
    var span = document.createElement('span');
    span.className = 'flag ' + (on ? 'on' : 'off');
    span.textContent = name;
    span.title = name + ': ' + on;
    return span;
  }

  function cell(className, label, child) {
    var td = document.createElement('td');
    td.className = className;
    td.setAttribute('data-label', label);
    if (typeof child === 'string') td.textContent = child; else td.appendChild(child);
    return td;
  }

  function copyButton(label, value) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small copy';
    b.textContent = label;
    b.title = 'Copy ' + value;
    b.setAttribute('data-copy', value);
    return b;
  }

  function renderRow(c) {
    var tr = document.createElement('tr');
    tr.className = 'clip';
    tr.tabIndex = 0;
    tr.setAttribute('data-id', c.id);
    if (c.id === playingId) tr.classList.add('playing');

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn play';
    play.setAttribute('data-play', c.id);
    play.setAttribute('aria-label', (c.id === playingId ? 'Stop' : 'Play') + ' ' + c.text);
    play.textContent = c.id === playingId ? '■' : '▶';
    tr.appendChild(cell('col-play', '', play));

    tr.appendChild(cell('col-text', 'Text', c.text));

    var em = document.createElement('span');
    em.className = 'emotion';
    em.textContent = c.emotion;
    tr.appendChild(cell('col-emotion', 'Emotion', em));

    var voice = document.createElement('code');
    voice.textContent = c.voice_id;
    tr.appendChild(cell('col-voice', 'Voice', voice));

    tr.appendChild(cell('col-duration', 'Duration', (c.duration_ms / 1000).toFixed(2) + ' s'));

    var flags = document.createElement('span');
    flags.className = 'flags';
    flags.appendChild(flag('truncated', c.truncated));
    flags.appendChild(flag('deal', c.deal));
    flags.appendChild(flag('enabled', c.enabled));
    tr.appendChild(cell('col-flags', 'Flags', flags));

    var copies = document.createElement('span');
    copies.className = 'copies';
    copies.appendChild(copyButton('id', c.id));
    copies.appendChild(copyButton('url', cdnUrl(c)));
    tr.appendChild(cell('col-copy', 'Copy', copies));

    return tr;
  }

  function render() {
    var visible = visibleClips();
    var frag = document.createDocumentFragment();
    visible.forEach(function (c) { frag.appendChild(renderRow(c)); });
    els.rows.textContent = '';
    els.rows.appendChild(frag);

    els.count.textContent = visible.length === clips.length
      ? clips.length + ' clips'
      : visible.length + ' of ' + clips.length + ' clips shown';
    els.empty.hidden = visible.length > 0;
    els.table.hidden = visible.length === 0;

    var sort = els.sort.value;
    var sortKey = sort.replace(/^-/, '');
    var desc = sort.charAt(0) === '-';
    Array.prototype.forEach.call(document.querySelectorAll('th .sort'), function (b) {
      var active = b.getAttribute('data-sort') === sortKey;
      b.classList.toggle('active', active);
      b.setAttribute('data-dir', active ? (desc ? 'desc' : 'asc') : '');
      b.parentNode.setAttribute('aria-sort', active ? (desc ? 'descending' : 'ascending') : 'none');
    });
  }

  function updatePlayingRow() {
    Array.prototype.forEach.call(els.rows.children, function (tr) {
      var id = tr.getAttribute('data-id');
      var on = id === playingId;
      tr.classList.toggle('playing', on);
      var b = tr.querySelector('.play');
      b.textContent = on ? '■' : '▶';
      b.setAttribute('aria-label', (on ? 'Stop' : 'Play') + ' ' + tr.querySelector('.col-text').textContent);
    });
  }

  // ---- playback ------------------------------------------------------------

  function stop() {
    els.player.pause();
    els.player.removeAttribute('src');
    els.player.load();
    playingId = null;
    updatePlayingRow();
  }

  function toggle(id) {
    if (id === playingId) { stop(); return; }
    var clip = clips.find(function (c) { return c.id === id; });
    if (!clip) return;
    playingId = id;
    els.player.src = cdnUrl(clip);
    els.player.play().catch(function (err) {
      showToast('Could not play clip: ' + err.message);
      stop();
    });
    updatePlayingRow();
  }

  els.player.addEventListener('ended', stop);
  els.player.addEventListener('error', function () {
    if (playingId) { showToast('Failed to load clip from CDN'); stop(); }
  });

  // ---- misc ----------------------------------------------------------------

  var toastTimer;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 1500);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  // ---- events --------------------------------------------------------------

  function onFilterChange() { writeState(); render(); }
  els.q.addEventListener('input', onFilterChange);
  [els.emotion, els.voice, els.sort, els.enabled, els.deal].forEach(function (el) {
    el.addEventListener('change', onFilterChange);
  });
  $('filters').addEventListener('submit', function (e) { e.preventDefault(); });
  els.reset.addEventListener('click', function () {
    els.q.value = '';
    els.emotion.value = '';
    els.voice.value = '';
    els.sort.value = '';
    els.enabled.checked = false;
    els.deal.checked = false;
    onFilterChange();
  });

  document.querySelector('thead').addEventListener('click', function (e) {
    var b = e.target.closest('.sort');
    if (!b) return;
    var key = b.getAttribute('data-sort');
    els.sort.value = els.sort.value === key ? '-' + key : key;
    onFilterChange();
  });

  els.rows.addEventListener('click', function (e) {
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      copyText(copy.getAttribute('data-copy')).then(
        function () { showToast('Copied ' + copy.textContent); },
        function () { showToast('Copy failed'); }
      );
      return;
    }
    var play = e.target.closest('[data-play]');
    if (play) toggle(play.getAttribute('data-play'));
  });

  els.rows.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    var tr = e.target.closest('tr.clip');
    if (!tr || e.target !== tr) return;
    e.preventDefault();
    toggle(tr.getAttribute('data-id'));
  });

  window.addEventListener('popstate', function () { readState(); render(); });

  // ---- init ----------------------------------------------------------------

  fetch('./manifest.json', { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      clips = data;
      fillSelect(els.emotion, countBy('emotion'));
      fillSelect(els.voice, countBy('voice_id'));
      readState();
      render();
    })
    .catch(function (err) {
      els.count.textContent = '';
      els.table.hidden = true;
      els.error.hidden = false;
      els.error.textContent = 'Could not load manifest.json: ' + err.message;
    });
})();
