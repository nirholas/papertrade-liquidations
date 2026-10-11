(function () {
  var root = document.documentElement;
  var sidebar = document.getElementById('sidebar');
  var menu = document.querySelector('.menu');
  menu.addEventListener('click', function () {
    var open = sidebar.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });

  document.querySelector('.theme').addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('pt-theme', next); } catch (e) {}
  });

  document.querySelectorAll('.code .copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.parentElement.querySelector('code').textContent;
      var done = function (label) { btn.textContent = label; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { done('Failed'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done('Copied'); } catch (e) { done('Failed'); }
        document.body.removeChild(ta);
      }
    });
  });

  var input = document.getElementById('q');
  var list = document.getElementById('results');
  var index = null;
  var loading = null;
  function load() {
    if (!loading) loading = fetch('/docs/search-index.json').then(function (r) { return r.json(); }).then(function (j) { index = j; });
    return loading;
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    var hits = [];
    index.forEach(function (e) {
      var title = e.title.toLowerCase();
      var body = (e.description + ' ' + e.text).toLowerCase();
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        var inTitle = title.indexOf(terms[i]) >= 0;
        var inBody = body.indexOf(terms[i]) >= 0;
        if (!inTitle && !inBody) return;
        score += inTitle ? 5 : 1;
      }
      hits.push({ e: e, score: score });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, 8);
  }
  function snippet(e, q) {
    if (!e.text) return '';
    var t = q.toLowerCase().split(/\s+/)[0];
    var i = e.text.toLowerCase().indexOf(t);
    if (i < 0) return e.description;
    var s = e.text.slice(Math.max(0, i - 40), i + 100);
    return (i > 40 ? '...' : '') + s + '...';
  }
  function show(q) {
    q = q.trim();
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    var hits = search(q);
    list.innerHTML = hits.length
      ? hits.map(function (h) { return '<li role="option"><a href="' + h.e.path + '"><b>' + esc(h.e.title) + '</b><span>' + esc(snippet(h.e, q)) + '</span></a></li>'; }).join('')
      : '<li class="none">No pages match "' + esc(q) + '". Try a tool name such as get_bust_map.</li>';
    list.hidden = false;
  }
  input.addEventListener('focus', load);
  input.addEventListener('input', function () { load().then(function () { show(input.value); }); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { input.value = ''; show(''); input.blur(); }
    if (ev.key === 'Enter') { var a = list.querySelector('a'); if (a) location.href = a.getAttribute('href'); }
  });
  document.addEventListener('click', function (ev) { if (!ev.target.closest('.search')) list.hidden = true; });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) { ev.preventDefault(); input.focus(); }
  });
})();
