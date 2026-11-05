const $ = (id) => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || sessionStorage.getItem('canvas-token') || '';
if (fragment.has('token')) { sessionStorage.setItem('canvas-token', token); history.replaceState(null, '', location.pathname + location.search); }
let state = { artifacts: [], board: { rev: 0, viewport: { x: 30, y: 30, zoom: 1 }, items: {} }, notes: { rev: 0, items: [] }, chat: { messages: [], pending: [] } };
let selection = null, view = 'canvas', gesture = null, liveText = '', streamController;
let saveQueue = Promise.resolve(), saving = 0, pendingState = null, saveBlocked = false;
const filters = new Map(), picked = new Map(), objectURLs = new Map();
const tableViews = new Set();
const positions = new Map(), boardNodes = new Map();
let reportSignature;
let activeTool = 'hand', spaceHeld = false, interactingId = null;
const selectedNodes = new Set(), undoStack = [], redoStack = [];
let refs = [], refsDir = '', refFilter = '전체';
const attachedRefs = new Set(), refURLs = new Map();
function refImage(id) {
  const img = el('img'); img.alt = '';
  if (!refURLs.has(id)) refURLs.set(id, fetch(`/api/refs/file?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.blob() : Promise.reject()).then(b => URL.createObjectURL(b)).catch(() => ''));
  refURLs.get(id).then(url => { if (url) img.src = url; }); return img;
}
function renderRefs() {
  const cats = ['전체', ...new Set(refs.map(r => r.category))];
  $('ref-filters').replaceChildren(...(refs.length ? cats : []).map(c => { const b = button(c, () => { refFilter = c; renderRefs(); }); b.setAttribute('aria-pressed', String(c === refFilter)); return b; }));
  $('ref-grid').replaceChildren(...refs.filter(r => refFilter === '전체' || r.category === refFilter).map(r => {
    const item = button('', () => { if (attachedRefs.has(r.id)) attachedRefs.delete(r.id); else if (attachedRefs.size < 4) attachedRefs.add(r.id); else notice('레퍼런스는 최대 4개까지 담을 수 있습니다.'); renderRefs(); });
    item.className = 'ref-card'; item.setAttribute('aria-pressed', String(attachedRefs.has(r.id)));
    item.title = r.learn || r.need || r.title; item.append(refImage(r.id), el('strong', '', r.title), el('span', '', r.need || r.category)); return item;
  }));
  $('ref-note').textContent = `고른 레퍼런스는 다음 메시지에 기준으로 함께 전달됩니다(최대 4개). 직접 만든 레퍼런스는 ${refsDir}/<분류>/<이름>.png 로 넣으면 추가됩니다.`;
  $('ref-chips').replaceChildren(...[...attachedRefs].map(id => {
    const chip = el('span', 'ref-chip'); chip.append(refImage(id), el('span', '', refs.find(r => r.id === id)?.title || id), button('×', () => { attachedRefs.delete(id); renderRefs(); })); return chip;
  }));
}
function setPanel(next) {
  $('gallery').hidden = next !== 'refs'; $('messages').hidden = next === 'refs';
  $('chat-tab').setAttribute('aria-pressed', String(next !== 'refs')); $('refs-tab').setAttribute('aria-pressed', String(next === 'refs'));
  if (next === 'refs') api('/refs').then(r => { refs = r.items; refsDir = r.dir; for (const id of attachedRefs) if (!refs.some(x => x.id === id)) attachedRefs.delete(id); renderRefs(); }).catch(notice);
}
const HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
function button(text, action) { const b = el('button', '', text); b.type = 'button'; b.addEventListener('click', action); return b; }
function notice(error) { $('notice').textContent = error?.message || String(error); $('notice').hidden = false; }
$('notice').onclick = () => { $('notice').hidden = true; };
// Every request names the task this tab shows; the server refuses task-scoped writes from a stale tab.
async function api(path, data, method, task = state.task?.id) {
  const response = await fetch(`/api${path}`, { method: method || (data === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, ...(task ? { 'X-Canvas-Task': task } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (!response.ok) { const body = await response.text(); let message = body; try { message = JSON.parse(body).error || body; } catch {} const error = new Error(`${response.status}: ${String(message).slice(0, 600)}`); error.status = response.status; throw error; }
  return response.status === 204 ? null : response.json();
}
function normalize(next) {
  next.artifacts ||= []; next.board ||= { rev: 0, viewport: { x: 30, y: 30, zoom: 1 }, items: {} };
  next.board.items ||= {}; next.board.viewport ||= { x: 30, y: 30, zoom: 1 };
  next.notes ||= { rev: 0, items: [] }; next.chat ||= { messages: [], pending: [] };
  return next;
}
function receive(next) {
  if (saveBlocked) return;
  // A response that started before a task switch must not bring the previous task back.
  if ((next.task?.epoch || 0) < Math.max(state.task?.epoch || 0, pendingState?.task?.epoch || 0)) return;
  if (gesture || saving || zoomTimer || document.activeElement?.classList.contains('note-editor') || document.activeElement?.closest('#approvals')) { pendingState = next; return; }
  if (next.task?.epoch !== state.task?.epoch) resetTaskView();
  state = normalize(next); render();
}
// Per-task view caches; keeping any of them would carry one task's layout or selection into another.
function resetTaskView() {
  selection = null; picked.clear(); filters.clear(); tableViews.clear(); selectedNodes.clear(); interactingId = null;
  undoStack.length = 0; redoStack.length = 0; liveText = ''; reportSignature = undefined; chatMessageNodes.clear(); $('live-message')?.remove();
  for (const { node } of boardNodes.values()) node.remove();
  boardNodes.clear(); positions.clear();
}
function flushPending() { if (pendingState && !saving && !gesture && !zoomTimer) { const next = pendingState; pendingState = null; receive(next); } }
function save(kind, patch) {
  saving++; $('save-status').textContent='— Saving…';
  const task = state.task?.id;
  saveQueue = saveQueue.then(async () => {
    if (saveBlocked) return;
    try {
      const result = await api(`/${kind}`, { ...state[kind], ...patch, rev: state[kind].rev }, 'PUT', task);
      if (state.task?.id === task) state[kind] = result;
    } catch (error) {
      // Conflict never silently overwrites another tab's edits; keep the draft visible until refreshed.
      saveBlocked = true; $('save-status').textContent='— 저장 실패';
      notice(error.status === 409 ? '다른 탭의 변경과 충돌했습니다. 현재 메모를 복사한 뒤 새로고침해 주세요.' : error);
      throw error;
    }
  }).catch(() => {}).finally(() => { saving--; if (!saving && !saveBlocked) { $('save-status').textContent='— Auto-saved'; pendingState = null; api('/state').then(receive).catch(notice); } });
  return saveQueue;
}
function position(id, index) {
  const saved=(Object.hasOwn(state.board.items,id)?state.board.items[id]:null)||positions.get(id);
  if(saved)return saved;
  const p={x:(index%2)*460,y:0,w:420,h:310};
  const occupied=[...Object.values(state.board.items),...positions.values()].filter(r=>!r.hidden&&[r.x,r.y,r.w,r.h].every(Number.isFinite));
  for(let i=0;i<=occupied.length;i++){const hits=occupied.filter(r=>p.x<r.x+r.w+24&&p.x+p.w+24>r.x&&p.y<r.y+r.h+40&&p.y+p.h+40>r.y);if(!hits.length)break;p.y=Math.max(...hits.map(r=>r.y+r.h))+60;}
  return p;
}
function applyPosition(node, p) {
  node.style.left = `${p.x}px`; node.style.top = `${p.y}px`; node.style.width = `${p.w}px`; node.style.height = `${p.h}px`;
  node.hidden = p.hidden === true;
  node.classList.toggle('selected', selectedNodes.has(node.dataset.id));
  node.classList.toggle('interacting', interactingId === node.dataset.id);
  node.classList.toggle('primitive', Boolean(p.kind)); node.dataset.kind = p.kind || '';
  if (p.fill) node.style.background = p.fill; else node.style.removeProperty('background');
  const body = node.querySelector('.card-content');
  if (p.kind === 'draw' && body && Array.isArray(p.points)) {
    let svg = body.querySelector('.drawing-path');
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('drawing-path'); svg.append(document.createElementNS(svg.namespaceURI,'polyline')); body.append(svg); }
    svg.setAttribute('viewBox', `0 0 ${p.drawW || p.w} ${p.drawH || p.h}`);
    const line = svg.firstChild; line.setAttribute('points', p.points.filter(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)).map(v=>v.join(',')).join(' '));
    line.setAttribute('fill','none'); line.setAttribute('stroke',p.stroke || '#a3adff'); line.setAttribute('stroke-width','2'); line.setAttribute('stroke-linecap','round'); line.setAttribute('stroke-linejoin','round');
  }
}
function applyViewport() {
  const v = state.board.viewport;
  $('world').style.transform = `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
  $('zoom-label').textContent = `${Math.round(v.zoom * 100)}%`;
}
function persistBoard() { return save('board', { viewport: { ...state.board.viewport }, items: { ...state.board.items } }); }
function safeURL(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
function markdown(text) {
  const root = el('div', 'markdown'); let code = null, para = [];
  const flush = () => { if (para.length) root.append(el('p', '', para.join('\n'))); para = []; };
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('```')) { flush(); if (code) { root.append(code); code = null; } else code = el('pre'); continue; }
    if (code) { code.textContent += `${line}\n`; continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { flush(); root.append(el(`h${heading[1].length}`, '', heading[2])); }
    else if (line.startsWith('> ')) { flush(); root.append(el('blockquote', '', line.slice(2))); }
    else if (/^[-*] /.test(line)) { flush(); const list = root.lastElementChild?.tagName === 'UL' ? root.lastElementChild : el('ul'); list.append(el('li', '', line.slice(2))); if (!list.parentNode) root.append(list); }
    else if (!line.trim()) flush(); else para.push(line);
  }
  flush(); if (code) root.append(code);
  for(const node of root.querySelectorAll('p,li,h1,h2,h3,blockquote')){
    const source=node.textContent;node.replaceChildren();
    for(const part of source.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g))node.append(part.startsWith('`')&&part.endsWith('`')?el('code','',part.slice(1,-1)):part.startsWith('**')&&part.endsWith('**')?el('strong','',part.slice(2,-2)):document.createTextNode(part));
  }
  return root;
}
function rowValue(row, column, index) { return Array.isArray(row) ? row[index] : row?.[column]; }
function dataset(artifact) {
  const rows = Array.isArray(artifact.rows) ? artifact.rows : [];
  const columns = artifact.columns || (rows[0] && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : []);
  return { rows, columns };
}
function choose(artifact, rowIndex) {
  const set = picked.get(artifact.id) || new Set();
  if (rowIndex !== undefined) { set.has(rowIndex) ? set.delete(rowIndex) : set.add(rowIndex); picked.set(artifact.id, set); }
  selection = { artifactId: artifact.id, rows: [...set], filter: filters.get(artifact.id) || '' };
  renderSelection(); document.querySelectorAll('[data-row]').forEach(n => { if (n.dataset.artifact === artifact.id) n.classList.toggle('picked', set.has(Number(n.dataset.row))); });
}
function renderSelection() {
  const box = $('selection'); box.replaceChildren(); box.hidden = !selection;
  if (!selection) return;
  const title = state.artifacts.find(a => a.id === selection.artifactId)?.title || selection.artifactId;
  box.append(el('span', '', `${title} · ${selection.rows?.length || 0}행 선택${selection.filter ? ` · 필터: ${selection.filter}` : ''}`), button('×', () => { selection = null; renderSelection(); }));
}
function table(artifact, interactive) {
  const wrapper = el('div'); const { rows, columns } = dataset(artifact);
  const filter = el('input', 'filter'); filter.placeholder = '데이터 필터…'; filter.setAttribute('aria-label', `${artifact.title} 데이터 필터`); filter.value = filters.get(artifact.id) || '';
  const scroll = el('div', 'table-scroll'), node = el('table'); scroll.append(node);
  const draw = () => {
    node.replaceChildren(); const head = el('thead'), tr = el('tr'); columns.forEach(c => tr.append(el('th', '', c))); head.append(tr); node.append(head);
    const body = el('tbody'), query = filter.value.toLocaleLowerCase();
    rows.forEach((row, index) => {
      if (query && !JSON.stringify(row).toLocaleLowerCase().includes(query)) return;
      const line = el('tr'); columns.forEach((column, i) => line.append(el('td', '', rowValue(row, column, i) ?? '')));
      if (interactive) { line.dataset.row = index; line.dataset.artifact = artifact.id; line.tabIndex = 0; line.classList.toggle('picked', picked.get(artifact.id)?.has(index)); line.onclick = () => choose(artifact, index); line.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(artifact, index); } }; }
      body.append(line);
    }); node.append(body);
  };
  filter.oninput = () => {
    filters.set(artifact.id, filter.value);
    for(const entry of tableViews){if(!entry.wrapper.isConnected){tableViews.delete(entry);continue;}if(entry.id===artifact.id){entry.filter.value=filter.value;entry.draw();}}
    choose(artifact);
  };
  if (interactive) wrapper.append(filter); wrapper.append(scroll); draw();
  tableViews.add({id:artifact.id,wrapper,filter,draw});return wrapper;
}
function chart(artifact, interactive) {
  const { rows, columns } = dataset(artifact); const config = artifact.chart || {};
  const xi = Math.max(0, columns.indexOf(config.x || columns[0])), yi = Math.max(0, columns.indexOf(config.y || columns[1]));
  const points = rows.map((r, i) => ({ x: String(rowValue(r, columns[xi], xi) ?? i), y: Number(rowValue(r, columns[yi], yi)), i })).filter(p => Number.isFinite(p.y));
  if (!points.length) return el('p', 'artifact-error', '차트에 사용할 숫자 데이터가 없습니다.');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 600 300'); svg.classList.add('chart-svg'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', artifact.title || '차트');
  const s = (tag, attrs, text) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; svg.append(n); return n; };
  const lo = Math.min(0, ...points.map(p => p.y)), hi = Math.max(0, ...points.map(p => p.y));
  const peak = Math.max(...points.map(p => p.y));
  const y = v => 245 - (v - lo) / (hi - lo || 1) * 210, step = 520 / points.length, x = i => 50 + step * (i + .5);
  for (let i = 0; i <= 4; i += 4) { const value = lo + (hi - lo) * i / 4; s('line', { x1: 45, y1: y(value), x2: 580, y2: y(value), stroke: '#e4ebe4' }); s('text', { x: 39, y: y(value) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#819386' }, value.toLocaleString(undefined, { maximumFractionDigits: 1 })); }
  if (config.kind === 'line') s('polyline', { points: points.map((p, i) => `${x(i)},${y(p.y)}`).join(' '), fill: 'none', stroke: '#138568', 'stroke-width': 3 });
  points.forEach((point, i) => {
    const top = point.y === peak, n = config.kind === 'line' ? s('circle', { cx: x(i), cy: y(point.y), r: top ? 7 : 5, fill: top ? '#138568' : '#9fb4a8' }) : s('rect', { x: x(i) - step * .32, y: Math.min(y(0), y(point.y)), width: step * .64, height: Math.max(2, Math.abs(y(point.y) - y(0))), rx: 4, fill: top ? '#138568' : '#d5ddd7' });
    if (points.length <= 12) s('text', { x: x(i), y: Math.min(y(0), y(point.y)) - 8, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': top ? 600 : 400, fill: top ? '#138568' : '#6f7d77' }, point.y.toLocaleString());
    const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${point.x}: ${point.y}`; n.append(title);
    if (interactive) { n.dataset.row = point.i; n.dataset.artifact = artifact.id; n.setAttribute('tabindex', '0'); n.onclick = () => choose(artifact, point.i); n.onkeydown = e => { if (e.key === 'Enter') choose(artifact, point.i); }; }
    if (points.length < 15 || i % Math.ceil(points.length / 12) === 0) s('text', { x: x(i), y: 268, 'text-anchor': 'middle', 'font-size': 10, fill: '#708578' }, point.x.slice(0, 14));
  });
  const best = points.find(p => p.y === peak), wrap = el('div', 'chart-wrap'), head = el('p', 'chart-headline');
  head.append(el('strong', '', `${best.x} ${best.y.toLocaleString()}`), el('span', '', ` 최댓값 · ${points.length}개 항목`));
  wrap.append(head, svg); return wrap;
}
async function loadMedia(artifact, target) {
  try {
    const response = await fetch(`/api/artifact/${encodeURIComponent(artifact.id)}/content`, { headers: { Authorization: `Bearer ${token}`, ...(state.task ? { 'X-Canvas-Task': state.task.id } : {}) } });
    if (!response.ok) throw new Error(`산출물 읽기 실패 (${response.status})`);
    if (!target.isConnected) return;
    if (artifact.type === 'html') {
      const html = await response.text();
      // Opaque-origin sandbox cannot access parent APIs, cookies or local files; CSP also blocks network.
      target.exportHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">${html}`;
      const ticket = await api(`/artifact/${encodeURIComponent(artifact.id)}/render`, {});
      if (target.isConnected) target.src = ticket.url;
    } else {
      const blob = await response.blob();
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(blob.type)) throw new Error('지원하지 않는 이미지 형식입니다.');
      const url = URL.createObjectURL(blob); objectURLs.set(url, target); target.src = url;
    }
  } catch (error) { if (target.isConnected) target.replaceWith(el('p', 'artifact-error', error.message)); }
}
function content(artifact, interactive) {
  const root = el('div', 'artifact-body');
  if (artifact.error) { root.append(el('p', 'artifact-error', artifact.error)); return root; }
  if (artifact.type === 'table') root.append(table(artifact, interactive));
  else if (artifact.type === 'chart') root.append(chart(artifact, interactive));
  else if (artifact.type === 'html') { const frame = el('iframe', 'artifact-frame'); frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.title = artifact.title || 'HTML 산출물'; root.append(frame); queueMicrotask(() => loadMedia(artifact, frame)); }
  else if (artifact.type === 'image') { const image = el('img', 'artifact-image'); image.alt = artifact.title || '분석 이미지'; root.append(image); queueMicrotask(() => loadMedia(artifact, image)); }
  else root.append(markdown(artifact.content));
  if (artifact.facts?.length) { const list = el('ul', 'facts'); artifact.facts.forEach(f => list.append(el('li', '', f))); root.append(list); }
  if (artifact.interpretation) { const box = el('div', 'interpretation'); box.append(el('strong', '', '해석'), el('p', '', artifact.interpretation)); root.append(box); }
  if (artifact.sources?.length) { const list = el('ul', 'source-list'); for (const source of artifact.sources) { const item = el('li'), url = safeURL(source.url); if (url) { const link = el('a', '', source.label || url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); } else item.textContent = [source.label, source.path].filter(Boolean).join(' — '); list.append(item); } root.append(list); }
  return root;
}
const KIND = { markdown: '메모', table: '표', chart: '차트', html: 'HTML', image: '이미지', NOTE: '내 메모' };
function card(id, title, kind, inner, index, note = false) {
  const node = el('section', `card${note ? ' note-card' : ''}`); node.dataset.id = id; const p = position(id, index); positions.set(id, p); applyPosition(node, p);
  const head = el('header', 'card-header'), label = el('div'); label.append(el('span', 'kind', KIND[kind] || kind), el('h2', '', title)); head.append(label);
  if (!note) {
    const actions = el('div', 'card-actions'); head.append(actions);
    actions.append(button('확대', () => {
      selectedNodes.clear();selectedNodes.add(id);focusEditorSelection();renderEditorPanels();
    }));
    actions.append(button('＋ 대화', () => choose(state.artifacts.find(a => a.id === id))));
    actions.firstChild.title = '확대'; actions.firstChild.setAttribute('aria-label', '확대'); actions.lastChild.title = '대화에 담기';
  }
  const body = el('div', 'card-content'); body.append(inner); const handle = el('div', 'resize'); handle.setAttribute('aria-label', '크기 조절');
  head.onpointerdown = e => { if (!e.target.closest('button')) beginGesture(e, 'move', id, node); };
  handle.onpointerdown = e => beginGesture(e, 'resize', id, node);
  const shield = el('div', 'interaction-shield'); shield.title = '드래그로 이동 · 더블클릭으로 콘텐츠 조작';
  shield.onpointerdown = e => { if (activeTool === 'hand' || spaceHeld) beginGesture(e, 'pan'); else if (activeTool === 'select') beginGesture(e, 'move', id, node); else beginCanvasGesture(e); };
  shield.ondblclick = e => { e.stopPropagation(); enterInteraction(id); };
  node.append(head, body, shield, handle);
  for (const corner of ['nw','ne','sw']) { const h=el('div','resize'); h.dataset.corner=corner; h.setAttribute('aria-label','크기 조절 '+corner); h.onpointerdown=e=>beginGesture(e,'resize',id,node,corner); node.append(h); }
  return node;
}
function renderBoard() {
  const world = $('world'), ids = new Set([...state.artifacts.map(a => a.id), ...state.notes.items.map(n => n.id)]);
  $('empty').hidden = !!(state.artifacts.length || state.notes.items.length);
  const sync = (id, data, index, create) => {
    const signature = JSON.stringify(data);
    let entry = boardNodes.get(id);
    if (!entry || entry.signature !== signature) {
      const node = create();
      if (entry) entry.node.replaceWith(node);
      entry = { node, signature }; boardNodes.set(id, entry);
    }
    const p = position(id, index); positions.set(id, p); applyPosition(entry.node, p);
    // Keep unchanged iframes attached so saved positions and chat updates cannot reload them.
    if (world.children[index] !== entry.node) world.insertBefore(entry.node, world.children[index] || null);
  };
  for (const [id, entry] of boardNodes) {
    if (!ids.has(id)) {
      entry.node.remove(); boardNodes.delete(id); positions.delete(id);
    }
  }
  state.artifacts.forEach((a, i) => sync(a.id, a, i, () => card(a.id, a.title || a.id, a.type, content(a, true), i)));
  state.notes.items.forEach((note, i) => sync(note.id, note, state.artifacts.length + i, () => {
    const text = el('textarea', 'note-editor'); text.value = note.text; text.setAttribute('aria-label', '메모');
    text.onchange = () => { rememberEditor(snapshotEditor()); const items = state.notes.items.map(n => n.id === note.id ? { ...n, text: text.value } : n); state.notes.items = items; save('notes', { items }); };
    text.onblur = () => queueMicrotask(flushPending);
    const kind=state.board.items[note.id]?.kind;
    return card(note.id, ({rectangle:'Rectangle',ellipse:'Ellipse',text:'Text',frame:'Frame',draw:'Path',note:'Note'})[kind]||'내 메모', 'NOTE', text, state.artifacts.length + i, true);
  })); applyViewport(); renderEditorPanels();
}
function renderReport() {
  const signature = JSON.stringify([state.artifacts, state.notes.items]);
  if (signature === reportSignature) return;
  reportSignature = signature;
  const toc = $('report-toc'), body = $('report-body'); toc.replaceChildren(); body.replaceChildren();
  if (!state.artifacts.length) { body.append(el('p', '', '분석 산출물이 생기면 이곳에서 글로 읽을 수 있습니다.')); return; }
  state.artifacts.forEach((a, i) => { const section = el('section', 'report-section'); section.id = `section-${i}`; section.dataset.artifact=a.id;
    const link = el('a', '', `${i + 1}. ${a.title || a.id}`); link.href = `#section-${i}`; link.onclick = e => { e.preventDefault(); section.scrollIntoView({ behavior: 'smooth' }); }; toc.append(link);
    const back=button('캔버스에서 보기 ↗',()=>{choose(a);setView('canvas');});back.className='report-canvas-link';
    section.append(el('span', 'kind', a.type), el('h2', '', a.title || a.id),back,content(a, true)); body.append(section);
  });
  if (state.notes.items.length) { const section = el('section', 'report-section'); section.append(el('h2', '', '내 메모')); state.notes.items.forEach(n => section.append(markdown(n.text))); body.append(section); }
}
const chatMessageNodes = new Map();
let renderedChatThread = '';
function renderChat() {
  const chat = state.chat, messages = $('messages');
  const engine=chat.engine==='pi'?'Pi':'Codex';
  $('agent-engine').value=chat.agentMode||'codex';$('agent-engine').disabled=chat.status==='running'||chat.switching||Boolean(chat.pending?.length);
  for(const o of $('agent-engine').options)if(o.value!=='auto')o.disabled=chat.availableAgents?.[o.value]===false;
  $('agent-engine').options[0].textContent=`자동 · ${engine}`;
  $('agent-detail').textContent=`${engine}${chat.model?.id?' · '+chat.model.id:''}`;
  $('agent-name').textContent=chat.model?.id||engine;
  $('agent-name').title=engine;
  const first=(chat.messages||[]).find(m=>m.role==='user'&&!m.text.trimStart().startsWith('/'))||(chat.messages||[]).find(m=>m.role==='user');
  $('conversation-title').textContent=first?.text||'New conversation';
  $('conversation-title').title=first?.text||'New conversation';
  const busy=chat.status==='running'||chat.switching||Boolean(chat.pending?.length);
  $('new-conversation').hidden=!chat.supportsConversations;
  $('new-conversation').disabled=busy;
  $('conversation-menu').querySelector('summary').setAttribute('aria-disabled',String(busy||!chat.supportsConversations));
  $('pi-questions').hidden=chat.engine!=='pi';$('pi-questions').disabled=chat.status==='running'; const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  const thread=`${chat.engine}:${chat.threadId||''}`;
  if(thread!==renderedChatThread){chatMessageNodes.clear();renderedChatThread=thread;}
  const next=[];
  for(const [index,m] of (chat.messages||[]).entries()){
    const signature=JSON.stringify([m.role,m.text,m.references]);let entry=chatMessageNodes.get(index);
    if(!entry||entry.signature!==signature){const node=el('div',`message ${m.role}`);if(m.references?.length)node.append(el('span','message-label',m.references.join(' · ')));node.append(m.role==='assistant'?markdown(m.text||''):document.createTextNode(m.text||''));entry={signature,node};chatMessageNodes.set(index,entry);}
    next.push(entry.node);
  }
  for(const key of chatMessageNodes.keys())if(key>=(chat.messages||[]).length)chatMessageNodes.delete(key);
  if(liveText&&chat.status==='running'){const live=$('live-message')||el('div','message live');live.id='live-message';live.textContent=liveText;next.push(live);}
  if(!next.length)next.push(el('p','chat-empty','어떤 작업을 시작할까요?'));
  next.forEach((node,i)=>{if(messages.childNodes[i]!==node)messages.insertBefore(node,messages.childNodes[i]||null)});
  while(messages.childNodes.length>next.length)messages.lastChild.remove();
  $('chat-status').textContent=`${engine}${chat.model?.id?' · '+chat.model.id:''} · ${({ running:'작업 중',unavailable:'연결 불가',idle:'준비' })[chat.status]||'준비'}`;
  $('send').disabled = chat.status === 'running'||chat.switching; $('stop').hidden = chat.status !== 'running'; if (chat.status !== 'running') liveText = '';
  if (nearBottom) messages.scrollTop = messages.scrollHeight;
  const last = (chat.messages || []).at(-1);
  $('dock-status').textContent = chat.status === 'running' ? `${engine} · 분석 중${liveText ? ` — ${liveText.slice(-80)}` : ''}` : last ? `${last.role === 'user' ? '나' : engine} · ${last.text || ''}` : '어떤 질문을 살펴볼까요?';
  $('dock-bar').classList.toggle('running', chat.status === 'running');
  renderApprovals();
}
function renderApprovals() {
  const area = $('approvals'); area.replaceChildren();
  for (const req of state.chat.pending || []) {
    const box = el('section', 'approval'), params = req.params || {}; box.append(el('strong', '', req.method.includes('UserInput') ? 'Codex의 질문' : '승인이 필요합니다'));
    const respond = async result => { try { await api('/answer', { id: req.id, result }); $('notice').hidden=true; box.remove(); flushPending(); } catch (e) { notice(e); } };
    if (req.method.startsWith('pi/')) {
      box.replaceChildren(el('strong','',params.title||'Pi 질문'));if(params.message)box.append(el('p','',params.message));
      if(params.method==='confirm')box.append(button('허용',()=>respond({confirmed:true})),button('거절',()=>respond({confirmed:false})));
      else {
        const input=params.method==='select'?el('select'):params.method==='editor'?el('textarea'):el('input');
        if(params.method==='select'){const blank=el('option','','선택해주세요');blank.value='';blank.disabled=true;blank.selected=true;input.append(blank);for(const value of params.options||[]){const option=el('option','',value);option.value=value;input.append(option)}}
        else{input.value=params.prefill||'';input.placeholder=params.placeholder||'';input.maxLength=20000;}
        input.setAttribute('aria-label',params.title||'Pi 답변');box.append(input,button('답변 제출',()=>{if(params.method==='select'&&!input.value){notice('답변을 선택해주세요.');return;}respond({value:input.value})}));
      }
      box.append(button('취소',()=>respond({cancelled:true})));
    } else if (req.method.includes('requestUserInput')) {
      const inputs = [];
      for (const q of params.questions || []) {
        box.append(el('p', '', q.question || q.header)); const input = q.options?.length ? el('select') : el('input');
        if (q.options?.length) for (const o of q.options) { const opt = el('option', '', o.label); opt.value = o.label; input.append(opt); }
        else input.type = q.isSecret ? 'password' : 'text';
        input.setAttribute('aria-label', q.question || q.id); box.append(input); inputs.push([q.id, input]);
      }
      box.append(button('응답', () => respond({ answers: Object.fromEntries(inputs.map(([id, input]) => [id, { answers: [input.value] }])) })));
    } else if (req.method.includes('permissions')) {
      box.append(el('pre', '', JSON.stringify(params.permissions || {}, null, 2)), button('이번 턴 허용', () => respond({ permissions: params.permissions || {}, scope: 'turn' })), button('거절', () => respond({ permissions: {}, scope: 'turn' })));
    } else {
      box.append(el('pre', '', params.command || params.reason || `파일 변경: ${params.itemId || ''}`));
      box.append(button('허용', () => respond({ decision: 'accept' })), button('거절', () => respond({ decision: 'decline' })), button('턴 취소', () => respond({ decision: 'cancel' })));
    }
    area.append(box);
  }
}
const taskName = (t) => t?.title || (!t || t.id === 'root' ? '기본 작업' : '새 작업'); // no task info = pre-task server, i.e. the root task
function renderTask() { const name = taskName(state.task); $('task-title').textContent = name; $('task-title').title = name; }
function render() {
  if (view === 'canvas') renderBoard(); else renderReport(); renderChat(); renderSelection(); renderTask();
  for (const [url, target] of objectURLs) if (!target.isConnected) { URL.revokeObjectURL(url); objectURLs.delete(url); }
}
function beginGesture(event, type, id, node, corner = 'se') {
  if (event.button !== 0 && event.button !== 1) return;
  if (type==='move' && activeTool!=='select' && activeTool!=='hand' && !spaceHeld && event.button===0) {beginCanvasGesture(event);return;}
  event.preventDefault(); event.stopPropagation();
  if (spaceHeld || activeTool === 'hand' || event.button === 1) { type='pan'; id=undefined; }
  if (id) { if (event.shiftKey && selectedNodes.has(id) && type==='move') {selectedNodes.delete(id);renderEditorPanels();return;} if (!selectedNodes.has(id)) {if(!event.shiftKey)selectedNodes.clear();selectedNodes.add(id);} interactingId=null;renderEditorPanels(); }
  const starts = new Map([...selectedNodes].map(key=>[key,{...positions.get(key)}]));
  gesture = { type, id, node, corner, x: event.clientX, y: event.clientY, start: { ...(id ? positions.get(id) : state.board.viewport) }, starts, pointer: event.pointerId, before: snapshotEditor() };
  document.body.classList.add('is-dragging'); event.currentTarget.setPointerCapture(event.pointerId);
}
document.addEventListener('pointermove', event => {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  const g = gesture, dx = event.clientX - g.x, dy = event.clientY - g.y;
  if (g.type === 'pan') { state.board.viewport = { ...g.start, x: g.start.x + dx, y: g.start.y + dy }; applyViewport(); }
  else if (g.type === 'move') { for (const [id,start] of g.starts) { const p={...start,x:start.x+dx/state.board.viewport.zoom,y:start.y+dy/state.board.viewport.zoom}; state.board.items[id]=p;positions.set(id,p);applyPosition(boardNodes.get(id).node,p); } }
  else if (g.type === 'resize') { const p={...g.start}, zx=dx/state.board.viewport.zoom,zy=dy/state.board.viewport.zoom;
    p.w=Math.max(40,g.start.w+(g.corner.includes('w')?-zx:zx));p.h=Math.max(40,g.start.h+(g.corner.includes('n')?-zy:zy));
    if(g.corner.includes('w'))p.x=g.start.x+g.start.w-p.w;if(g.corner.includes('n'))p.y=g.start.y+g.start.h-p.h;
    state.board.items[g.id]=p;positions.set(g.id,p);applyPosition(g.node,p);
  } else if (g.type === 'marquee' || g.type === 'create') {
    const r=$('canvas').getBoundingClientRect(); const x=Math.min(event.clientX,g.x)-r.left,y=Math.min(event.clientY,g.y)-r.top,w=Math.abs(dx),h=Math.abs(dy);
    Object.assign($('marquee').style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});$('marquee').hidden=false;
    g.end=worldPoint(event);if(g.tool==='draw'&&g.points.length<2000)g.points.push(g.end);
  }
});
const endGesture = () => {
  if (!gesture) return; const g=gesture;gesture=null;document.body.classList.remove('is-dragging');$('marquee').hidden=true;
  if (g.type==='marquee') { if(!g.add)selectedNodes.clear();const a=g.origin,b=g.end||a;for(const[id,p]of positions)if(!p.hidden&&p.x<Math.max(a.x,b.x)&&p.x+p.w>Math.min(a.x,b.x)&&p.y<Math.max(a.y,b.y)&&p.y+p.h>Math.min(a.y,b.y))selectedNodes.add(id);renderEditorPanels();flushPending();return; }
  if (g.type==='create') {finishCreate(g);return;}
  if (g.type!=='pan'&&JSON.stringify(g.before.items)!==JSON.stringify(state.board.items))rememberEditor(g.before);
  persistBoard();renderEditorPanels();
};
document.addEventListener('pointerup', endGesture); document.addEventListener('pointercancel', () => {if(!gesture)return;state.board.items=gesture.before.items;gesture=null;positions.clear();$('marquee').hidden=true;document.body.classList.remove('is-dragging');render();flushPending();});
$('canvas').onpointerdown = e => { if (!e.target.closest('.card')) beginCanvasGesture(e); };
function zoom(factor, px, py) { const box = $('canvas').getBoundingClientRect(), v = state.board.viewport; const x = px ?? box.width / 2, y = py ?? box.height / 2; const next = Math.min(2.5, Math.max(.2, v.zoom * factor)); state.board.viewport = { x: x - (x - v.x) * next / v.zoom, y: y - (y - v.y) * next / v.zoom, zoom: next }; applyViewport(); }
let zoomTimer;
$('canvas').addEventListener('wheel', e => {
  if (e.target.closest('.card.interacting .card-content') && !e.ctrlKey && !e.metaKey && !spaceHeld) return;
  e.preventDefault(); const r=$('canvas').getBoundingClientRect();
  if(e.ctrlKey||e.metaKey)zoom(Math.exp(-e.deltaY*.002),e.clientX-r.left,e.clientY-r.top);
  else if(Math.abs(e.deltaX)>Math.abs(e.deltaY))zoom(1-Math.max(-30,Math.min(30,e.deltaX))*.012,e.clientX-r.left,e.clientY-r.top);
  else {state.board.viewport.x-=e.shiftKey?e.deltaY:e.deltaX;state.board.viewport.y-=e.shiftKey?0:e.deltaY;applyViewport();}
  clearTimeout(zoomTimer);zoomTimer=setTimeout(()=>{zoomTimer=null;persistBoard();},200);
}, { passive:false });
$('zoom-in').onclick = () => { zoom(1.2); persistBoard(); }; $('zoom-out').onclick = () => { zoom(1 / 1.2); persistBoard(); };
$('fit').onclick = () => {
  const ids = [...state.artifacts.map(a => a.id), ...state.notes.items.map(n => n.id)].filter(id=>!positions.get(id)?.hidden); if (!ids.length) return;
  const list = ids.map(id=>positions.get(id)),  minX = Math.min(...list.map(p => p.x)), minY = Math.min(...list.map(p => p.y)), maxX = Math.max(...list.map(p => p.x + p.w)), maxY = Math.max(...list.map(p => p.y + p.h));
  const z = Math.min(1.2, Math.max(.2, Math.min(($('canvas').clientWidth - 140) / (maxX - minX), ($('canvas').clientHeight - 180) / (maxY - minY)))); state.board.viewport = { x: 70 - minX * z, y: 80 - minY * z, zoom: z }; applyViewport(); persistBoard();
};
$('add-note').onclick = () => setEditorTool('note');
function setView(next) {
  if(next===view)return;
  const node=[...selectedNodes].find(id=>state.artifacts.some(a=>a.id===id));
  const contextId=next==='report'?(node||selection?.artifactId):(selection?.artifactId||node);
  view=next;document.body.dataset.view=next;interactingId=null;$('layers-panel').hidden=true;
  $('canvas').hidden=next!=='canvas';$('report').hidden=next!=='report';
  $('canvas-tab').setAttribute('aria-pressed',next==='canvas');$('report-tab').setAttribute('aria-pressed',next==='report');$('export-report').hidden=next!=='report';
  render();renderEditorPanels();
  if(contextId&&next==='report') [...$('report-body').querySelectorAll('.report-section')].find(s=>s.dataset.artifact===contextId)?.scrollIntoView({block:'start'});
  if(contextId&&next==='canvas'&&positions.has(contextId)&&!positions.get(contextId).hidden){selectedNodes.clear();selectedNodes.add(contextId);focusEditorSelection();renderEditorPanels();}
}
$('canvas-tab').onclick = () => setView('canvas'); $('report-tab').onclick = () => setView('report');
function setChatCollapsed(collapsed) {
  // Collapsed chat docks to the bottom as a composer instead of disappearing.
  document.querySelector('.workspace').classList.toggle('chat-collapsed', collapsed);
  $('toggle-chat').setAttribute('aria-expanded', String(!collapsed));
  $('toggle-chat').setAttribute('aria-label', collapsed ? 'Agent 패널 열기' : 'Agent 패널 닫기');
  $('toggle-chat').title = collapsed ? '채팅 펼치기' : '채팅 접기';
  resizeComposer();
}
const chatCollapsed = () => document.querySelector('.workspace').classList.contains('chat-collapsed');
$('toggle-chat').onclick = () => { $('layers-panel').hidden=true; setChatCollapsed(!chatCollapsed()); };
setChatCollapsed(new URLSearchParams(location.search).get('panel') !== 'agent');
$('dock-expand').onclick = () => setChatCollapsed(false);
$('chat-tab').onclick = () => setPanel('chat'); $('refs-tab').onclick = () => setPanel('refs');
document.addEventListener('pointerdown', e => { if (!e.target.closest('#tools')) $('tools').open = false; if (!e.target.closest('#task-menu')) $('task-menu').open = false; });
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; for (const id of ['tools', 'task-menu']) if ($(id).open) { $(id).open = false; $(id).querySelector('summary').focus(); } });
$('tools').addEventListener('click', e => { if (e.target.closest('button') && !e.target.closest('.zoom-controls')) $('tools').open = false; });


