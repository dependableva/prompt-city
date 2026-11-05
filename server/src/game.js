// The game around the Citizens: the wanted level (stars a player earns, not buys), the daily job, crews, picking a
// Citizen to mint by its looks, and crafting three Citizens into one of the next rarity.
//
// Wanted level: every account has XP (users.xp). The daily job (/job) gives XP and a little $PROMPT; XP sets the level,
// ★ to ★★★★★. A level gives a discount on picked mints and opens the rarest picks (Kingpin from ★★★, Legend from ★★★★).
// Nothing here is paid by chance: a job costs nothing, a pick shows the Citizen before it is minted, and a craft lets the
// player choose the Citizen it gives (or take any free one of that rarity).
import * as m from './market.js';
import { openSql, closedTurfs, districtSchedule, turfOf, TURF } from './districts.js';
import { toMicro } from './money.js';

const fail = (msg) => { throw new m.MarketError(msg); };

export const RARITIES = ['Street', 'Hustler', 'Boss', 'Kingpin', 'Legend'];
export const rarityStars = (r) => Math.max(1, RARITIES.indexOf(r) + 1);
export const stars = (n) => '★'.repeat(Math.max(0, Math.min(5, n)));
export const nextRarity = (r) => RARITIES[RARITIES.indexOf(r) + 1] || null;

// ---------- the wanted level ----------
// XP for ★1 … ★5, the pick discount at each level (%), and the level a pick of a rarity needs
export const LEVELS = [0, 150, 500, 1500, 4000];
export const DISCOUNT = [0, 0, 5, 10, 15, 20];
export const PICK_LEVEL = { Kingpin: 3, Legend: 4 };
export const levelOf = (xp) => LEVELS.filter((x) => Number(xp) >= x).length;

const alert = (name, v, d) => { console.error(`ALERT: ${name}="${v}" is not valid; using the default`); return d; };
// "Street:5,Hustler:8,Boss:15,Kingpin:30,Legend:75" → { Street: 5000000, ... } in micro-units
export function parsePickPrices(v) {
  const d = { Street: '5', Hustler: '8', Boss: '15', Kingpin: '30', Legend: '75' };
  const out = Object.fromEntries(Object.entries(d).map(([k, x]) => [k, toMicro(x)]));
  if (v == null || String(v).trim() === '') return out;
  for (const part of String(v).split(',')) {
    const [k, x] = part.split(':').map((s) => s.trim());
    if (!RARITIES.includes(k)) return alert('PICK_PRICES', v, out);
    try { out[k] = toMicro(x, { what: 'PICK_PRICES' }); } catch { return alert('PICK_PRICES', v, out); }
  }
  return out;
}
const intEnv = (v, d) => (/^\d{1,9}$/.test(String(v ?? '').trim()) ? Number(v) : d);
export const CONFIG = {
  pickPrices: parsePickPrices(process.env.PICK_PRICES),
  craftFee: (() => { try { return toMicro(process.env.CRAFT_FEE || '1', { what: 'CRAFT_FEE' }); } catch { return alert('CRAFT_FEE', process.env.CRAFT_FEE, 1_000_000); } })(),
  promptPerXp: intEnv(process.env.JOB_PROMPT_PER_XP, 10), // $PROMPT a job gives per XP it gives
  crewMax: Math.max(2, intEnv(process.env.CREW_MAX, 10)),
};

// what a pick of this rarity costs at this level, in micro-units (whole cents)
export function pickPrice(rarity, level) {
  const base = CONFIG.pickPrices[rarity] ?? CONFIG.pickPrices.Street;
  const off = DISCOUNT[Math.max(0, Math.min(5, level))] || 0;
  return Math.round((base * (100 - off)) / 100 / m.CENT) * m.CENT;
}

export async function wanted(db, userId) {
  const [u] = await db.query(`select u.xp, u.job_streak, u.last_job_day::text as last_job_day, u.public_id,
      (select coalesce(sum(prompt), 0)::bigint from jobs where user_id = u.id) as job_prompt,
      (select count(*)::int from jobs where user_id = u.id) as jobs
    from users u where u.id = $1`, [userId]);
  const xp = Number(u.xp);
  const level = levelOf(xp);
  return {
    xp, level, stars: stars(level), next: level < 5 ? LEVELS[level] : null, discount: DISCOUNT[level],
    streak: Number(u.job_streak), last_job_day: u.last_job_day, jobs: u.jobs, job_prompt: Number(u.job_prompt),
    crew: await myCrew(db, userId),
  };
}

