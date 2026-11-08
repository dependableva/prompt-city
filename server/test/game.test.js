// The game (game.js): the daily job and the wanted level, crews, picking a Citizen by its looks, district drops,
// crafting three Citizens into one; and taking a Citizen to Solana (bridge.js) with a fake chain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { base58 } from '@scure/base';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open';
delete process.env.DISTRICTS;
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { findRoot } = await import('../src/paths.js');
const { checkMoney } = await import('../src/backup.js');
const { keypairFromSeed, decodeTransaction } = await import('../src/tx.js');
const m = await import('../src/market.js');
const game = await import('../src/game.js');
const bridgeMod = await import('../src/bridge.js');

const root = findRoot();
let db, app, server, base, bridge;
const chain = { sent: [], accounts: new Map(), statuses: new Map() };
// a fake Solana node: blockhashes, sendTransaction (checks the signatures, "lands" the asset), statuses, accounts
async function fakeRpc(method, params) {
  if (method === 'getLatestBlockhash') return { value: { blockhash: base58.encode(crypto.randomBytes(32)), lastValidBlockHeight: 100 } };
  if (method === 'getAccountInfo') return { value: chain.accounts.get(params[0]) || null };
  if (method === 'sendTransaction') {
    const t = decodeTransaction(Buffer.from(params[0], 'base64'));
    assert.ok(t.verified, 'every signature checks out');
    chain.sent.push(t);
    const create = t.instructions.find((i) => i.programId === bridgeMod.MPL_CORE);
    chain.accounts.set(create.accounts[0], { owner: bridgeMod.MPL_CORE, data: ['', 'base64'] });
    chain.statuses.set(t.signature, { confirmationStatus: 'confirmed', err: null });
    return t.signature;
  }
  if (method === 'getSignatureStatuses') return { value: params[0].map((s) => chain.statuses.get(s) || null) };
  throw new Error(`fake rpc: ${method}`);
}
const PAYER = keypairFromSeed(Buffer.alloc(32, 3));

before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  bridge = bridgeMod.createBridge(db, { rpc: fakeRpc, publicUrl: 'https://city.example',
    config: { cluster: 'devnet', fee: 1_000_000, secret: base58.encode(Buffer.concat([PAYER.seed, base58.decode(PAYER.publicKey)])), rpcUrl: '' } });
  ({ app } = await createApp({ db, publicUrl: 'https://city.example', devLogin: true, storage: memoryStorage(), bridge }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = () => [...crypto.randomBytes(88)].map((b) => B58[b % 58]).join('');
const wallet = () => base58.encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
let k = 0;
async function user(handle = `g${++k}`, dollars = 100) {
  const u = await m.upsertUser(db, { xId: `dev:${handle}`, handle });
  await m.ensurePublicIds(db);
  if (dollars) await m.credit(db, u.id, dollars * 1e6, 'deposit', `USDC ${sig()} ${sig().slice(0, 44)}`);
  return (await db.query('select * from users where id = $1', [u.id]))[0];
}
// Citizens given to an account straight in the database (as if minted), by rarity and optional traits
async function give(u, n, rarity = 'Street', traits = []) {
  const p = [u.id, rarity, n];
  const extra = traits.map(([t, v]) => { p.push(JSON.stringify([{ trait_type: t, value: v }])); return `and n.attributes @> $${p.length}::jsonb`; }).join(' ');
  return (await db.query(`update nfts set owner_id = $1, minted_at = now() where id in (
    select n.id from nfts n join collections c on c.id = n.collection_id where c.slug = 'citizens' and n.minted_at is null and n.rarity = $2 ${extra}
    order by n.id limit $3) returning id`, p)).map((x) => Number(x.id));
}
async function mcp(u) {
  const srv = buildMcpServer(db, u.id, { publicUrl: 'https://city.example', thumbsDir: path.join(root, 'collection', 'thumbs'), deposits: { enabled: false }, ui: null, bridge });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  return async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), isError: !!r.isError };
  };
}
const day = (s) => new Date(`${s}T12:00:00Z`);
const moneyOk = async () => {
  const c = await checkMoney(db);
  assert.ok(c.balancesMatch, 'every balance equals its ledger');
  assert.ok(c.creditMatch, '$PROMPT = burns + drops + jobs - claims');
};

