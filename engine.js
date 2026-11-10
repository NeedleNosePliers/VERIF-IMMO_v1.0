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
    function target(chantier, role, isAB) {
      const t = isAB ? findAB(chantier, role) : findCP(chantier, ROLE_CP[role]);
      const key = (chantier || '?') + '|' + role + '|' + (isAB ? 'AB' : 'CP');
      if (!t.eotp && !seenMsg[key]) {
        seenMsg[key] = 1;
        add('rouge', isAB
          ? `Élément « ${t.label} » absent de la liste SAP${chantier ? ' (' + chantier + ')' : ''} : à créer ou à vérifier.`
          : `CP ${t.cp} à créer${chantier ? ' (' + chantier + ')' : ''} : aucun élément d'OTP en CP ${ROLE_CP[role].join(' ou ')} dans la liste SAP.`);
      } else if (t.multiple && !seenMsg[key + 'm']) {
        seenMsg[key + 'm'] = 1;
        add('orange', `Plusieurs EOTP possibles pour ${isAB ? t.label : 'le CP ' + t.cp} : ${t.all.join(', ')}. ${t.eotp} retenu par défaut — modifier la répartition si besoin.`);
      }
      // colonne de repli quand l'EOTP n'existe pas : « CP 23 à créer »
      t.col = t.eotp || (isAB ? `${t.label} (à créer)` : `CP ${t.cp} à créer`);
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
        insee: x.src.insee, unit: unitOf(t), exact: 0, exactTube: 0, lines: [] };
      const q = t === 'RES' ? (+x.a.longueur || 0) : 1;
      b.exact += q; if (x.a.tubage) b.exactTube += q;
      b.lines.push(x.uid); x.bien = key;
    }
    const biens = Object.values(bienMap).map(b => {
      b.exact = r2(b.exact); b.exactTube = r2(b.exactTube);
      b.cap = ceilQ(b.exact, b.unit);
      b.tubeCap = Math.min(b.cap, ceilQ(b.exactTube, b.unit));
      b.label = b.type === 'RES' ? `Réseau ${b.mat} ${b.IN || '?'} ${b.annee || '?'}` : TYPE_LABEL[b.type];
      b.cells = {}; b.auto = {};
      return b;
    });

    // 5. répartition automatique : chaque EOTP de renouvellement reçoit en dépose la quantité posée ; le reste du bien part en AB
    //    réseau : le CP 23 (tubage) puise d'abord dans la partie tubée des biens, le CP 22 dans la partie non tubée
    const infoBrt = new Set();
    for (const ch of [...new Set(pose.map(p => p.chantier).concat(biens.map(b => b.chantier)))]) {
      for (const F of ['RES', 'BI', 'BC', 'CI', 'CM']) {
        const bs = biens.filter(b => b.chantier === ch && b.fam === F);
        const ps = pose.filter(p => p.chantier === ch && p.fam === F);
        if (!bs.length && !ps.length) continue;
        const rem = {}, tub = {};
        bs.forEach(b => { rem[b.key] = b.cap; tub[b.key] = b.tubeCap; });
        const take = (b, col, q) => { if (q <= 0) return 0; b.auto[col] = (b.auto[col] || 0) + q; rem[b.key] -= q; tub[b.key] = Math.min(tub[b.key], rem[b.key]); return q; };
        const order = (ps.find(p => p.role === 'RES_TUB') ? ['RES_TUB'] : []).concat(ps.filter(p => p.role !== 'RES_TUB').map(p => p.role));
        for (const role of [...new Set(order)]) {
          const p = ps.find(q => q.role === role); if (!p) continue;
          let need = p.qty;
          const byTube = (x, y) => tub[y.key] - tub[x.key] || rem[y.key] - rem[x.key];
          const byNonTube = (x, y) => (rem[y.key] - tub[y.key]) - (rem[x.key] - tub[x.key]) || rem[y.key] - rem[x.key];
          if (role === 'RES_TUB') {
            for (const b of bs.slice().sort(byTube)) need -= take(b, p.col, Math.min(need, tub[b.key]));
            for (const b of bs.slice().sort(byNonTube)) need -= take(b, p.col, Math.min(need, rem[b.key]));
          } else {
            for (const b of bs.slice().sort(byNonTube)) need -= take(b, p.col, Math.min(need, rem[b.key] - tub[b.key]));
            for (const b of bs.slice().sort(byTube)) need -= take(b, p.col, Math.min(need, rem[b.key]));
          }
          // branchements posés sans branchements déposés dans la carto : dépose proposée = pose (à vérifier)
          if (need > 0 && F !== 'RES' && !bs.length) {
            const key = `${ch}|${F}`;
            const b = { key, chantier: ch, type: F, fam: F, mat: '', IN: '', annee: '', insee: '', unit: 'u', exact: 0, exactTube: 0, lines: [], cap: need, tubeCap: 0,
              label: TYPE_LABEL[F], cells: {}, auto: {}, virtuel: true };
            biens.push(b); bs.push(b); rem[key] = need; tub[key] = 0;
            need -= take(b, p.col, need);
            infoBrt.add(`${TYPE_LABEL[F]} : aucun branchement déposé dans la carto — dépose proposée égale à la pose (${b.cap}), à vérifier dans SAP.`);
          }
        }
        // reste des biens -> AB
        const tAB = bs.some(b => rem[b.key] > 0) ? target(ch, F, true) : null;
        for (const b of bs) if (rem[b.key] > 0) take(b, tAB.col, rem[b.key]);
        if (tAB) bs.forEach(b => { b.abCol = tAB.col; });
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
        addCol(col, { eotp: pc ? col : null, cp: pc ? pc.cp : (col.match(/CP (\w+)/) || [])[1] || (/AB/.test(col) ? 'AB' : null), toCreate: !pc, fam: b.fam });
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
      if (ab > 0) add('info', `Affecter ${b.unit === 'm' ? fr(ab) + ' m' : ab + ' ' + (b.type === 'CI' || b.type === 'CM' ? 'ouvrage' : 'branchement') + (ab > 1 ? 's' : '')} d'abandon à ${b.abCol} — ${b.label}.`);
    }

    // 7. totaux par colonne (EOTP) et test ±10 % sur les EOTP de renouvellement (VERIF_IMMO, SAISIE SAP - VERIF, colonne V)
    const eotpTotals = Object.values(cols).map(c => {
      const p = pose.find(x => x.col === c.col);
      const dep = biens.reduce((s, b) => s + (+b.cells[c.col] || 0), 0);
      const e = { ...c, pose: p ? p.qty : 0, depose: r2(dep), unit: p ? p.unit : (biens.find(b => b.cells[c.col] != null) || {}).unit || 'm' };
      e.renouv = RENEW_CP.includes(e.cp);
      e.ecart = e.pose > 0 ? (e.depose - e.pose) / e.pose : (e.depose > 0 ? Infinity : null);
      if (e.renouv && (e.pose > 0 || e.depose > 0)) {
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
    const sapDepose = [];
    for (const b of biens) for (const [col, q] of Object.entries(b.cells)) if (+q > 0) {
      const c = cols[col] || {};
      sapDepose.push({ col, eotp: c.eotp, cp: c.cp, bien: b.key, label: b.label, type: b.type, mat: b.mat, IN: b.IN, annee: b.annee, qty: +q, unit: b.unit, categorie: categorie(c.cp, b.type), forced: !!forces['REP:' + b.key + '|' + col] });
    }

    // 10. EOTP non utilisés (information)
    const used = new Set(Object.keys(cols).concat(pdr.map(p => p.eotp)));
    const unused = elements.filter(e => !used.has(e.code));
    for (const e of unused) add('info', `EOTP A EXCLURE : ${e.code} (${e.designation || 'sans désignation'}) — rien à y affecter.`, 'eotp:' + e.code);

    const R = { lines: L, pose, biens, cols: Object.values(cols), eotpTotals, sapDepose, pdr, controls, unused, chantiers,
      elements: elements.map(e => ({ code: e.code, designation: e.designation, cp: e.p.cp })) };

    // 11. écran ORC (facultatif)
    if (state.orc && ((state.orc.eotpRows || []).length || (state.orc.deposeRows || []).length)) {
      R.orc = compareOrc(R, state.orc);
      if (state.orcVerified === false) add('orange', "Écran ORC lu sur capture : à vérifier par rapport à SAP puis cocher « Écran ORC vérifié » (onglet Captures SAP).");
      if (R.orc.nbEcarts) add('orange', `Écran ORC : ${R.orc.nbEcarts} valeur${R.orc.nbEcarts > 1 ? 's' : ''} saisie${R.orc.nbEcarts > 1 ? 's' : ''} dans SAP différente${R.orc.nbEcarts > 1 ? 's' : ''} de la répartition proposée.`);
    }

    // 12. verdict
    const bad = controls.filter(c => c.level === 'rouge' || c.level === 'orange').length;
    R.autoVerdict = bad ? 'ÉCARTS À CORRIGER' : 'VALIDATION OK';
    R.verdict = forces.VERDICT ? forces.VERDICT.value : R.autoVerdict;
    return R;
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
    for (const k of Object.keys(poseApp)) if (!seenP.has(k)) out.pose.push({ eotp: k, prev: null, reel: null, unit: (R.pose.find(p => p.eotp === k) || {}).unit === 'm' ? 'M' : 'PCE', nat: '', app: poseApp[k], ok: false, absent: true });
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
    for (const k of Object.keys(depApp)) if (!seenD.has(k)) {
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
    out.nbEcarts = out.pose.filter(x => !x.ok).length + out.depose.filter(x => !x.ok).length;
    return out;
  }

  const api = { compute, MAT_SAP, parseOrcText, compareOrc, parseCarto, parseOcrText, fixEotp, parseEotpCode, classeIN, categorie, autoAttrs, typeOf, TYPE_LABEL, RENEW_CP, yearOf, norm, dateDisp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VIEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