// ---------- the daily job ----------
// One job a day for everyone (UTC), so players can talk about it. Each has three ways in; the story hints at the best
// one (+10 XP). A Citizen of the player's with the right look helps (+10, more for a rarer one), a streak of days helps
// (+3 a day, up to +18), and so does a crew of 3 or more (+5).
export const APPROACHES = {
  stealth: { label: 'Stealth', does: 'Sneak in quietly',
    traits: [['Lid', 'Balaclava'], ['Lid', 'Bandana'], ['Optics', 'Cyber Visor'], ['Optics', 'Neon Shades'], ['Fit', 'Black Suit'], ['Fit', 'Jumpsuit'], ['Fit', 'Hoodie']] },
  muscle: { label: 'Muscle', does: 'Go in loud',
    traits: [['Fit', 'Tracksuit'], ['Fit', 'Leather Jacket'], ['Fit', 'White Tank'], ['Ink', 'Scar'], ['Ink', 'Neck Script'], ['Mouth', 'Cigar'], ['Mouth', 'Toothpick']] },
  talk: { label: 'Talk', does: 'Talk your way in',
    traits: [['Fit', 'Gold Suit'], ['Fit', 'Pastel Suit'], ['Fit', 'Palm Shirt'], ['Bling', 'Gold Chain'], ['Bling', 'Diamond Chain'], ['Bling', '$ Pendant'],
      ['Mouth', 'Gold Tooth'], ['Lid', 'Fedora'], ['Lid', 'Crown']] },
};
// these help in any job
const WILDCARDS = [['Optics', 'Laser Eyes'], ['Skin', 'Chrome'], ['Skin', 'Gold'], ['Skin', 'Neon Ghost']];
const HELPER_BONUS = { Street: 0, Hustler: 2, Boss: 4, Kingpin: 7, Legend: 12 };

export const JOBS = [
  { key: 'pier9', title: 'The Pier 9 Container', best: 'stealth', story: 'A container of sneakers sits on Pier 9. The dock guards just changed shifts and the new ones are half asleep.' },
  { key: 'chips', title: 'Neon Casino Chips', best: 'talk', story: 'The pit boss at the Neon owes a favor to anyone who looks like money.' },
  { key: 'van', title: 'The Ocean Drive Van', best: 'muscle', story: 'An armored van stops at the same red light for exactly forty seconds. No time for small talk.' },
  { key: 'penthouse', title: 'Penthouse Party', best: 'talk', story: 'A safe sits behind the bar of a penthouse party. The guest list is long and the doorman is bored.' },
  { key: 'chopshop', title: 'Chop Shop Payback', best: 'muscle', story: 'A rival crew stripped your ride. They are loud, a little drunk and outnumbered.' },
  { key: 'gallery', title: 'Gallery Night', best: 'stealth', story: 'Lasers on the floor, cameras on a loop every ninety seconds, and one painting you want.' },
  { key: 'yacht', title: 'The Yacht Club Ledger', best: 'talk', story: 'The accountant keeps the real books on his yacht, and he loves a good story.' },
  { key: 'race', title: 'The Street Race Bookie', best: 'muscle', story: 'The bookie skims every race on the Strip and nobody has ever pushed back.' },
  { key: 'servers', title: 'The Skyline Server Room', best: 'stealth', story: 'One keycard, one blind spot, one quiet hallway on the 40th floor.' },
  { key: 'gala', title: "The Mayor's Gala", best: 'talk', story: 'Everybody at the gala wants to be seen with the right people. Be the right people.' },
  { key: 'warehouse', title: 'Warehouse Standoff', best: 'muscle', story: 'They brought bats to the warehouse. You brought more friends.' },
  { key: 'crown', title: 'The Museum Crown', best: 'stealth', story: 'The crown sits in a glass case and the night guard reads comics till dawn.' },
  { key: 'radio', title: 'Radio Takeover', best: 'talk', story: 'The late-night DJ will play anything for a good enough pitch, even your crew\'s name.' },
  { key: 'pawn', title: 'The Pawn Shop Debt', best: 'muscle', story: 'The pawn shop owner only respects people who don\'t blink.' },
];

