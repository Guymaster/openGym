// Builds an openGym plan file (opengym_plan 1, programme_fmt 1) from the 6-month programme PDF.
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
const X = {
  squat: '0043', bench: '0025', row: '0027', plank: '0463', dead: '0032', ohp: '1162', pull: '0652',
  lat: '0198', lunge: '0336', incdb: '0314', rdl: '0085', dbrow: '2393', curl: '0031', dbcurl: '0294',
  triext: '2188', dbbench: '0289', latraise: '0334', dbohp: '0405', legpress: '0739', pushdown: '0201',
  bulg: '2290', incbar: '0047', seatrow: '0861', legcurl: '0586', hammer: '0313', dips: '0814',
  walk: '4295', pushup: '0662',
}

// ---- Bloc 1 : force ----
const N1 = 'S1-3 : 4×6, repos 2-3 min · S4-6 : 5×4, repos 3 min · S7-8 : 5×3 (+1 série sur le 1er exercice) · S9 allégée : 3×5 à −20 %. Toutes les reps réussies : +2,5 kg (haut du corps) ou +5 kg (squat, soulevé de terre).'
const main1 = (id, extra = {}) => ({ id, sets: 4, reps: 6, restSec: 150, note: N1, ...extra })
const r1 = [
  { id: 'b1a', name: 'Force · Séance A', ex: [main1(X.squat), main1(X.bench), main1(X.row),
    { id: X.plank, mode: 'time', sets: 3, sec: 30, restSec: 60, note: '3 × 30 à 45 s' }] },
  { id: 'b1b', name: 'Force · Séance B', ex: [main1(X.dead), main1(X.ohp), main1(X.pull, { subs: [X.lat], note: N1 + ' Sinon : tirage vertical à la poulie.' }),
    { id: X.lunge, sets: 3, reps: 8, side: true, restSec: 90, note: '3 × 8 par jambe' }] },
  { id: 'b1c', name: 'Force · Séance C', ex: [main1(X.squat), main1(X.incdb), main1(X.rdl), main1(X.dbrow),
    { id: X.curl, sets: 2, reps: 10, restSec: 60 }, { id: X.triext, sets: 2, reps: 10, restSec: 60 }] },
]

// ---- Bloc 2 : prise de muscle ----
const N2 = 'S10-12 : 4×6-8, repos 2 min · S13-15 : 3×12-15, repos 60-90 s · S16-17 : 4×8-10, repos 90 s · S18 allégée : 2×10 à −20 %.'
const N2iso = N2 + ' S16-17 : dernière série jusqu’à l’échec.'
const N2last = N2iso + ' S16-17 : + une série dégressive (dropset).'
const m2 = (id, note = N2) => ({ id, sets: 4, reps: 8, repsMin: 6, repsMax: 8, restSec: 120, note })
const r2 = [
  { id: 'b2a', name: 'Muscle · Séance A', ex: [m2(X.squat), m2(X.dbbench), m2(X.lat), m2(X.latraise, N2iso), m2(X.dbcurl, N2last)] },
  { id: 'b2b', name: 'Muscle · Séance B', ex: [m2(X.rdl), m2(X.dbohp), m2(X.row), m2(X.legpress), m2(X.pushdown, N2last)] },
  { id: 'b2c', name: 'Muscle · Séance C', ex: [{ ...m2(X.bulg), side: true }, m2(X.incbar), m2(X.seatrow), m2(X.legcurl, N2iso), m2(X.hammer, N2iso), m2(X.dips, N2last)] },
]

// ---- Bloc 3 : perte de gras (supersets) ----
const N3 = 'Repos entre supersets : S19-21 90 s · S22-24 60 s · S25-26 45 s (+ un superset en fin de séance) · S27 : séance raccourcie de moitié.'
const ss = (sg, id, extra = {}) => ({ id, sets: 4, reps: 12, repsMin: 10, repsMax: 12, sg, sgRest: 90, note: N3, ...extra })
const heavy = 'Seul, en premier, assez lourd pour garder ta force. S27 : à −20 %.'
const r3 = [
  { id: 'b3a', name: 'Sèche · Séance A', ex: [{ id: X.squat, sets: 4, reps: 6, restSec: 150, note: heavy },
    ss('a1', X.bench), ss('a1', X.row),
    ss('a2', X.walk, { side: true }), ss('a2', X.plank, { mode: 'time', sec: 45, reps: undefined, repsMin: undefined, repsMax: undefined })] },
  { id: 'b3b', name: 'Sèche · Séance B', ex: [{ id: X.dead, sets: 3, reps: 5, restSec: 150, note: heavy },
    ss('b1', X.ohp), ss('b1', X.pull, { subs: [X.lat] }),
    ss('b2', X.legpress), ss('b2', X.curl)] },
  { id: 'b3c', name: 'Sèche · Séance C', ex: [ss('c1', X.rdl), ss('c1', X.pushup), ss('c2', X.dbrow), ss('c2', X.latraise), ss('c3', X.legcurl), ss('c3', X.pushdown)] },
]

const clean = r => ({ ...r, ex: r.ex.map(e => JSON.parse(JSON.stringify(e))) })
const routines = [...r1, ...r2, ...r3].map(clean)

// Lundi (1), mercredi (3), vendredi (5) — getDay().
const days = ([a, b, c]) => ({ 1: [a], 3: [b], 5: [c] })
const wk = rpe => ({ rpe })
const programmes = [
  { name: 'Bloc 1 · Force (semaines 1 à 9)', days: days(['b1a', 'b1b', 'b1c']),
    weeks: [wk(8.5), wk(8.5), wk(8.5), wk(9), wk(9), wk(9), wk(9.5), wk(9.5), { deload: true }] },
  { name: 'Bloc 2 · Muscle (semaines 10 à 18)', days: days(['b2a', 'b2b', 'b2c']),
    weeks: [wk(8.5), wk(8.5), wk(8.5), wk(8), wk(8), wk(8), wk(9.5), wk(9.5), { deload: true }] },
  { name: 'Bloc 3 · Perte de gras (semaines 19 à 27)', days: days(['b3a', 'b3b', 'b3c']),
    weeks: [wk(8), wk(8), wk(8), wk(8.5), wk(8.5), wk(8.5), wk(9), wk(9), { deload: true }] },
]

const plan = {
  opengym_plan: 1, exported: '2026-11-22', name: 'Programme 6 mois · Force, muscle, perte de gras', unit: 'kg',
  week: days(['b1a', 'b1b', 'b1c']), routines, customEx: [], programme_fmt: 1, programmes,
}
writeFileSync(out, JSON.stringify(plan, null, 2))
console.log('routines', routines.length, 'exercises', routines.reduce((n, r) => n + r.ex.length, 0), 'programmes', programmes.length)
