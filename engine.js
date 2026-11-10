/* VERIF-IMMO — moteur de calcul (aucune donnée d'affaire ici, uniquement les règles métier) */
(function (root) {
  'use strict';

  // ---------- Référentiels ----------
  // Codes plans de renouvellement (doc M-GES-08/11X – M-RES-08/30X, p.19)
  const RENEW_CP = ['17', '18', '20', '21', '22', '23', '25', '26', '27'];

  // Rôle -> codes plans possibles (le 1er trouvé dans la liste SAP est retenu)
  const ROLE_CP = {
    RES_TUB: ['23', '18'], // tubage des conduites (23 ; 18 si fonte grise)
    RES_HT: ['22', '17'],  // réseau hors tubage (22 ; 17 si fonte grise)
    BI: ['25', '20'],      // branchements individuels
    BC: ['26', '21'],      // branchements collectifs
    CI: ['27'],
    CM: ['27']
  };

  // Rôle abandon -> reconnaissance de l'élément AB par sa désignation
  const AB_ROLE = {
    RES: { label: 'AB réseau', re: /r[ée]seau|\bABD\b|canalisation|\bcana\b|conduite(?! montante| d.immeuble)/i },
    BI: { label: 'AB branchement individuel', re: /individuel|\bindiv/i },
    BC: { label: 'AB branchement collectif', re: /collectif|\bcollect/i },
    CI: { label: 'AB CI', re: /^\s*CI\b|conduite d.immeuble/i },
    CM: { label: 'AB CM', re: /^\s*CM\b|montante/i },
    PDR: { label: 'AB poste', re: /PDR|poste/i }
  };

  const TYPE_LABEL = { RES: 'Réseau', BI: 'Brt individuel', BC: 'Brt collectif', CI: 'CI', CM: 'CM', AUTRE: 'Non classé' };

  // Catégories d'immo par code plan (tableau fourni par le CA + doc p.27 pour 17 à 21)
  function categorie(cp, type, brtPDR) {
    if (!cp || cp === 'AB') return '—';
    if (cp === '22' || cp === '15') {
      if (type === 'PDR') return 'S31E';
      if (brtPDR) return 'P21E';
      return 'M10E';
    }
    const t = {
      '03': 'M10E', '04': 'P21E', '05': 'P23E', '16': 'M10E', '17': 'M10E', '18': 'M10E',
      '20': 'P21E', '21': 'P23E', '23': 'M10E', '25': 'P21E', '26': 'P23E', '35': 'S63E'
    };
    if (cp === '06' || cp === '27') return type === 'CM' ? 'P24E' : 'P25E';
    if (cp === '11') return 'P26E / P27E';
    return t[cp] || '?';
  }

  // ---------- Utilitaires ----------
  const EPS = 0.005;
  const TOL_AB = 1; // m : en dessous, un surplus de dépose n'est pas envoyé en AB (reste sur l'EOTP de renouvellement)
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const num = v => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  };
  function yearOf(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v.getFullYear();
    if (typeof v === 'number') { // numéro de série Excel
      if (v > 1000 && v < 3000) return Math.round(v);
      const d = new Date(Math.round((v - 25569) * 86400000));
      return d.getUTCFullYear();
    }
    const s = String(v);
    let m = s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (m) return +m[3];
    m = s.match(/(\d{4})-\d{1,2}-\d{1,2}/); if (m) return +m[1];
    m = s.match(/\b(19|20)\d{2}\b/); if (m) return +m[0];
    return null;
  }
  const r2 = x => Math.round(x * 100) / 100;
  const fr = x => r2(x).toLocaleString('fr-FR', { maximumFractionDigits: 2 }); // 24,7
  const plur = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  function dateDisp(v) {
    if (v == null || v === '') return '';
    let d = null;
    if (typeof v === 'number') d = new Date(Math.round((v - 25569) * 86400000));
    else if (v instanceof Date) return v.toLocaleDateString('fr-FR');
    else { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[3] + '/' + m[2] + '/' + m[1]; return String(v); }
    const p = n => String(n).padStart(2, '0');
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
  }

  function classeIN(d) {
    if (d == null) return null;
    if (d < 80) return 'IN1';
    if (d < 200) return 'IN2';
    return 'IN3';
  }

  // ---------- Lecture des fichiers carto (G Canalisation) ----------
  // Colonnes repérées par leur intitulé (insensible aux accents/majuscules)
  const COLS = {
    id: ['id sig'],
    fonction: ['fonction reseau'],
    etat: ['etat de service'],
    materiau: ['materiau'],
    diam: ['diametre externe [mm]', 'diametre externe'],
    dateInst: ["date d'installation"],
    etatDepuis: ['etat de service depuis'],
    lInst: ['longueur installee (m)', 'longueur installee'],
    lSig: ['longueur sig (m)', 'longueur sig'],
    voie: ['nom de la voie'],
    insee: ['code commune'],
    commune: ['nom de la commune'],
    eotpDepose: ['eotp ouvrage de depose'],
    eotpPose: ['eotp ouvrage de pose'],
    posteTech: ['n° poste technique', 'no poste technique', 'n poste technique'],
    technique: ['technique de pose'],
    commentaire: ['commentaire']
  };

  // rows : tableau de tableaux (1re dimension = lignes), tel que renvoyé par SheetJS (header:1)
  function parseCarto(rows, fileName) {
    let hIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const r = (rows[i] || []).map(norm);
      if (r.includes('id sig') && r.some(c => c === 'fonction reseau')) { hIdx = i; break; }
    }
    if (hIdx < 0) throw new Error("En-têtes introuvables : la feuille doit contenir les colonnes « Id SIG » et « Fonction réseau ».");
    const hdr = rows[hIdx].map(norm);
    const col = {};
    const missing = [];
    for (const k in COLS) {
      // correspondance exacte d'abord (évite que « Etat de service » prenne « Etat de service depuis »)
      let j = hdr.findIndex(h => COLS[k].includes(h));
      if (j < 0) j = hdr.findIndex(h => COLS[k].some(n => h.startsWith(n)));
      col[k] = j;
      if (j < 0 && ['id', 'fonction', 'etat', 'materiau', 'diam', 'lInst'].includes(k)) missing.push(k);
    }
    if (missing.length) throw new Error('Colonnes obligatoires absentes : ' + missing.join(', '));
    const get = (r, k) => (col[k] >= 0 ? r[col[k]] : null);
    const lines = [];
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (get(r, 'id') == null && get(r, 'fonction') == null) continue;
      lines.push({
        row: i + 1, // n° de ligne Excel
        id: String(get(r, 'id') ?? ''),
        fonction: String(get(r, 'fonction') ?? ''),
        etat: String(get(r, 'etat') ?? ''),
        materiau: String(get(r, 'materiau') ?? ''),
        diam: num(get(r, 'diam')),
        dateInst: get(r, 'dateInst'),
        etatDepuis: get(r, 'etatDepuis'),
        lInst: num(get(r, 'lInst')),
        lSig: num(get(r, 'lSig')),
        voie: String(get(r, 'voie') ?? ''),
        insee: String(get(r, 'insee') ?? ''),
        eotpDepose: String(get(r, 'eotpDepose') ?? '').trim(),
        eotpPose: String(get(r, 'eotpPose') ?? '').trim(),
        posteTech: String(get(r, 'posteTech') ?? ''),
        technique: String(get(r, 'technique') ?? ''),
        commentaire: String(get(r, 'commentaire') ?? '')
      });
    }
    // Pose ou dépose ? D'abord le nom du fichier, sinon le contenu
    let kind = null;
    const fn = norm(fileName || '');
    if (/depose/.test(fn)) kind = 'depose';
    else if (/pose/.test(fn)) kind = 'pose';
    if (!kind) {
      const ab = lines.filter(l => /abandon/i.test(norm(l.etat))).length;
      kind = ab > lines.length / 2 ? 'depose' : 'pose';
    }
    const m = String(fileName || '').match(/([A-Z]{2,3}\d?-\d{7}(?:-\d)?)/i);
    return { kind, lines, fileName: fileName || '', affaireCode: m ? m[1].toUpperCase() : '', headerRow: hIdx + 1 };
  }

  // ---------- Classification d'une ligne carto ----------
  function typeOf(fonction) {
    const f = norm(fonction);
    if (f.startsWith('reseau')) return 'RES';
    if (f.includes('branchement') && f.includes('collectif')) return 'BC';
    if (f.includes('branchement')) return 'BI'; // courant, GC (gros consommateur)
    if (f.includes('montante')) return 'CM';
    if (f.includes('immeuble')) return 'CI';
    return 'AUTRE';
  }
  function matiereSAP(materiau) {
    const m = String(materiau).match(/\(([^)]+)\)/);
    const code = m ? m[1].trim().toUpperCase() : '';
    if (code === 'PE') return '(PE)';
    if (code === 'AC') return '(Ac)';
    return '(Autre)';
  }
  function matiereCode(materiau) {
    const m = String(materiau).match(/\(([^)]+)\)/);
    return m ? '(' + m[1].trim() + ')' : String(materiau).split(' ')[0];
  }

  // Valeurs automatiques d'une ligne
  function autoAttrs(l, kind) {
    const type = typeOf(l.fonction);
    const k = l.lSig == null ? 0 : l.lSig; // K vide = 0
    const abandonne = /abandon/.test(norm(l.etat));
    const tubage = type === 'RES' && (kind === 'pose'
      ? /tubage/.test(norm(l.technique))
      : (abandonne && Math.abs(k) < EPS));
    return {
      type,
      matiere: matiereSAP(l.materiau),
      IN: classeIN(l.diam),
      annee: kind === 'pose' ? (yearOf(l.etatDepuis) ?? yearOf(l.dateInst)) : yearOf(l.dateInst),
      longueur: l.lInst == null ? 0 : l.lInst,
      tubage,
      brtPDR: false,
      eotp: '',      // vide = affectation automatique
      ignore: false,
      chantier: (kind === 'pose' ? l.eotpPose : l.eotpDepose).toUpperCase()
    };
  }

  // ---------- Liste des EOTP (lecture SAP) ----------
  // code complet ex : RV4-2302983-1-C1-AB-I06
  function parseEotpCode(code) {
    const c = String(code).toUpperCase().trim();
    const m = c.match(/^([A-Z0-9]{2,4}-\d{7}-\d)(?:-(C\d+))?(?:-([0-9A-Z]{2}))?(?:-(I\d{2}))?$/);
    if (!m) return null;
    return { code: c, base: m[1], chantier: m[2] ? m[1] + '-' + m[2] : null, cp: m[3] || null, elem: m[4] || null };
  }
  const isElement = e => { const p = parseEotpCode(e.code); return !!(p && p.elem); };

  // Correction des confusions OCR classiques dans un code EOTP
  function fixEotp(raw) {
    let s = String(raw).toUpperCase().replace(/[\s_]/g, '').replace(/—|–/g, '-');
    // segments : BASE-NUM-D-Cx-CP-Ixx
    let m = s.match(/^([A-Z0-9]{2,4})-?([0-9OIL]{7})-?([0-9OIL])(?:-?C([0-9IL]{1,2}))?(?:-?([0-9A-Z]{2}))?(?:-?([I1L]?)([0-9OIL]{2,3}))?/);
    if (!m) return null;
    const dig = x => x.replace(/O/g, '0').replace(/[IL]/g, '1');
    let base = m[1].replace(/^RVA/, 'RV4');
    let out = base + '-' + dig(m[2]) + '-' + dig(m[3]);
    if (m[4]) out += '-C' + dig(m[4]);
    if (m[4] && m[5]) {
      let cp = m[5];
      if (/\d/.test(cp) && /[A-Z]/.test(cp)) cp = cp.replace(/8/g, 'B').replace(/0/g, 'O').replace(/4/g, 'A');
      if (/^[0-9OIL]{2}$/.test(cp) && /\d/.test(cp)) cp = dig(cp);
      out += '-' + cp;
      if (m[7]) {
        let d = dig(m[7]);
        if (d.length === 3) d = d.slice(-2); // « 101 » lu pour « I01 », « I102 » pour « I02 »
        out += '-I' + d;
      }
    }
    return out;
  }

  const TYPE_TOKENS = { AF: 'AF', CH: 'CH', CP: 'CP', CO: 'CP', OC: 'OC', '0C': 'OC', OB: 'OB', OS: 'OB', '08': 'OB', '0B': 'OB', AB: 'AB', A8: 'AB', '2B': 'AB' };

  // Texte OCR -> lignes EOTP {code, designation, type}
  function parseOcrText(text) {
    const out = [];
    const reCode = /([A-Z0-9]{2,4}-?[0-9OIL]{7}-?[0-9OIL](?:-?C[0-9IL]{1,2}(?:-?[0-9A-Z]{2}(?:-?[I1L]?[0-9OIL]{2,3})?)?)?)/i;
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.replace(/[|]/g, ' ');
      const m = line.match(reCode);
      if (!m) continue;
      const code = fixEotp(m[1]);
      if (!code || !parseEotpCode(code)) continue;
      let rest = line.slice(m.index + m[1].length).trim();
      // désignation = jusqu'au dernier jeton « type » reconnu
      const toks = rest.split(/\s+/);
      let cut = -1, type = '';
      for (let i = toks.length - 1; i >= 0; i--) {
        const t = toks[i].toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (TYPE_TOKENS[t] && i > 0) { cut = i; type = TYPE_TOKENS[t]; break; }
      }
      // coupe aux colonnes de statut SAP (MESR, AEIT, LANC…) puis retire les jetons parasites de fin
      let dtoks = cut > 0 ? toks.slice(0, cut) : toks;
      const st = dtoks.findIndex(t => /^(MES[RD]|MESRAEIT|AEI[VT]|REIV|MEIV|LANC|IeC|RIMP|ranc|Lac)/i.test(t));
      if (st > 0) dtoks = dtoks.slice(0, st);
      const JUNK = /^(AF|ARF|ÀF|CH|CP|CO|OC|0C|OB|OS|08|0B|AB|AS|A8|2B|AE|H|EH|ÀH|OH|BH|HO|RH|ŒH|CH|NE|8|=|—|-|\.|\||[^A-Za-z0-9()]+)$/i;
      while (dtoks.length > 1 && JUNK.test(dtoks[dtoks.length - 1])) dtoks.pop();
      let designation = dtoks.join(' ').trim();
      designation = designation.replace(/^[^A-Za-z0-9(]+/, '');
      // n° de PDR : D13212-PDR00020 (O lu à la place de 0)
      designation = designation.replace(/(D\d{5}-PDR)([0-9O]{5})/gi, (a, p, n) => p.toUpperCase() + n.replace(/O/gi, '0'));
      out.push({ code, designation, type });
    }
    return harmonise(out);
  }

  // Toutes les lignes d'une même affaire partagent la même base : on corrige les écarts isolés
  function harmonise(list) {
    const counts = {};
    list.forEach(e => { const p = parseEotpCode(e.code); if (p) counts[p.base] = (counts[p.base] || 0) + 1; });
    const bases = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (!bases.length) return list;
    const main = bases[0];
    const dist = (a, b) => { if (a.length !== b.length) return 99; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
    const seen = new Set();
    const res = [];
    for (const e of list) {
      const p = parseEotpCode(e.code);
      let code = e.code;
      if (p && p.base !== main && dist(p.base, main) <= 2) code = main + code.slice(p.base.length);
      if (seen.has(code)) continue;
      seen.add(code);
      res.push({ ...e, code });
    }
    return res;
  }

  // ---------- Forçages ----------
  // forces : { "<clé>": { value, comment, date } }
  // clés : L:<pose|depose>:<id>:<champ>  |  R:<cléRécap>:<qte|cat>  |  P:<pdrKey>:<champ>  |  VERDICT
  function applyLineForces(kind, l, auto, forces) {
    const a = { ...auto };
    for (const f of ['type', 'matiere', 'IN', 'annee', 'longueur', 'tubage', 'brtPDR', 'eotp', 'ignore']) {
      const k = `L:${kind}:${l.id}:${f}`;
      if (forces[k]) a[f] = forces[k].value;
    }
    return a;
  }

  // ---------- Calcul principal ----------
  // state : { pose:{lines}, depose:{lines}, eotps:[{code,designation}], forces:{}, choices:{ ab:{}, split22:{} }, pdrManual:[] }
  function compute(state) {
    const forces = state.forces || {};
    const choices = state.choices || { ab: {}, split22: {} };
    choices.ab = choices.ab || {}; choices.split22 = choices.split22 || {};
    const eotps = (state.eotps || []).map(e => ({ ...e, p: parseEotpCode(e.code) })).filter(e => e.p);
    const elements = eotps.filter(e => e.p.elem);
    const chantiers = [...new Set(eotps.map(e => e.p.chantier).filter(Boolean))];
    const controls = [];
    const add = (level, msg, ref) => controls.push({ level, msg, ref: ref || null });

    // 1. lignes enrichies
    const L = [];
    for (const kind of ['pose', 'depose']) {
      for (const l of ((state[kind] && state[kind].lines) || [])) {
        const auto = autoAttrs(l, kind);
        const a = applyLineForces(kind, l, auto, forces);
        let chantier = a.chantier;
        if (!chantier || !chantiers.includes(chantier)) {
          if (chantiers.length === 1) chantier = chantiers[0];
        }
        L.push({ kind, src: l, uid: kind + ':' + l.id, auto, a, chantier, alloc: [], ab: 0 });
      }
    }

    // recherche d'un élément d'OTP
    function findCP(chantier, cps) {
      for (const cp of cps) {
        const c = elements.filter(e => e.p.cp === cp && (!chantier || e.p.chantier === chantier));
        if (c.length) return { cp, eotp: c[0].code, multiple: c.length > 1, all: c.map(x => x.code) };
      }
      return { cp: cps[0], eotp: null, multiple: false, all: [] };
    }
    function findAB(chantier, role) {
      const c = elements.filter(e => e.p.cp === 'AB' && (!chantier || e.p.chantier === chantier) && AB_ROLE[role].re.test(e.designation || ''));
      const c2 = role === 'RES' ? c.filter(x => !/individuel|collectif|PDR|poste|\bCI\b|\bCM\b|montante|immeuble/i.test(x.designation)) : c;
      const pick = c2.length ? c2 : c;
      return { cp: 'AB', eotp: pick.length ? pick[0].code : null, multiple: pick.length > 1, all: pick.map(x => x.code), label: AB_ROLE[role].label };
    }
    const missing = {};
    function target(chantier, role, isAB) {
      const t = isAB ? findAB(chantier, role) : findCP(chantier, ROLE_CP[role]);
      const key = (chantier || '?') + '|' + role + '|' + (isAB ? 'AB' : 'CP');
      if (!t.eotp && !missing[key]) {
        missing[key] = 1;
        add('rouge', isAB
          ? `Élément « ${t.label} » absent de la liste SAP${chantier ? ' (' + chantier + ')' : ''} : à créer ou à vérifier.`
          : `CP ${t.cp} à créer${chantier ? ' (' + chantier + ')' : ''} : aucun élément d'OTP en CP ${ROLE_CP[role].join(' ou ')} dans la liste SAP.`);
      } else if (t.multiple && !missing[key + 'm']) {
        missing[key + 'm'] = 1;
        add('orange', `Plusieurs EOTP possibles pour ${isAB ? t.label : 'le CP ' + t.cp} : ${t.all.join(', ')}. ${t.eotp} retenu par défaut — forcer si besoin.`);
      }
      return t;
    }
    const qtyOf = x => x.a.type === 'RES' ? (+x.a.longueur || 0) : 1;

    if (!eotps.length) add('rouge', "Aucun EOTP : charger au moins une capture SAP (structure du projet ou écran ORC).");
    else if (state.eotpVerified === false) add('orange', "Liste des EOTP lue sur capture : à vérifier par rapport à SAP puis cocher « Liste vérifiée » (onglet Captures SAP).");

    // 2. lignes ignorées / forcées / non classées
    const active = [];
    for (const x of L) {
      if (x.a.ignore) continue;
      if (x.a.eotp) {
        const p = parseEotpCode(x.a.eotp);
        x.alloc.push({ eotp: x.a.eotp, cp: p ? p.cp : null, qty: qtyOf(x), forced: true });
        continue;
      }
      if (x.a.type === 'AUTRE') { add('rouge', `Ligne ${x.kind} ${x.src.id} (« ${x.src.fonction} ») non classée : choisir l'EOTP (forçage).`, x.uid); continue; }
      if (!x.chantier && chantiers.length > 1) { add('rouge', `Ligne ${x.kind} ${x.src.id} : chantier (C1, C2…) inconnu, choisir l'EOTP (forçage).`, x.uid); continue; }
      if (x.a.type === 'RES' && !(x.a.longueur > 0)) add('orange', `Ligne ${x.kind} ${x.src.id} : longueur installée nulle ou absente.`, x.uid);
      active.push(x);
    }

    // 3. calcul par chantier
    const pools = []; // pour le schéma et le choix AB
    const pending = new Set(); // EOTP dont l'AB n'est pas encore réparti
    const pendingQty = {};      // quantité de dépose encore à basculer en AB, par EOTP de renouvellement
    const byCh = {};
    active.forEach(x => { (byCh[x.chantier || '?'] = byCh[x.chantier || '?'] || []).push(x); });
    for (const ch of Object.keys(byCh)) {
      const xs = byCh[ch];
      const chantier = ch === '?' ? null : ch;
      // ----- Réseau -----
      const poseTub = xs.filter(x => x.kind === 'pose' && x.a.type === 'RES' && x.a.tubage);
      const poseHT = xs.filter(x => x.kind === 'pose' && x.a.type === 'RES' && !x.a.tubage);
      const depTub = xs.filter(x => x.kind === 'depose' && x.a.type === 'RES' && x.a.tubage);
      const depNT = xs.filter(x => x.kind === 'depose' && x.a.type === 'RES' && !x.a.tubage);
      const sum = arr => arr.reduce((s, x) => s + (+x.a.longueur || 0), 0);
      if (poseTub.length + poseHT.length + depTub.length + depNT.length) {
        const P_tub = sum(poseTub), D_tub = sum(depTub);
        const R23 = Math.min(P_tub, D_tub);
        const t23 = (poseTub.length || depTub.length) ? target(chantier, 'RES_TUB') : null;
        const t22 = target(chantier, 'RES_HT');
        const tAB = (D_tub - R23 > EPS || depNT.length) ? target(chantier, 'RES', true) : null;
        // pose tubée : CP23 jusqu'à R23, le surplus en CP22 (choix CA possible via split22)
        let userCP23 = 0; const autoL = [];
        for (const x of poseTub) {
          const s = choices.split22[x.uid];
          if (s != null && s !== '') { const v = Math.max(0, Math.min(+s, x.a.longueur)); x.split22 = v; x.split22User = true; userCP23 += x.a.longueur - v; }
          else autoL.push(x);
        }
        let left = Math.max(0, R23 - userCP23);
        for (const x of autoL) { const c23 = Math.min(x.a.longueur, left); left -= c23; x.split22 = r2(x.a.longueur - c23); }
        let poseCP23 = 0, surplus = 0;
        for (const x of poseTub) {
          const c23 = x.a.longueur - x.split22;
          poseCP23 += c23; surplus += x.split22;
          if (c23 > EPS) x.alloc.push({ eotp: t23 && t23.eotp, cp: t23 && t23.cp, qty: r2(c23) });
          if (x.split22 > EPS) x.alloc.push({ eotp: t22.eotp, cp: t22.cp, qty: r2(x.split22), note: 'surplus tubage' });
        }
        if (Math.abs(poseCP23 - R23) > EPS && poseTub.length)
          add('orange', `Répartition de la pose tubée modifiée : ${fr(poseCP23)} m en CP 23 au lieu de ${fr(R23)} m.`);
        for (const x of poseHT) x.alloc.push({ eotp: t22.eotp, cp: t22.cp, qty: r2(x.a.longueur) });
        const P22 = sum(poseHT) + surplus;
        const D_nt = sum(depNT);
        const R22 = Math.min(P22, D_nt);
        let ab23 = D_tub - R23, ab22 = D_nt - R22;
        // tolérance : petit surplus de dépose (< 1 m) laissé sur l'EOTP de renouvellement, sauf si le CA a déjà choisi de l'AB
        const hasChoice = arr => arr.some(x => +choices.ab[x.uid] > 0);
        let tol23 = 0, tol22 = 0;
        if (ab23 > EPS && ab23 < TOL_AB && !hasChoice(depTub)) { tol23 = ab23; ab23 = 0; add('info', `Réseau tubé (CP 23) : écart de ${fr(tol23)} m entre dépose tubée et PE tubé, toléré (moins de ${TOL_AB} m) et laissé en CP 23.`); }
        if (ab22 > EPS && ab22 < TOL_AB && !hasChoice(depNT)) { tol22 = ab22; ab22 = 0; add('info', `Réseau hors tubage (CP 22) : écart de ${fr(tol22)} m toléré (moins de ${TOL_AB} m) et laissé en CP 22.`); }
        // dépose : le CA choisit les tronçons qui partent en AB
        const deal = (arr, tCP, need, poolName) => {
          let chosen = 0;
          for (const x of arr) {
            let ab = +choices.ab[x.uid] || 0;
            ab = Math.max(0, Math.min(ab, x.a.longueur));
            x.ab = ab; chosen += ab;
            const keep = x.a.longueur - ab;
            if (keep > EPS) x.alloc.push({ eotp: tCP && tCP.eotp, cp: tCP && tCP.cp, qty: r2(keep) });
            if (ab > EPS) x.alloc.push({ eotp: tAB && tAB.eotp, cp: 'AB', qty: r2(ab) });
          }
          const rest = r2(need - chosen);
          if (Math.abs(rest) > EPS) { pending.add(tCP && tCP.eotp); if (tAB) pending.add(tAB.eotp); }
          if (rest > EPS && tCP && tCP.eotp) pendingQty[tCP.eotp] = (pendingQty[tCP.eotp] || 0) + rest;
          if (Math.abs(rest) > EPS)
            add('orange', rest > 0
              ? `${poolName} : ${fr(rest)} m de dépose à mettre en AB — choisir les tronçons dans l'onglet Tronçons.`
              : `${poolName} : ${fr(-rest)} m de trop mis en AB.`, 'pool:' + ch + ':' + poolName);
          return { need: r2(need), chosen: r2(chosen), rest };
        };
        const s23 = deal(depTub, t23, ab23, 'Réseau tubé (CP 23)');
        const s22 = deal(depNT, t22, ab22, 'Réseau hors tubage (CP 22)');
        pools.push({ chantier: ch, kind: 'RES', label: 'Réseau', unit: 'm',
          P_tub: r2(P_tub), D_tub: r2(D_tub), R23: r2(R23), P22: r2(P22), D_nt: r2(D_nt), R22: r2(R22), R23dep: r2(R23 + tol23), R22dep: r2(R22 + tol22),
          AB23: r2(ab23), AB22: r2(ab22), surplusTub: r2(surplus), s23, s22 });
      }
      // ----- Branchements / CI / CM (en nombre) -----
      for (const role of ['BI', 'BC', 'CI', 'CM']) {
        const P = xs.filter(x => x.kind === 'pose' && x.a.type === role);
        const D = xs.filter(x => x.kind === 'depose' && x.a.type === role);
        if (!P.length && !D.length) continue;
        const t = target(chantier, role);
        const R = Math.min(P.length, D.length);
        const need = D.length - R;
        const tAB = need > 0 ? target(chantier, role, true) : null;
        for (const x of P) x.alloc.push({ eotp: t.eotp, cp: t.cp, qty: 1 });
        let chosen = 0;
        for (const x of D) {
          const ab = choices.ab[x.uid] ? 1 : 0; x.ab = ab; chosen += ab;
          if (ab) x.alloc.push({ eotp: (tAB || target(chantier, role, true)).eotp, cp: 'AB', qty: 1 });
          else x.alloc.push({ eotp: t.eotp, cp: t.cp, qty: 1 });
        }
        if (chosen !== need) { pending.add(t.eotp); }
        if (need > chosen && t.eotp) pendingQty[t.eotp] = (pendingQty[t.eotp] || 0) + (need - chosen);
        if (chosen !== need)
          add('orange', chosen < need
            ? `${TYPE_LABEL[role]} : ${(n => `${n} ${role === 'CI' || role === 'CM' ? 'ouvrage' : 'branchement'}${n > 1 ? 's' : ''} déposé${n > 1 ? 's' : ''}`)(need - chosen)} à mettre en AB — cocher les lignes dans l'onglet Tronçons.`
            : `${TYPE_LABEL[role]} : ${plur(chosen - need, role === 'CI' || role === 'CM' ? 'ouvrage' : 'branchement')} de trop mis en AB.`, 'pool:' + ch + ':' + role);
        pools.push({ chantier: ch, kind: role, label: TYPE_LABEL[role], unit: 'u', P: P.length, D: D.length, R, AB: need, chosen });
      }
    }

    // 4. PDR : détectés dans les désignations SAP + ajouts manuels
    const pdr = [];
    for (const e of elements) {
      const des = String(e.designation || '');
      const m = des.match(/D\d{5}-PDR\d{5}/i);
      // poste reconnu par son n° (D00000-PDR00000) ou, à défaut, par le mot « poste » / « PDR » dans la désignation
      const isPoste = m || /\bposte\b|\bPDR\b/i.test(des);
      if (isPoste) pdr.push({ key: 'auto:' + e.code, pdr: m ? m[0].toUpperCase() : 'n° non indiqué (' + des.replace(/\(abandon\)/i, '').trim() + ')', eotp: e.code, nature: e.p.cp === 'AB' ? 'Abandon' : 'Pose', auto: true, sansNumero: !m });
    }
    for (const p of (state.pdrManual || [])) pdr.push({ key: 'man:' + p.id, pdr: p.pdr, eotp: p.eotp, nature: p.nature, auto: false, id: p.id });
    for (const p of pdr) {
      for (const f of ['pdr', 'eotp', 'nature']) { const k = `P:${p.key}:${f}`; if (forces[k]) { p['auto_' + f] = p[f]; p[f] = forces[k].value; } }
      const pp = parseEotpCode(p.eotp || '');
      p.cp = pp ? pp.cp : null;
      p.categorie = p.nature === 'Abandon' ? '—' : categorie(p.cp, 'PDR');
    }
    if (pdr.length) add('info', `${pdr.length} PDR détecté(s) : ${pdr.map(p => p.pdr).join(', ')}.`);

    // 5. récapitulatif des lignes d'immo
    const recapMap = {};
    for (const x of L) {
      if (x.a.ignore) continue;
      for (const al of x.alloc) {
        const action = x.kind === 'pose' ? 'POSE' : 'DEPOSE';
        const t = x.a.type;
        let libelle;
        if (t === 'RES') libelle = `Réseau ${x.a.matiere} ${x.a.IN || '?'} ${x.a.annee || '?'} ${x.src.insee}`;
        else if (x.kind === 'pose') libelle = `${TYPE_LABEL[t]} ${x.a.annee || '?'} ${x.src.insee}`;
        else libelle = `${TYPE_LABEL[t]} ${x.src.insee}`; // dépose brt : sans année (comme VERIF_IMMO)
        const key = `${al.eotp || 'SANS-EOTP'}|${action}|${libelle}|${x.a.brtPDR ? 'BRTPDR' : ''}`;
        const r = recapMap[key] = recapMap[key] || { key, eotp: al.eotp || '', cp: al.cp, action, type: t, libelle,
          matiere: t === 'RES' ? x.a.matiere : '', IN: t === 'RES' ? x.a.IN : '', annee: (t === 'RES' || x.kind === 'pose') ? x.a.annee : '',
          insee: x.src.insee, unit: t === 'RES' ? 'm' : 'u', qty: 0, brtPDR: !!x.a.brtPDR, lines: [] };
        r.qty += al.qty; r.lines.push(x.uid);
      }
    }
    const recap = Object.values(recapMap).map(r => {
      r.qty = r2(r.qty);
      r.categorie = categorie(r.cp, r.type, r.brtPDR);
      r.autoQty = r.qty; r.autoCat = r.categorie;
      const kq = `R:${r.key}:qte`, kc = `R:${r.key}:cat`;
      if (forces[kq]) { r.qty = +forces[kq].value; r.forcedQty = true; }
      // quantité à saisir dans SAP : mètres arrondis à l'unité supérieure (valeur forcée reprise telle quelle)
      r.qtySAP = (r.unit === 'm' && !r.forcedQty) ? Math.ceil(r.qty - 1e-9) : r.qty;
      if (forces[kc]) { r.categorie = forces[kc].value; r.forcedCat = true; }
      if (!r.eotp) add('rouge', `${r.libelle} (${r.action.toLowerCase()}) : pas d'EOTP — à créer dans SAP ou à forcer.`, 'recap:' + r.key);
      return r;
    }).sort((a, b) => (a.eotp || 'ZZ').localeCompare(b.eotp || 'ZZ') || a.action.localeCompare(b.action) || a.libelle.localeCompare(b.libelle));

    // 6. contrôle ±10 % pose/dépose sur les EOTP de renouvellement (comme VERIF_IMMO, colonne V)
    const perEotp = {};
    for (const r of recap) {
      if (!r.eotp) continue;
      const e = perEotp[r.eotp] = perEotp[r.eotp] || { eotp: r.eotp, cp: r.cp, unit: r.unit, pose: 0, depose: 0 };
      e[r.action === 'POSE' ? 'pose' : 'depose'] += r.qty;
    }
    const eotpTotals = Object.values(perEotp).map(e => {
      e.pose = r2(e.pose); e.depose = r2(e.depose);
      e.renouv = RENEW_CP.includes(e.cp);
      e.pending = pending.has(e.eotp);
      // dépose retenue = dépose affectée moins la part qui doit encore partir en AB (le test ne dépend pas du choix des tronçons)
      e.deposeAffectee = e.depose;
      e.abAChoisir = r2(pendingQty[e.eotp] || 0);
      e.depose = r2(e.depose - e.abAChoisir);
      // écart = (dépose − pose) / pose
      e.ecart = e.pose > 0 ? (e.depose - e.pose) / e.pose : (e.depose > 0 ? Infinity : null);
      if (e.renouv && (e.pose > 0 || e.depose > 0)) {
        e.ok10 = e.depose > 0.9 * e.pose && e.depose < 1.1 * e.pose;
        const q = n => e.unit === 'm' ? `${fr(n)} m` : `${n} ${['27'].includes(e.cp) ? 'ouvrage' : 'branchement'}${n > 1 ? 's' : ''}`;
        if (!e.ok10) add('rouge', `${e.eotp} (CP ${e.cp}) : écart pose/dépose de ${e.ecart === Infinity ? 'plus de 100' : fr(Math.abs(e.ecart) * 100)} % (> 10 %) — pose : ${q(e.pose)}, dépose renouvelée : ${q(e.depose)}.`, 'eotp:' + e.eotp);
      }
      return e;
    }).sort((a, b) => a.eotp.localeCompare(b.eotp));

    // 7. EOTP non utilisés (information, comme « EOTP A EXCLURE »)
    const used = new Set(recap.map(r => r.eotp).concat(pdr.map(p => p.eotp)));
    const unused = elements.filter(e => !used.has(e.code));
    for (const e of unused) add('info', `EOTP A EXCLURE : ${e.code} (${e.designation || 'sans désignation'}) — aucun tronçon affecté.`, 'eotp:' + e.code);

    // 8. écran ORC (facultatif)
    let orc = null;
    if (state.orc && ((state.orc.eotpRows || []).length || (state.orc.deposeRows || []).length)) {
      orc = compareOrc({ recap, pdr }, state.orc);
      if (state.orcVerified === false) add('orange', "Écran ORC lu sur capture : à vérifier par rapport à SAP puis cocher « Écran ORC vérifié » (onglet Captures SAP).");
      if (orc.nbEcarts) add('orange', `Écran ORC : ${orc.nbEcarts} ligne${orc.nbEcarts > 1 ? 's' : ''} différente${orc.nbEcarts > 1 ? 's' : ''} de la proposition de l'appli — voir « Comparaison avec l'écran ORC ».`);
    }

    // 9. verdict
    const bad = controls.filter(c => c.level === 'rouge' || c.level === 'orange').length;
    const autoVerdict = bad ? 'ÉCARTS À CORRIGER' : 'VALIDATION OK';
    const verdict = forces.VERDICT ? forces.VERDICT.value : autoVerdict;

    return { lines: L, recap, eotpTotals, pools, pdr, orc, controls, unused, verdict, autoVerdict, chantiers, elements: elements.map(e => ({ code: e.code, designation: e.designation, cp: e.p.cp })) };
  }

  // ---------- Écran SAP « ORC – Dépose des immobilisations » ----------
  const numFr = v => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
  const fixNat = n => { const t = String(n).toUpperCase().replace(/[^A-Z0-9]/g, ''); const m = t.match(/^([A-Z])[A-Z]?(\d{2}[EF])$/); return m ? m[1] + m[2] : t; };
  const fixIN = t => { const m = String(t).toUpperCase().match(/^IN([1-3IL])$/); return m ? 'IN' + m[1].replace(/[IL]/, '1') : null; };
  // texte lu -> { eotpRows (tableau « Description technique des EOTP »), deposeRows (tableau « Dépose ») }
  function parseOrcText(text) {
    const eotpRows = [], deposeRows = [];
    const reCode = /([A-Z0-9]{2,4}-?[0-9OIL]{7}-?[0-9OIL]-?C[0-9IL]{1,2}-?[0-9A-Z]{2}-?[I1L]?[0-9OIL]{2,3})/i;
    let zone = 1;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
      if (/^d[ée]pose\b/i.test(line)) { zone = 2; continue; }
      const m = line.match(reCode);
      if (!m) continue;
      const code = fixEotp(m[1]);
      if (!code || !parseEotpCode(code) || !parseEotpCode(code).elem) continue;
      const before = line.slice(0, m.index).trim();
      const after = line.slice(m.index + m[1].length).trim();
      if (zone === 1 && !before) {
        // EOTP INSEE prév unité réel unité nature
        const t = after.match(/^(\d{5})\s+([\d.,]+)\s+(M|PCE|U|ML)\s+([\d.,]+)?\s*(M|PCE|U|ML)?\s*([A-Z0-9]{3,6})?/i);
        if (t) eotpRows.push({ eotp: code, insee: t[1], prev: numFr(t[2]), unit: t[3].toUpperCase(), reel: t[4] != null ? numFr(t[4]) : null, nat: t[6] ? fixNat(t[6]) : '' });
        continue;
      }
      // ligne du tableau Dépose : INSEE commune EOTP nature désignation [mat IN libellé diamètre] [année] prév unité réel unité date
      const insee = (before.match(/^(\d{5})/) || [])[1] || '';
      const tail = after.match(/(?:\s(\d{4}))?\s+([\d.,]+)\s+(M|PCE|U|ML)\s+([\d.,]+)?\s*(M|PCE|U|ML)?\s*(\d{2}[./]\d{2}[./]\d{4})?\s*$/i);
      if (!tail) continue;
      let mid = after.slice(0, tail.index).trim();
      const natM = mid.match(/^([A-Z0-9]{3,6})\s+/i);
      const nat = natM ? fixNat(natM[1]) : '';
      if (natM) mid = mid.slice(natM[0].length);
      let mat = '', IN = null, designation = mid;
      const mm = mid.match(/\s(A|PE|AC|FG|FD|[A-Z]{1,3})\s+(IN[1-3IL])\b/i);
      if (mm && fixIN(mm[2])) { mat = mm[1].toUpperCase(); IN = fixIN(mm[2]); designation = mid.slice(0, mm.index).trim(); }
      deposeRows.push({ eotp: code, insee, nat, designation, mat, IN, annee: tail[1] ? +tail[1] : null,
        prev: numFr(tail[2]), unit: tail[3].toUpperCase(), reel: tail[4] != null ? numFr(tail[4]) : null, date: tail[6] || '' });
    }
    return { eotpRows, deposeRows };
  }

  // Comparaison écran ORC / proposition de l'appli (INSEE ignoré : la carto donne l'arrondissement, SAP la commune)
  const MAT_SAP = { '(PE)': 'PE', '(Ac)': 'AC', '(Autre)': 'A' };
  function compareOrc(R, orc) {
    const out = { pose: [], depose: [] };
    if (!orc) return out;
    const ceil = (q, u) => u === 'm' ? Math.ceil(q - 1e-9) : q;
    // pose par EOTP
    const poseApp = {};
    for (const r of R.recap) if (r.action === 'POSE' && r.eotp) poseApp[r.eotp] = (poseApp[r.eotp] || 0) + r.qtySAP;
    const seenP = new Set();
    for (const e of orc.eotpRows || []) {
      seenP.add(e.eotp);
      const app = poseApp[e.eotp] ?? 0;
      out.pose.push({ ...e, app, ok: e.reel != null && Math.abs(e.reel - app) < EPS });
    }
    for (const k of Object.keys(poseApp)) if (!seenP.has(k)) out.pose.push({ eotp: k, prev: null, reel: null, unit: (R.recap.find(r => r.eotp === k && r.action === 'POSE') || {}).unit === 'm' ? 'M' : 'PCE', nat: '', app: poseApp[k], ok: false, absent: true });
    // dépose par EOTP + matière + IN + année (réseau) ; par EOTP pour branchements et postes
    const depApp = {};
    const keyOf = (eotp, mat, IN, annee) => mat ? `${eotp}|${mat}|${IN}|${annee}` : `${eotp}|-`;
    for (const r of R.recap) {
      if (r.action !== 'DEPOSE' || !r.eotp) continue;
      const k = r.type === 'RES' ? keyOf(r.eotp, MAT_SAP[r.matiere] || r.matiere, r.IN, r.annee) : keyOf(r.eotp);
      depApp[k] = (depApp[k] || 0) + r.qtySAP;
    }
    for (const p of R.pdr || []) if (p.eotp) { const k = keyOf(p.eotp); depApp[k] = (depApp[k] || 0) + 1; }
    const seenD = new Set();
    for (const d of orc.deposeRows || []) {
      const k = keyOf(d.eotp, d.mat, d.IN, d.annee);
      seenD.add(k);
      const app = depApp[k] ?? 0;
      out.depose.push({ ...d, key: k, app, ok: d.reel != null && Math.abs(d.reel - app) < EPS });
    }
    for (const k of Object.keys(depApp)) if (!seenD.has(k)) {
      const [eotp, mat, IN, annee] = k.split('|');
      out.depose.push({ eotp, mat: mat === '-' ? '' : mat, IN: IN || null, annee: annee ? +annee : null, designation: '', prev: null, reel: null, unit: mat !== '-' ? 'M' : 'PCE', app: depApp[k], ok: false, absent: true, key: k });
    }
    out.nbEcarts = out.pose.filter(x => !x.ok).length + out.depose.filter(x => !x.ok).length;
    return out;
  }

  const api = { compute, parseOrcText, compareOrc, parseCarto, parseOcrText, fixEotp, parseEotpCode, classeIN, categorie, autoAttrs, typeOf, TYPE_LABEL, RENEW_CP, yearOf, norm, dateDisp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VIEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