export const dayOf = (now = new Date()) => now.toISOString().slice(0, 10);
const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400e3);
export const jobOfDay = (day) => JOBS[((dayNumber(day) % JOBS.length) + JOBS.length) % JOBS.length];
const prevDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);

const patterns = (pairs) => pairs.map(([trait_type, value]) => JSON.stringify([{ trait_type, value }]));
// the account's best Citizen for an approach: one with a matching look (or a wildcard), the rarest first
async function helperFor(q, userId, approach) {
  const pairs = [...APPROACHES[approach].traits, ...WILDCARDS];
  const [n] = await q(`select n.id, n.name, n.rarity, n.attributes from nfts n join collections c on c.id = n.collection_id
    where c.slug = $1 and n.owner_id = $2 and n.attributes @> any($3::jsonb[])
    order by array_position($4::text[], n.rarity) desc nulls last, n.id limit 1`, [m.OWN_COLLECTION, userId, patterns(pairs), RARITIES]);
  if (!n) return null;
  const why = (n.attributes || []).find((a) => pairs.some(([t, v]) => t === a.trait_type && v === a.value));
  return { id: Number(n.id), name: n.name, rarity: n.rarity, trait: why ? `${why.trait_type}: ${why.value}` : null, bonus: 10 + (HELPER_BONUS[n.rarity] ?? 0) };
}

export async function todayJob(db, userId, now = new Date()) {
  const day = dayOf(now);
  const job = jobOfDay(day);
  const [done] = await db.query('select * from jobs where user_id = $1 and day = $2', [userId, day]);
  const helpers = {};
  for (const a of Object.keys(APPROACHES)) helpers[a] = await helperFor(db.query, userId, a);
  return { day, job, done: done ? jobView(done) : null, helpers, wanted: await wanted(db, userId) };
}

const jobView = (j) => ({ day: String(j.day instanceof Date ? j.day.toISOString().slice(0, 10) : j.day).slice(0, 10), job: j.job, approach: j.approach,
  xp: Number(j.xp), prompt: Number(j.prompt), helper_nft: j.helper_nft == null ? null : Number(j.helper_nft), breakdown: j.breakdown });

