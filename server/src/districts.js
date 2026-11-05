// District drops: every Citizen lives in a district (its "Turf" trait), and districts open for minting one by one.
// DISTRICTS lists the ones that open later, each with the time it opens:
//   DISTRICTS="Golden Hour@2026-11-20T18:00:00Z, Cash Rain@2026-11-13T18:00:00Z"
// A district that is not listed is open from the start; with DISTRICTS unset every district is open.
// Until its district opens, a Citizen can't be minted in any way (random, picked, free code, craft); the owner's
// team mint is not limited. Read on every start, like the mint price.
export const TURF = 'Turf';

export function districtSchedule(env = process.env) {
  const out = [];
  for (const part of String(env.DISTRICTS || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const at = s.lastIndexOf('@');
    const turf = at > 0 ? s.slice(0, at).trim() : '';
    const when = at > 0 ? new Date(s.slice(at + 1).trim()) : null;
    if (!turf || !when || Number.isNaN(when.getTime())) {
      console.error(`ALERT DISTRICTS: "${s}" is not "<Turf>@<ISO time>"; skipped`);
      continue;
    }
    out.push({ turf, opens_at: when });
  }
  return out.sort((a, b) => a.opens_at - b.opens_at);
}

// the districts that are not open yet at `now`
export function closedTurfs(now = new Date(), env = process.env) {
  return districtSchedule(env).filter((d) => d.opens_at > now).map((d) => d.turf);
}

// SQL for "this NFT's district is open": adds the closed districts to p (as jsonb containment patterns) and returns
// the condition, or 'true' when every district is open. `alias` is the nfts table alias.
export function openSql(p, { alias = 'n', now = new Date(), env = process.env } = {}) {
  const closed = closedTurfs(now, env);
  if (!closed.length) return 'true';
  p.push(closed.map((turf) => JSON.stringify([{ trait_type: TURF, value: turf }])));
  return `not (${alias}.attributes @> any($${p.length}::jsonb[]))`;
}

export const turfOf = (attributes) => (attributes || []).find((a) => a.trait_type === TURF)?.value ?? null;