test('job: one a day, one step, XP and $PROMPT, a helping Citizen, a streak, levels', async () => {
  const u = await user();
  const d1 = '2026-11-10';
  const j1 = game.jobOfDay(d1);
  const t = await game.todayJob(db, u.id, day(d1));
  assert.equal(t.job.key, j1.key);
  assert.equal(t.done, null);
  assert.equal(t.helper, null);
  // no choices: the job pays 30 XP
  const r1 = await game.doJob(db, u.id, day(d1));
  assert.equal(r1.xp, 30);
  assert.equal(r1.prompt, 300);
  assert.equal(r1.streak, 1);
  assert.equal(r1.approach, j1.best);
  await assert.rejects(game.doJob(db, u.id, day(d1)), /already pulled today's job/);
  // a Citizen with the right look for the day's job helps: a Boss in a balaclava on a stealth day, +10 +4
  const stealthDay = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].find((d) => game.jobOfDay(d).best === 'stealth');
  const [boss] = await give(u, 1, 'Boss', [['Lid', 'Balaclava']]);
  const t2 = await game.todayJob(db, u.id, day(stealthDay));
  assert.equal(t2.helper.id, boss);
  assert.equal(t2.helper.bonus, 14);
  const r2 = await game.doJob(db, u.id, day(stealthDay));
  assert.ok(r2.breakdown.some(([w, x]) => w.startsWith(`Citizen #${boss}`) && x === 14), JSON.stringify(r2.breakdown));
  // a day missed: the streak starts over
  const r3 = await game.doJob(db, u.id, day('2026-11-20'));
  assert.equal(r3.streak, 1);
  const w = await game.wanted(db, u.id);
  assert.equal(w.xp, r1.xp + r2.xp + r3.xp);
  assert.equal(w.jobs, 3);
  assert.equal(Number((await db.query('select credit_balance from users where id = $1', [u.id]))[0].credit_balance), (r1.xp + r2.xp + r3.xp) * 10);
  // a streak: two days in a row adds 3
  const r4 = await game.doJob(db, u.id, day('2026-11-21'));
  assert.equal(r4.streak, 2);
  assert.ok(r4.breakdown.some(([w0, x]) => w0 === '2 days in a row' && x === 3), JSON.stringify(r4.breakdown));
  // levels: ★ at 0, ★★ from 150 …
  assert.deepEqual([0, 149, 150, 499, 500, 1500, 3999, 4000].map(game.levelOf), [1, 1, 2, 2, 3, 4, 4, 5]);
  await moneyOk();
});

