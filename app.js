/* VERIF-IMMO — interface. Tout est traité localement dans le navigateur. */
(function () {
  'use strict';
  const VERSION = '2.9';
  const APPNAME = 'VERIF-IMMO';
  const E = window.VIEngine;
  const STORE_KEY = 'verifimmo.v1';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => (n == null || n === '' || isNaN(n)) ? '' : Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });
  const fmtQ = (q, u) => u === 'm' ? fmt(q) + ' m' : fmt(q, 0);
  const nowStr = () => new Date().toLocaleString('fr-FR');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  $('#ver').textContent = 'Ver.' + VERSION;

  // ---------------- Sauvegarde ----------------
  let db = { affaires: [] };
  let storageOk = true;
  function load() {
    try { const s = localStorage.getItem(STORE_KEY); if (s) db = JSON.parse(s); } catch (e) { storageOk = false; }
    if (!db || !Array.isArray(db.affaires)) db = { affaires: [] };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); storageOk = true; }
    catch (e) { storageOk = false; toast("Sauvegarde dans le navigateur impossible : pensez à exporter l'affaire (fichier)."); }
  }
  load();

  // ---------------- État d'affichage ----------------
  const ui = { view: 'home', id: null, tab: 'fichiers', filter: null, ocr: null };
  const cur = () => db.affaires.find(a => a.id === ui.id);
  function touch(a) { a.updated = new Date().toISOString(); save(); }
  function newAffaire() {
    const a = { id: uid(), nom: 'Nouvelle affaire', created: new Date().toISOString(), updated: new Date().toISOString(),
      pose: null, depose: null, eotps: [], eotpVerified: true, forces: {}, choices: { ab: {}, split22: {} }, pdrManual: [], autoName: true };
    db.affaires.push(a); save();
    ui.view = 'affaire'; ui.id = a.id; ui.tab = 'fichiers'; ui.filter = null; render();
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ---------------- Modale générique ----------------
  function modal(html, onReady) {
    const m = $('#modal'); m.innerHTML = '<div class="mbox">' + html + '</div>'; m.hidden = false;
    m.onclick = e => { if (e.target === m) closeModal(); };
    if (onReady) onReady(m);
  }
  function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
  function confirmBox(msg, onYes, yesLabel = 'Confirmer') {
    modal(`<h2>Confirmation</h2><p>${esc(msg)}</p><div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn sec" id="mNo">Annuler</button><button class="btn danger" id="mYes">${esc(yesLabel)}</button></div>`, m => {
      m.querySelector('#mNo').onclick = closeModal;
      m.querySelector('#mYes').onclick = () => { closeModal(); onYes(); };
    });
  }

  // ---------------- Forçage ----------------
  // spec : { key, label, auto, type:'select'|'number'|'text'|'bool', options:[[val,label]] }
  function forceDialog(spec) {
    const a = cur(); const f = a.forces[spec.key];
    const curVal = f ? f.value : spec.auto;
    const autoDisp = spec.type === 'bool' ? (spec.auto ? 'Oui' : 'Non') : (spec.auto === '' || spec.auto == null ? '(vide / automatique)' : spec.auto);
    let field;
    if (spec.type === 'select' || spec.type === 'bool') {
      const opts = spec.type === 'bool' ? [[true, 'Oui'], [false, 'Non']] : spec.options;
      field = `<select class="t" id="fv">${opts.map(([v, l]) => `<option value="${esc(JSON.stringify(v))}" ${JSON.stringify(v) === JSON.stringify(curVal) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      if (spec.free) field += `<label>… ou saisir une valeur</label><input class="t" id="fvfree" placeholder="ex : RV4-0000000-1-C1-22-I01">`;
    } else {
      field = `<input class="t" id="fv" type="text" ${spec.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(spec.type === 'number' && curVal != null && curVal !== '' ? String(curVal).replace('.', ',') : (curVal ?? ''))}">`;
    }
    modal(`<h2>Forcer une valeur</h2>
      <p class="small muted">${esc(spec.label)}</p>
      <p class="small">Valeur calculée par l'appli : <b>${esc(autoDisp)}</b></p>
      <label>Nouvelle valeur</label>${field}
      <label>Commentaire (facultatif, apparaît dans la trace et l'export)</label>
      <input class="t" id="fc" value="${esc(f ? f.comment : '')}" placeholder="ex : carto erronée, vu avec la carto le ${new Date().toLocaleDateString('fr-FR')}">
      <div class="row" style="justify-content:space-between;margin-top:16px">
        <button class="btn sec" id="fReset" ${f ? '' : 'disabled'}>Revenir à l'automatique</button>
        <span class="row"><button class="btn sec" id="fCancel">Annuler</button><button class="btn" id="fOk">Forcer</button></span>
      </div>`, m => {
      m.querySelector('#fCancel').onclick = closeModal;
      m.querySelector('#fReset').onclick = () => { delete a.forces[spec.key]; touch(a); closeModal(); render(); };
      m.querySelector('#fOk').onclick = () => {
        let v;
        const el = m.querySelector('#fv');
        const free = m.querySelector('#fvfree');
        if (free && free.value.trim()) v = free.value.trim().toUpperCase();
        else if (spec.type === 'select' || spec.type === 'bool') v = JSON.parse(el.value);
        else if (spec.type === 'number') { v = parseFloat(String(el.value).replace(',', '.')); if (!isFinite(v)) { toast('Valeur numérique attendue'); return; } }
        else v = el.value.trim();
        const comment = m.querySelector('#fc').value.trim();
        if (JSON.stringify(v) === JSON.stringify(spec.auto) && !comment) { delete a.forces[spec.key]; touch(a); closeModal(); render(); return; }
        a.forces[spec.key] = { value: v, comment: m.querySelector('#fc').value.trim(), date: nowStr(), label: spec.label, auto: autoDisp };
        touch(a); closeModal(); render();
      };
    });
  }
  const isForced = key => { const a = cur(); return !!(a && a.forces[key]); };
  // affiche une valeur avec son bouton de forçage
  function fcell(key, disp, autoDisp) {
    const forced = isForced(key);
    return `<span class="cell">${forced ? `<span class="forced" title="Valeur forcée (auto : ${esc(autoDisp)})">${esc(disp)}</span>` : esc(disp)}<button class="fbtn" data-force="${esc(key)}" title="Forcer cette valeur">✎</button></span>`;
  }
  let forceSpecs = {}; // clé -> spec, reconstruit à chaque rendu

  // ---------------- Lecture des fichiers carto ----------------
  function readCarto(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellDates: false, bookVBA: false });
          let parsed = null, lastErr = null;
          const names = wb.SheetNames.slice().sort((x, y) => (/canalisation/i.test(y) ? 1 : 0) - (/canalisation/i.test(x) ? 1 : 0));
          for (const n of names) {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
            try { parsed = E.parseCarto(rows, file.name); parsed.sheet = n; break; } catch (e) { lastErr = e; }
          }
          if (!parsed) throw lastErr || new Error('Aucune feuille exploitable');
          res(parsed);
        } catch (e) { rej(e); }
      };
      fr.onerror = () => rej(fr.error);
      fr.readAsArrayBuffer(file);
    });
  }
  async function handleCartoFiles(files) {
    const a = cur();
    for (const f of files) {
      if (!/\.(xlsx|xlsm|xls)$/i.test(f.name)) { toast(`${f.name} : format non pris en charge (xlsx, xlsm, xls)`); continue; }
      try {
        const p = await readCarto(f);
        p.loaded = nowStr();
        a[p.kind] = p;
        if (a.autoName && p.affaireCode) {
          const after = f.name.replace(/\.[^.]+$/, '').split(p.affaireCode)[1] || '';
          a.nom = (p.affaireCode + ' ' + after.replace(/_/g, ' ')).trim();
        }
        toast(`${f.name} : ${p.lines.length} lignes lues (${p.kind === 'pose' ? 'POSE' : 'DÉPOSE'})`);
      } catch (e) { toast(`${f.name} : ${e.message}`); }
    }
    touch(a); render();
  }

  // ---------------- Lecture des captures SAP (OCR local) ----------------
  let worker = null;
  async function getWorker(progress) {
    if (worker) return worker;
    const base = new URL('vendor/tesseract/', location.href).href;
    worker = await Tesseract.createWorker('fra', 1, {
      workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang/', gzip: true,
      logger: m => { if (progress && m.progress != null) progress(m.status, m.progress); }
    });
    return worker;
  }
  function preprocess(img) {
    const s = Math.max(1, Math.min(3, 4200 / img.naturalWidth));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
    let mn = 255, mx = 0;
    for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = g; if (g < mn) mn = g; if (g > mx) mx = g; }
    const k = mx > mn ? 255 / (mx - mn) : 1;
    for (let i = 0; i < p.length; i += 4) { const g = (p[i] - mn) * k; p[i] = p[i + 1] = p[i + 2] = g; }
    x.putImageData(d, 0, 0);
    return c;
  }
  function loadImg(file) {
    return new Promise((res, rej) => { const u = URL.createObjectURL(file); const i = new Image(); i.onload = () => res({ img: i, url: u }); i.onerror = rej; i.src = u; });
  }
  async function handleImages(files, target = 'eotp') {
    const a = cur();
    const imgs = [...files].filter(f => /^image\//.test(f.type));
    if (!imgs.length) { toast('Aucune image reconnue'); return; }
    ui.ocr = { status: 'Préparation de la lecture…', p: 0, thumbs: [], target };
    render();
    try {
      const w = await getWorker((st, p) => { if (ui.ocr) { ui.ocr.status = st === 'recognizing text' ? 'Lecture du texte…' : 'Chargement du moteur de lecture…'; ui.ocr.p = p; updOcr(); } });
      let added = 0;
      for (let i = 0; i < imgs.length; i++) {
        const { img, url } = await loadImg(imgs[i]);
        ui.ocr.thumbs.push(url); ui.ocr.status = `Lecture de la capture ${i + 1}/${imgs.length}…`; render();
        const { data } = await w.recognize(preprocess(img));
        if (target === 'orc') {
          const o = E.parseOrcText(data.text);
          a.orc = a.orc || { eotpRows: [], deposeRows: [] };
          const sig = r => JSON.stringify([r.eotp, r.mat, r.IN, r.annee, r.prev, r.reel, r.designation]);
          for (const r of o.eotpRows) if (!a.orc.eotpRows.some(x => x.eotp === r.eotp)) { a.orc.eotpRows.push(r); added++; }
          for (const r of o.deposeRows) if (!a.orc.deposeRows.some(x => sig(x) === sig(r))) { a.orc.deposeRows.push(r); added++; }
          // les EOTP de l'écran ORC complètent la liste des EOTP si besoin
          for (const r of o.eotpRows.concat(o.deposeRows)) if (!a.eotps.some(e => e.code === r.eotp)) { a.eotps.push({ code: r.eotp, designation: r.designation || '', src: 'ORC' }); }
        } else {
          const rows = E.parseOcrText(data.text);
          for (const r of rows) {
            if (a.eotps.some(e => e.code === r.code)) continue;
            a.eotps.push({ code: r.code, designation: r.designation, src: 'capture' }); added++;
          }
        }
      }
      if (target === 'orc') a.orcVerified = false; else a.eotpVerified = false;
      ui.ocr = null; touch(a); render();
      toast(target === 'orc' ? `${added} ligne(s) lue(s) sur l'écran ORC. Vérifiez puis cochez « Écran ORC vérifié ».` : `${added} EOTP ajouté(s). Vérifiez la liste puis cochez « Liste vérifiée ».`);
    } catch (e) {
      console.error(e); ui.ocr = null; render(); toast('Lecture impossible : ' + e.message);
    }
  }
  function updOcr() { const b = document.querySelector('#ocrbar'); const s = document.querySelector('#ocrst'); if (b && ui.ocr) b.style.width = Math.round(ui.ocr.p * 100) + '%'; if (s && ui.ocr) s.textContent = ui.ocr.status; }
  function sortEotps(list) {
    return list.slice().sort((x, y) => x.code.localeCompare(y.code, 'fr', { numeric: true }));
  }

  // ---------------- Rendu ----------------
  function render() {
    forceSpecs = {};
    const main = $('#main');
    main.classList.toggle('wide', ui.view === 'affaire' && ui.tab === 'troncons');
    if (ui.view === 'help') main.innerHTML = renderHelp();
    else if (ui.view === 'affaire' && cur()) main.innerHTML = renderAffaire();
    else { ui.view = 'home'; main.innerHTML = renderHome(); }
    bind();
  }

  function renderHome() {
    const list = db.affaires.slice().sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const items = list.map(a => {
      let v = null; try { v = (a.pose || a.depose) ? E.compute(a).verdict : null; } catch (e) { }
      const badge = v ? `<span class="badge ${v === 'VALIDATION OK' ? 'ok' : 'ko'}">${esc(v)}</span>` : '<span class="badge na">à compléter</span>';
      return `<div class="it"><span class="nm grow" data-open="${a.id}">${esc(a.nom)}</span>${badge}
        <span class="small muted">modifiée le ${esc(new Date(a.updated).toLocaleString('fr-FR'))}</span>
        <button class="btn sm sec" data-open="${a.id}">Ouvrir</button>
        <button class="btn sm sec" data-exp="${a.id}">Exporter</button>
        <button class="btn sm danger" data-del="${a.id}">Supprimer</button></div>`;
    }).join('');
    return `<h1>Mes affaires</h1>
      ${storageOk ? '' : '<div class="ctl orange"><span class="lv">Attention</span><span>La sauvegarde du navigateur est indisponible (navigation privée ?). Exportez vos affaires en fichier.</span></div>'}
      <div class="card"><div class="row">
        <button class="btn" id="newAff">+ Nouvelle affaire</button>
        <label class="btn sec" style="cursor:pointer">Importer une affaire (.json)<input type="file" id="impAff" accept=".json,application/json" hidden></label>
      </div>
      <p class="small muted" style="margin-top:10px">Les affaires sont enregistrées dans ce navigateur, sur cet appareil uniquement. Utilisez « Exporter » pour les mettre en sécurité, les passer du PC au téléphone ou les transmettre à un autre CA.</p></div>
      <div class="alist">${items || '<p class="muted">Aucune affaire pour l\'instant.</p>'}</div>`;
  }

  function tabDot(level) { const c = { rouge: 'var(--red)', orange: 'var(--orange)', ok: 'var(--green)' }[level]; return c ? `<span class="dot" style="background:${c}"></span>` : ''; }

  function renderAffaire() {
    const a = cur();
    let R = null, err = null;
    try { R = E.compute(a); } catch (e) { err = e; console.error(e); }
    ui.R = R;
    const lv = c => R && R.controls.some(x => x.level === c);
    const tabs = [
      ['fichiers', '1. Fichiers carto', (a.pose && a.depose) ? 'ok' : 'rouge'],
      ['eotp', '2. Captures SAP', a.eotps.length ? ((a.eotpVerified !== false && a.orcVerified !== false) ? 'ok' : 'orange') : 'rouge'],
      ['resultat', '3. Résultat', R ? (lv('rouge') ? 'rouge' : lv('orange') ? 'orange' : 'ok') : ''],
      ['troncons', '4. Tronçons', R && R.controls.some(c => c.level === 'orange' && /AB/.test(c.msg)) ? 'orange' : ''],
      ['export', '5. Forçages & export', '']
    ];
    let body = '';
    if (err) body = `<div class="ctl rouge"><span class="lv">Erreur</span><span>${esc(err.message)}</span></div>`;
    else if (ui.tab === 'fichiers') body = renderFichiers(a);
    else if (ui.tab === 'eotp') body = renderEotp(a);
    else if (ui.tab === 'resultat') body = renderResultat(a, R);
    else if (ui.tab === 'troncons') body = renderTroncons(a, R);
    else body = renderExport(a, R);
    return `<div class="row"><input class="t grow" id="affName" value="${esc(a.nom)}" style="font-size:18px;font-weight:600;max-width:700px" title="Nom de l'affaire"></div>
      <div class="tabs">${tabs.map(([k, l, d]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-tab="${k}">${l}${tabDot(d)}</button>`).join('')}</div>
      ${body}`;
  }

  // ----- 1. Fichiers -----
  function fileCard(p, kind) {
    if (!p) return `<div class="filecard"><span class="tag ${kind}">${kind === 'pose' ? 'POSE' : 'DÉPOSE'}</span> <span class="muted">aucun fichier</span></div>`;
    return `<div class="filecard"><span class="tag ${kind}">${kind === 'pose' ? 'POSE' : 'DÉPOSE'}</span>
      <b style="margin-left:6px;word-break:break-all">${esc(p.fileName)}</b>
      <div class="small muted">${p.lines.length} lignes · feuille « ${esc(p.sheet || 'G Canalisation')} » · chargé le ${esc(p.loaded || '')}</div>
      <div class="row" style="margin-top:6px"><button class="btn sm sec" data-swap="1">Inverser pose / dépose</button><button class="btn sm danger" data-rmfile="${kind}">Retirer</button></div></div>`;
  }
  function renderFichiers(a) {
    return `<div class="card"><h2>Fichiers carto « G Canalisation »</h2>
      <p class="muted small">Glissez ici les deux fichiers Excel envoyés par la carto (pose et dépose), sans les ouvrir. L'appli reconnaît la pose et la dépose d'après le nom du fichier (IMMO_POSE / IMMO_DEPOSE) ou son contenu.</p>
      <label class="drop" id="dropCarto"><b>Déposer les fichiers .xlsm / .xlsx ici</b><br><span class="small">ou cliquer pour les choisir</span>
        <input type="file" id="inCarto" accept=".xlsx,.xlsm,.xls" multiple hidden></label>
      <div class="row" style="margin-top:12px;align-items:stretch">${fileCard(a.pose, 'pose')}${fileCard(a.depose, 'depose')}</div></div>
      ${(a.pose && a.depose) ? `<div class="row"><button class="btn" data-tab="eotp">Étape suivante : EOTP SAP →</button></div>` : ''}`;
  }

  // ----- 2. EOTP -----
  function renderEotp(a) {
    const rows = a.eotps.map((e, i) => {
      const p = E.parseEotpCode(e.code);
      const bad = !p;
      return `<tr class="${bad ? 'hl' : ''}"><td><input class="t" style="min-width:230px" data-eotp-code="${i}" value="${esc(e.code)}"></td>
        <td class="wrap"><input class="t" style="min-width:240px" data-eotp-des="${i}" value="${esc(e.designation || '')}"></td>
        <td>${p ? (p.elem ? 'Élément' : p.cp ? 'Niveau CP' : p.chantier ? 'Chantier' : 'Projet') : '<span class="pill none">code invalide</span>'}</td>
        <td>${p && p.cp ? esc(p.cp) : ''}</td>
        <td class="cell"><button class="btn sm sec" data-eotp-ins="${i}" title="Insérer une ligne en dessous">+</button><button class="btn sm sec" data-eotp-up="${i}" title="Monter" ${i ? '' : 'disabled'}>↑</button><button class="btn sm sec" data-eotp-dn="${i}" title="Descendre" ${i < a.eotps.length - 1 ? '' : 'disabled'}>↓</button><button class="btn sm danger" data-eotp-del="${i}" title="Supprimer">✕</button></td></tr>`;
    }).join('');
    const ocr = ui.ocr ? `<div class="card"><b>${ui.ocr.target === 'orc' ? 'Écran ORC' : 'Structure du projet'}</b> — <b id="ocrst">${esc(ui.ocr.status)}</b><div class="prog"><i id="ocrbar" style="width:${Math.round(ui.ocr.p * 100)}%"></i></div>
      <div class="thumbs">${ui.ocr.thumbs.map(u => `<img src="${u}" alt="capture">`).join('')}</div>
      <p class="small muted">La première lecture charge le moteur (quelques secondes). Tout se passe sur cet appareil.</p></div>` : '';
    return `<div class="row" style="margin-bottom:12px;align-items:center"><span class="grow small muted">Une seule des deux captures suffit pour obtenir le résultat ; les deux donnent le contrôle le plus complet.</span>
        <button class="btn" data-tab="resultat">Voir le résultat →</button></div>
      <div class="card"><h2>Capture 1 — Structure du projet (« Donn. base ») <span class="small muted">(au choix)</span></h2>
      <label class="drop" id="dropImg" data-paste="eotp"><b>Déposer / coller les captures d'écran ici</b><br><span class="small">ou cliquer pour choisir (photos sur téléphone)</span>
        <input type="file" id="inImg" accept="image/*" multiple hidden></label></div>
      ${ocr}
      <div class="card"><div class="row"><h2 class="grow" style="margin:0">Vérification (${a.eotps.length} lignes)</h2>
        <button class="btn sm sec" id="eotpAdd">+ Ajouter une ligne</button>
        ${a.eotps.length ? '<button class="btn sm danger" id="eotpClear">Vider la liste</button>' : ''}</div>
      <p class="small muted">Les lignes sont dans le même ordre que dans SAP. Comparez chaque ligne avec l'écran SAP et corrigez si besoin (+ insère une ligne en dessous, ↑ ↓ déplacent). Les EOTP sont toujours écrits en entier (ex : RV4-0000000-1-C1-22-I01).</p>
      ${a.eotps.length ? `<div class="tw"><table><thead><tr><th>Élément d'OTP</th><th>Désignation</th><th>Niveau</th><th>CP</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <label class="row" style="margin-top:12px;font-weight:600;cursor:pointer"><input type="checkbox" id="eotpOk" ${a.eotpVerified ? 'checked' : ''} style="width:20px;height:20px"> Liste vérifiée par rapport à SAP</label>` : '<p class="muted">Aucun EOTP pour l\'instant.</p>'}
      </div>${renderOrcInput(a)}<div class="row"><button class="btn" data-tab="resultat">Voir le résultat →</button></div>`;
  }

  // ----- 2 bis. Écran ORC -----
  function renderOrcInput(a) {
    const o = a.orc || { eotpRows: [], deposeRows: [] };
    const inp = (t, i, f, v, w) => `<input class="t" style="min-width:${w || 60}px" data-orc="${t}:${i}:${f}" value="${esc(v ?? '')}">`;
    const t1 = o.eotpRows.map((r, i) => `<tr><td>${inp('e', i, 'eotp', r.eotp, 220)}</td><td>${inp('e', i, 'prev', fmt(r.prev))}</td><td>${inp('e', i, 'reel', fmt(r.reel))}</td><td>${esc(r.unit)}</td><td>${inp('e', i, 'nat', r.nat)}</td><td><button class="btn sm danger" data-orcdel="e:${i}">✕</button></td></tr>`).join('');
    const t2 = o.deposeRows.map((r, i) => `<tr><td>${inp('d', i, 'eotp', r.eotp, 220)}</td><td>${inp('d', i, 'nat', r.nat)}</td><td>${inp('d', i, 'designation', r.designation, 200)}</td><td>${inp('d', i, 'mat', r.mat, 45)}</td><td>${inp('d', i, 'IN', r.IN, 50)}</td><td>${inp('d', i, 'annee', r.annee, 60)}</td><td>${inp('d', i, 'prev', fmt(r.prev))}</td><td>${inp('d', i, 'reel', fmt(r.reel))}</td><td>${esc(r.unit)}</td><td><button class="btn sm danger" data-orcdel="d:${i}">✕</button></td></tr>`).join('');
    const has = o.eotpRows.length || o.deposeRows.length;
    return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Capture 2 — Écran ORC « Dépose des immobilisations » <span class="small muted">(au choix)</span></h2>
        ${has ? '<button class="btn sm danger" id="orcClear">Vider</button>' : ''}</div>
      <p class="small muted">Capture des deux tableaux « Description technique des EOTP » et « Dépose ». L'appli compare ensuite les quantités réelles saisies dans SAP avec sa proposition (onglet Résultat).</p>
      <label class="drop" id="dropOrc" data-paste="orc"><b>Déposer / coller la capture de l'écran ORC ici</b><br><span class="small">ou cliquer pour choisir</span>
        <input type="file" id="inOrc" accept="image/*" multiple hidden></label>
      ${has ? `<h3>Description technique des EOTP (pose)</h3><div class="tw"><table><thead><tr><th>Élément d'OTP</th><th>Qté prév.</th><th>Qté réelle</th><th>Unité</th><th>Nat. ouvr.</th><th></th></tr></thead><tbody>${t1 || '<tr><td colspan="6" class="muted">—</td></tr>'}</tbody></table></div>
      <h3>Dépose</h3><div class="tw"><table><thead><tr><th>Élément d'OTP</th><th>Nat. ouvr.</th><th>Désignation</th><th>Mat.</th><th>IN</th><th>Année</th><th>Qté prév.</th><th>Qté réelle</th><th>Unité</th><th></th></tr></thead><tbody>${t2 || '<tr><td colspan="10" class="muted">—</td></tr>'}</tbody></table></div>
      <label class="row" style="margin-top:12px;font-weight:600;cursor:pointer"><input type="checkbox" id="orcOk" ${a.orcVerified ? 'checked' : ''} style="width:20px;height:20px"> Écran ORC vérifié par rapport à SAP</label>` : ''}</div>`;
  }
  function renderOrcCompare(R) {
    if (!R.orc) return '';
    const st = x => x.absent ? '<span class="pill none">absent de l\'écran ORC</span>' : x.ok ? '<span class="pill" style="background:var(--green-l);color:#2f6b10">identique</span>' : '<span class="pill" style="background:var(--orange-l);color:var(--orange)">différent</span>';
    const u = x => x.unit === 'M' ? ' m' : '';
    const p = R.orc.pose.map(x => `<tr><td>${esc(x.eotp)}</td><td>${esc(x.nat || '')}</td><td class="num">${x.prev == null ? '—' : fmt(x.prev) + u(x)}</td><td class="num">${x.reel == null ? '—' : fmt(x.reel) + u(x)}</td><td class="num"><b>${fmt(x.app)}${u(x)}</b></td><td>${st(x)}</td></tr>`).join('');
    const d = R.orc.depose.map(x => `<tr><td>${esc(x.eotp)}</td><td class="wrap">${esc(x.designation || '')}</td><td>${esc(x.mat || '')}</td><td>${esc(x.IN || '')}</td><td>${esc(x.annee || '')}</td><td class="num">${x.prev == null ? '—' : fmt(x.prev) + u(x)}</td><td class="num">${x.reel == null ? '—' : fmt(x.reel) + u(x)}</td><td class="num"><b>${fmt(x.app)}${u(x)}</b></td><td>${st(x)}</td></tr>`).join('');
    return `<div class="card"><h2>Comparaison avec l'écran ORC</h2>
      <p class="small muted">« Qté réelle SAP » = ce qui est saisi dans SAP ; « Proposition » = ce que calcule l'appli à partir de la carto (mètres arrondis au-dessus). INSEE non comparé (la carto donne l'arrondissement, SAP la commune).</p>
      <h3>Pose par EOTP</h3><div class="tw"><table><thead><tr><th>EOTP</th><th>Nat. ouvr.</th><th class="num">Qté prév.</th><th class="num">Qté réelle SAP</th><th class="num">Proposition</th><th>Statut</th></tr></thead><tbody>${p || '<tr><td colspan="6" class="muted">—</td></tr>'}</tbody></table></div>
      <h3>Dépose / abandon</h3><div class="tw"><table><thead><tr><th>EOTP</th><th>Désignation</th><th>Mat.</th><th>IN</th><th>Année</th><th class="num">Qté prév.</th><th class="num">Qté réelle SAP</th><th class="num">Proposition</th><th>Statut</th></tr></thead><tbody>${d || '<tr><td colspan="9" class="muted">—</td></tr>'}</tbody></table></div></div>`;
  }

  // ----- 3. Résultat -----
  const CPCLS = cp => cp === '23' || cp === '18' ? 'c23' : cp === 'AB' ? 'cab' : cp ? 'c22' : 'none';
  function eotpOptions(R) { return [['', '(automatique)']].concat(R.elements.map(e => [e.code, e.code + ' — ' + (e.designation || '')])); }

  function renderSchema(R) {
    if (!R.pools.length) return '<p class="muted">Chargez les fichiers carto pour voir le schéma.</p>';
    const W = 340, bh = 26;
    const C = { c23: getCss('--c23'), c22: getCss('--c22'), cab: getCss('--cab'), pend: getCss('--cpend'), cbr: getCss('--cbr') };
    const cards = R.pools.map(p => {
      let dep, pos, unit = p.unit === 'm' ? ' m' : '';
      if (p.kind === 'RES') {
        dep = [
          { v: p.R23dep ?? p.R23, c: C.c23, l: 'CP 23 renouv.', f: { kind: 'depose', type: 'RES', tub: true } },
          { v: p.AB23 - Math.max(0, p.s23.rest), c: C.cab, l: 'AB', f: { kind: 'depose', type: 'RES', tub: true, ab: true } },
          { v: Math.max(0, p.s23.rest), c: C.pend, l: 'AB à choisir', f: { kind: 'depose', type: 'RES', tub: true } },
          { v: p.R22dep ?? p.R22, c: C.c22, l: 'CP 22 renouv.', f: { kind: 'depose', type: 'RES', tub: false } },
          { v: p.AB22 - Math.max(0, p.s22.rest), c: C.cab, l: 'AB', f: { kind: 'depose', type: 'RES', tub: false, ab: true } },
          { v: Math.max(0, p.s22.rest), c: C.pend, l: 'AB à choisir', f: { kind: 'depose', type: 'RES', tub: false } }];
        pos = [
          { v: p.R23, c: C.c23, l: 'CP 23 tubage', f: { kind: 'pose', type: 'RES', tub: true } },
          { v: p.surplusTub, c: C.c22, l: 'surplus tubage → CP 22', f: { kind: 'pose', type: 'RES', tub: true } },
          { v: p.P22 - p.surplusTub, c: C.c22, l: 'CP 22', f: { kind: 'pose', type: 'RES', tub: false } }];
      } else {
        const pend = Math.max(0, p.AB - p.chosen);
        dep = [{ v: p.D - p.AB, c: C.cbr, l: 'renouv.', f: { kind: 'depose', type: p.kind } },
          { v: Math.min(p.chosen, p.AB), c: C.cab, l: 'AB', f: { kind: 'depose', type: p.kind, ab: true } },
          { v: pend, c: C.pend, l: 'AB à choisir', f: { kind: 'depose', type: p.kind } }];
        pos = [{ v: p.P, c: C.cbr, l: 'posés', f: { kind: 'pose', type: p.kind } }];
      }
      const tot = s => s.reduce((t, x) => t + Math.max(0, x.v), 0);
      const max = Math.max(tot(dep), tot(pos), 0.0001);
      const bar = (segs, y) => {
        let x = 0;
        return segs.filter(s => s.v > 0.004).map(s => {
          const w = Math.max(2, s.v / max * W);
          const r = `<g class="seg" data-filter='${esc(JSON.stringify(s.f))}'><rect x="${x}" y="${y}" width="${w}" height="${bh}" fill="${s.c}" rx="3"><title>${esc(s.l)} : ${fmt(s.v)}${unit}</title></rect>
            ${w > 46 ? `<text x="${x + w / 2}" y="${y + 17}" fill="#fff" font-size="11.5" text-anchor="middle" font-weight="600">${fmt(s.v, p.unit === 'm' ? 1 : 0)}${unit}</text>` : ''}</g>`;
          x += w; return r;
        }).join('');
      };
      const svg = `<svg viewBox="-2 0 ${W + 4} 92" width="100%" style="max-width:560px;display:block" role="img" aria-label="Schéma ${esc(p.label)}">
        <text x="0" y="12" font-size="12" fill="#4a5866">Ancien (dépose) : ${fmt(tot(dep))}${unit}</text>${bar(dep, 16)}
        <text x="0" y="60" font-size="12" fill="#4a5866">Nouveau (pose) : ${fmt(tot(pos))}${unit}</text>${bar(pos, 64)}</svg>`;
      return `<div class="card"><h3 style="margin-top:0">${esc(p.label)}${R.chantiers.length > 1 ? ' — ' + esc(p.chantier) : ''}</h3>${svg}</div>`;
    }).join('');
    return `<div class="schema">${cards}</div>
      <div class="legend"><span><i style="background:var(--c23)"></i>CP 23 tubage</span><span><i style="background:var(--c22)"></i>CP 22 hors tubage</span>
      <span><i style="background:var(--cbr)"></i>Branchements (CP 25 / 26)</span><span><i style="background:var(--cab)"></i>AB abandon</span><span><i style="background:var(--cpend)"></i>AB à choisir</span></div>`;
  }
  function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888'; }

  function renderResultat(a, R) {
    if (!a.pose && !a.depose) return `<div class="card"><p>Commencez par charger les fichiers carto.</p><button class="btn" data-tab="fichiers">Charger les fichiers</button></div>`;
    const vk = 'VERDICT';
    forceSpecs[vk] = { key: vk, label: 'Verdict global du contrôle', auto: R.autoVerdict, type: 'select', options: [['VALIDATION OK', 'VALIDATION OK'], ['ÉCARTS À CORRIGER', 'ÉCARTS À CORRIGER']] };
    const ok = R.verdict === 'VALIDATION OK';
    const order = { rouge: 0, orange: 1, info: 2 };
    const ctls = R.controls.slice().sort((x, y) => order[x.level] - order[y.level]).map(c =>
      `<div class="ctl ${c.level}"><span class="lv">${c.level === 'info' ? 'info' : c.level}</span><span>${esc(c.msg)}</span></div>`).join('');
    // récap
    const rec = R.recap.map(r => {
      const kq = `R:${r.key}:qte`, kc = `R:${r.key}:cat`;
      forceSpecs[kq] = { key: kq, label: `Quantité — ${r.eotp || 'sans EOTP'} — ${r.action} — ${r.libelle}`, auto: r.autoQty, type: 'number' };
      forceSpecs[kc] = { key: kc, label: `Catégorie d'immo — ${r.eotp || 'sans EOTP'} — ${r.action} — ${r.libelle}`, auto: r.autoCat, type: 'text' };
      return `<tr><td>${r.eotp ? esc(r.eotp) : '<span class="pill none">sans EOTP</span>'}</td><td><span class="pill ${CPCLS(r.cp)}">${esc(r.cp || '?')}</span></td>
        <td>${r.action === 'POSE' ? '<span class="tag pose">POSE</span>' : '<span class="tag depose">DÉPOSE</span>'}</td>
        <td>${esc(r.libelle)}${r.brtPDR ? ' <span class="pill">Brt PDR</span>' : ''}</td>
        <td class="num">${fcell(kq, fmtQ(r.qtySAP, r.unit), fmtQ(r.autoQty, r.unit))}${r.unit === 'm' && r.qtySAP !== r.qty ? `<div class="small muted">exact : ${fmtQ(r.qty, r.unit)}</div>` : ''}</td>
        <td>${fcell(kc, r.categorie, r.autoCat)}</td><td class="num">${r.lines.length}</td></tr>`;
    }).join('');
    const tot = R.eotpTotals.map(e => `<tr><td>${esc(e.eotp)}</td><td><span class="pill ${CPCLS(e.cp)}">${esc(e.cp)}</span></td>
      <td class="num">${fmtQ(e.pose, e.unit)}</td><td class="num">${fmtQ(e.depose, e.unit)}${e.abAChoisir > 0 ? `<div class="small muted">+ ${fmtQ(e.abAChoisir, e.unit)} à mettre en AB</div>` : ''}</td><td class="num"><b>${pct(e)}</b></td>
      <td>${!e.renouv ? '<span class="muted">—</span>' : e.ok10 ? '<span class="pill" style="background:var(--green-l);color:#2f6b10">OK</span>' : '<span class="pill none">écart &gt; 10 %</span>'}</td></tr>`).join('');
    // PDR
    const pdrRows = R.pdr.map(p => {
      const ks = ['pdr', 'eotp', 'nature'].map(f => `P:${p.key}:${f}`);
      forceSpecs[ks[0]] = { key: ks[0], label: `PDR — numéro (${p.pdr})`, auto: p.auto_pdr ?? p.pdr, type: 'text' };
      forceSpecs[ks[1]] = { key: ks[1], label: `PDR ${p.pdr} — EOTP`, auto: p.auto_eotp ?? p.eotp, type: 'select', options: eotpOptions(R).slice(1), free: true };
      forceSpecs[ks[2]] = { key: ks[2], label: `PDR ${p.pdr} — nature`, auto: p.auto_nature ?? p.nature, type: 'select', options: [['Pose', 'Pose'], ['Abandon', 'Abandon']] };
      return `<tr><td>${fcell(ks[0], p.pdr, p.auto_pdr ?? p.pdr)}</td><td>${fcell(ks[1], p.eotp || '—', p.auto_eotp ?? p.eotp)}</td><td>${fcell(ks[2], p.nature, p.auto_nature ?? p.nature)}</td>
        <td>${esc(p.categorie)}</td><td>${p.auto ? 'détecté dans SAP' : `ajouté à la main <button class="btn sm danger" data-pdr-del="${esc(p.id)}">✕</button>`}</td></tr>`;
    }).join('');
    return `<div class="verdict ${ok ? 'ok' : 'ko'}"><span class="grow">${ok ? '✔' : '✖'} ${esc(R.verdict)}</span>
        ${isForced(vk) ? `<span class="forced small">forcé (auto : ${esc(R.autoVerdict)})</span>` : ''}
        <button class="btn sm sec" data-force="${vk}">Forcer le verdict</button></div>
      <div class="card" style="margin-top:14px"><h2>Schéma de l'affaire</h2>${renderSchema(R)}</div>
      <div class="card"><h2>Contrôles</h2>${ctls || '<p class="muted">Aucun point à signaler.</p>'}</div>
      <div class="card"><h2>Lignes d'immo à saisir dans SAP</h2>
        <p class="small muted">Regroupées par EOTP, action, type, matière, classe IN, année et INSEE (comme VERIF_IMMO). Longueurs = longueur installée, arrondies au mètre supérieur pour la saisie SAP. Les quantités et catégories sont forçables (✎).</p>
        <div class="tw"><table><thead><tr><th>EOTP</th><th>CP</th><th>Action</th><th>Ligne</th><th class="num">Quantité à saisir</th><th>Catégorie</th><th class="num">Tronçons</th></tr></thead><tbody>${rec || '<tr><td colspan="7" class="muted">—</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>Totaux par EOTP et test ±10 %</h2>
        <p class="small muted">Sur les EOTP de renouvellement (CP 17, 18, 20, 21, 22, 23, 25, 26, 27), écart = (dépose renouvelée − pose) / pose, à garder entre −10 % et +10 %. La dépose renouvelée ne compte pas la part qui doit partir en AB.</p>
        <div class="tw"><table><thead><tr><th>EOTP</th><th>CP</th><th class="num">Pose</th><th class="num">Dépose renouvelée</th><th class="num">Écart</th><th>Test ±10 %</th></tr></thead><tbody>${tot || '<tr><td colspan="6" class="muted">—</td></tr>'}</tbody></table></div></div>
      ${renderOrcCompare(R)}
      <div class="card"><div class="row"><h2 class="grow" style="margin:0">PDR</h2><button class="btn sm sec" id="pdrAdd">+ Ajouter un PDR</button></div>
        ${R.pdr.length ? `<div class="tw"><table><thead><tr><th>PDR</th><th>EOTP</th><th>Nature</th><th>Catégorie</th><th>Origine</th></tr></thead><tbody>${pdrRows}</tbody></table></div>` : '<p class="muted">Aucun PDR.</p>'}</div>`;
  }

  // ----- 4. Tronçons -----
  function lineMatches(x, f) {
    if (!f) return true;
    if (f.kind && x.kind !== f.kind) return false;
    if (f.type && x.a.type !== f.type) return false;
    if (f.tub != null && !!x.a.tubage !== f.tub) return false;
    if (f.ab && !(x.ab > 0)) return false;
    return true;
  }
  function renderTroncons(a, R) {
    if (!R.lines.length) return `<div class="card"><p>Aucun tronçon : charge les fichiers carto.</p></div>`;
    const f = ui.filter;
    const opts = eotpOptions(R);
    const typeOpts = Object.entries(E.TYPE_LABEL).map(([k, v]) => [k, v]);
    const pending = R.controls.filter(c => c.level === 'orange' && /AB/.test(c.msg));
    const table = kind => {
      const xs = R.lines.filter(x => x.kind === kind && lineMatches(x, f));
      if (!xs.length) return '<p class="muted">Aucune ligne.</p>';
      const rows = xs.map(x => {
        const id = x.src.id, k = fld => `L:${kind}:${id}:${fld}`;
        const sp = (fld, label, type, options) => { forceSpecs[k(fld)] = { key: k(fld), label: `${kind === 'pose' ? 'Pose' : 'Dépose'} — Id SIG ${id} — ${label}`, auto: x.auto[fld], type, options }; };
        sp('type', 'type', 'select', typeOpts); sp('matiere', 'matière', 'select', [['(PE)', '(PE)'], ['(Ac)', '(Ac)'], ['(Autre)', '(Autre)']]);
        sp('IN', 'classe IN', 'select', [['IN1', 'IN1 (< 80 mm)'], ['IN2', 'IN2 (80 à < 200 mm)'], ['IN3', 'IN3 (≥ 200 mm)']]);
        sp('annee', 'année', 'number'); sp('longueur', 'longueur installée (m)', 'number'); sp('tubage', 'tubage', 'bool');
        sp('brtPDR', 'branchement de PDR (catégorie P21E)', 'bool'); sp('eotp', 'EOTP (affectation forcée de toute la ligne)', 'select', opts);
        forceSpecs[k('eotp')].free = true; sp('ignore', 'ignorer la ligne', 'bool');
        const allocs = x.alloc.map(al => `<span class="pill ${al.eotp ? CPCLS(al.cp) : 'none'}" title="${esc(al.eotp || 'EOTP à créer')}">${esc(al.eotp ? al.eotp.split('-').slice(-2).join('-') : 'à créer')} · ${fmtQ(al.qty, x.a.type === 'RES' ? 'm' : 'u')}${al.forced ? ' ✎' : ''}</span>`).join('');
        let choice = '';
        const inPool = !x.a.ignore && !x.a.eotp && x.a.type !== 'AUTRE';
        if (inPool && kind === 'depose') {
          if (x.a.type === 'RES') choice = `<span class="cell"><input class="n" type="text" inputmode="decimal" data-ab="${esc(x.uid)}" value="${a.choices.ab[x.uid] ? fmt(a.choices.ab[x.uid]) : ''}" placeholder="0"> m <button class="btn sm sec" data-aball="${esc(x.uid)}" data-len="${x.a.longueur}">Tout</button></span>`;
          else choice = `<label class="cell"><input type="checkbox" data-abchk="${esc(x.uid)}" ${a.choices.ab[x.uid] ? 'checked' : ''}> AB</label>`;
        }
        if (inPool && kind === 'pose' && x.a.type === 'RES' && x.a.tubage) {
          const user = a.choices.split22[x.uid];
          choice = `<span class="cell" title="Part de ce tronçon tubé reportée en CP 22 (surplus de tubage)">CP22 : <input class="n" type="text" inputmode="decimal" data-split="${esc(x.uid)}" value="${user != null ? fmt(user) : ''}" placeholder="${fmt(x.split22 || 0)}"> m</span>`;
        }
        const yr = kind === 'pose' ? E.dateDisp(x.src.etatDepuis) : E.dateDisp(x.src.dateInst);
        return `<tr class="${x.a.ignore ? 'ign' : ''}"><td class="num">${x.src.row}</td><td>${esc(id)}</td><td class="fn">${esc(x.src.fonction)}</td>
          <td>${fcell(k('type'), E.TYPE_LABEL[x.a.type], E.TYPE_LABEL[x.auto.type])}</td>
          <td title="${esc(x.src.materiau)}">${fcell(k('matiere'), x.a.matiere, x.auto.matiere)}${x.a.matiere === '(Autre)' ? ` <span class="small muted">${esc((x.src.materiau.match(/\(([^)]+)\)/) || [, ''])[1])}</span>` : ''}</td>
          <td class="num">${fmt(x.src.diam, 0)}</td><td>${fcell(k('IN'), x.a.IN || '?', x.auto.IN)}</td>
          <td title="${esc(yr)}">${fcell(k('annee'), x.a.annee || '?', x.auto.annee)}</td>
          <td class="num">${fcell(k('longueur'), fmt(x.a.longueur), fmt(x.auto.longueur))}</td>
          <td class="num">${x.src.lSig == null ? '<span class="muted">vide</span>' : fmt(x.src.lSig)}</td>
          <td title="${esc(x.src.technique)} · ${esc(x.src.etat)}">${x.a.type === 'RES' ? fcell(k('tubage'), x.a.tubage ? 'Oui' : 'Non', x.auto.tubage ? 'Oui' : 'Non') : '<span class="muted">—</span>'}</td>
          <td class="al">${allocs || '<span class="muted">—</span>'} <button class="fbtn" data-force="${esc(k('eotp'))}" title="Forcer l'EOTP de toute la ligne">✎</button></td>
          <td>${choice}</td>
          <td>${x.a.type === 'RES' ? fcell(k('brtPDR'), x.a.brtPDR ? 'Oui' : 'Non', 'Non') : ''}</td>
          <td>${fcell(k('ignore'), x.a.ignore ? 'Oui' : 'Non', 'Non')}</td>
          <td class="cm small muted" title="${esc(x.src.commentaire)}">${esc(x.src.commentaire)}</td></tr>`;
      }).join('');
      return `<div class="tw"><table class="tr"><thead><tr><th class="num">Ligne</th><th>Id SIG</th><th>Fonction réseau</th><th>Type</th><th>Matière</th><th class="num">Ø ext.</th><th>IN</th><th>Année</th><th class="num">Long. inst.</th><th class="num">Long. SIG</th><th>Tubage</th><th>EOTP affecté(s)</th><th>${kind === 'depose' ? 'Choix AB' : 'Surplus tubage'}</th><th>Brt PDR</th><th>Ignorer</th><th>Commentaire carto</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    return `${pending.length ? `<div class="card">${pending.map(c => `<div class="ctl orange"><span class="lv">à faire</span><span>${esc(c.msg)}</span></div>`).join('')}
        <p class="small muted">Choisissez, dans le tableau Dépose (colonne « Choix AB »), les tronçons ou la part de tronçon qui partent en abandon.</p></div>` : ''}
      ${f ? `<div class="filterbar"><span>Filtre : ${esc(describeFilter(f))}</span><button class="btn sm sec" id="clrFilter">Tout afficher</button></div>` : ''}
      <div class="card"><h2>Pose <span class="small muted">(${esc(a.pose ? a.pose.fileName : 'aucun fichier')})</span></h2>${a.pose ? table('pose') : '<p class="muted">—</p>'}</div>
      <div class="card"><h2>Dépose <span class="small muted">(${esc(a.depose ? a.depose.fileName : 'aucun fichier')})</span></h2>${a.depose ? table('depose') : '<p class="muted">—</p>'}</div>
      <p class="small muted">✎ = forcer une valeur. Une valeur forcée est surlignée en violet et n'est jamais écrasée par un nouveau calcul.</p>`;
  }
  function describeFilter(f) {
    const p = [];
    if (f.kind) p.push(f.kind === 'pose' ? 'pose' : 'dépose');
    if (f.type) p.push(E.TYPE_LABEL[f.type]);
    if (f.tub === true) p.push('tubage'); if (f.tub === false) p.push('hors tubage');
    if (f.ab) p.push('mis en AB');
    return p.join(' · ');
  }

  // ----- 5. Forçages & export -----
  function renderExport(a, R) {
    const fs = Object.entries(a.forces);
    const rows = fs.map(([k, f]) => `<tr><td class="wrap">${esc(f.label || k)}</td><td>${esc(f.auto)}</td><td><span class="forced">${esc(fmtVal(f.value))}</span></td>
      <td class="wrap">${esc(f.comment || '')}</td><td>${esc(f.date)}</td><td><button class="btn sm sec" data-unforce="${esc(k)}">Annuler</button></td></tr>`).join('');
    return `<div class="card"><h2>Trace des forçages (${fs.length})</h2>
      ${fs.length ? `<div class="tw"><table><thead><tr><th>Valeur</th><th>Auto</th><th>Forcée</th><th>Commentaire</th><th>Date</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Aucune valeur forcée.</p>'}</div>
      <div class="card"><h2>Exporter</h2><div class="row">
        <button class="btn" id="expPdf">PDF du contrôle</button>
        <button class="btn" id="expXls">Excel du contrôle</button>
        <button class="btn sec" id="expJson">Sauvegarde de l'affaire (.json)</button></div>
        <p class="small muted" style="margin-top:8px">Le PDF et l'Excel contiennent le verdict, les contrôles, les lignes d'immo, les totaux par EOTP, les PDR, les tronçons et la trace des forçages. Le fichier .json permet de rouvrir l'affaire sur un autre appareil (menu Mes affaires → Importer).</p></div>`;
  }
  // dépose / pose en %
  // écart (dépose − pose) / pose, signé
  const pct = e => (!e.renouv || e.ecart == null) ? '—' : e.ecart === Infinity ? 'pas de pose' : (e.ecart > 0.0005 ? '+' : '') + fmt(e.ecart * 100, 1) + ' %';
  const fmtVal = v => v === true ? 'Oui' : v === false ? 'Non' : v;

  // ----- Aide -----
  function renderHelp() {
    return `<div class="card help"><h1>Aide — ${APPNAME} Ver.${VERSION}</h1>
      <h3>Étapes</h3><ol>
      <li><b>Fichiers carto</b> : glisser les deux fichiers « G Canalisation » (pose et dépose) envoyés par la carto, sans les ouvrir.</li>
      <li><b>Captures SAP</b> : capture de la structure du projet (onglet « Donn. base »), puis, si possible, capture de l'écran ORC « Dépose des immobilisations ». Vérification de ce qui a été lu.</li>
      <li><b>Résultat</b> : verdict, schéma, contrôles, lignes d'immo à saisir, test ±10 %, PDR.</li>
      <li><b>Tronçons</b> : détail ligne par ligne, choix des tronçons qui partent en AB, forçages.</li>
      <li><b>Export</b> : PDF / Excel avec la trace des forçages, sauvegarde de l'affaire.</li></ol>
      <h3>Règles appliquées (réseau)</h3><ol>
      <li><b>Dépose tubée</b> = « Etat de service » Abandonné et « Longueur SIG » = 0 (ou vide). <b>Pose tubée</b> = technique de pose contenant « Tubage ».</li>
      <li><b>CP 23</b> = la plus petite longueur entre le PE posé en tubage et la dépose tubée. Le surplus de dépose tubée part en <b>AB</b>, le surplus de PE tubé part en <b>CP 22</b>.</li>
      <li><b>CP 22</b> = toute la pose restante (hors tubage + surplus de tubage). En face : la dépose non tubée, à concurrence de cette pose. Le reste de la dépose part en <b>AB</b>.</li>
      <li>Les tronçons qui partent en AB sont <b>choisis par le CA</b> (onglet Tronçons). Le CP 15 n'est jamais choisi automatiquement : il reste disponible par forçage.</li>
      <li>Tolérance : un surplus de dépose de <b>moins de 1 m</b> n'est pas envoyé en AB ; il reste sur l'EOTP de renouvellement (sauf si le CA choisit de l'AB).</li>
      <li>Quantités à saisir dans SAP : mètres <b>arrondis à l'unité supérieure</b> (ex : 15,6 m → 16 m).</li>
      <li>Longueur retenue : <b>longueur installée</b>. Classes : IN1 &lt; 80 mm ; IN2 de 80 à &lt; 200 mm ; IN3 ≥ 200 mm (diamètre externe).</li></ol>
      <h3>Écran ORC</h3><ul><li>Facultatif. L'appli lit les deux tableaux (« Description technique des EOTP » et « Dépose ») et compare chaque quantité réelle saisie dans SAP avec sa proposition : pose par EOTP ; dépose par EOTP, matière, classe IN et année. Les EOTP de l'écran ORC absents de la liste sont ajoutés à la liste des EOTP.</li></ul>
            <h3>Branchements</h3><ul><li>Une ligne carto = un branchement. Individuel (courant, GC) → CP 25 ; collectif → CP 26. Renouvelés = le plus petit nombre entre pose et dépose ; le surplus de dépose part en AB (lignes cochées par le CA). Le tubage ne s'applique qu'au réseau.</li></ul>
      <h3>Fonte grise</h3><ul><li>Si la structure SAP contient les CP 17, 18, 20 ou 21 à la place de 22, 23, 25 ou 26, l'appli les utilise.</li></ul>
      <h3>PDR</h3><ul><li>Absents de la carto : détectés dans les désignations SAP (« D00000-PDR00000 »). Nature = Abandon si l'EOTP est sous AB, sinon Pose (catégorie S31E). Le branchement d'un poste est traité comme du réseau ; l'option « Brt PDR » (catégorie P21E) reste disponible ligne par ligne.</li></ul>
      <h3>Contrôles</h3><ul>
      <li><b>±10 %</b> : sur chaque EOTP de renouvellement (CP 17, 18, 20, 21, 22, 23, 25, 26, 27), la dépose doit être comprise entre 90 % et 110 % de la pose.</li>
      <li><b>CP xx à créer</b> : la règle demande un code plan absent de la structure SAP.</li>
      <li><b>EOTP A EXCLURE</b> (information) : EOTP de la structure sans aucun tronçon affecté.</li></ul>
      <h3>Catégories d'immo</h3><p class="small">CP 03 M10E · 04 P21E · 05 P23E · 06 / 27 P25E (CI) – P24E (CM) · 11 P26E (BREU) – P27E (CIEU) · 15 et 22 M10E (cana) – P21E (Brt PDR) – S31E (PDR) · 16 M10E · 17 / 18 / 23 M10E · 20 / 25 P21E · 21 / 26 P23E · 35 S63E. Sources : tableau des catégories de l'agence ; doc. M-GES-08/11X – M-RES-08/30X p. 18-19 (codes plans) et p. 27-28 (catégories).</p>
      <h3>Forçage</h3><ul><li>Toute valeur calculée peut être forcée (✎) avec un commentaire. Les valeurs forcées sont surlignées en violet, ne sont jamais écrasées par un recalcul et figurent dans la trace et les exports.</li></ul>
      <h3>Hors ligne</h3><ul><li>Après une première ouverture avec réseau, l'appli est enregistrée sur l'appareil et fonctionne sans connexion, lecture des captures comprise. Les mises à jour sont récupérées automatiquement au retour du réseau.</li></ul>
      <h3>Confidentialité</h3><ul><li>Tout est traité sur l'appareil : aucun fichier, aucune capture n'est envoyé sur Internet. Les affaires sont enregistrées dans ce navigateur ; exporter en .json pour les conserver ailleurs.</li></ul>
      <button class="btn" data-go="home">Retour à mes affaires</button></div>`;
  }

  // ---------------- Événements ----------------
  function bind() {
    const a = cur();
    document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { ui.view = b.dataset.go; render(); window.scrollTo(0, 0); });
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { ui.view = 'affaire'; ui.id = b.dataset.open; ui.tab = 'resultat'; ui.filter = null; const x = cur(); if (x && !(x.pose && x.depose)) ui.tab = 'fichiers'; render(); });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const x = db.affaires.find(y => y.id === b.dataset.del);
      confirmBox(`Supprimer l'affaire « ${x.nom} » de ce navigateur ? Pensez à l'exporter avant si vous souhaitez la conserver.`, () => { db.affaires = db.affaires.filter(y => y.id !== x.id); save(); render(); }, 'Supprimer');
    });
    document.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => exportJson(db.affaires.find(y => y.id === b.dataset.exp)));
    const nb = $('#newAff'); if (nb) nb.onclick = newAffaire;
    const imp = $('#impAff'); if (imp) imp.onchange = e => importJson(e.target.files[0]);
    document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; if (ui.tab !== 'troncons') ui.filter = null; render(); window.scrollTo(0, 0); });
    document.querySelectorAll('[data-force]').forEach(b => b.onclick = () => { const s = forceSpecs[b.dataset.force]; if (s) forceDialog(s); });
    if (!a) return;
    const nm = $('#affName'); if (nm) nm.onchange = () => { a.nom = nm.value.trim() || 'Affaire'; a.autoName = false; touch(a); };
    // fichiers
    const dz = $('#dropCarto'), ic = $('#inCarto');
    if (dz) { dropify(dz, files => handleCartoFiles(files)); ic.onchange = e => handleCartoFiles(e.target.files); }
    document.querySelectorAll('[data-swap]').forEach(b => b.onclick = () => {
      const p = a.pose, d = a.depose; a.pose = d ? { ...d, kind: 'pose' } : null; a.depose = p ? { ...p, kind: 'depose' } : null; touch(a); render();
    });
    document.querySelectorAll('[data-rmfile]').forEach(b => b.onclick = () => { a[b.dataset.rmfile] = null; touch(a); render(); });
    // eotp
    const dor = $('#dropOrc'), ior = $('#inOrc');
    if (dor) { dropify(dor, files => handleImages(files, 'orc')); ior.onchange = e => handleImages(e.target.files, 'orc'); }
    document.querySelectorAll('[data-paste]').forEach(z => { const set = () => { ui.pasteTarget = z.dataset.paste; document.querySelectorAll('[data-paste]').forEach(y => y.classList.toggle('hover', y === z)); }; z.addEventListener('mouseenter', set); });
    document.querySelectorAll('[data-orc]').forEach(i => i.onchange = () => {
      const [t, idx, f] = i.dataset.orc.split(':'); const row = a.orc[t === 'e' ? 'eotpRows' : 'deposeRows'][+idx];
      let v = i.value.trim();
      if (['prev', 'reel', 'annee'].includes(f)) { const n = parseFloat(v.replace(',', '.')); v = isFinite(n) ? n : null; }
      else if (['eotp', 'mat', 'IN', 'nat'].includes(f)) v = v.toUpperCase();
      row[f] = v; touch(a); render();
    });
    document.querySelectorAll('[data-orcdel]').forEach(b => b.onclick = () => { const [t, idx] = b.dataset.orcdel.split(':'); a.orc[t === 'e' ? 'eotpRows' : 'deposeRows'].splice(+idx, 1); touch(a); render(); });
    const oc = $('#orcClear'); if (oc) oc.onclick = () => confirmBox("Vider les données lues sur l'écran ORC ?", () => { a.orc = null; delete a.orcVerified; touch(a); render(); }, 'Vider');
    const ook = $('#orcOk'); if (ook) ook.onchange = () => { a.orcVerified = ook.checked; touch(a); render(); };
    const di = $('#dropImg'), ii = $('#inImg');
    if (di) { dropify(di, files => handleImages(files)); ii.onchange = e => handleImages(e.target.files); }
    document.querySelectorAll('[data-eotp-code]').forEach(i => i.onchange = () => { const e = a.eotps[+i.dataset.eotpCode]; e.code = i.value.trim().toUpperCase(); touch(a); render(); });
    document.querySelectorAll('[data-eotp-des]').forEach(i => i.onchange = () => { a.eotps[+i.dataset.eotpDes].designation = i.value.trim(); touch(a); render(); });
    document.querySelectorAll('[data-eotp-ins]').forEach(b => b.onclick = () => { a.eotps.splice(+b.dataset.eotpIns + 1, 0, { code: '', designation: '', src: 'manuel' }); touch(a); render(); });
    const mv = (i, d) => { const j = i + d; if (j < 0 || j >= a.eotps.length) return; [a.eotps[i], a.eotps[j]] = [a.eotps[j], a.eotps[i]]; touch(a); render(); };
    document.querySelectorAll('[data-eotp-up]').forEach(b => b.onclick = () => mv(+b.dataset.eotpUp, -1));
    document.querySelectorAll('[data-eotp-dn]').forEach(b => b.onclick = () => mv(+b.dataset.eotpDn, 1));
    document.querySelectorAll('[data-eotp-del]').forEach(b => b.onclick = () => { a.eotps.splice(+b.dataset.eotpDel, 1); touch(a); render(); });
    const ea = $('#eotpAdd'); if (ea) ea.onclick = () => { a.eotps.push({ code: '', designation: '', src: 'manuel' }); touch(a); render(); };
    const ec = $('#eotpClear'); if (ec) ec.onclick = () => confirmBox('Vider toute la liste des EOTP ?', () => { a.eotps = []; a.eotpVerified = true; touch(a); render(); }, 'Vider');
    const eo = $('#eotpOk'); if (eo) eo.onchange = () => { a.eotpVerified = eo.checked; touch(a); render(); };
    // schéma
    document.querySelectorAll('.seg').forEach(g => g.onclick = () => { ui.filter = JSON.parse(g.dataset.filter); ui.tab = 'troncons'; render(); window.scrollTo(0, 0); });
    const cf = $('#clrFilter'); if (cf) cf.onclick = () => { ui.filter = null; render(); };
    // choix AB / surplus
    document.querySelectorAll('[data-ab]').forEach(i => i.onchange = () => { const v = parseFloat(String(i.value).replace(/\s/g, '').replace(',', '.')); if (isFinite(v) && v > 0) a.choices.ab[i.dataset.ab] = v; else delete a.choices.ab[i.dataset.ab]; touch(a); render(); });
    document.querySelectorAll('[data-aball]').forEach(b => b.onclick = () => { a.choices.ab[b.dataset.aball] = +b.dataset.len; touch(a); render(); });
    document.querySelectorAll('[data-abchk]').forEach(i => i.onchange = () => { if (i.checked) a.choices.ab[i.dataset.abchk] = 1; else delete a.choices.ab[i.dataset.abchk]; touch(a); render(); });
    document.querySelectorAll('[data-split]').forEach(i => i.onchange = () => { const v = parseFloat(String(i.value).replace(',', '.')); if (isFinite(v)) a.choices.split22[i.dataset.split] = v; else delete a.choices.split22[i.dataset.split]; touch(a); render(); });
    // PDR
    const pa = $('#pdrAdd'); if (pa) pa.onclick = () => pdrDialog(a);
    document.querySelectorAll('[data-pdr-del]').forEach(b => b.onclick = () => { a.pdrManual = a.pdrManual.filter(p => p.id !== b.dataset.pdrDel); touch(a); render(); });
    // forçages
    document.querySelectorAll('[data-unforce]').forEach(b => b.onclick = () => { delete a.forces[b.dataset.unforce]; touch(a); render(); });
    const xp = $('#expPdf'); if (xp) xp.onclick = () => exportPdf(a, ui.R);
    const xx = $('#expXls'); if (xx) xx.onclick = () => exportXlsx(a, ui.R);
    const xj = $('#expJson'); if (xj) xj.onclick = () => exportJson(a);
  }
  function dropify(el, cb) {
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('hover'); });
    el.addEventListener('dragleave', () => el.classList.remove('hover'));
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('hover'); if (e.dataTransfer.files.length) cb(e.dataTransfer.files); });
  }
  // coller une capture (Ctrl+V)
  document.addEventListener('paste', e => {
    if (ui.view !== 'affaire' || ui.tab !== 'eotp' || !cur()) return;
    const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile());
    if (files.length) { e.preventDefault(); handleImages(files, ui.pasteTarget || 'eotp'); }
  });

  function pdrDialog(a) {
    const R = ui.R;
    modal(`<h2>Ajouter un PDR</h2>
      <label>Numéro du PDR</label><input class="t" id="pn" placeholder="ex : D00000-PDR00000">
      <label>EOTP</label><select class="t" id="pe">${R.elements.map(e => `<option>${esc(e.code)}</option>`).join('')}</select>
      <label>Nature</label><select class="t" id="pt"><option>Pose</option><option>Abandon</option></select>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" id="pc">Annuler</button><button class="btn" id="po">Ajouter</button></div>`, m => {
      m.querySelector('#pc').onclick = closeModal;
      m.querySelector('#po').onclick = () => {
        const pdr = m.querySelector('#pn').value.trim().toUpperCase();
        if (!pdr) { toast('Numéro du PDR obligatoire'); return; }
        a.pdrManual.push({ id: uid(), pdr, eotp: m.querySelector('#pe').value, nature: m.querySelector('#pt').value });
        touch(a); closeModal(); render();
      };
    });
  }

  // ---------------- Exports ----------------
  function download(blob, name) {
    const u = URL.createObjectURL(blob); const l = document.createElement('a'); l.href = u; l.download = name;
    document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000);
  }
  const safeName = s => String(s).replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 80);
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

  function exportJson(a) {
    const data = { app: APPNAME, version: VERSION, exported: new Date().toISOString(), affaire: a };
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${safeName(a.nom)}_${stamp()}.json`);
  }
  function importJson(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result); const a = d.affaire || d;
        if (!a || !('eotps' in a)) throw new Error('fichier non reconnu');
        if (db.affaires.some(x => x.id === a.id)) { a.id = uid(); a.nom += ' (importée)'; }
        a.forces = a.forces || {}; a.choices = a.choices || { ab: {}, split22: {} }; a.pdrManual = a.pdrManual || [];
        db.affaires.push(a); save(); toast('Affaire importée : ' + a.nom); render();
      } catch (e) { toast('Import impossible : ' + e.message); }
    };
    fr.readAsText(file);
  }

  function lineRows(R, kind) {
    return R.lines.filter(x => x.kind === kind).map(x => [x.src.row, x.src.id, x.src.fonction, E.TYPE_LABEL[x.a.type], x.a.matiere, x.src.diam, x.a.IN, x.a.annee,
      x.a.longueur, x.src.lSig, x.a.type === 'RES' ? (x.a.tubage ? 'Oui' : 'Non') : '', x.alloc.map(al => `${al.eotp || 'à créer'} : ${al.qty}`).join(' | '), x.ab || '', x.a.ignore ? 'Oui' : '']);
  }
  const LINE_HDR = ['Ligne', 'Id SIG', 'Fonction réseau', 'Type', 'Matière', 'Ø ext.', 'IN', 'Année', 'Long. installée', 'Long. SIG', 'Tubage', 'EOTP (quantité)', 'AB', 'Ignorée'];
  const forceRows = a => Object.entries(a.forces).map(([k, f]) => [f.label || k, f.auto, fmtVal(f.value), f.comment || '', f.date]);

  function exportXlsx(a, R) {
    const wb = XLSX.utils.book_new();
    const add = (name, aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); if (widths) ws['!cols'] = widths.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
    add('Synthèse', [[APPNAME + ' Ver.' + VERSION], ['Affaire', a.nom], ['Édité le', nowStr()], ['Fichier pose', a.pose ? a.pose.fileName : ''], ['Fichier dépose', a.depose ? a.depose.fileName : ''],
      ['Verdict', R.verdict + (a.forces.VERDICT ? ' (forcé, auto : ' + R.autoVerdict + ')' : '')], [], ['Niveau', 'Contrôle'], ...R.controls.map(c => [c.level, c.msg])], [18, 120]);
    add("Lignes d'immo", [['EOTP', 'CP', 'Action', 'Ligne', 'Quantité à saisir', 'Quantité exacte', 'Unité', 'Catégorie', 'Forcé', 'Nb tronçons'],
      ...R.recap.map(r => [r.eotp, r.cp, r.action, r.libelle, r.qtySAP, r.qty, r.unit === 'm' ? 'm' : 'nb', r.categorie, (r.forcedQty || r.forcedCat) ? 'Oui' : '', r.lines.length])], [28, 5, 8, 36, 12, 12, 6, 12, 7, 10]);
    add('Totaux EOTP', [['EOTP', 'CP', 'Pose', 'Dépose renouvelée', 'Unité', 'Écart', 'Test ±10 %'],
      ...R.eotpTotals.map(e => [e.eotp, e.cp, e.pose, e.depose, e.unit === 'm' ? 'm' : 'nb', pct(e), !e.renouv ? '—' : e.ok10 ? 'OK' : 'ÉCART > 10 %'])], [28, 5, 10, 10, 6, 13, 14]);
    add('PDR', [['PDR', 'EOTP', 'Nature', 'Catégorie', 'Origine'], ...R.pdr.map(p => [p.pdr, p.eotp, p.nature, p.categorie, p.auto ? 'détecté SAP' : 'manuel'])], [18, 28, 10, 10, 12]);
    add('Tronçons pose', [LINE_HDR, ...lineRows(R, 'pose')], [6, 12, 26, 12, 8, 7, 5, 6, 10, 9, 7, 50, 6, 7]);
    add('Tronçons dépose', [LINE_HDR, ...lineRows(R, 'depose')], [6, 12, 26, 12, 8, 7, 5, 6, 10, 9, 7, 50, 6, 7]);
    add('EOTP SAP', [['Élément d\'OTP', 'Désignation'], ...a.eotps.map(e => [e.code, e.designation])], [30, 50]);
    if (R.orc) add('Comparaison ORC', [['Tableau', 'EOTP', 'Désignation', 'Mat.', 'IN', 'Année', 'Qté prév.', 'Qté réelle SAP', 'Proposition', 'Statut'],
      ...R.orc.pose.map(x => ['Pose', x.eotp, x.nat || '', '', '', '', x.prev, x.reel, x.app, x.absent ? 'absent ORC' : x.ok ? 'identique' : 'différent']),
      ...R.orc.depose.map(x => ['Dépose', x.eotp, x.designation || '', x.mat || '', x.IN || '', x.annee || '', x.prev, x.reel, x.app, x.absent ? 'absent ORC' : x.ok ? 'identique' : 'différent'])], [8, 28, 34, 6, 6, 7, 10, 14, 12, 12]);
    add('Forçages', [['Valeur', 'Auto', 'Forcée', 'Commentaire', 'Date'], ...forceRows(a)], [60, 18, 18, 40, 18]);
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeName(a.nom)}_controle_${stamp()}.xlsx`);
  }

  function exportPdf(a, R) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const blue = [0, 94, 184];
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(...blue); doc.rect(0, 0, W, 16, 'F');
    doc.setTextColor(255); doc.setFontSize(14); doc.text(APPNAME, 10, 10.5); doc.setFontSize(9); doc.text('Ver.' + VERSION + ' — édité le ' + nowStr(), W - 10, 10.5, { align: 'right' });
    doc.setTextColor(20); doc.setFontSize(12); doc.text('Affaire : ' + a.nom, 10, 24);
    doc.setFontSize(9);
    doc.text(`Pose : ${a.pose ? a.pose.fileName : '—'}   ·   Dépose : ${a.depose ? a.depose.fileName : '—'}`, 10, 30);
    const ok = R.verdict === 'VALIDATION OK';
    doc.setFillColor(...(ok ? [234, 245, 227] : [253, 236, 234])); doc.rect(10, 33, W - 20, 10, 'F');
    doc.setTextColor(...(ok ? [47, 107, 16] : [198, 40, 40])); doc.setFontSize(12);
    doc.text('Verdict : ' + R.verdict + (a.forces.VERDICT ? '  (forcé — auto : ' + R.autoVerdict + ')' : ''), 14, 39.7);
    doc.setTextColor(20);
    // schéma simplifié
    let y = 50;
    const colors = { c23: [0, 94, 184], c22: [42, 157, 143], ab: [138, 150, 163], pend: [224, 123, 0], br: [91, 170, 45] };
    doc.setFontSize(10); doc.text('Schéma', 10, y); y += 4;
    for (const p of R.pools) {
      let dep, pos;
      if (p.kind === 'RES') {
        dep = [[p.R23dep ?? p.R23, 'c23'], [p.AB23 - Math.max(0, p.s23.rest), 'ab'], [Math.max(0, p.s23.rest), 'pend'], [p.R22dep ?? p.R22, 'c22'], [p.AB22 - Math.max(0, p.s22.rest), 'ab'], [Math.max(0, p.s22.rest), 'pend']];
        pos = [[p.R23, 'c23'], [p.surplusTub, 'c22'], [p.P22 - p.surplusTub, 'c22']];
      } else {
        dep = [[p.D - p.AB, 'br'], [Math.min(p.chosen, p.AB), 'ab'], [Math.max(0, p.AB - p.chosen), 'pend']];
        pos = [[p.P, 'br']];
      }
      const tot = s => s.reduce((t, x) => t + Math.max(0, x[0]), 0);
      const mx = Math.max(tot(dep), tot(pos), 0.0001), BW = 150, u = p.unit === 'm' ? ' m' : '';
      doc.setFontSize(9); doc.text(p.label + (R.chantiers.length > 1 ? ' — ' + p.chantier : ''), 10, y + 4);
      const bar = (segs, yy, lab) => {
        doc.text(lab, 45, yy + 3.6); let x = 80;
        for (const [v, c] of segs) { if (v <= 0.004) continue; const w = Math.max(0.6, v / mx * BW); doc.setFillColor(...colors[c]); doc.rect(x, yy, w, 5, 'F'); if (w > 14) { doc.setTextColor(255); doc.text(fmt(v, 1) + u, x + w / 2, yy + 3.6, { align: 'center' }); doc.setTextColor(20); } x += w; }
      };
      bar(dep, y, `Ancien ${fmt(tot(dep))}${u}`); bar(pos, y + 6.5, `Nouveau ${fmt(tot(pos))}${u}`);
      y += 16;
    }
    doc.setFontSize(7.5);
    const lg = [['CP 23 tubage', 'c23'], ['CP 22 hors tubage', 'c22'], ['Branchements', 'br'], ['AB', 'ab'], ['AB à choisir', 'pend']];
    let lx = 10; for (const [l, c] of lg) { doc.setFillColor(...colors[c]); doc.rect(lx, y - 2.6, 3, 3, 'F'); doc.text(l, lx + 4, y); lx += 34; }
    y += 4;
    const tbl = (title, head, body, opts = {}) => {
      if (y > 175) { doc.addPage(); y = 14; }
      doc.setFontSize(11); doc.setTextColor(0, 74, 145); doc.text(title, 10, y); doc.setTextColor(20);
      doc.autoTable({ startY: y + 2, head: [head], body: body.length ? body : [['—']], styles: { fontSize: 7.5, cellPadding: 1.2 }, headStyles: { fillColor: blue }, margin: { left: 10, right: 10 }, ...opts });
      y = doc.lastAutoTable.finalY + 8;
    };
    tbl('Contrôles', ['Niveau', 'Contrôle'], R.controls.map(c => [c.level.toUpperCase(), c.msg]), { columnStyles: { 0: { cellWidth: 18 } } });
    tbl("Lignes d'immo à saisir dans SAP", ['EOTP', 'CP', 'Action', 'Ligne', 'Quantité', 'Catégorie', 'Forcé'],
      R.recap.map(r => [r.eotp || 'SANS EOTP', r.cp || '', r.action, r.libelle, fmtQ(r.qtySAP, r.unit) + (r.unit === 'm' && r.qtySAP !== r.qty ? ` (${fmtQ(r.qty, r.unit)})` : ''), r.categorie, (r.forcedQty || r.forcedCat) ? 'Oui' : '']));
    tbl('Totaux par EOTP — test ±10 %', ['EOTP', 'CP', 'Pose', 'Dépose renouvelée', 'Écart', 'Test ±10 %'],
      R.eotpTotals.map(e => [e.eotp, e.cp, fmtQ(e.pose, e.unit), fmtQ(e.depose, e.unit), pct(e), !e.renouv ? '—' : e.ok10 ? 'OK' : 'ÉCART > 10 %']));
    tbl('PDR', ['PDR', 'EOTP', 'Nature', 'Catégorie', 'Origine'], R.pdr.map(p => [p.pdr, p.eotp, p.nature, p.categorie, p.auto ? 'détecté SAP' : 'manuel']));
    if (R.orc) tbl("Comparaison avec l'écran ORC", ['Tableau', 'EOTP', 'Désignation', 'Mat.', 'IN', 'Année', 'Qté prév.', 'Qté réelle SAP', 'Proposition', 'Statut'],
      R.orc.pose.map(x => ['Pose', x.eotp, x.nat || '', '', '', '', x.prev ?? '—', x.reel ?? '—', x.app, x.absent ? 'absent ORC' : x.ok ? 'identique' : 'différent'])
        .concat(R.orc.depose.map(x => ['Dépose', x.eotp, x.designation || '', x.mat || '', x.IN || '', x.annee || '', x.prev ?? '—', x.reel ?? '—', x.app, x.absent ? 'absent ORC' : x.ok ? 'identique' : 'différent'])));
    tbl('Trace des forçages', ['Valeur', 'Auto', 'Forcée', 'Commentaire', 'Date'], forceRows(a));
    doc.addPage(); y = 14;
    tbl('Annexe — tronçons pose', LINE_HDR, lineRows(R, 'pose'));
    tbl('Annexe — tronçons dépose', LINE_HDR, lineRows(R, 'depose'));
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(120); doc.text(`${APPNAME} Ver.${VERSION} — ${a.nom} — page ${i}/${n}`, W / 2, 205, { align: 'center' }); }
    doc.save(`${safeName(a.nom)}_controle_${stamp()}.pdf`);
  }

  render();
  // fonctionnement hors ligne : enregistre l'appli sur l'appareil (https ou localhost uniquement)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Hors ligne indisponible :', e));
  }
})();