export async function doJob(db, userId, approach, now = new Date()) {
  if (!Object.hasOwn(APPROACHES, approach)) fail(`Pick a way in: ${Object.keys(APPROACHES).join(', ')}.`);
  const day = dayOf(now);
  const job = jobOfDay(day);
  return db.tx(async (t) => {
    const [u] = await t.query('select id, xp, job_streak, last_job_day::text as last from users where id = $1 for update', [userId]);
    const [had] = await t.query('select * from jobs where user_id = $1 and day = $2', [userId, day]);
    if (had) fail(`You already pulled today's job (${job.title}). A new one comes at 00:00 UTC.`);
    const helper = await helperFor(t.query, userId, approach);
    const streak = u.last && u.last.slice(0, 10) === prevDay(day) ? Number(u.job_streak) + 1 : 1;
    const [crew] = await t.query(`select c.name, (select count(*)::int from crew_members x where x.crew_id = c.id) as size
      from crew_members cm join crews c on c.id = cm.crew_id where cm.user_id = $1`, [userId]);
    const breakdown = [['the job', 20]];
    if (approach === job.best) breakdown.push(['the right way in', 10]);
    if (helper) breakdown.push([`${helper.name} (${helper.trait})`, helper.bonus]);
    if (streak > 1) breakdown.push([`${streak} days in a row`, Math.min(streak - 1, 6) * 3]);
    if (crew && crew.size >= 3) breakdown.push([`crew ${crew.name}`, 5]);
    const xp = breakdown.reduce((s, [, x]) => s + x, 0);
    const prompt = xp * CONFIG.promptPerXp;
    const before = levelOf(u.xp);
    await t.query(`insert into jobs (user_id, day, job, approach, xp, prompt, helper_nft, breakdown) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, day, job.key, approach, xp, prompt, helper?.id ?? null, JSON.stringify(breakdown)]);
    const [after] = await t.query(`update users set xp = xp + $1, job_streak = $2, last_job_day = $3, credit_balance = credit_balance + $4
      where id = $5 returning xp, credit_balance`, [xp, streak, day, prompt, userId]);
    const level = levelOf(after.xp);
    return { day, job, approach, best: approach === job.best, xp, prompt, breakdown, helper, streak, crew: crew?.name ?? null,
      total_xp: Number(after.xp), level, level_up: level > before, credit_balance: Number(after.credit_balance), next: level < 5 ? LEVELS[level] : null };
  });
}

// ---------- crews ----------
// A crew is a gang of up to CREW_MAX players. Anyone can start one or join one by its name; a crew's score is its
// members' XP. When the boss leaves, the longest member takes over; the last one out closes the crew.
const crewKey = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
function crewName(input) {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]$/.test(s)) fail('A crew name is 3 to 20 letters, digits, spaces, dots, dashes or underscores, e.g. "Vice Kings".');
  return s;
}

export async function myCrew(db, userId) {
  const [c] = await db.query(`select c.id, c.name, c.boss_id, c.created_at from crew_members cm join crews c on c.id = cm.crew_id where cm.user_id = $1`, [userId]);
  if (!c) return null;
  const members = await db.query(`select u.id, u.public_id, case when u.show_handle then u.handle end as name, u.xp, cm.joined_at
    from crew_members cm join users u on u.id = cm.user_id where cm.crew_id = $1 order by u.xp desc, cm.joined_at`, [c.id]);
  return { id: Number(c.id), name: c.name, boss: members.find((x) => Number(x.id) === Number(c.boss_id))?.public_id ?? null,
    you_are_boss: Number(c.boss_id) === Number(userId), size: members.length, max: CONFIG.crewMax,
    xp: members.reduce((s, x) => s + Number(x.xp), 0),
    members: members.map((x) => ({ addr: x.public_id, name: x.name, xp: Number(x.xp), level: levelOf(x.xp) })) };
}

export async function createCrew(db, userId, name) {
  const n = crewName(name);
  return db.tx(async (t) => {
    await t.query('select id from users where id = $1 for update', [userId]);
    const [in0] = await t.query('select c.name from crew_members cm join crews c on c.id = cm.crew_id where cm.user_id = $1', [userId]);
    if (in0) fail(`You are already in the crew ${in0.name}. Leave it first: /crew-city leave`);
    const [taken] = await t.query('select name from crews where key = $1', [crewKey(n)]);
    if (taken) fail(`There is already a crew called ${taken.name}. Join it (/crew-city join ${taken.name}) or pick another name.`);
    const [c] = await t.query('insert into crews (name, key, boss_id) values ($1, $2, $3) returning id', [n, crewKey(n), userId]);
    await t.query('insert into crew_members (user_id, crew_id) values ($1, $2)', [userId, c.id]);
    return c.id;
  }).then(() => myCrew(db, userId));
}

export async function joinCrew(db, userId, name) {
  return db.tx(async (t) => {
    const [c] = await t.query('select * from crews where key = $1 for update', [crewKey(name)]);
    if (!c) fail(`There is no crew called "${String(name ?? '').trim().slice(0, 30)}". Check the name, or start your own: /crew-city create <name>`);
    await t.query('select id from users where id = $1 for update', [userId]);
    const [in0] = await t.query('select c.name, c.id from crew_members cm join crews c on c.id = cm.crew_id where cm.user_id = $1', [userId]);
    if (in0 && Number(in0.id) === Number(c.id)) fail(`You are already in ${c.name}.`);
    if (in0) fail(`You are in the crew ${in0.name}. Leave it first: /crew-city leave`);
    const [{ n }] = await t.query('select count(*)::int as n from crew_members where crew_id = $1', [c.id]);
    if (n >= CONFIG.crewMax) fail(`${c.name} is full: ${CONFIG.crewMax} members.`);
    await t.query('insert into crew_members (user_id, crew_id) values ($1, $2)', [userId, c.id]);
  }).then(() => myCrew(db, userId));
}

export async function leaveCrew(db, userId) {
  return db.tx(async (t) => {
    const [cm] = await t.query('select crew_id from crew_members where user_id = $1', [userId]);
    if (!cm) fail('You are not in a crew.');
    const [c] = await t.query('select * from crews where id = $1 for update', [cm.crew_id]);
    await t.query('delete from crew_members where user_id = $1', [userId]);
    const [heir] = await t.query('select user_id from crew_members where crew_id = $1 order by joined_at, user_id limit 1', [c.id]);
    if (!heir) {
      await t.query('delete from crews where id = $1', [c.id]);
      return { left: c.name, closed: true };
    }
    if (Number(c.boss_id) === Number(userId)) await t.query('update crews set boss_id = $1 where id = $2', [heir.user_id, c.id]);
    return { left: c.name, closed: false };
  });
}

// the leaderboards on the site: players by XP, crews by their members' XP
export async function boards(db, { limit = 20 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const players = await db.query(`select u.public_id as addr, case when u.show_handle then u.handle end as name, u.xp,
      (select c.name from crew_members cm join crews c on c.id = cm.crew_id where cm.user_id = u.id) as crew
    from users u where u.xp > 0 order by u.xp desc, u.id limit $1`, [n]);
  const crews = await db.query(`select c.name, count(cm.user_id)::int as size, coalesce(sum(u.xp), 0)::bigint as xp
    from crews c join crew_members cm on cm.crew_id = c.id join users u on u.id = cm.user_id
    group by c.id, c.name order by xp desc, c.id limit $1`, [n]);
  return {
    players: players.map((p) => ({ ...p, xp: Number(p.xp), level: levelOf(p.xp) })),
    crews: crews.map((c) => ({ name: c.name, size: c.size, xp: Number(c.xp) })),
    levels: LEVELS,
  };
}

// ---------- districts ----------
export async function districts(db, now = new Date()) {
  const rows = await db.query(`select a.value as turf, count(*)::int as total, count(*) filter (where n.minted_at is null)::int as left
    from nfts n join collections c on c.id = n.collection_id, jsonb_to_recordset(n.attributes) as a(trait_type text, value text)
    where c.slug = $1 and a.trait_type = $2 group by a.value order by a.value`, [m.OWN_COLLECTION, TURF]);
  const sched = new Map(districtSchedule().map((d) => [d.turf, d.opens_at]));
  return rows.map((r) => {
    const at = sched.get(r.turf) || null;
    return { turf: r.turf, total: r.total, left: r.left, open: !at || at <= now, opens_at: at ? at.toISOString() : null };
  }).sort((a, b) => (a.open === b.open ? (a.opens_at || '').localeCompare(b.opens_at || '') || a.turf.localeCompare(b.turf) : a.open ? -1 : 1));
}

// ---------- picking a Citizen by its looks ----------
// traits: [[type, value], ...]; values of one type are alternatives, different types must all match
export async function findCitizens(db, { rarity, traits = [], limit = 8 } = {}) {
  const p = [m.OWN_COLLECTION];
  const where = ['c.slug = $1', 'n.minted_at is null'];
  where.push(openSql(p));
  if (rarity) { p.push(String(rarity)); where.push(`lower(n.rarity) = lower($${p.length})`); }
  m.traitFilter(traits, where, p);
  const sql = `from nfts n join collections c on c.id = n.collection_id where ${where.join(' and ')}`;
  const [{ n }] = await db.query(`select count(*)::int as n ${sql}`, p);
  p.push(Math.min(Math.max(Number(limit) || 8, 1), 20));
  const items = await db.query(`select n.id, n.name, n.rarity, n.attributes, n.pixel, c.slug as collection, c.name as collection_name ${sql}
    order by random() limit $${p.length}`, p);
  return { total: n, items };
}

// mints the Citizen the user picked, at the price of its rarity less the level discount
export async function pickMint(db, userId, nftId) {
  const w = await wanted(db, userId);
  return m.mint(db, userId, {
    nftId,
    priceOf: (nft) => {
      const need = PICK_LEVEL[nft.rarity];
      if (need && w.level < need) {
        fail(`${nft.name} is a ${nft.rarity}: picking one needs wanted level ${stars(need)} and you are ${stars(w.level)} (${w.xp} XP). ` +
          'Pull the daily job to level up: /job');
      }
      return pickPrice(nft.rarity, w.level);
    },
  });
}

// ---------- crafting ----------
// Three Citizens of one rarity (not Legend) burn into one Citizen of the next rarity, for CRAFT_FEE $CASH. pick: the
// one the player wants (free, of that rarity, in an open district), or any free one. The new Citizen is outside the
// mint limit. The burned ones get a "craft_burn" ledger row each, the new one a "craft" row (all zero-amount).
export const CRAFT_N = 3;
export async function craft(db, userId, ids, { pick = null } = {}) {
  const list = [...new Set((ids || []).map(Number))];
  if (list.length !== CRAFT_N || (ids || []).length !== CRAFT_N || list.some((x) => !Number.isInteger(x) || x < 1)) {
    fail(`Crafting takes exactly ${CRAFT_N} different Citizens of one rarity, e.g. /craft-city 12 40 77. Nothing was crafted.`);
  }
  list.sort((a, b) => a - b);
  return db.tx(async (t) => {
    const [c] = await t.query('select * from collections where slug = $1 for share', [m.OWN_COLLECTION]);
    if (c.status === 'frozen') fail(`${c.name} is frozen. Nothing was crafted.`);
    const nfts = await t.query('select id, name, rarity, owner_id, collection_id from nfts where id = any($1::int[]) order by id for update', [list]);
    for (const id of list) {
      const n = nfts.find((x) => Number(x.id) === id);
      if (!n || Number(n.owner_id) !== Number(userId)) fail(`You don't own ${n ? n.name : m.nftName(id)}. Nothing was crafted.`);
      if (Number(n.collection_id) !== Number(c.id)) fail(`Only Citizens can be crafted; ${n.name} isn't one. Nothing was crafted.`);
    }
    const rarity = nfts[0].rarity;
    if (nfts.some((n) => n.rarity !== rarity)) fail(`All ${CRAFT_N} must be of one rarity (${nfts.map((n) => `${n.name}: ${n.rarity}`).join(', ')}). Nothing was crafted.`);
    const into = nextRarity(rarity);
    if (!into) fail(`${rarity} is the top rarity: Legends can't be crafted into anything. Nothing was crafted.`);
    let target;
    const p = [c.id, into];
    const open = openSql(p);
    if (pick != null) {
      p.push(Number(pick));
      [target] = await t.query(`select id, name, rarity, attributes from nfts n where n.collection_id = $1 and n.rarity = $2 and n.id = $${p.length}
        and n.minted_at is null and ${open} for update`, p);
      if (!target) fail(`${m.nftName(pick)} isn't a free ${into} Citizen in an open district. Find one: /find-city ${into}. Nothing was crafted.`);
    } else {
      [target] = await t.query(`select id, name, rarity, attributes from nfts n where n.collection_id = $1 and n.rarity = $2 and n.minted_at is null and ${open}
        order by random() limit 1 for update skip locked`, p);
      if (!target) fail(`No free ${into} Citizen is left in the open districts to craft into. Nothing was crafted.`);
    }
    await t.query('select id from users where id = $1 for update', [userId]);
    if (CONFIG.craftFee > 0) {
      await m.move(t, userId, -CONFIG.craftFee, 'craft_fee', String(target.id));
      await m.move(t, null, CONFIG.craftFee, 'craft_fee', String(target.id));
    }
    const gone = await t.query(`update nfts set owner_id = null, price = null, listed_at = null, burned_at = now(), burned_by = $2
      where id = any($1::int[]) and owner_id = $2 returning id`, [list, userId]);
    if (gone.length !== CRAFT_N) fail('Some of these NFTs just changed hands. Nothing was crafted.');
    await t.query(`insert into ledger (user_id, delta, kind, ref) select $1, 0, 'craft_burn', x::text from unnest($2::int[]) as x order by x`, [userId, list]);
    const [nft] = await t.query('update nfts set owner_id = $1, minted_at = now() where id = $2 and minted_at is null returning *', [userId, target.id]);
    if (!nft) fail('Someone minted that one a moment ago; try again. Nothing was crafted.');
    await t.query("insert into ledger (user_id, delta, kind, ref) values ($1, 0, 'craft', $2)", [userId, String(nft.id)]);
    const [row] = await t.query('insert into crafts (user_id, burned, nft_id, fee) values ($1, $2, $3, $4) returning id', [userId, list, nft.id, CONFIG.craftFee]);
    return { id: Number(row.id), from: rarity, into, fee: CONFIG.craftFee, nft: { ...nft, collection: c.slug, collection_name: c.name },
      burned: nfts.map((n) => ({ id: Number(n.id), name: n.name, rarity: n.rarity })), turf: turfOf(nft.attributes) };
  });
}

export const closedNow = closedTurfs;