test('job: through the chat, one command does it', async () => {
  const u = await user();
  const call = await mcp(u);
  const done = await call('job');
  assert.match(done.text, /Job done\./);
  assert.match(done.text, /\+30 the job/);
  assert.match(done.text, /= 30 XP and 300 \$PROMPT/);
  assert.doesNotMatch(done.text, /which way|stealth \(|Note for the assistant/);
  const again = await call('job');
  assert.match(again.text, /Done already: \+30 XP, \+300 \$PROMPT/);
  assert.match((await call('wanted')).text, /Wanted level ★ \(1\/5\)/);
});

test('crews: start, join, the +5 XP of a crew of 3, the boss leaves, the last one closes it', async () => {
  const [a, b, c, d] = [await user(), await user(), await user(), await user()];
  const crew = await game.createCrew(db, a.id, '  Vice   Kings ');
  assert.equal(crew.name, 'Vice Kings');
  assert.equal(crew.you_are_boss, true);
  await assert.rejects(game.createCrew(db, b.id, 'vice kings'), /already a crew called Vice Kings/);
  await assert.rejects(game.createCrew(db, b.id, 'x'), /3 to 20 letters/);
  await assert.rejects(game.joinCrew(db, b.id, 'Nobody Here'), /no crew called/);
  await game.joinCrew(db, b.id, 'VICE KINGS');
  await assert.rejects(game.createCrew(db, b.id, 'Other'), /already in the crew Vice Kings/);
  const r1 = await game.doJob(db, a.id, day('2026-12-01'));
  assert.ok(!r1.breakdown.some(([w]) => w.startsWith('crew')), 'two members: no crew bonus');
  await game.joinCrew(db, c.id, 'vice kings');
  const r2 = await game.doJob(db, a.id, day('2026-12-02'));
  assert.ok(r2.breakdown.some(([w, x]) => w === 'crew Vice Kings' && x === 5));
  // the boss leaves: the next longest member takes over
  await game.leaveCrew(db, a.id);
  const left = await game.myCrew(db, b.id);
  assert.equal(left.size, 2);
  assert.equal(left.you_are_boss, true);
  // full
  const prev = game.CONFIG.crewMax;
  game.CONFIG.crewMax = 2;
  await assert.rejects(game.joinCrew(db, d.id, 'Vice Kings'), /full: 2 members/);
  game.CONFIG.crewMax = prev;
  await game.leaveCrew(db, b.id);
  assert.deepEqual(await game.leaveCrew(db, c.id), { left: 'Vice Kings', closed: true });
  assert.equal((await db.query("select count(*)::int as n from crews where key = 'vice kings'"))[0].n, 0);
  await assert.rejects(game.leaveCrew(db, c.id), /not in a crew/);
  // through the chat
  const call = await mcp(d);
  assert.match((await call('crew')).text, /not in a crew/);
  assert.match((await call('crew', { action: 'create', name: 'Neon Owls' })).text, /^Crew started: Neon Owls · 1\/10 members/);
  assert.match((await call('crew', { action: 'join' })).text, /Which crew\?/);
});

test('pick: find by looks, pay the price of the rarity less the level discount, rare picks need stars', async () => {
  const u = await user('picker', 200);
  const call = await mcp(u);
  const found = await game.findCitizens(db, { rarity: 'Boss', traits: [['Bling', 'Gold Chain']], limit: 3 });
  assert.ok(found.total > 0 && found.items.length === 3);
  for (const n of found.items) {
    assert.equal(n.rarity, 'Boss');
    assert.ok(n.attributes.some((a) => a.trait_type === 'Bling' && a.value === 'Gold Chain'));
  }
  const t = await call('find_citizens', { rarity: 'Boss', traits: ['Bling: Gold Chain'] });
  assert.match(t.text, /free Citizens? match/);
  assert.match(t.text, /pick for 15 \$CASH/);
  // the line shows the look asked for, and the district only once
  for (const l of t.text.split('\n').filter((x) => /^#\d+ Boss/.test(x))) {
    assert.match(l, /^#\d+ Boss · [^·]+ · Gold Chain[,· ]/, l);
    const turf = l.split(' · ')[1];
    assert.equal(l.split(turf).length - 1, 1, l);
  }
  const pick = found.items[0];
  const before = Number(u.balance);
  const r = await call('pick_citizen', { nft_id: pick.id });
  assert.match(r.text, new RegExp(`^Picked and minted Citizen #${pick.id} · Boss`));
  assert.match(r.text, /Paid 15 \$CASH/);
  assert.equal(Number((await m.getUser(db, u.id)).balance), before - 15e6);
  assert.match((await call('pick_citizen', { nft_id: pick.id })).text, /already minted/);
  // a Legend needs ★★★★: refused, nothing paid
  const [leg] = (await game.findCitizens(db, { rarity: 'Legend', limit: 1 })).items;
  const no = await call('pick_citizen', { nft_id: leg.id });
  assert.ok(no.isError);
  assert.match(no.text, /picking one needs wanted level ★★★★ and you are ★/);
  assert.equal(Number((await m.getUser(db, u.id)).balance), before - 15e6);
  // at ★★★ (500 XP) a Boss costs 10% less
  await db.query('update users set xp = 500 where id = $1', [u.id]);
  assert.equal(game.pickPrice('Boss', 3), 13_500_000);
  const [b2] = (await game.findCitizens(db, { rarity: 'Boss', limit: 1 })).items;
  assert.match((await call('pick_citizen', { nft_id: b2.id })).text, /Paid 13\.50 \$CASH/);
  await moneyOk();
});

test('districts: a district that opens later can not be minted in any way until then', async () => {
  const u = await user('dist', 200);
  const call = await mcp(u);
  const soon = new Date(Date.now() + 3 * 86400e3).toISOString();
  process.env.DISTRICTS = `Ocean Drive@${soon}, Sunset Strip@2020-01-01T00:00:00Z`;
  try {
    const list = await game.districts(db);
    const od = list.find((d) => d.turf === 'Ocean Drive');
    assert.equal(od.open, false);
    assert.equal(od.opens_at, soon);
    assert.equal(list.find((d) => d.turf === 'Sunset Strip').open, true, 'a time in the past: open');
    assert.equal(list.find((d) => d.turf === 'Hot Pink').open, true, 'not listed: open');
    assert.match((await call('districts')).text, /LOCKED Ocean Drive: [\d,]+ of 844 free · opens /);
    // random mints never land there (4 of the 5 an account may mint)
    for (let i = 0; i < 4; i++) {
      const n = await m.mint(db, u.id);
      assert.notEqual((n.attributes.find((a) => a.trait_type === 'Turf') || {}).value, 'Ocean Drive');
    }
    // nor a pick, nor find
    const [x] = await db.query(`select id from nfts where minted_at is null and attributes @> '[{"trait_type":"Turf","value":"Ocean Drive"}]' limit 1`);
    await assert.rejects(game.pickMint(db, u.id, x.id), /lives in Ocean Drive, which isn't open yet/);
    assert.equal((await game.findCitizens(db, { traits: [['Turf', 'Ocean Drive']] })).total, 0);
    const api = await fetch(`${base}/api/districts`).then((r) => r.json());
    assert.equal(api.find((d) => d.turf === 'Ocean Drive').open, false);
  } finally {
    delete process.env.DISTRICTS;
  }
  assert.ok((await game.findCitizens(db, { traits: [['Turf', 'Ocean Drive']] })).total > 0, 'open again without DISTRICTS');
});

test('craft: three of one rarity burn into one of the next; fee, ledger and the explorer', async () => {
  const u = await user('crafter', 20);
  const other = await user();
  const call = await mcp(u);
  const streets = await give(u, 4, 'Street');
  const [hustler] = await give(u, 1, 'Hustler');
  await assert.rejects(game.craft(db, u.id, streets.slice(0, 2)), /exactly 3 different/);
  await assert.rejects(game.craft(db, u.id, [streets[0], streets[0], streets[1]]), /exactly 3 different/);
  await assert.rejects(game.craft(db, u.id, [streets[0], streets[1], hustler]), /must be of one rarity/);
  const [theirs] = await give(other, 1, 'Street');
  await assert.rejects(game.craft(db, u.id, [streets[0], streets[1], theirs]), /You don't own Citizen #/);
  // the preview moves nothing
  const pre = await call('craft', { nft_ids: streets.slice(0, 3) });
  assert.match(pre.text, /^Craft: burn Citizen #\d+ \(Street\), .* → a free Hustler Citizen, fee 1 \$CASH/);
  assert.equal((await db.query('select count(*)::int as n from nfts where id = any($1) and owner_id = $2', [streets, u.id]))[0].n, 4);
  // pick the Hustler it gives
  const [want] = (await game.findCitizens(db, { rarity: 'Hustler', limit: 1 })).items;
  const done = await call('craft', { nft_ids: streets.slice(0, 3), into: want.id, confirm: true });
  assert.match(done.text, new RegExp(`^Crafted! .* burned into Citizen #${want.id} · Hustler`));
  const gone = await db.query('select owner_id, burned_at from nfts where id = any($1)', [streets.slice(0, 3)]);
  assert.ok(gone.every((n) => n.owner_id == null && n.burned_at));
  const [got] = await db.query('select owner_id, minted_by from nfts where id = $1', [want.id]);
  assert.equal(Number(got.owner_id), Number(u.id));
  assert.equal(got.minted_by, null, 'outside the mint limit');
  assert.equal(Number((await m.getUser(db, u.id)).balance), 19e6);
  // a crafted Citizen can be crafted again into the next (here: any free Boss)
  const two = await give(u, 2, 'Hustler');
  const r = await game.craft(db, u.id, [want.id, ...two]);
  assert.equal(r.into, 'Boss');
  // Legends don't craft
  const legs = await give(u, 3, 'Legend');
  await assert.rejects(game.craft(db, u.id, legs), /top rarity/);
  // history and explorer
  const n = await m.getNft(db, want.id);
  assert.ok(n.activity.some((a) => a.type === 'mint' && a.craft));
  assert.ok(n.activity.some((a) => a.type === 'burn' && a.craft));
  const txs = await fetch(`${base}/api/explorer/txs?type=craft`).then((x) => x.json());
  const list = Array.isArray(txs) ? txs : txs.items || txs.txs;
  assert.ok(list.length >= 2 && list.every((t) => t.type === 'craft'), JSON.stringify(list[0]));
  assert.equal(list.find((t) => t.nft?.id === want.id).craft.burned.length, 3);
  await moneyOk();
});

test('bridge: Metaplex Core CreateV1 is byte for byte what @metaplex-foundation/mpl-core makes', () => {
  const asset = keypairFromSeed(Buffer.alloc(32, 7)).publicKey;
  const payer = keypairFromSeed(Buffer.alloc(32, 9)).publicKey;
  assert.equal(asset, 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
  assert.equal(payer, 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf');
  const i = bridgeMod.createCoreAsset({ asset, payer, owner: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', name: 'Citizen #42', uri: 'https://prompt-city-test.netlify.app/meta/42.json' });
  assert.equal(i.programId, 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
  const P = i.programId;
  assert.deepEqual(i.keys.map((x) => [x.pubkey, x.isSigner, x.isWritable]), [
    [asset, true, true], [P, false, false], [P, false, false], [payer, true, true],
    ['9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', false, false], [P, false, false], ['11111111111111111111111111111111', false, false], [P, false, false]]);
  assert.equal(i.data.toString('hex'), '00000b000000436974697a656e202334323100000068747470733a2f2f70726f6d70742d636974792d746573742e6e65746c6966792e6170702f6d6574612f34322e6a736f6e0100000000');
});

test('bridge: a Citizen goes to a Solana wallet: off the market here, minted there, its metadata served', async () => {
  const u = await user('exporter', 10);
  const call = await mcp(u);
  const [id] = await give(u, 1, 'Kingpin');
  await m.list(db, u.id, id, 50e6);
  const to = wallet();
  assert.match((await call('export_nft', { nft_id: id, wallet: 'not-a-wallet', confirm: true })).text, /not a Solana wallet/);
  const pre = await call('export_nft', { nft_id: id, wallet: to });
  assert.match(pre.text, new RegExp(`^Take Citizen #${id} \\(Kingpin\\) to Solana devnet wallet ${to}\\? Fee 1 \\$CASH`));
  assert.equal(Number((await db.query('select owner_id from nfts where id = $1', [id]))[0].owner_id), Number(u.id), 'the preview moves nothing');
  const r = await call('export_nft', { nft_id: id, wallet: to, confirm: true });
  assert.match(r.text, /is on its way to/);
  const [n] = await db.query('select owner_id, price, exported_at from nfts where id = $1', [id]);
  assert.equal(n.owner_id, null);
  assert.equal(n.price, null, 'off the market');
  assert.ok(n.exported_at);
  assert.equal(Number((await m.getUser(db, u.id)).balance), 9e6);
  await assert.rejects(m.list(db, u.id, id, 5e6), /You don't own/);
  // the scheduled run mints it
  const t1 = await bridge.tick();
  assert.equal(t1.sent, 1);
  const tx = chain.sent.at(-1);
  const ixn = tx.instructions.find((i) => i.programId === bridgeMod.MPL_CORE);
  assert.equal(ixn.accounts[4], to, 'owned by the wallet given');
  assert.equal(ixn.accounts[3], PAYER.publicKey, 'paid by the server wallet');
  assert.ok(ixn.data.includes(Buffer.from(`https://city.example/meta/${id}.json`)));
  const t2 = await bridge.tick();
  assert.equal(t2.minted, 1);
  const [x] = await db.query('select * from nft_exports where nft_id = $1', [id]);
  assert.equal(x.status, 'minted');
  assert.equal(x.asset, ixn.accounts[0]);
  assert.equal((await db.query('select export_asset from nfts where id = $1', [id]))[0].export_asset, x.asset);
  assert.deepEqual(await bridge.tick(), { minted: 0, sent: 0, failed: 0, waiting: 0 }, 'nothing left to do');
  assert.match((await call('export_nft')).text, new RegExp(`Citizen #${id} → ${to} · minted · https://explorer.solana.com/address/${x.asset}\\?cluster=devnet`));
  // the metadata of the asset
  const meta = await fetch(`${base}/meta/${id}.json`).then((res) => res.json());
  assert.equal(meta.name, `Citizen #${id}`);
  assert.equal(meta.image, `https://city.example/big/${id}.png`);
  assert.ok(meta.attributes.some((a) => a.trait_type === 'Rarity' && a.value === 'Kingpin'));
  assert.equal((await fetch(`${base}/meta/999999.json`)).status, 404);
  const nft = await m.getNft(db, id);
  assert.ok(nft.activity.some((a) => a.type === 'export'));
  await moneyOk();
});

test('bridge: a send that landed before the run crashed is not sent again', async () => {
  const u = await user('exporter2', 10);
  const [id] = await give(u, 1, 'Street');
  const r = await bridge.request(u.id, id, wallet());
  chain.accounts.set(r.asset, { owner: bridgeMod.MPL_CORE });
  const sentBefore = chain.sent.length;
  assert.equal((await bridge.tick()).minted, 1);
  assert.equal(chain.sent.length, sentBefore, 'already on chain: no new transaction');
  const off = bridgeMod.createBridge(db, { config: { cluster: 'devnet', fee: 0, secret: '', rpcUrl: '' } });
  assert.equal(off.enabled, false);
  await assert.rejects(off.request(u.id, id, wallet()), /not switched on/);
});

test('site API: the leaderboards and today\'s job', async () => {
  const b = await fetch(`${base}/api/leaderboard`).then((r) => r.json());
  assert.ok(b.players.length > 0);
  for (let i = 1; i < b.players.length; i++) assert.ok(b.players[i - 1].xp >= b.players[i].xp);
  assert.ok(b.players.every((p) => /^city_/.test(p.addr) && p.level >= 1));
  assert.ok(Array.isArray(b.crews));
  const j = await fetch(`${base}/api/job`).then((r) => r.json());
  assert.equal(j.title, game.jobOfDay(game.dayOf()).title);
  assert.deepEqual(j.approaches.map((a) => a.key), ['stealth', 'muscle', 'talk']);
  assert.deepEqual(j.pick_prices, { Street: 5, Hustler: 8, Boss: 15, Kingpin: 30, Legend: 75 });
  assert.equal(j.export.enabled, true);
});
