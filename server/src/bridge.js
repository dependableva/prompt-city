// Taking a Citizen to Solana. The owner asks in the chat (/export-city) with the wallet it should go to; the NFT leaves
// the market for good (no owner here any more, an "export" ledger row, off sale) and joins the queue. The scheduled
// run mints each one on Solana as a Metaplex Core asset owned by that wallet, with the picture and traits from
// /meta/<id>.json. The server's wallet (EXPORT_KEY) pays the network fees and the asset's rent; the export fee in
// $CASH (EXPORT_FEE) covers that.
//
// Safe to retry: each export has its own asset address, derived from EXPORT_KEY and the export's number, so sending
// again can never make a second asset (the account exists after the first lands). Before sending, the run checks
// whether the asset is already there.
import crypto from 'node:crypto';
import * as m from './market.js';
import * as sol from './solana.js';
import { keypairFromSecret, keypairFromSeed, signTransaction, SYSTEM_PROGRAM, ix as txIx } from './tx.js';
import { toMicro } from './money.js';

const fail = (msg) => { throw new m.MarketError(msg); };
export const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const MAX_ATTEMPTS = 5;

// Metaplex Core CreateV1: a new asset (a signer) owned by `owner`, update authority the payer, no collection and no
// plugins. Unused optional accounts are the program's own id. Byte for byte what @metaplex-foundation/mpl-core makes
// (test/bridge.test.js has the frozen vector).
export function createCoreAsset({ asset, payer, owner, name, uri }) {
  const str = (s) => {
    const b = Buffer.from(String(s), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const data = Buffer.concat([Buffer.from([0, 0]), str(name), str(uri), Buffer.from([1, 0, 0, 0, 0])]);
  const k = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  return {
    programId: MPL_CORE,
    keys: [k(asset, true, true), k(MPL_CORE, false, false), k(MPL_CORE, false, false), k(payer, true, true), k(owner, false, false),
      k(MPL_CORE, false, false), k(SYSTEM_PROGRAM, false, false), k(MPL_CORE, false, false)],
    data,
  };
}

export function exportConfig(env = process.env) {
  const testMode = env.TEST_MODE === '1';
  const cluster = String(env.SOLANA_CLUSTER || (testMode ? 'devnet' : 'mainnet')).toLowerCase();
  let fee = 1_000_000;
  try { if (env.EXPORT_FEE != null && env.EXPORT_FEE !== '') fee = String(env.EXPORT_FEE).trim() === '0' ? 0 : toMicro(env.EXPORT_FEE, { what: 'EXPORT_FEE' }); } catch {
    console.error(`ALERT: EXPORT_FEE="${env.EXPORT_FEE}" is not valid; using 1`);
  }
  return {
    cluster,
    fee,
    secret: env.EXPORT_KEY || '',
    rpcUrl: env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? sol.heliusRpcUrl(cluster, env.HELIUS_API_KEY) : ''),
  };
}

export const explorerAsset = (asset, cluster) => `https://solscan.io/token/${asset}${cluster === 'mainnet' ? '' : `?cluster=${cluster}`}`;

export function createBridge(db, { rpc: rpcOpt, config, publicUrl } = {}) {
  const cfg = config || exportConfig();
  let payer = null;
  let problem = null;
  try {
    if (!cfg.secret) problem = 'EXPORT_KEY is not set';
    else payer = keypairFromSecret(cfg.secret);
  } catch (e) {
    problem = `EXPORT_KEY: ${e.message}`;
  }
  if (!problem && !cfg.rpcUrl && !rpcOpt) problem = 'HELIUS_API_KEY (or SOLANA_RPC_URL) is not set';
  const rpc = rpcOpt || (cfg.rpcUrl ? sol.makeRpc(cfg.rpcUrl) : null);
  const enabled = !problem;
  const site = String(publicUrl || process.env.PUBLIC_URL || '').replace(/\/$/, '');

  // the export's own asset keypair: the same every time for the same export
  const assetFor = (exportId) => keypairFromSeed(crypto.createHmac('sha256', payer.seed).update(`prompt-city/export-asset:${cfg.cluster}:${exportId}`).digest());

  // The owner's request: the NFT leaves the market now; the mint on Solana follows in the scheduled run.
  async function request(userId, nftId, wallet) {
    if (!enabled) fail('Taking NFTs to Solana is not switched on yet on this server.');
    const w = String(wallet ?? '').trim();
    if (!sol.isWallet(w)) fail('That is not a Solana wallet address. Paste the address of your wallet (Phantom, Solflare, Backpack). Nothing was sent.');
    return db.tx(async (t) => {
      const [c] = await t.query('select * from collections where slug = $1 for share', [m.OWN_COLLECTION]);
      const [n] = await t.query('select * from nfts where id = $1 for update', [Number(nftId)]);
      if (!n || Number(n.owner_id) !== Number(userId)) fail(`You don't own ${n ? n.name : m.nftName(nftId)}. Nothing was sent.`);
      if (Number(n.collection_id) !== Number(c.id)) fail(`Only Citizens can go to Solana; ${n.name} can't. Nothing was sent.`);
      if (c.status === 'frozen') fail(`${c.name} is frozen. Nothing was sent.`);
      await t.query('select id from users where id = $1 for update', [userId]);
      if (cfg.fee > 0) {
        await m.move(t, userId, -cfg.fee, 'export_fee', String(n.id));
        await m.move(t, null, cfg.fee, 'export_fee', String(n.id));
      }
      const [gone] = await t.query(`update nfts set owner_id = null, price = null, listed_at = null, exported_at = now()
        where id = $1 and owner_id = $2 returning id`, [n.id, userId]);
      if (!gone) fail('This NFT just changed hands. Nothing was sent.');
      await t.query("insert into ledger (user_id, delta, kind, ref) values ($1, 0, 'export', $2)", [userId, String(n.id)]);
      const [x] = await t.query('insert into nft_exports (nft_id, user_id, wallet, network, fee) values ($1, $2, $3, $4, $5) returning id',
        [n.id, userId, w, cfg.cluster, cfg.fee]);
      const asset = assetFor(x.id).publicKey;
      await t.query('update nft_exports set asset = $1 where id = $2', [asset, x.id]);
      return { id: Number(x.id), nft: { id: Number(n.id), name: n.name, rarity: n.rarity }, wallet: w, asset, fee: cfg.fee, cluster: cfg.cluster };
    });
  }

  async function mine(userId, limit = 20) {
    const rows = await db.query(`select x.*, n.name from nft_exports x join nfts n on n.id = x.nft_id where x.user_id = $1 order by x.id desc limit $2`, [userId, limit]);
    return rows.map(view);
  }
  const view = (x) => ({ id: Number(x.id), nft_id: Number(x.nft_id), name: x.name, wallet: x.wallet, status: x.status, asset: x.asset,
    signature: x.signature, network: x.network, fee: Number(x.fee), error: x.error, created_at: x.created_at, minted_at: x.minted_at,
    url: x.asset ? explorerAsset(x.asset, x.network) : null });

  const markMinted = (x) => db.tx(async (t) => {
    await t.query("update nft_exports set status = 'minted', minted_at = now(), error = null where id = $1 and status <> 'minted'", [x.id]);
    await t.query('update nfts set export_asset = $1 where id = $2', [x.asset, x.nft_id]);
  });

  // one step for one export: done already? landed? then send (again)
  async function step(x) {
    const asset = assetFor(x.id);
    if (x.signature) {
      const st = (await rpc('getSignatureStatuses', [[x.signature], { searchTransactionHistory: true }]).catch(() => null))?.value?.[0];
      if (st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus)) { await markMinted(x); return 'minted'; }
      if (st?.err) await db.query('update nft_exports set error = $1 where id = $2', [`transaction failed: ${JSON.stringify(st.err).slice(0, 200)}`, x.id]);
    }
    const info = await rpc('getAccountInfo', [asset.publicKey, { encoding: 'base64', commitment: 'confirmed' }]);
    if (info?.value) {
      if (info.value.owner !== MPL_CORE) {
        await db.query("update nft_exports set status = 'failed', error = 'the asset address is taken by another program' where id = $1", [x.id]);
        return 'failed';
      }
      await markMinted(x);
      return 'minted';
    }
    if (x.status === 'sending' && x.attempts >= MAX_ATTEMPTS) {
      await db.query("update nft_exports set status = 'failed' where id = $1", [x.id]);
      return 'failed';
    }
    // a sent transaction gets a minute to land before it is replaced
    if (x.signature && x.updated_ago != null && x.updated_ago < 60) return 'waiting';
    const { value: bh } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const signed = signTransaction({
      payer: payer.publicKey, recentBlockhash: bh.blockhash, signers: [payer, asset],
      instructions: [txIx.computeUnitLimit(60_000), createCoreAsset({ asset: asset.publicKey, payer: payer.publicKey, owner: x.wallet, name: x.name.slice(0, 32), uri: `${site}/meta/${x.nft_id}.json` })],
    });
    await db.query("update nft_exports set status = 'sending', signature = $1, attempts = attempts + 1, sent_at = now() where id = $2", [signed.signature, x.id]);
    try {
      await rpc('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
    } catch (e) {
      await db.query('update nft_exports set error = $1 where id = $2', [String(e.message).slice(0, 300), x.id]);
    }
    return 'sent';
  }

  // the scheduled run: the oldest exports first, within the time budget
  async function tick({ budgetMs = 8000 } = {}) {
    if (!enabled) return { skipped: problem };
    const until = Date.now() + budgetMs;
    const rows = await db.query(`select x.*, n.name, extract(epoch from now() - x.sent_at)::float as updated_ago from nft_exports x join nfts n on n.id = x.nft_id
      where x.status in ('pending', 'sending') and x.network = $1 order by x.id limit 20`, [cfg.cluster]);
    const out = { minted: 0, sent: 0, failed: 0, waiting: 0 };
    for (const x of rows) {
      if (Date.now() > until) break;
      try {
        const r = await step(x);
        out[r] = (out[r] || 0) + 1;
      } catch (e) {
        console.error(`export #${x.id}:`, e.message);
        await db.query('update nft_exports set error = $1 where id = $2', [String(e.message).slice(0, 300), x.id]).catch(() => {});
      }
    }
    return out;
  }

  return { enabled, problem, cluster: cfg.cluster, fee: cfg.fee, payer: payer?.publicKey ?? null, request, mine, tick, assetFor: (id) => assetFor(id).publicKey };
}

// the Metaplex metadata of a Citizen (the "uri" of its asset): name, picture, traits
export function metadata(n, publicUrl) {
  return {
    name: n.name,
    symbol: 'CITY',
    description: 'A Prompt City Citizen: one of 5,555 pixel citizens of the first city inside your AI.',
    image: `${publicUrl}/big/${n.id}.png`,
    external_url: `${publicUrl}/nft/${n.id}`,
    attributes: (n.attributes || []).map((a) => ({ trait_type: a.trait_type, value: a.value })),
    properties: { files: [{ uri: `${publicUrl}/big/${n.id}.png`, type: 'image/png' }], category: 'image' },
  };
}
