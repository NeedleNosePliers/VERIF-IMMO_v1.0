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
    RES_RS: ['15'],        // restructuration : réseau posé là où rien n'existait
    BI: ['25', '20'],      // branchements individuels
    BC: ['26', '21'],      // branchements collectifs
    CI: ['27'],
    CM: ['27']
  };

  // Rôle abandon -> reconnaissance de l'élément AB par sa désignation
  const AB_ROLE = {
    RES: { label: 'AB réseau', re: /r[ée]seau|\bABD\b|canalisation|\bcana\b|conduite(?! montante| d.immeuble)|\d+(?:[,.]\d+)?\s*m(?![a-zé])|2GS|\bfonte\b|\bacier\b|\bPE\s?\d/i }, // « Abandon 10 m 2GS 118 BP »
    BI: { label: 'AB branchement individuel', re: /individuel|\bindiv/i },
    BC: { label: 'AB branchement collectif', re: /collectif|\bcollect/i },
    CI: { label: 'AB CI', re: /^\s*CI\b|conduite d.immeuble/i },
    CM: { label: 'AB CM', re: /^\s*CM\b|montante/i },
    PDR: { label: 'AB poste', re: /PDR|poste/i }
  };

  const TYPE_LABEL = { RES: 'Réseau', BI: 'Brt individuel', BC: 'Brt collectif', CI: 'CI', CM: 'CM', AUTRE: 'Non classé' };

  // Catégories d'immo par code plan (tableau fourni par le CA + doc p.27 pour 17 à 21)
  function categorie(cp, type, brtPDR) {
    if (!cp) return '—';
    // abandon : nature d'ouvrage du bien abandonné (comme l'écran ORC)
    if (cp === 'AB') return ({ RES: 'M10E', BI: 'P21E', BC: 'P23E', CI: 'P25E', CM: 'P24E', PDR: 'S31E' })[type] || '—';
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

  const dateKey = v => { const d = dateDisp(v); const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? +(m[3] + m[2] + m[1]) : 0; };
  const keyDisp = k => k ? String(k).replace(/^(\d{4})(\d{2})(\d{2})$/, '$3/$2/$1') : '';
  // classes de diamètre telles que l'écran ORC les affiche : PE « < 100 » / « >= 100 et < 200 » ; autres matières « < 80 » / « >= 80 et < 200 »
  function classeIN(d, mat) {
    if (d == null) return null;
    const s1 = mat === 'PE' || mat === '(PE)' ? 100 : 80;
    if (d < s1) return 'IN1';
    if (d < 200) return 'IN2';
    return 'IN3';
  }
  const LIB_MAT = { A: 'AUTRES', PE: 'POLYETHYLENE', AC: 'ACIER' };
  function diamTxt(mat, IN) {
    const s1 = mat === 'PE' ? 100 : 80;
    return IN === 'IN1' ? `< ${s1}` : IN === 'IN2' ? `>= ${s1} et < 200` : IN === 'IN3' ? '>= 200' : '';
  }
  // INSEE SAP : la commune (Marseille, Lyon, Paris), pas l'arrondissement de la carto
  function inseeSAP(c) {
    const n = +c;
    if (n >= 13201 && n <= 13216) return '13055';
    if (n >= 69381 && n <= 69389) return '69123';
    if (n >= 75101 && n <= 75120) return '75056';
    return String(c || '');
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
    pression: ['niveau de pression'],
    eotpDepose: ['eotp ouvrage de depose'],
    eotpPose: ['eotp ouvrage de pose'],
    posteTech: ['n° poste technique', 'no poste technique', 'n poste technique', 'poste technique'],
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
        commune: String(get(r, 'commune') ?? ''),
        pression: String(get(r, 'pression') ?? '').trim(),
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
    let type = typeOf(l.fonction);
    // branchement rattaché à un poste technique de branchement collectif (…-BRC…) : compté en collectif (fiche de correction Cristol)
    if (type === 'BI' && /-BRC\d/i.test(l.posteTech || '')) type = 'BC';
    if (type === 'BC' && /-BRI\d/i.test(l.posteTech || '')) type = 'BI';
    // tubage : colonne « Technique de pose » de la carto, en pose comme en dépose (demande du CA, remplace la règle VERIF_IMMO « Abandonné + longueur SIG 0 »)
    const tubage = type === 'RES' && /tubage/.test(norm(l.technique));
    return {
      type,
      matiere: matiereSAP(l.materiau),
      IN: classeIN(l.diam, matiereSAP(l.materiau)),
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

  // ---------- Calcul principal : répartition des biens entre les EOTP ----------
  // state : { pose:{lines}, depose:{lines}, eotps:[{code,designation}], forces:{}, orc, orcVerified, eotpVerified, pdrManual:[] }
  // forces : L:<pose|depose>:<id>:<champ> (attributs de ligne) | POSE:<eotp> (quantité posée) | REP:<cléBien>|<eotp> (case de répartition)
  //          P:<pdrKey>:<champ> | VERDICT
  const MAT_SAP = { '(PE)': 'PE', '(Ac)': 'AC', '(Autre)': 'A' };
  const famOfCp = cp => (['20', '25', '04', '08', '02'].includes(cp) ? 'BI' : ['21', '26', '05', '09'].includes(cp) ? 'BC' : ['27', '06', '10'].includes(cp) ? 'CI' : 'RES');
  const ceilQ = (q, unit) => unit === 'm' ? Math.ceil(q - 1e-9) : Math.round(q);
  function compute(state) {
    const forces = state.forces || {};
    const eotps = (state.eotps || []).map(e => ({ ...e, p: parseEotpCode(e.code) })).filter(e => e.p);
    const elements = eotps.filter(e => e.p.elem);
    const chantiers = [...new Set(eotps.map(e => e.p.chantier).filter(Boolean))];
    const controls = [];
    const add = (level, msg, ref) => controls.push({ level, msg, ref: ref || null });

    // 1. lignes carto enrichies
    const L = [];
    for (const kind of ['pose', 'depose']) {
      for (const l of ((state[kind] && state[kind].lines) || [])) {
        const auto = autoAttrs(l, kind);
        const a = applyLineForces(kind, l, auto, forces);
        let chantier = a.chantier;
        if ((!chantier || !chantiers.includes(chantier)) && chantiers.length === 1) chantier = chantiers[0];
        L.push({ kind, src: l, uid: kind + ':' + l.id, auto, a, chantier: chantier || '' });
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
      const c2 = role === 'RES' ? c.filter(x => !/individuel|collectif|PDR|poste|\bCI\b|\bCM\b|montante|immeuble|\bBR[IC]\b/i.test(x.designation)) : c;
      const pick = c2.length ? c2 : c;
      return { cp: 'AB', eotp: pick.length ? pick[0].code : null, multiple: pick.length > 1, all: pick.map(x => x.code), label: AB_ROLE[role].label };
    }
    const seenMsg = {};
    // pas de création d'EOTP : seulement un élément de niveau 4 (suffixe I01, I02…) sous le niveau CP
    const chDefault = chantiers.length === 1 ? chantiers[0] : null;
    function nextElement(chantier, cp) {
      const ch = chantier || chDefault;
      if (!ch) return null;
      const used = elements.filter(e => e.p.chantier === ch && e.p.cp === cp).map(e => +e.p.elem.slice(1));
      const n = used.length ? Math.max(...used) + 1 : 1;
      return `${ch}-${cp}-I${String(n).padStart(2, '0')}`;
    }
    const proposed = {};
    function target(chantier, role, isAB) {
      const t = isAB ? findAB(chantier, role) : findCP(chantier, ROLE_CP[role]);
      const key = (chantier || '?') + '|' + role + '|' + (isAB ? 'AB' : 'CP');
      if (!t.eotp) {
        // élément à créer : suffixe suivant, réservé par rôle pour ne pas donner deux fois le même
        if (!proposed[key]) {
          let code = nextElement(chantier, t.cp);
          if (code) { const taken = new Set(Object.values(proposed)); while (taken.has(code)) { const m = code.match(/-I(\d+)$/); code = code.replace(/-I\d+$/, '-I' + String(+m[1] + 1).padStart(2, '0')); } }
          proposed[key] = code || (isAB ? t.label : 'CP ' + t.cp);
        }
        t.proposed = proposed[key];
      }
      if (!t.eotp && !seenMsg[key]) {
        seenMsg[key] = 1;
        add('rouge', isAB
          ? `Créer l'élément de niveau 4 ${t.proposed} (${t.label.replace(/^AB /, 'abandon ')}) : aucun élément AB correspondant dans la liste SAP.`
          : `Créer l'élément de niveau 4 ${t.proposed} (CP ${t.cp}) : aucun élément en CP ${ROLE_CP[role].join(' ou ')} dans la liste SAP.`);
      } else if (t.multiple && !seenMsg[key + 'm']) {
        seenMsg[key + 'm'] = 1;
        add('orange', `Plusieurs EOTP possibles pour ${isAB ? t.label : 'le CP ' + t.cp} : ${t.all.join(', ')}. ${t.eotp} retenu par défaut — modifier la répartition si besoin.`);
      }
      // colonne de repli quand l'élément n'existe pas : « RV4-…-C1-15-I01 (à créer) »
      t.col = t.eotp || `${t.proposed} (à créer)`;
      t.toCreate = !t.eotp;
      return t;
    }

    if (!eotps.length) add('rouge', "Aucun EOTP : charger au moins une capture SAP (structure du projet ou écran ORC).");
    else if (state.eotpVerified === false) add('orange', "Liste des EOTP lue sur capture : à vérifier par rapport à SAP puis cocher « Liste vérifiée » (onglet Captures SAP).");

    // 2. lignes actives
    const active = [];
    for (const x of L) {
      if (x.a.ignore) continue;
      if (x.a.type === 'AUTRE') { add('rouge', `Ligne ${x.kind} ${x.src.id} (« ${x.src.fonction} ») non classée : forcer son type (onglet Tronçons).`, x.uid); continue; }
      if (!x.chantier && chantiers.length > 1) { add('rouge', `Ligne ${x.kind} ${x.src.id} : chantier (C1, C2…) inconnu.`, x.uid); continue; }
      if (x.a.type === 'RES' && !(x.a.longueur > 0)) add('orange', `Ligne ${x.kind} ${x.src.id} : longueur installée nulle ou absente.`, x.uid);
      active.push(x);
    }
    const fam = t => t === 'RES' ? 'RES' : t; // famille : réseau, BI, BC, CI, CM
    const unitOf = t => t === 'RES' ? 'm' : 'u';

    // 3. pose par EOTP (tableau « Description technique des EOTP »)
    const poseMap = {};
    for (const x of active.filter(y => y.kind === 'pose')) {
      const role = x.a.type === 'RES' ? (x.a.tubage ? 'RES_TUB' : 'RES_HT') : x.a.type;
      const t = target(x.chantier, role);
      const k = t.col;
      const p = poseMap[k] = poseMap[k] || { eotp: t.eotp, col: k, cp: t.cp, toCreate: t.toCreate, role, type: x.a.type, fam: fam(x.a.type), chantier: x.chantier, unit: unitOf(x.a.type), exact: 0, lines: [], brtPDR: false };
      p.exact += x.a.type === 'RES' ? (+x.a.longueur || 0) : 1;
      p.lines.push(x.uid); x.eotp = k;
      p.dtMat = p.dtMat || new Set(); p.dtDiam = p.dtDiam || new Set(); p.dtPress = p.dtPress || new Set();
      p.dtMat.add(MAT_SAP[x.a.matiere] || x.a.matiere); if (x.src.diam != null) p.dtDiam.add(+x.src.diam); if (x.src.pression) p.dtPress.add(x.src.pression.toUpperCase());
      p.insee = p.insee || inseeSAP(x.src.insee); p.commune = p.commune || String(x.src.commune || '').replace(/\s+\d+.*$/, '').toUpperCase();
      // date de mise en service réelle : « Etat de service depuis » (à défaut « Date d'installation ») du tableau de pose
      const dk = dateKey(x.src.etatDepuis) || dateKey(x.src.dateInst);
      if (dk) { p.dateKeys = p.dateKeys || new Set(); p.dateKeys.add(dk); }
      if (x.a.brtPDR) p.brtPDR = true;
    }
    // pose forcée sur une colonne sans tronçon (ex. CP 15 : restructuration) et colonnes ajoutées par le CA
    const extra = [];
    for (const e of elements) if (e.p.cp === '15') extra.push({ col: e.code, fam: 'RES' });
    for (const [f, arr] of Object.entries(state.extraCols || {})) for (const c of arr || []) extra.push({ col: c, fam: f });
    // EOTP présents dans l'écran ORC : affichés en colonne pour voir la valeur saisie dans SAP
    const famOfNat = (nat, mat) => mat ? 'RES' : /^P21/.test(nat) ? 'BI' : /^P23/.test(nat) ? 'BC' : /^P24/.test(nat) ? 'CM' : /^P25/.test(nat) ? 'CI' : null;
    for (const d of ((state.orc && state.orc.deposeRows) || [])) { const f = famOfNat(d.nat || '', d.mat); if (f && parseEotpCode(d.eotp)) extra.push({ col: d.eotp, fam: f }); }
    for (const k of Object.keys(forces)) if (k.startsWith('POSE:')) { const c = k.slice(5); if (!poseMap[c]) { const pc = parseEotpCode(c); extra.push({ col: c, fam: pc ? famOfCp(pc.cp) : 'RES', pose: true }); } }
    for (const x of extra) {
      const pc = parseEotpCode(x.col);
      if (!poseMap[x.col] && (x.pose || forces['POSE:' + x.col])) poseMap[x.col] = { eotp: pc ? x.col : null, col: x.col, cp: pc ? pc.cp : null, toCreate: !pc, role: 'EXTRA', type: x.fam === 'RES' ? 'RES' : x.fam, fam: x.fam, chantier: pc ? pc.chantier : (chantiers[0] || ''), unit: x.fam === 'RES' ? 'm' : 'u', exact: 0, lines: [], brtPDR: false };
    }
    const pose = Object.values(poseMap).map(p => {
      p.exact = r2(p.exact);
      p.auto = ceilQ(p.exact, p.unit);
      const f = forces['POSE:' + p.col];
      p.qty = f ? +f.value : p.auto; p.forced = !!f;
      p.categorie = categorie(p.cp, p.type, p.brtPDR);
      return p;
    });

    // 4. biens déposés (matière + IN + année pour le réseau ; un bien par type pour les branchements)
    const bienMap = {};
    for (const x of active.filter(y => y.kind === 'depose')) {
      const t = x.a.type, mat = MAT_SAP[x.a.matiere] || x.a.matiere;
      const key = t === 'RES' ? `${x.chantier}|RES|${mat}|${x.a.IN || '?'}|${x.a.annee || '?'}` : `${x.chantier}|${t}`;
      const b = bienMap[key] = bienMap[key] || { key, chantier: x.chantier, type: t, fam: fam(t), mat: t === 'RES' ? mat : '', IN: t === 'RES' ? x.a.IN : '', annee: t === 'RES' ? x.a.annee : '',
        insee: inseeSAP(x.src.insee), commune: String(x.src.commune || '').replace(/\s+\d+.*$/, '').toUpperCase(), unit: unitOf(t), exact: 0, exactTube: 0, lines: [] };
      const q = t === 'RES' ? (+x.a.longueur || 0) : 1;
      b.exact += q; if (x.a.tubage) b.exactTube += q;
      b.lines.push(x.uid); x.bien = key;
      // date réelle de dépose / abandon : « Etat de service depuis » du tableau de dépose
      const dk = dateKey(x.src.etatDepuis);
      if (dk) { b.dateKeys = b.dateKeys || new Set(); b.dateKeys.add(dk); }
    }
    const biens = Object.values(bienMap).map(b => {
      b.exact = r2(b.exact); b.exactTube = r2(b.exactTube);
      b.cap = ceilQ(b.exact, b.unit);
      b.tubeCap = Math.min(b.cap, ceilQ(b.exactTube, b.unit));
      b.label = b.type === 'RES' ? `Réseau ${b.mat} ${b.IN || '?'} ${b.annee || '?'}` : TYPE_LABEL[b.type];
      b.cells = {}; b.auto = {};
      return b;
    });

    // 4 bis. CP 15 (restructuration) : la pose hors tubage qui ne remplace aucune dépose (réseau nouveau) part en CP 15 ;
    //        le remplacement d'un réseau existant (conversion de pression, changement de diamètre…) reste en CP 22
    for (const ch of [...new Set(pose.map(p => p.chantier))]) {
      const p22 = pose.find(p => p.chantier === ch && p.role === 'RES_HT');
      if (!p22 || p22.forced) continue;
      const p23 = pose.find(p => p.chantier === ch && p.role === 'RES_TUB');
      const depCap = biens.filter(b => b.chantier === ch && b.type === 'RES').reduce((s, b) => s + b.cap, 0);
      const avail = Math.max(0, depCap - (p23 ? p23.qty : 0));
      if (p22.auto <= avail) continue;
      const surplus = p22.auto - avail;
      const t15 = target(ch, 'RES_RS');
      let p15 = pose.find(p => p.col === t15.col);
      if (!p15) { p15 = { eotp: t15.eotp, col: t15.col, cp: t15.cp, toCreate: t15.toCreate, role: 'RES_RS', type: 'RES', fam: 'RES', chantier: ch, unit: 'm', exact: 0, lines: [], brtPDR: false, auto: 0, qty: 0 }; pose.push(p15); }
      p15.role = 'RES_RS'; p15.auto += surplus; p15.exact = r2(p15.exact + surplus);
      const f15 = forces['POSE:' + p15.col]; p15.qty = f15 ? +f15.value : p15.auto; p15.forced = !!f15; p15.categorie = categorie('15', 'RES');
      p22.auto = avail; p22.qty = avail;
      add('info', `${surplus} m de réseau posé en tranchée sans dépose en face : proposés en CP 15 restructuration (${t15.eotp || t15.proposed + ', élément à créer'}).`);
    }

    // 5. répartition : chaque EOTP de renouvellement reçoit en dépose sa quantité posée.
    //    Le surplus de dépose (dépose > pose) part en abandon : c'est le CA qui choisit sur quel(s) bien(s) ;
    //    l'app ne le place elle-même que s'il n'y a qu'un bien possible. Une fois le surplus placé,
    //    le reste des biens est réparti sur les EOTP de renouvellement (CP 22 puis CP 23, du plus ancien au plus récent).
    const infoBrt = new Set();
    const rankRole = r => r === 'RES_HT' ? 0 : r === 'RES_TUB' ? 1 : 2;
    const abMan = state.abManual || {}; // abandons hors carto saisis par le CA (branchements, CI, CM)
    const isAbCol = col => { const pc = parseEotpCode(col.split(' ')[0]); return pc ? pc.cp === 'AB' : /\bAB\b/.test(col); };
    const forcedOf = b => { const o = {}; const pre = 'REP:' + b.key + '|'; for (const k of Object.keys(forces)) if (k.startsWith(pre)) o[k.slice(pre.length)] = +forces[k].value || 0; return o; };
    const famWord = (F, n) => F === 'RES' ? `${fr(n)} m` : `${n} ${F === 'CI' || F === 'CM' ? 'ouvrage' : 'branchement'}${n > 1 ? 's' : ''}`;
    const chList = [...new Set(pose.map(p => p.chantier).concat(biens.map(b => b.chantier)).concat(chantiers.slice(0, 1)))];
    for (const ch of chList) {
      for (const F of ['RES', 'BI', 'BC', 'CI', 'CM']) {
        const nMan = F !== 'RES' && ch === chList[0] ? Math.max(0, Math.round(+abMan[F] || 0)) : 0;
        const bs = biens.filter(b => b.chantier === ch && b.fam === F);
        const ps = pose.filter(p => p.chantier === ch && p.fam === F);
        if (!bs.length && !ps.length && !nMan) continue;
        if (F !== 'RES' && !bs.length && !nMan && ps.some(p => p.qty > 0))
          infoBrt.add(`${TYPE_LABEL[F]} : aucune dépose dans la carto — dépose 0. Si des branchements ont été abandonnés, les saisir dans « Abandons hors carto ».`);
        // abandons hors carto : ajoutés au bien du type, ils partent en abandon (fiche Cristol : 6 BRI hors carto en AB)
        let manB = null;
        if (nMan) {
          const key = `${ch}|${F}`;
          manB = bs.find(x => x.key === key);
          if (!manB) { manB = { key, chantier: ch, type: F, fam: F, mat: '', IN: '', annee: '', insee: '', unit: 'u', exact: 0, exactTube: 0, lines: [], cap: 0, tubeCap: 0, label: TYPE_LABEL[F], cells: {}, auto: {}, virtuel: true }; biens.push(manB); bs.push(manB); }
          manB.cap += nMan; manB.manuel = nMan;
        }
        if (!bs.length) continue;
        const renew = ps.filter(p => !(p.cp === '15' || p.role === 'RES_RS')).sort((x, y) => rankRole(x.role) - rankRole(y.role));
        const tAB = target(ch, F, true);
        bs.forEach(b => { b.abCol = tAB.col; });
        const fo = {}, rem = {};
        bs.forEach(b => { fo[b.key] = forcedOf(b); rem[b.key] = b.cap - Object.values(fo[b.key]).reduce((x, y) => x + y, 0); });
        const take = (b, col, q) => { if (q <= 0 || fo[b.key][col] != null) return 0; b.auto[col] = (b.auto[col] || 0) + q; rem[b.key] -= q; return q; };
        const capTot = bs.reduce((x, b) => x + b.cap, 0);
        const poseTot = renew.reduce((x, p) => x + p.qty, 0);
        const surplus = r2(capTot - nMan - poseTot); // carto seule ; les abandons hors carto vont en AB à part
        if (manB) take(manB, tAB.col, Math.min(nMan, rem[manB.key]));
        let surplusLeft = surplus;
        const forcedAB = bs.reduce((x, b) => x + Object.entries(fo[b.key]).filter(([c]) => isAbCol(c)).reduce((y, [, v]) => y + v, 0), 0);
        surplusLeft = r2(surplusLeft - forcedAB);
        const choix = bs.filter(b => rem[b.key] > 0);
        if (surplusLeft > 0 && choix.length === 1) { take(choix[0], tAB.col, Math.min(surplusLeft, rem[choix[0].key])); surplusLeft = 0; }
        if (surplusLeft > 0) {
          // le CA choisit le(s) bien(s) abandonné(s) : rien n'est réparti tant que le surplus n'est pas placé
          bs.forEach(b => { if (b.auto[tAB.col] == null) b.auto[tAB.col] = 0; });
          add('orange', `${TYPE_LABEL[F] || 'Réseau'} : ${famWord(F, surplusLeft)} de dépose de plus que la pose, à mettre en abandon (${tAB.col}). Saisissez dans la colonne abandon le ou les biens concernés ; le reste se répartira ensuite sur les EOTP de renouvellement.`, 'fam:' + F);
          continue;
        }
        for (const p of renew) {
          let need = p.qty - bs.reduce((x, b) => x + (fo[b.key][p.col] || 0), 0);
          for (const b of bs.slice().sort((x, y) => (+x.annee || 9999) - (+y.annee || 9999) || y.cap - x.cap)) need -= take(b, p.col, Math.min(need, rem[b.key]));
        }
        if (surplus < 0) add('info', `${TYPE_LABEL[F] || 'Réseau'} : ${famWord(F, -surplus)} de pose de plus que la dépose (hors CP 15).`);
      }
    }
    infoBrt.forEach(m => add('info', m));

    // 6. cases forcées par le CA, reste à répartir
    const cols = {}; // colonne -> infos
    const addCol = (col, info) => { cols[col] = cols[col] || { col, eotp: info.eotp || null, cp: info.cp || null, toCreate: !!info.toCreate, fam: info.fam }; };
    pose.forEach(p => addCol(p.col, p));
    for (const x of extra) { const pc = parseEotpCode(x.col); addCol(x.col, { eotp: pc ? x.col : null, cp: pc ? pc.cp : null, toCreate: !pc, fam: x.fam }); }
    for (const b of biens) {
      for (const [col, q] of Object.entries(b.auto)) b.cells[col] = q;
      for (const k of Object.keys(forces)) {
        if (!k.startsWith('REP:' + b.key + '|')) continue;
        const col = k.slice(('REP:' + b.key + '|').length);
        b.cells[col] = +forces[k].value;
      }
      for (const col of Object.keys(b.cells)) {
        const pc = parseEotpCode(col);
        const pc2 = parseEotpCode(col.split(' ')[0]);
        addCol(col, { eotp: pc ? col : null, cp: pc ? pc.cp : (pc2 ? pc2.cp : ((col.match(/CP (\w+)/) || [])[1] || (/AB/.test(col) ? 'AB' : null))), toCreate: !pc, fam: b.fam });
      }
      b.total = Object.values(b.cells).reduce((s, v) => s + (+v || 0), 0);
      b.reste = r2(b.cap - b.total);
      const u = n => b.unit === 'm' ? fr(n) + ' m' : String(n);
      if (b.reste > 0) add('orange', `${b.label} : reste ${u(b.reste)} à répartir.`, 'bien:' + b.key);
      if (b.reste < 0) add('orange', `${b.label} : ${u(-b.reste)} répartis en trop (carto : ${u(b.cap)}).`, 'bien:' + b.key);
    }
    // consigne explicite d'abandon
    for (const b of biens) {
      const ab = b.abCol && b.cells[b.abCol];
      if (ab > 0 && b.auto[b.abCol] > 0) add('info', `Affecter ${b.unit === 'm' ? fr(ab) + ' m' : ab + ' ' + (b.type === 'CI' || b.type === 'CM' ? 'ouvrage' : 'branchement') + (ab > 1 ? 's' : '')} d'abandon à ${b.abCol} — ${b.label}.`);
    }

    // 7. totaux par colonne (EOTP) et test ±10 % sur les EOTP de renouvellement (VERIF_IMMO, SAISIE SAP - VERIF, colonne V)
    const eotpTotals = Object.values(cols).map(c => {
      const p = pose.find(x => x.col === c.col);
      const dep = biens.reduce((s, b) => s + (+b.cells[c.col] || 0), 0);
      const e = { ...c, pose: p ? p.qty : 0, depose: r2(dep), unit: p ? p.unit : (biens.find(b => b.cells[c.col] != null) || {}).unit || 'm' };
      e.renouv = RENEW_CP.includes(e.cp);
      e.ecart = e.pose > 0 ? (e.depose - e.pose) / e.pose : (e.depose > 0 ? Infinity : null);
      if (false && e.renouv && (e.pose > 0 || e.depose > 0)) { // test ±10 % abandonné
        e.ok10 = e.depose > 0.9 * e.pose && e.depose < 1.1 * e.pose;
        const q = n => e.unit === 'm' ? `${fr(n)} m` : `${n} ${['27'].includes(e.cp) ? 'ouvrage' : 'branchement'}${n > 1 ? 's' : ''}`;
        if (!e.ok10) add('rouge', `${c.col} (CP ${e.cp}) : écart pose/dépose de ${e.ecart === Infinity ? 'plus de 100' : fr(Math.abs(e.ecart) * 100)} % (> 10 %) — pose : ${q(e.pose)}, dépose : ${q(e.depose)}.`, 'eotp:' + c.col);
      }
      return e;
    });

    // 8. PDR : détectés dans les désignations SAP + ajouts manuels
    const pdr = [];
    for (const e of elements) {
      const des = String(e.designation || '');
      const m = des.match(/D\d{5}-PDR\d{5}/i);
      const isPoste = m || /\bposte\b|\bPDR\b/i.test(des);
      if (isPoste) pdr.push({ key: 'auto:' + e.code, pdr: m ? m[0].toUpperCase() : 'n° non indiqué (' + des.replace(/\(abandon\)/i, '').trim() + ')', eotp: e.code, nature: e.p.cp === 'AB' ? 'Abandon' : 'Pose', auto: true, sansNumero: !m });
    }
    for (const p of (state.pdrManual || [])) pdr.push({ key: 'man:' + p.id, pdr: p.pdr, eotp: p.eotp, nature: p.nature, auto: false, id: p.id });
    for (const p of pdr) {
      for (const f of ['pdr', 'eotp', 'nature']) { const k = `P:${p.key}:${f}`; if (forces[k]) { p['auto_' + f] = p[f]; p[f] = forces[k].value; } }
      const pp = parseEotpCode(p.eotp || '');
      p.cp = pp ? pp.cp : null;
      p.categorie = categorie(p.cp, 'PDR');
    }
    if (pdr.length) add('info', `${pdr.length} PDR détecté(s) : ${pdr.map(p => p.pdr).join(', ')}.`);

    // 9. lignes à saisir dans SAP (format écran ORC)
    // dates à saisir : la plus récente du tableau carto ; signalées si plusieurs
    const allDep = new Set(); biens.forEach(b => (b.dateKeys || []).forEach(k => allDep.add(k)));
    const allPose = new Set(); pose.forEach(p => (p.dateKeys || []).forEach(k => allPose.add(k)));
    const latest = set => set && set.size ? keyDisp(Math.max(...set)) : '';
    for (const p of pose) {
      p.dateMES = latest(p.dateKeys) || latest(allPose);
      if (p.dateKeys && p.dateKeys.size > 1) add('info', `${p.col} : plusieurs dates de mise en service dans la carto (${[...p.dateKeys].sort().map(keyDisp).join(', ')}) — la plus récente est proposée.`);
    }
    for (const b of biens) b.dateDep = latest(b.dateKeys) || latest(allDep) || latest(allPose);
    const sapDepose = [];
    for (const b of biens) for (const [col, q] of Object.entries(b.cells)) if (+q > 0) {
      const c = cols[col] || {};
      const el = elements.find(e => e.code === c.eotp);
      sapDepose.push({ col, eotp: c.eotp, cp: c.cp, bien: b.key, label: b.label, type: b.type, mat: b.mat, IN: b.IN, annee: b.annee, date: b.dateDep, qty: +q,
        insee: b.insee || (pose[0] && pose[0].insee) || '', commune: b.commune || (pose[0] && pose[0].commune) || '', designation: el ? el.designation : '', libMat: LIB_MAT[b.mat] || '', diamTxt: b.type === 'RES' ? diamTxt(b.mat, b.IN) : '', unit: b.unit, categorie: categorie(c.cp, b.type), forced: !!forces['REP:' + b.key + '|' + col] });
    }

    // 10. EOTP non utilisés (information)
    const used = new Set(Object.keys(cols).concat(pdr.map(p => p.eotp)));
    const unused = elements.filter(e => !used.has(e.code));
    for (const e of unused) add('info', `EOTP A EXCLURE : ${e.code} (${e.designation || 'sans désignation'}) — rien à y affecter, ne pas le reporter dans la dépose (écran ORC).`, 'eotp:' + e.code);

    const R = { lines: L, pose, biens, cols: Object.values(cols), eotpTotals, sapDepose, pdr, controls, unused, chantiers,
      elements: elements.map(e => ({ code: e.code, designation: e.designation, cp: e.p.cp })) };

    // 11. écran ORC (facultatif)
    if (state.orc && ((state.orc.eotpRows || []).length || (state.orc.deposeRows || []).length)) {
      R.orc = compareOrc(R, state.orc);
      if (state.orcVerified === false) add('orange', "Écran ORC lu sur capture : à vérifier par rapport à SAP puis cocher « Écran ORC vérifié » (onglet Captures SAP).");
      if (R.orc.nbControle) add('orange', `Contrôle de la saisie SAP (écran ORC) : ${R.orc.nbControle} point${R.orc.nbControle > 1 ? 's' : ''} à vérifier.`);
    }
    {
      R.dt = checkDt(R, state.dt);
      if (state.dt && state.dt.length && state.dtVerified === false) add('orange', "Écrans Descr. tech. lus sur capture : à vérifier par rapport à SAP puis cocher « Écrans Descr. tech. vérifiés » (onglet Captures SAP).");
      if (R.dt.nb) add('orange', `Contrôle de la saisie SAP (écrans Descr. tech., pose) : ${R.dt.nb} point${R.dt.nb > 1 ? 's' : ''} à vérifier.`);
    }

    // 12. verdict
    const bad = controls.filter(c => c.level === 'rouge' || c.level === 'orange').length;
    R.autoVerdict = bad ? 'ÉCARTS À CORRIGER' : 'VALIDATION OK';
    R.verdict = forces.VERDICT ? forces.VERDICT.value : R.autoVerdict;
    return R;
  }

  // ---------- Écran SAP « ORC – Dépose des immobilisations » ----------
  const numFr = v => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
  const fixNat = n => { let t = String(n).toUpperCase().replace(/[^A-Z0-9]/g, ''); const q = t.match(/^([A-Z])([0-9OIL]{2})([EF])$/); if (q) t = q[1] + q[2].replace(/O/g, '0').replace(/[IL]/g, '1') + q[3]; const m = t.match(/^([A-Z])[A-Z]?(\d{2}[EF])$/); return m ? m[1] + m[2] : t; };
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
      const tail = after.match(/(?:\s(\d{4}))?\s+([\d.,]+)\s+(M|PCE|U|ML)\s+([\d.,]+)?\s*([A-Z]{1,4})?\s*(\d{2}[./]\d{2}[./]\d{4})?\s*$/i);
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

  // Comparaison écran ORC / répartition proposée (INSEE ignoré : la carto donne l'arrondissement, SAP la commune)
  const orcKey = (eotp, mat, IN, annee) => mat ? `${eotp}|${mat}|${IN}|${annee}` : `${eotp}|-`;
  // écran « Afficher / Modifier élément OTP », onglet Descr. tech. (une capture par EOTP)
  function parseDtText(text) {
    const t = String(text || '');
    const g = (re, f) => { const m = t.match(re); return m ? (f ? f(m) : m[1]) : null; };
    const d8 = m => `${m[1]}/${m[2]}/${m[3]}`;
    const DATE = '[^\\d\\n]{0,14}?(\\d{2})[.\\/,](\\d{2})[.\\/,](\\d{4})';
    const out = {
      dateMes: g(new RegExp('Date MES r[ée]elle' + DATE, 'i'), d8),
      dateMesPrev: g(new RegExp('Date MES pr[ée]vi\\w*' + DATE, 'i'), d8),
      dateCloture: g(new RegExp('cl[ôo]ture pr[ée]v' + DATE, 'i'), d8),
      qte: g(/Qt[ée][ \t]*r[ée]elle[ \t]*\(?en serv\)?[ \t]*[\[(|]?[ \t]*([\d][\d .,]*)/i, m => numFr(m[1].trim())),
      unite: g(/Unit[ée] mes(?!ure)\.?[ \t]*[\[(|]?[ \t]*([A-Z]{1,3})\b/i, m => m[1].toUpperCase()),
      insee: g(/Code INSEE[ \t]*[\[(|]?[ \t]*(\d{5})/i),
      codePlan: g(/Code Plan[ \t]*[\[(|]?[ \t]*([0-9]{2}|AB)\b/i),
      codeMat: g(/Code mati[èe]re[ \t]*[\[(|]?[ \t]*([A-Z]{1,3})\b/i, m => m[1].toUpperCase()),
      diametre: g(/Diam[èe]tre[ \t]*[\[(|]?[ \t]*([A-Z]{0,3}[ \t]?\d{2,4})/i, m => m[1].replace(/\s/g, '').toUpperCase()),
      pression: g(/Pression pos[ée]e[ \t]*[\[(|]?[ \t]*([A-Z]{2,4})\b/i, m => m[1].toUpperCase()),
      qtePrev: g(/Quantit[ée] pr[ée]v[ \t]*[\[(|]?[ \t]*([\d][\d .,]*)/i, m => numFr(m[1].trim())),
      nat: g(/Nature d.ouvrage[ \t]*[\[(|]?[ \t]*([A-Z0-9]{4})\b/i, m => fixNat(m[1])),
    };
    // élément d'OTP : lecture directe, sinon n° d'affaire + Cx + code plan (rapproché ensuite des EOTP connus)
    const line = (t.match(/El[ée]ment d.OTP[^\n]*/i) || [''])[0];
    const tok = (line.replace(/El[ée]ment d.OTP/i, '').match(/[A-Za-z0-9][A-Za-z0-9=€\-–—_.]{12,}/) || [''])[0];
    const clean = tok.replace(/€/g, 'C').replace(/[=_.–—]/g, '-');
    if (out.diametre) { const m = out.diametre.match(/^(PE|AC|A|FD|FG)?(.+)$/); if (m) out.diametre = (m[1] || '') + m[2].replace(/O/g, '0').replace(/[IL]/g, '1'); }
    out.eotpRaw = tok;
    out.eotp = fixEotp(clean) || null;
    if (out.eotp && !(parseEotpCode(out.eotp) || {}).elem) out.eotp = null;
    out.affaire = (t.match(/(\d{7})/) || [])[1] || null;
    out.chantierNo = (clean.match(/-C(\d{1,2})-/i) || [])[1] || null;
    return out;
  }
  // rapproche une capture Descr. tech. d'un EOTP de pose ; contrôle les valeurs saisies
  function checkDt(R, dts) {
    const out = { rows: [], captures: [], nb: 0 };
    if (!dts || !dts.length) return out;
    const poseE = R.pose.filter(p => p.eotp);
    for (const d of dts) {
      let eotp = d.eotpChoisi || null, sure = !!d.eotpChoisi;
      if (!eotp && d.eotp && poseE.some(p => p.eotp === d.eotp)) { eotp = d.eotp; sure = true; }
      if (!eotp) {
        const c = poseE.filter(p => (!d.affaire || p.eotp.includes(d.affaire)) && (!d.codePlan || p.cp === d.codePlan) && (!d.chantierNo || p.eotp.includes('-C' + d.chantierNo + '-')));
        if (c.length === 1) eotp = c[0].eotp; else if (c.length) eotp = c[0].eotp;
        sure = c.length === 1;
      }
      // EOTP lu, connu dans la liste SAP mais sans pose dans la carto (ex. CP 16, AB) : reconnu, sans valeur attendue
      let raison = null;
      const elems = (R.elements || []).map(e => e.code);
      if (!eotp && d.eotp && elems.includes(d.eotp)) { eotp = d.eotp; sure = true; }
      if (eotp && !poseE.some(p => p.eotp === eotp)) raison = R.pose.length ? 'sansPose' : 'pasDeCarto';
      if (!eotp) raison = !R.pose.length ? 'pasDeCarto' : !elems.length ? 'pasDeListe' : (!d.eotp ? 'codeIllisible' : 'absentListe');
      out.captures.push({ ...d, eotpRetenu: eotp, sure, raison });
    }
    for (const c of out.captures) if (c.raison === 'sansPose') out.rows.push({ eotp: c.eotpRetenu, champ: 'Qté réelle (en serv)', attendu: 'aucune pose dans la carto', sap: c.qte == null ? '—' : fmtN(c.qte), ok: null, info: 'EOTP sans pose dans la carto' });
    for (const p of poseE) {
      const d = out.captures.find(x => x.eotpRetenu === p.eotp);
      if (!d) { out.rows.push({ eotp: p.eotp, champ: 'Capture', attendu: '', sap: '', ok: null, info: 'pas de capture' }); continue; }
      const push = (champ, attendu, sap, ok, info) => { out.rows.push({ eotp: p.eotp, champ, attendu, sap: sap == null ? '—' : sap, ok, info }); if (ok === false) out.nb++; };
      // champ vide sur la capture (capture prise avant la saisie) : valeur à saisir, pas une erreur
      const aSaisir = (champ, attendu) => out.rows.push({ eotp: p.eotp, champ, attendu, sap: '—', ok: null, info: 'pas encore saisi : à saisir' });
      if (!d.sure) push('Élément d\'OTP', p.eotp, d.eotpRaw || '?', false, 'EOTP lu sur la capture incertain : vérifiez');
      if (d.qte == null) aSaisir('Qté réelle (en serv)', fmtN(p.qty)); else push('Qté réelle (en serv)', fmtN(p.qty), fmtN(d.qte), Math.abs(d.qte - p.qty) < EPS);
      if (p.unit === 'm') push('Unité mes.', 'M', d.unite, d.unite === 'M');
      if (!d.dateMes) aSaisir('Date MES réelle', p.dateMES || ''); else push('Date MES réelle', p.dateMES || '', d.dateMes, d.dateMes === p.dateMES);
      if (!d.dateCloture) aSaisir('Date de clôture prév', 'ni le 1er ni le dernier jour du mois');
      else {
        const [dd, mm, yy] = d.dateCloture.split('/').map(Number);
        const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        push('Date de clôture prév', 'ni le 1er ni le dernier jour du mois', d.dateCloture, dd !== 1 && dd !== last);
      }
      if (d.codePlan) push('Code Plan', p.cp || '', d.codePlan, d.codePlan === p.cp);
      const mats = [...(p.dtMat || [])], diams = [...(p.dtDiam || [])], press = [...(p.dtPress || [])];
      if (d.codeMat && mats.length) push('Code matière', mats.join(' / '), d.codeMat, mats.includes(d.codeMat), 'information');
      if (d.diametre && diams.length) { const n = +(d.diametre.match(/\d+/) || [0])[0]; push('Diamètre', diams.map(x => (mats[0] === 'PE' ? 'PE' : '') + String(x).padStart(3, '0')).join(' / '), d.diametre, diams.includes(n), 'information'); }
      if (d.pression && press.length) push('Pression posée', press.join(' / '), d.pression, press.includes(d.pression), 'information');
      if (p.categorie) { if (d.nat) push('Nature d\'ouvrage', p.categorie, d.nat, p.categorie.split(' / ').includes(d.nat)); else out.rows.push({ eotp: p.eotp, champ: 'Nature d\'ouvrage', attendu: p.categorie, sap: '—', ok: null, info: 'non lue sur la capture (la saisir dans « Description technique et Données de base », onglet Captures SAP)' }); }
    }
    return out;
  }
  const fmtN = n => String(r2(n)).replace('.', ',');

  function compareOrc(R, orc) {
    const out = { pose: [], depose: [], inventaire: [], cellMap: {}, poseMap: {} };
    if (!orc) return out;
    // pose par EOTP
    const poseApp = {};
    for (const p of R.pose) if (p.eotp) poseApp[p.eotp] = (poseApp[p.eotp] || 0) + p.qty;
    const seenP = new Set();
    for (const e of orc.eotpRows || []) {
      seenP.add(e.eotp); out.poseMap[e.eotp] = e.reel;
      const app = poseApp[e.eotp] ?? 0;
      out.pose.push({ ...e, app, ok: e.reel != null && Math.abs(e.reel - app) < EPS });
    }
    if ((orc.eotpRows || []).length) for (const k of Object.keys(poseApp)) if (!seenP.has(k)) out.pose.push({ eotp: k, prev: null, reel: null, unit: (R.pose.find(p => p.eotp === k) || {}).unit === 'm' ? 'M' : 'PCE', nat: '', app: poseApp[k], ok: false, absent: true });
    // dépose : par EOTP + matière + IN + année (réseau), par EOTP (branchements, postes)
    const depApp = {};
    for (const s of R.sapDepose) if (s.eotp) { const k = s.type === 'RES' ? orcKey(s.eotp, s.mat, s.IN, s.annee) : orcKey(s.eotp); depApp[k] = (depApp[k] || 0) + s.qty; }
    for (const p of R.pdr || []) if (p.eotp) { const k = orcKey(p.eotp); depApp[k] = (depApp[k] || 0) + 1; }
    const seenD = new Set();
    for (const d of orc.deposeRows || []) {
      const k = orcKey(d.eotp, d.mat, d.IN, d.annee);
      seenD.add(k); out.cellMap[k] = (out.cellMap[k] || 0) + (d.reel || 0);
      const app = depApp[k] ?? 0;
      out.depose.push({ ...d, key: k, app, ok: d.reel != null && Math.abs(d.reel - app) < EPS });
    }
    if ((orc.deposeRows || []).length) for (const k of Object.keys(depApp)) if (!seenD.has(k)) {
      const [eotp, mat, IN, annee] = k.split('|');
      out.depose.push({ eotp, mat: mat === '-' ? '' : mat, IN: IN || null, annee: annee ? +annee : null, designation: '', prev: null, reel: null, unit: mat !== '-' ? 'M' : 'PCE', app: depApp[k], ok: false, absent: true, key: k });
    }
    // inventaire : quantité du bien dans SAP (« Qté prév. dépose ») face à la carto
    const inv = {};
    for (const d of orc.deposeRows || []) if (d.mat) { const k = `${d.mat}|${d.IN}|${d.annee}`; inv[k] = Math.max(inv[k] || 0, d.prev || 0); }
    for (const [k, sap] of Object.entries(inv)) {
      const [mat, IN, annee] = k.split('|');
      const b = R.biens.find(x => x.type === 'RES' && x.mat === mat && x.IN === IN && String(x.annee) === annee);
      out.inventaire.push({ mat, IN, annee: +annee, sap, carto: b ? b.cap : 0, ok: b ? Math.abs(b.cap - sap) < EPS : false });
    }
    for (const b of R.biens) if (b.type === 'RES' && !inv[`${b.mat}|${b.IN}|${b.annee}`]) out.inventaire.push({ mat: b.mat, IN: b.IN, annee: b.annee, sap: null, carto: b.cap, ok: false });
    // contrôle de la saisie du CA : l'écran ORC face à la carto (et non face à la répartition proposée par l'app)
    const famOfRow = d => {
      if (d.mat) return 'RES';
      const n = d.nat || '';
      if (/^S31/.test(n)) return 'PDR';
      if (/^P21/.test(n)) return 'BI'; if (/^P23/.test(n)) return 'BC'; if (/^P25/.test(n)) return 'CI'; if (/^P24/.test(n)) return 'CM';
      const pc = parseEotpCode(d.eotp) || {};
      return ({ '25': 'BI', '20': 'BI', '26': 'BC', '21': 'BC', '22': 'RES', '23': 'RES', '17': 'RES', '18': 'RES', '15': 'RES' })[pc.cp] || '?';
    };
    const chOf = code => (parseEotpCode(code) || {}).chantier || '';
    const rows = (orc.deposeRows || []).map(d => ({ ...d, fam: famOfRow(d), ch: chOf(d.eotp), cp: (parseEotpCode(d.eotp) || {}).cp || null }));
    const C = out.controle = { biens: [], equilibre: [], abandon: [], dates: [], nat: [] };
    if (rows.length) {
      // 1. chaque bien de la carto : total saisi dans SAP (toutes EOTP confondues) = quantité carto
      const bienKeyOf = d => d.fam === 'RES' ? `${d.ch}|RES|${d.mat}|${d.IN}|${d.annee}` : `${d.ch}|${d.fam}`;
      const sapB = {};
      for (const d of rows) if (d.fam !== 'PDR' && d.fam !== '?') { const k = bienKeyOf(d); sapB[k] = (sapB[k] || 0) + (d.reel || 0); }
      for (const b of R.biens) {
        const sap = sapB[b.key] ?? 0;
        C.biens.push({ label: b.label + (b.manuel ? ` (dont ${b.manuel} hors carto)` : ''), unit: b.unit, attendu: b.cap, sap, ok: Math.abs(sap - b.cap) < EPS });
      }
      for (const [k, sap] of Object.entries(sapB)) if (!R.biens.some(b => b.key === k)) {
        const [, fam, mat, IN, annee] = k.split('|');
        C.biens.push({ label: fam === 'RES' ? `Réseau ${mat} ${IN} ${annee}` : TYPE_LABEL[fam], unit: fam === 'RES' ? 'm' : 'u', attendu: 0, sap, ok: false, horsCarto: true });
      }
      // 2. chaque EOTP de renouvellement : dépose saisie = quantité posée
      const poseSap = {}; for (const e of orc.eotpRows || []) poseSap[e.eotp] = e.reel;
      const eotps = new Set(R.pose.filter(p => p.eotp && RENEW_CP.includes(p.cp)).map(p => p.eotp));
      rows.forEach(d => { if (RENEW_CP.includes(d.cp)) eotps.add(d.eotp); });
      for (const e of eotps) {
        const p = R.pose.find(x => x.eotp === e);
        const pose = poseSap[e] != null ? poseSap[e] : (p ? p.qty : 0);
        const dep = rows.filter(d => d.eotp === e).reduce((x, d) => x + (d.reel || 0), 0);
        C.equilibre.push({ eotp: e, unit: p ? p.unit : (rows.find(d => d.eotp === e) || {}).unit === 'M' ? 'm' : 'u', pose, src: poseSap[e] != null ? 'SAP' : 'carto', dep, ok: Math.abs(pose - dep) < EPS });
      }
      // 3. abandon par famille : total en AB = surplus de la carto (dépose − pose renouvelée) + abandons hors carto
      const fams = [...new Set(R.biens.map(b => b.chantier + '|' + b.fam).concat(rows.filter(d => d.cp === 'AB' && d.fam !== '?' && d.fam !== 'PDR').map(d => d.ch + '|' + d.fam)))];
      for (const cf of fams) {
        const [ch, fam] = cf.split('|');
        const bs = R.biens.filter(b => b.chantier === ch && b.fam === fam);
        const carto = bs.reduce((x, b) => x + b.cap - (b.manuel || 0), 0), man = bs.reduce((x, b) => x + (b.manuel || 0), 0);
        const posee = R.pose.filter(p => p.chantier === ch && p.fam === fam && RENEW_CP.includes(p.cp)).reduce((x, p) => x + p.qty, 0);
        const attendu = Math.max(0, r2(carto - posee)) + man;
        const sap = rows.filter(d => d.ch === ch && d.fam === fam && d.cp === 'AB').reduce((x, d) => x + (d.reel || 0), 0);
        C.abandon.push({ fam, label: TYPE_LABEL[fam], unit: fam === 'RES' ? 'm' : 'u', depose: carto, pose: posee, man, attendu, sap, ok: Math.abs(attendu - sap) < EPS });
      }
      // 3 bis. nature d'ouvrage saisie par le CA sur chaque ligne de dépose
      C.nat = [];
      for (const d of rows) {
        if (d.fam === '?' || !d.cp) continue;
        const att = categorie(d.cp, d.fam);
        if (!att || att === '—' || att === '?') continue;
        if (!att.split(' / ').includes(d.nat || '')) C.nat.push({ eotp: d.eotp, label: d.fam === 'RES' ? `${d.mat} ${d.IN} ${d.annee}` : (TYPE_LABEL[d.fam] || d.fam), sap: d.nat || '—', attendu: att });
      }
      // 4. dates de dépose : la plus récente « Etat de service depuis » de la carto
      const dateCarto = {}; for (const b of R.biens) if (b.dateDep) dateCarto[b.key] = b.dateDep;
      const norm8 = t => String(t || '').replace(/\./g, '/');
      for (const d of rows) {
        if (d.fam === 'PDR' || d.fam === '?' || !d.date) continue;
        const att = dateCarto[bienKeyOf(d)];
        if (att && norm8(d.date) !== att) C.dates.push({ eotp: d.eotp, label: d.fam === 'RES' ? `${d.mat} ${d.IN} ${d.annee}` : TYPE_LABEL[d.fam], sap: norm8(d.date), attendu: att });
      }
    }
    out.nbControle = C.biens.filter(x => !x.ok).length + C.equilibre.filter(x => !x.ok).length + C.abandon.filter(x => !x.ok).length + C.dates.length + C.nat.length + out.pose.filter(x => !x.ok).length;
    out.nbEcarts = out.pose.filter(x => !x.ok).length + out.depose.filter(x => !x.ok).length;
    return out;
  }

  const api = { compute, parseDtText, checkDt, MAT_SAP, inseeSAP, diamTxt, LIB_MAT, parseOrcText, compareOrc, parseCarto, parseOcrText, fixEotp, parseEotpCode, classeIN, categorie, autoAttrs, typeOf, TYPE_LABEL, RENEW_CP, yearOf, norm, dateDisp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VIEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
