// src/api/routes/strategy.ts
import { Router, Request, Response } from 'express';
import { getClient } from '../../services/client-manager';
import { MNQDeltaTrendTrader } from '../../strategies/mnq-delta-trend/trader';
import { MNQDeltaTrendCalculator } from '../../strategies/mnq-delta-trend/calculator';
import { MNQ_DELTA_TREND_CONFIG } from '../../strategies/mnq-delta-trend/config';
import { Logger } from '../../utils/logger';

const router = Router();
const logger = new Logger('StrategyRoute');

// Normalize broker history rows → { timestamp, open, high, low, close, volume }
function normalizeBars(raw: any[]): any[] {
  const toIso = (t: any): string => {
    if (t == null) return '';
    if (typeof t === 'number') return new Date(t).toISOString();           // epoch ms
    if (/^\d+$/.test(String(t))) return new Date(Number(t)).toISOString(); // epoch as string
    // otherwise assume ISO-ish
    const d = new Date(t);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  };

  const num = (x: any): number => {
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  };

  return (raw ?? []).map((r: any) => {
    // try multiple field aliases commonly seen
    const ts =
      r.timestamp ?? r.timestampUtc ?? r.time ?? r.barTime ?? r.startTime ?? r.date ?? r.t;

    const o = r.open ?? r.o ?? r.openPrice ?? r.op;
    const h = r.high ?? r.h ?? r.highPrice ?? r.hi;
    const l = r.low ?? r.l ?? r.lowPrice ?? r.lo;
    const c = r.close ?? r.c ?? r.closePrice ?? r.cl;
    const v = r.volume ?? r.v ?? r.vol ?? r.tradeVolume;

    return {
      timestamp: toIso(ts),
      open: num(o),
      high: num(h),
      low: num(l),
      close: num(c),
      volume: Math.max(0, Math.floor(num(v)))
    };
  }).filter(b =>
    b.timestamp &&
    Number.isFinite(b.open) &&
    Number.isFinite(b.high) &&
    Number.isFinite(b.low) &&
    Number.isFinite(b.close)
  );
}

// Rebuild signed delta like Pine (close vs prev close → ±volume)
function attachSignedDeltaSeries(bars: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < bars.length; i++) {
    const prev = out[i - 1];
    const cur = { ...bars[i] };
    if (i === 0) cur.delta = 0;
    else {
      if (cur.close > prev.close) cur.delta = Math.trunc(cur.volume ?? 0);
      else if (cur.close < prev.close) cur.delta = -Math.trunc(cur.volume ?? 0);
      else cur.delta = 0;
    }
    out.push(cur);
  }
  return out;
}

// Keep a single running instance
let strategy: MNQDeltaTrendTrader | null = null;