$('prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$('send').disabled) $('chat-form').requestSubmit(); } };
$('chat-form').onsubmit = async e => { e.preventDefault(); const text = $('prompt').value.trim(); if (!text) return; $('send').disabled = true; try { liveText = ''; await api('/chat', { text, ...(selection ? { selection } : {}), ...(attachedRefs.size ? { references: [...attachedRefs] } : {}) }); $('prompt').value = ''; resizeComposer(); selection = null; renderSelection(); attachedRefs.clear(); renderRefs(); setPanel('chat'); receive(await api('/state')); } catch (error) { notice(error); $('send').disabled = false; } };
$('stop').onclick = () => api('/interrupt', {}).catch(notice);
$('agent-engine').onchange=async()=>{const requested=$('agent-engine').value;$('agent-engine').disabled=true;try{await api('/agent',{backend:requested});liveText='';receive(await api('/state'))}catch(e){notice(e);renderChat()}};
$('pi-questions').onclick=async()=>{try{$('agent-menu').open=false;await api('/chat',{text:'/q'});receive(await api('/state'))}catch(e){notice(e)}};
async function changeConversation(id){
  if($('prompt').value.trim()&&!confirm('작성 중인 메시지를 지우고 대화를 전환할까요?'))return;
  try{await api('/conversations',id?{id}:{});$('notice').hidden=true;liveText='';$('prompt').value='';resizeComposer();$('conversation-menu').open=false;receive(await api('/state'));setPanel('chat');$('prompt').focus()}catch(e){notice(e)}
}
$('new-conversation').onclick=()=>changeConversation();
// Tasks are saved automatically and kept until the user deletes one here.
async function changeTask(path, body) {
  document.activeElement?.blur?.(); await saveQueue;
  if (saveBlocked) { notice('저장하지 못한 변경이 있어 작업을 바꾸지 않았습니다. 새로고침해 주세요.'); return; }
  $('new-task').disabled = $('delete-task').disabled = true;
  try { const next = await api(path, body); $('notice').hidden = true; $('task-menu').open = false; receive(next); }
  catch (e) { notice(e); }
  finally { $('new-task').disabled = $('delete-task').disabled = false; }
}
$('new-task').onclick = () => changeTask('/tasks', {});
let deleteTarget = null;
$('delete-task').onclick = () => {
  const c = state.chat; if (!state.task) { notice('작업 정보를 받지 못했습니다. 서버를 다시 시작한 뒤 새로고침해 주세요.'); return; }
  if (c.status === 'running' || c.switching || c.pending?.length) { notice('에이전트 작업이나 응답 대기 질문이 끝난 뒤 삭제할 수 있습니다. 완료하거나 중단해 주세요.'); return; }
  deleteTarget = state.task.id; $('delete-task-name').textContent = taskName(state.task); $('delete-task-dialog').showModal();
};
$('cancel-delete-task').onclick = () => $('delete-task-dialog').close();
$('confirm-delete-task').onclick = () => { $('delete-task-dialog').close(); changeTask('/tasks/delete', { id: deleteTarget }); };
$('task-menu').ontoggle = async () => {
  if (!$('task-menu').open) return;
  const list = $('task-list'); list.replaceChildren(el('p', '', '작업 불러오는 중…'));
  try {
    const result = await api('/tasks');
    // Narrow screens have no room for the topbar actions, so the menu carries them there.
    const actions = el('div', 'task-menu-actions'); actions.append(button('새 작업', () => changeTask('/tasks', {})), button('작업 삭제', () => $('delete-task').click()));
    list.replaceChildren(actions, el('p', '', '작업은 자동 저장되어 삭제하기 전까지 남습니다'), ...result.items.map(t => {
      const when = t.createdAt ? ` · ${new Date(t.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
      const row = button(taskName(t) + when, () => changeTask('/tasks', { id: t.id })); row.title = taskName(t);
      if (t.id === result.current) { row.setAttribute('aria-current', 'true'); row.disabled = true; }
      return row;
    }));
  } catch (e) { list.replaceChildren(el('p', '', e.message)); }
};
$('conversation-menu').ontoggle=async()=>{
  if(!$('conversation-menu').open)return;
  if($('conversation-menu').querySelector('summary').getAttribute('aria-disabled')==='true'){$('conversation-menu').open=false;return;}
  const list=$('conversation-list'),engine=state.chat.engine;list.replaceChildren(el('p','','대화 불러오는 중…'));
  try{const result=await api('/conversations');if(engine!==state.chat.engine)return;list.replaceChildren(el('p','','현재 대화는 자동으로 보존됩니다'));for(const item of result.items){const row=button(item.title,()=>changeConversation(item.id));row.title=item.title;list.append(row)}if(!result.items.length)list.append(el('p','','이전 대화가 없습니다'))}catch(e){list.replaceChildren(el('p','',e.message))}
};
$('export-report').onclick = async () => {
  try {
    const clone = $('report').cloneNode(true); clone.hidden = false;
    for (const input of clone.querySelectorAll('input,button')) input.remove();
    const originals = $('report').querySelectorAll('iframe');
    for (const [i, frame] of [...clone.querySelectorAll('iframe')].entries()) {
      if (!originals[i].exportHtml) throw new Error('HTML 로딩 후 다시 저장해 주세요.');
      frame.removeAttribute('src'); frame.srcdoc = originals[i].exportHtml;
    }
    // Embed images; the exported report must not depend on authenticated blob URLs.
    for (const image of clone.querySelectorAll('img')) { const blob = await fetch(image.src).then(r => r.blob()); image.src = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); }
    const css = await fetch('/styles.css').then(r => r.text());
    const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>분석 보고서</title><style>${css}\nhtml,body{height:auto;overflow:auto;background:white}#report{position:static;overflow:visible;border-radius:0}</style>${clone.outerHTML}</html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' })); const a = el('a'); a.href = url; a.download = 'analysis-report.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notice(error); }
};
function resizeComposer(){
  const input=$('prompt');
  // Safari reserves scrollbar space in a one-line textarea unless its content fits explicitly.
  input.style.height='auto';
  const height=Math.max(chatCollapsed()?36:54,Math.min(180,input.scrollHeight));
  input.style.height=height+'px';input.style.overflowY=input.scrollHeight>height?'auto':'hidden';
}
$('prompt').addEventListener('input',resizeComposer);
window.addEventListener('resize',resizeComposer);
function snapshotEditor(){return {items:structuredClone(state.board.items),notes:structuredClone(state.notes.items)};}
function rememberEditor(before){undoStack.push(before);if(undoStack.length>40)undoStack.shift();redoStack.length=0;}
function restoreEditor(from,to){if(gesture||saving||!from.length)return;to.push(snapshotEditor());const prev=from.pop();state.board.items=prev.items;state.notes.items=prev.notes;positions.clear();selectedNodes.clear();interactingId=null;render();save('notes',{items:prev.notes});persistBoard();}
function worldPoint(e){const r=$('canvas').getBoundingClientRect(),v=state.board.viewport;return{x:(e.clientX-r.left-v.x)/v.zoom,y:(e.clientY-r.top-v.y)/v.zoom};}
function setEditorTool(tool){activeTool=tool;interactingId=null;document.body.dataset.tool=tool;document.querySelectorAll('button[data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===tool)));renderEditorPanels();}
function beginCanvasGesture(e){
 if(e.button!==0&&e.button!==1)return;
 if(activeTool==='hand'||spaceHeld||e.button===1){beginGesture(e,'pan');return;}
 e.preventDefault();e.stopPropagation();interactingId=null;const origin=worldPoint(e);
 gesture={type:activeTool==='select'?'marquee':'create',tool:activeTool,origin,end:origin,points:[origin],add:e.shiftKey,x:e.clientX,y:e.clientY,pointer:e.pointerId,before:snapshotEditor()};
 if(!e.shiftKey)selectedNodes.clear();renderEditorPanels();e.currentTarget.setPointerCapture(e.pointerId);
}
function finishCreate(g){
 if(state.notes.items.length>=500){notice('이 작업 공간의 메모 한도에 도달했습니다.');flushPending();return;}
 const a=g.origin,b=g.end||a,small=Math.abs(a.x-b.x)+Math.abs(a.y-b.y)<6;
 const kind=g.tool,id=`note-${crypto.randomUUID()}`,name=({rectangle:'Rectangle',ellipse:'Ellipse',text:'Text',frame:'Frame',note:'Note',draw:'Path'})[kind]||'Note';
 const p={x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:small?200:Math.max(40,Math.abs(b.x-a.x)),h:small?(kind==='text'?70:140):Math.max(40,Math.abs(b.y-a.y)),kind,fill:kind==='note'?'#fff3b7':['text','frame','draw'].includes(kind)?'transparent':'#d9d9d9'};
 if(kind==='draw'){const xs=g.points.map(p=>p.x),ys=g.points.map(p=>p.y);p.x=Math.min(...xs);p.y=Math.min(...ys);p.w=Math.max(40,Math.max(...xs)-p.x);p.h=Math.max(40,Math.max(...ys)-p.y);p.drawW=p.w;p.drawH=p.h;p.points=g.points.map(q=>[q.x-p.x,q.y-p.y]);p.stroke='#a3adff';}
 rememberEditor(g.before);state.notes.items=[...state.notes.items,{id,text:kind==='note'?'메모를 입력하세요':kind==='text'?'텍스트':name}];state.board.items[id]=p;
 selectedNodes.clear();selectedNodes.add(id);setEditorTool('select');render();save('notes',{items:state.notes.items});persistBoard();
 if(kind==='text'||kind==='note'){enterInteraction(id);queueMicrotask(()=>{const t=boardNodes.get(id)?.node.querySelector('textarea');t?.focus();t?.select();});}
}
function enterInteraction(id){if(!boardNodes.has(id))return;selectedNodes.clear();selectedNodes.add(id);setEditorTool('select');interactingId=id;renderEditorPanels();}
function focusEditorSelection(){const list=[...selectedNodes].map(id=>positions.get(id)).filter(p=>p&&!p.hidden);if(!list.length)return;const minX=Math.min(...list.map(p=>p.x)),minY=Math.min(...list.map(p=>p.y)),maxX=Math.max(...list.map(p=>p.x+p.w)),maxY=Math.max(...list.map(p=>p.y+p.h));const r=$('canvas').getBoundingClientRect();const z=Math.min(2.5,Math.max(.1,Math.min((r.width-160)/(maxX-minX),(r.height-180)/(maxY-minY))));state.board.viewport={x:80-minX*z,y:80-minY*z,zoom:z};applyViewport();persistBoard();}
function hideEditorSelection(){if(!selectedNodes.size)return;rememberEditor(snapshotEditor());for(const id of selectedNodes)state.board.items[id]={...positions.get(id),hidden:true};selectedNodes.clear();interactingId=null;render();persistBoard();}
function renderEditorPanels(){
 for(const[id,entry]of boardNodes){entry.node.classList.toggle('selected',selectedNodes.has(id));entry.node.classList.toggle('interacting',interactingId===id);}
 $('interaction-hint').hidden=!interactingId;
 const id=[...selectedNodes][0],p=positions.get(id);$('properties').hidden=!p||view!=='canvas'||Boolean(interactingId);
 if(p){$('property-title').textContent=selectedNodes.size>1?`${selectedNodes.size}개 선택`:p.kind||state.artifacts.find(a=>a.id===id)?.title||'메모';for(const k of ['x','y','w','h'])if(document.activeElement!==$('prop-'+k))$('prop-'+k).value=Math.round(p[k]);$('prop-color').value=/^#[0-9a-f]{6}$/i.test(p.fill||'')?p.fill:'#d9d9d9';$('prop-color').disabled=!p.kind;}
 if($('layers-panel').hidden)return;
 const q=$('layer-filter').value.toLowerCase();$('layer-list').replaceChildren();
 for(const item of [...state.artifacts.map(a=>({id:a.id,name:a.title||a.id})),...state.notes.items.map(n=>({id:n.id,name:n.text||'Note'}))]){if(!item.name.toLowerCase().includes(q))continue;const row=el('div','layer-row');row.classList.toggle('active',selectedNodes.has(item.id));row.classList.toggle('muted',Boolean(positions.get(item.id)?.hidden));const pick=button(item.name,()=>{selectedNodes.clear();selectedNodes.add(item.id);interactingId=null;renderEditorPanels();});pick.ondblclick=focusEditorSelection;const visibility=button(positions.get(item.id)?.hidden?'○':'●',()=>{rememberEditor(snapshotEditor());state.board.items[item.id]={...positions.get(item.id),hidden:!positions.get(item.id)?.hidden};render();persistBoard();});visibility.className='visibility';visibility.setAttribute('aria-label',item.name+' 표시 전환');row.append(pick,visibility);$('layer-list').append(row);}
}
function openLayerPanel(){setChatCollapsed(true);$('layers-panel').hidden=false;renderEditorPanels();}
for(const b of document.querySelectorAll('button[data-tool]'))b.onclick=()=>setEditorTool(b.dataset.tool);
$('show-layers').onclick=()=>{$('layers-panel').hidden?openLayerPanel():$('layers-panel').hidden=true;};
$('layer-tab').onclick=openLayerPanel;$('close-layers').onclick=()=>{$('layers-panel').hidden=true;};
$('find-layers').onclick=()=>{openLayerPanel();$('layer-filter').focus();};$('layer-filter').oninput=renderEditorPanels;
$('close-properties').onclick=()=>{selectedNodes.clear();interactingId=null;renderEditorPanels();};
$('exit-interaction').onclick=()=>{interactingId=null;renderEditorPanels();$('canvas').focus();};
$('selection-fit').onclick=focusEditorSelection;$('interact').onclick=()=>{const id=[...selectedNodes][0];if(id)enterInteraction(id)};
$('hide-selection').onclick=hideEditorSelection;
$('selection-chat').onclick=()=>{const artifact=state.artifacts.find(a=>selectedNodes.has(a.id));if(artifact)choose(artifact);else notice('메모·도형은 레이어에서 직접 편집할 수 있습니다.');};
for(const k of ['x','y','w','h'])$('prop-'+k).onchange=()=>{const v=Number($('prop-'+k).value);if(!Number.isFinite(v)||Math.abs(v)>1000000||(['w','h'].includes(k)&&v<40)){renderEditorPanels();return;}rememberEditor(snapshotEditor());for(const id of selectedNodes)state.board.items[id]={...positions.get(id),[k]:v};render();persistBoard();};
$('prop-color').onchange=()=>{rememberEditor(snapshotEditor());for(const id of selectedNodes){const p=positions.get(id);if(p?.kind)state.board.items[id]={...p,[p.kind==='draw'?'stroke':'fill']:$('prop-color').value};}render();persistBoard();};
$('zoom-reset').onclick=()=>{const r=$('canvas').getBoundingClientRect();zoom(1/state.board.viewport.zoom,r.width/2,r.height/2);persistBoard();};
for(const id of ['open-refs','attach-reference'])$(id).onclick=()=>{$('layers-panel').hidden=true;setChatCollapsed(false);setPanel('refs');};
$('theme-toggle').onclick=()=>{document.body.classList.toggle('light');try{localStorage.setItem('canvas-theme',document.body.classList.contains('light')?'light':'dark')}catch{}};
try{document.body.classList.toggle('light',localStorage.getItem('canvas-theme')==='light')}catch{}
$('presentation').onclick=()=>{document.body.classList.toggle('presenting');selectedNodes.clear();interactingId=null;renderEditorPanels();};
$('keyboard-help').onclick=()=>notice('V 선택 · H / Space 이동 · R 사각형 · O 타원 · P 그리기 · T 텍스트 · F 프레임 · N 메모 · Shift+1 전체 보기 · Shift+2 선택 보기 · Delete 숨기기 · Ctrl/⌘ Z 실행 취소 · Esc 콘텐츠 조작 종료');
window.addEventListener('keydown',e=>{
 if($('delete-task-dialog').open)return;
 const typing=e.target.closest('input,textarea,select,[contenteditable=true]');
 if(e.key==='Escape'){document.body.classList.remove('presenting');interactingId=null;selectedNodes.clear();$('tools').open=false;renderEditorPanels();return;}
 if(typing||view!=='canvas')return;
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();restoreEditor(e.shiftKey?redoStack:undoStack,e.shiftKey?undoStack:redoStack);return;}
 if(e.code==='Space'){e.preventDefault();spaceHeld=true;document.body.classList.add('space-pan');return;}
 if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();hideEditorSelection();return;}
 if(e.shiftKey&&e.code==='Digit1'){e.preventDefault();$('fit').click();return;}if(e.shiftKey&&e.code==='Digit2'){e.preventDefault();focusEditorSelection();return;}
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 const tools={v:'select',h:'hand',r:'rectangle',o:'ellipse',p:'draw',t:'text',f:'frame',n:'note'};if(tools[e.key.toLowerCase()]){e.preventDefault();setEditorTool(tools[e.key.toLowerCase()]);}
});
window.addEventListener('keyup',e=>{if(e.code==='Space'){spaceHeld=false;document.body.classList.remove('space-pan')}});
window.addEventListener('blur',()=>{spaceHeld=false;document.body.classList.remove('space-pan');if(gesture)endGesture();});
// Lucide icons, matching the installed lucide-react 0.468.0 set.
const iconParts={
 ChevronDown:'<path d="m6 9 6 6 6-6"/>',LayoutGrid:'<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
 Images:'<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>',
 SunMoon:'<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2M12 20v2m-7.1-17.1 1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
 Layers:'<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
 Play:'<polygon points="6 3 20 12 6 21 6 3"/>',PanelLeft:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
 MousePointer2:'<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',Square:'<rect width="18" height="18" x="3" y="3" rx="2"/>',Circle:'<circle cx="12" cy="12" r="10"/>',
 PenTool:'<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18m-10.7-15.7 7.286 7.286"/><circle cx="11" cy="11" r="2"/>',
 Type:'<polyline points="4 7 4 4 20 4 20 7"/><path d="M9 20h6M12 4v16"/>',Frame:'<path d="M22 6H2m20 12H2M6 2v20M18 2v20"/>',StickyNote:'<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
 Hand:'<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
 Search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',Trash2:'<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/>',MessageSquare:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',Plus:'<path d="M5 12h14M12 5v14"/>',ArrowUp:'<path d="m5 12 7-7 7 7M12 19V5"/>'
};
for(const n of document.querySelectorAll('[data-icon]'))n.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconParts[n.dataset.icon]||''}</svg>`;
setEditorTool('hand');
async function events() {
  streamController = new AbortController();
  const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` }, signal: streamController.signal });
  if (!response.ok) throw new Error(`실시간 연결 실패 (${response.status})`);
  $('connection').textContent = '● 연결됨';
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) throw new Error('서버 연결이 종료됐습니다. 서버를 확인한 뒤 새로고침해 주세요.');
    buffer += decoder.decode(value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.length > 8_000_000) throw new Error('실시간 메시지가 너무 큽니다.');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); let type = 'message'; const data = [];
      for (const line of block.split('\n')) { if (line.startsWith('event:')) type = line.slice(6).trim(); if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
      if (!data.length) continue;
      try { const payload = JSON.parse(data.join('\n')); if (type === 'state') receive(payload); else if (type === 'delta') { if(payload.reset){liveText='';$('live-message')?.remove();continue;} liveText += payload.text || ''; let live = $('live-message'); if (!live) { live = el('div', 'message live'); live.id = 'live-message'; $('messages').append(live); } live.textContent = liveText; if (chatCollapsed()) $('dock-status').textContent = `${state.chat.engine==='pi'?'Pi':'Codex'} · 분석 중 — ${liveText.slice(-80)}`; $('messages').scrollTop = $('messages').scrollHeight; } else if (type === 'error') notice(payload.message); } catch (error) { notice(error); }
    }
  }
}
window.addEventListener('pagehide', () => streamController?.abort());
// Reopening a restarted server's capability URL can otherwise be a hash-only navigation in Safari.
window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).has('token')) location.reload(); });
if (!token) { $('connection').textContent = '접속 주소 필요'; notice('서버가 출력한 #token=… 주소로 접속해 주세요.'); }
else api('/state').then(next => { receive(next); return events(); }).catch(error => { $('connection').textContent = '연결 끊김'; notice(error); });