router.post('/start', async (req: Request, res: Response) => {
  try {
    if (strategy) {
      return res.status(200).json({ success: true, message: 'Strategy already running' });
    }

    const client = getClient();
    if (!client) {
      return res.status(500).json({ success: false, message: 'Client not initialized' });
    }

    // --- Account selection + logging (UI → client → resolved) ---
    const uiAccountIdRaw = (req.body && (req.body as any).accountId) ?? undefined;

    // If the UI passed an account id, set it on the client
    if (uiAccountIdRaw !== undefined && uiAccountIdRaw !== null && uiAccountIdRaw !== '') {
      const parsed = Number(uiAccountIdRaw);
      if (Number.isFinite(parsed)) {
        // requires ProjectXClient.setSelectedAccountId(id: number)
        (client as any).setSelectedAccountId?.(parsed);
      }
    }

    // What does the client currently think is selected?
    const selectedId = (client as any).getSelectedAccountId?.() ?? null;

    // Try to resolve full account details for logging
    let resolvedAccount: any = null;
    try {
      if (selectedId !== null) {
        // getAccount expects accountNumber string; if your API needs number->string mapping, adjust here
        // If your getAccount takes the *account number* not the internal ID, skip and use searchAccounts below
        const acctSearch = await (client as any).getAccounts?.();
        const matched = Array.isArray(acctSearch)
          ? acctSearch.find((a: any) => a.id === selectedId || a.accountNumber === selectedId || a.number === String(selectedId))
          : null;
        resolvedAccount = matched ?? null;
      }
    } catch { /* swallow - this is just for logs */ }

    // Fallback if we couldn’t resolve by the getter
    if (!resolvedAccount) {
      try {
        const all = await (client as any).getAccounts?.();
        if (Array.isArray(all) && all.length) resolvedAccount = all[0];
      } catch { /* ignore */ }

    // Emit a compact log line showing UI -> client -> resolved account
    }
    console.info('[account@start]', {
      uiAccountIdRaw,
      selectedId,
      resolved: resolvedAccount
        ? {
            id: resolvedAccount.id,
            number: resolvedAccount.accountNumber ?? resolvedAccount.number ?? resolvedAccount.name,
            isActive: !!(resolvedAccount.isActive ?? resolvedAccount.active),
            status: resolvedAccount.status ?? null,
            live: resolvedAccount.live ?? undefined,
            balance: resolvedAccount.balance ?? undefined,
          }
        : null
    });   
    // Pick most current MNQ futures contract
    const contracts = await client.searchContracts('MNQ');
    if (!contracts || contracts.length === 0) {
      return res.status(404).json({ success: false, message: 'No MNQ contracts found' });
    }

    // naive “most current”: first active or first in list
    const active = contracts.find(c => (c as any).isActive === true) ?? contracts[0];
    const contractId = active.id;
    const symbol = (active as any).symbolId ?? 'F.US.MNQ';

    // Build calculator with Pine-parity config
    const calculator = new MNQDeltaTrendCalculator(MNQ_DELTA_TREND_CONFIG);

    // // ---------- WARM-UP (history → calculator) ----------
    // // 1) Fetch history (minutes as strings, per your ProjectXClient.getBars)
    // const bars3m = await client.getBars(contractId, '3', 300);   // 3-minute bars
    // const htfMinutes = String(MNQ_DELTA_TREND_CONFIG.higherTimeframe ?? 15);
    // const barsHTF = await client.getBars(contractId, htfMinutes, 300); // e.g., 15-minute bars

    // // 2) Feed warm-up in timestamp order
    // for (const b of bars3m)  calculator.processWarmUpBar(b, '3min');
    // for (const b of barsHTF) calculator.processWarmUpBar(b, 'HTF');

    // // 3) Seal warm-up
    // calculator.completeWarmUp();
    // logger.info(`[WarmUp] 3m=${bars3m.length} HTF(${htfMinutes}m)=${barsHTF.length}`);

    // ---------- WARM-UP (history → calculator) ----------
    const bars3mRaw = await client.getBars(contractId, '3', 300);
    const htfMinutes = String(MNQ_DELTA_TREND_CONFIG.higherTimeframe ?? 15);
    const barsHTFRaw = await client.getBars(contractId, htfMinutes, 300);

    // ✅ normalize → shape we expect
    const bars3mNorm  = normalizeBars(bars3mRaw);
    const barsHTFNorm = normalizeBars(barsHTFRaw);

    // ✅ sort ascending by time
    const asc = (a: any, b: any) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    const bars3mSorted  = [...bars3mNorm].sort(asc);
    const barsHTFSorted = [...barsHTFNorm].sort(asc);

    // Rebuild Pine-style signed delta
    const bars3m = attachSignedDeltaSeries(bars3mSorted);
    const barsHTF = attachSignedDeltaSeries(barsHTFSorted);

    // Feed
    for (const b of bars3m)  calculator.processWarmUpBar(b, '3min');
    for (const b of barsHTF) calculator.processWarmUpBar(b, 'HTF');

    // Seal warm-up
    calculator.completeWarmUp();
    logger.info(`[WarmUp] 3m=${bars3m.length} HTF(${htfMinutes}m)=${barsHTF.length}`);

    // quick sanity peek
    const peek = bars3m.slice(-3).map(b => ({ t: b.timestamp, o:b.open, h:b.high, l:b.low, c:b.close, d:b.delta, v:b.volume }));
    logger.info('[WarmUp][peek last 3 LTF]', peek);

    // Construct trader (calculator is now warm)
    strategy = new MNQDeltaTrendTrader({
      client,
      calculator,
      config: MNQ_DELTA_TREND_CONFIG,
      contractId,
      symbol,
    });

    await strategy.start();

    logger.info(`Strategy started for ${symbol} (contractId=${contractId})`);
    return res.status(200).json({ success: true, message: 'Strategy started', contractId, symbol });
  } catch (err: any) {
    logger.error('Failed to start strategy', err);
    return res.status(500).json({ success: false, message: err?.message ?? String(err) });
  }
});

router.post('/stop', async (_req: Request, res: Response) => {
  try {
    if (!strategy) {
      return res.status(200).json({ success: true, message: 'Strategy already stopped' });
    }
    // If your MNQDeltaTrendTrader has stop(), await it; otherwise just null it out
    if ((strategy as any).stop) {
      await (strategy as any).stop();
    }
    strategy = null;
    return res.status(200).json({ success: true, message: 'Strategy stopped' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err?.message ?? String(err) });
  }
});

router.get('/status', (_req: Request, res: Response) => {
  return res.status(200).json({ running: !!strategy });
});

export default router;
